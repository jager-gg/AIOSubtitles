/**
 * Timing by speech on a file with no subtitle track (bySpeech in src/sync.ts): a step timed per
 * stretch, a step too few windows show, how much speech a fit needs, the lead each kind of subtitle
 * keeps before its voice, and five more spots of the audio heard in the background when the first
 * five don't say clearly (hearMoreSpeech). Built from the benchmark's made-up episodes.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Cue, FileAnchors } from "../src/sync.js";
import { drowned, episode, faithful, heard, retimedByOthers, shifted, speechOnlyFile, srt, srtStarts, stepped, unrelated, type SubLine } from "./synthetic.js";

const CACHE = ".cache-speech-test";
let sync: typeof import("../src/sync.js");
let config: typeof import("../src/config.js").config;

beforeAll(async () => {
  // Before anything loads src/config.ts, which reads CACHE_DIR once.
  process.env.CACHE_DIR = CACHE;
  sync = await import("../src/sync.js");
  ({ config } = await import("../src/config.js"));
});

/** Lets out the fetches held by stalled(): they fail, as offline. */
let release: () => void = () => {};

afterEach(async () => {
  release();
  await sync.settled();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

/** AIOStreams doesn't answer until the test is over: a sync waiting on the read would never end. */
function stalled() {
  const gate = new Promise<void>((resolve) => (release = resolve));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await gate;
    throw new TypeError("offline");
  });
}

const cues = (sub: SubLine[]): Cue[] => sub.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
/** The share of lines a timing puts within `ms` of where they belong. */
const within = (sub: SubLine[], shift: (start: number) => number, ms: number) => sub.filter((l) => Math.abs(l.start + shift(l.start) - l.truth) <= ms).length / sub.length;

describe("timing by speech", () => {
  const ep = episode(701);
  const voices = heard(ep.lines, 702);
  const translation = retimedByOthers(faithful(ep.lines), 703, { jitter: 250 });

  it("times each side of a step by its own windows, once ten windows are heard", () => {
    const sub = stepped(translation, [ep.cuts[2]], [800, 3400]);
    const timed = sync.bySpeech(speechOnlyFile(ep.duration, voices, { more: true }), cues(sub));
    expect(timed?.steps).toBe(1);
    const plan = sync.planShifts(timed!.anchors, cues(sub), timed!.reference);
    expect(within(sub, plan, 300)).toBeGreaterThan(0.9);
    // Each side rests on three windows at least, so the timing passes every whole-file test, even
    // the one a shift per stretch must (the share of windows it rests on), and the verdict is synced.
    expect(timed!.anchors.length).toBeGreaterThanOrEqual(6);
    expect(sync.accountsForFile(speechOnlyFile(ep.duration, voices, { more: true }), cues(sub), plan, timed!.anchors)).toBeUndefined();
    expect(sync.judge(speechOnlyFile(ep.duration, voices, { more: true }), cues(sub)).verdict).toBe("synced");
  });

  it("doesn't time by one shift a subtitle whose step too few windows show", () => {
    // The step at the second break leaves two of the ten windows after it: enough to see, too few to place.
    const sub = stepped(translation, [ep.cuts[3] + 60_000], [800, 3400]);
    const record = speechOnlyFile(ep.duration, voices, { more: true });
    const after = record.windows.filter((w) => w.from > ep.cuts[3] + 60_000 && w.cues.length >= 3).length;
    expect(after).toBe(2);
    expect(sync.bySpeech(record, cues(sub))).toBeUndefined();
    // The same subtitle at one shift is timed.
    expect(sync.bySpeech(record, cues(shifted(translation, 800)))?.anchors.length).toBeGreaterThanOrEqual(8);
  });

  it("needs the best shift to stand out by more than chance among few voices", () => {
    // A third of the voices heard, another episode's lines: before, a fit this thin passed on its
    // share alone (score 0.54, margin 0.15 over 13 voices).
    const thin = episode(1062);
    const record = speechOnlyFile(thin.duration, drowned(heard(thin.lines, 7062), 7162, 0.33), { more: true });
    expect(sync.bySpeech(record, cues(unrelated(episode(5062, { like: thin }).lines)))).toBeUndefined();
    // The episode's own lines on the same file still are.
    expect(sync.bySpeech(record, cues(shifted(faithful(thin.lines), -900)))).toBeDefined();
  });

  it("places dub captions closer to their voices than translations", () => {
    const record = speechOnlyFile(ep.duration, voices);
    const captions = cues(shifted(faithful(ep.lines), 1500));
    const asTranslation = sync.bySpeech(record, captions);
    const asDub = sync.bySpeech(record, captions, sync.VOICE_LEAD_MS);
    expect(asTranslation && asDub).toBeTruthy();
    const median = (anchors: Array<{ offset: number }>) => [...anchors].map((a) => a.offset).sort((a, b) => a - b)[anchors.length >> 1];
    expect(median(asDub!.anchors) - median(asTranslation!.anchors)).toBe(200 - sync.VOICE_LEAD_MS);
  });
});

describe("more of the audio heard for a file with no subtitle track", () => {
  const AIOSTREAMS = "https://aiostreams.invalid/stremio/u/p/manifest.json";
  const ep = episode(711);
  const lines = shifted(retimedByOthers(faithful(ep.lines), 713, { jitter: 250 }), 1400);
  /** Speech so drowned by music that five windows don't time the subtitle, and ten do. */
  const sparse = drowned(heard(ep.lines, 712), 714, 0.4);
  let n = 0;
  /** A file with no subtitle track, stored as fileAnchors keeps it, and a subtitle for it on disk. */
  async function play(record: FileAnchors, subtitle: SubLine[]) {
    const filename = `Show.S02E${String(++n).padStart(2, "0")}.mp4`;
    const { cacheKey, cachePath } = await import("../src/cache.js");
    await mkdir(cachePath("anchors"), { recursive: true });
    const anchors = path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename })}.json`);
    await writeFile(anchors, JSON.stringify({ ...record, filename }));
    await mkdir(cachePath("subs"), { recursive: true });
    const file = path.join(cachePath("subs"), `${filename}.srt`);
    const sorted = [...subtitle].sort((a, b) => a.start - b.start);
    await writeFile(file, srt(sorted));
    const caption = vi.fn(async () => ({ file }));
    const key = sync.syncKey(`ss${700 + n}`, 2, n, filename);
    const run = () => sync.syncCaptions(key, caption, AIOSTREAMS, `tt0000002:2:${n}`, "series", filename, "Arabic");
    const off = async (served: string) => {
      const starts = srtStarts(await readFile(served, "utf8"));
      return sorted.filter((l, i) => Math.abs(starts[i] - l.truth) <= 300).length / sorted.length;
    };
    return { filename, anchors, caption, run, key, off, store: (r: FileAnchors) => writeFile(anchors, JSON.stringify({ ...r, filename })) };
  }

  it("hears five more spots when the first five don't time the subtitle, without being waited on", async () => {
    const fetch = stalled();
    const p = await play(speechOnlyFile(ep.duration, sparse), lines);
    const result = await p.run();
    expect(result?.anchors).toHaveLength(0);
    expect(result?.speechPending).toBe(true);
    // The read has started: the file's stream is being looked up (once, with no asking again).
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("/stream/series/");
    expect(sync.MORE_SPOTS).toHaveLength(5);
  });

  it("syncs again by ten windows once they are heard, and only then", async () => {
    stalled();
    const p = await play(speechOnlyFile(ep.duration, sparse), lines);
    expect((await p.run())?.anchors).toHaveLength(0);
    // Asked again before the audio is in: the same answer, not synced again.
    p.caption.mockClear();
    expect((await p.run())?.speechPending).toBe(true);
    expect(p.caption).not.toHaveBeenCalled();
    expect(await sync.knownSync(p.key, p.filename)).toBe("unsynced");
    // The audio is in (as the background read stores it): the list asks again, and the next request is timed by it.
    await p.store(speechOnlyFile(ep.duration, sparse, { more: true }));
    expect(await sync.knownSync(p.key, p.filename)).toBe("unknown");
    const again = await p.run();
    expect(p.caption).toHaveBeenCalled();
    expect(again?.speechPending).toBeUndefined();
    expect(again?.bySpeech).toBe(true);
    expect(again?.anchors.length).toBeGreaterThanOrEqual(3);
    expect(await p.off(again!.file)).toBeGreaterThan(0.9);
    expect(await sync.knownSync(p.key, p.filename)).toBe("speech");
  });

  it("judges again on ten windows a subtitle the whole-file test refused on five", async () => {
    stalled();
    // The file's own lines for its first 60% only: speech times them where they are, and the windows
    // after hold voices and none of its lines, so it doesn't account for the whole file.
    const voices = heard(ep.lines, 712);
    const part = lines.filter((l) => l.truth < ep.duration * 0.6);
    const p = await play(speechOnlyFile(ep.duration, voices), part);
    expect(sync.bySpeech(speechOnlyFile(ep.duration, voices), cues(part))).toBeDefined();
    const first = await p.run();
    expect(first?.anchors).toHaveLength(0);
    expect(first?.noFit).toBe(true);
    expect(first?.speechPending).toBe(true);
    expect(await sync.knownSync(p.key, p.filename)).toBe("wrong");
    // Once more of the audio is heard, the refusal by five windows isn't final: it is synced again.
    await p.store(speechOnlyFile(ep.duration, voices, { more: true }));
    expect(await sync.knownSync(p.key, p.filename)).toBe("unknown");
    const again = await p.run();
    expect(p.caption).toHaveBeenCalledTimes(2);
    expect(again?.speechPending).toBeUndefined();
    expect(again?.anchors).toHaveLength(0);
    expect(await sync.knownSync(p.key, p.filename)).toBe("wrong");
  });

  it("isn't started when five windows time the subtitle clearly", async () => {
    const fetch = stalled();
    const p = await play(speechOnlyFile(ep.duration, heard(ep.lines, 712)), lines);
    const result = await p.run();
    expect(result?.anchors.length).toBe(5);
    expect(result?.speechPending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isn't started again once the five more spots have been heard", async () => {
    const fetch = stalled();
    const p = await play(speechOnlyFile(ep.duration, drowned(heard(ep.lines, 712), 714, 0.12), { more: true }), lines);
    const result = await p.run();
    expect(result?.speechPending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is held back while today's reads leave too little for syncs a viewer waits on", async () => {
    const before = config.dailyReadGb;
    try {
      const fetch = stalled();
      // 5 windows of 40 s at 2 Mb/s are 50 MB: more than 80% of a 60 MB day.
      config.dailyReadGb = 0.06;
      const p = await play({ ...speechOnlyFile(ep.duration, sparse), bitrate: 2_000_000 }, lines);
      expect((await p.run())?.speechPending).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      config.dailyReadGb = before;
    }
  });

  it("isn't started for a file too heavy to hear in the background", async () => {
    const fetch = stalled();
    expect(sync.moreSpeechCost({ bitrate: 70_000_000 })).toBeGreaterThan(800e6);
    expect(sync.moreSpeechCost({ bitrate: 3_500_000 })).toBeLessThan(90e6);
    const p = await play({ ...speechOnlyFile(ep.duration, sparse), bitrate: 70_000_000 }, lines);
    expect((await p.run())?.speechPending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves the file's readings as they were when the read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const p = await play(speechOnlyFile(ep.duration, sparse), lines);
    expect((await p.run())?.speechPending).toBe(true);
    await sync.settled();
    // Still five windows, so a later request may try again.
    const stored = JSON.parse(await readFile(p.anchors, "utf8")) as FileAnchors;
    expect(stored.windows).toHaveLength(5);
    expect(sync.moreSpeechToHear(stored)).toBe(true);
  });

  it("is only for files with no subtitle track", () => {
    const record = speechOnlyFile(ep.duration, sparse);
    expect(sync.moreSpeechToHear(record)).toBe(true);
    expect(sync.moreSpeechToHear({ ...record, speechOnly: undefined })).toBe(false);
    expect(sync.moreSpeechToHear({ ...record, audio: undefined })).toBe(false);
    expect(sync.moreSpeechToHear({ ...record, rounds: 1 })).toBe(false);
  });
});
