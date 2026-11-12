/**
 * Dub captions timed closer by the dub's voices (refineBySpeech in src/sync.ts), and the English
 * audio heard in the background for them on a file timed from its index (hearDubVoices). Built from
 * the benchmark's made-up episodes (test/synthetic.ts): the captions are right by the dub's voices,
 * and the file's own track follows the original audio.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Cue, FileAnchors } from "../src/sync.js";
import { dubbed, episode, faithful, heardVoices, indexFile, shifted, speechOnlyFile, srt, srtStarts, type SubLine } from "./synthetic.js";

const CACHE = ".cache-voices-test";
let sync: typeof import("../src/sync.js");
let config: typeof import("../src/config.js").config;
let reads: typeof import("../src/reads.js");

beforeAll(async () => {
  // Before anything loads src/config.ts, which reads CACHE_DIR once.
  process.env.CACHE_DIR = CACHE;
  sync = await import("../src/sync.js");
  ({ config } = await import("../src/config.js"));
  reads = await import("../src/reads.js");
});

/** Lets out the fetches held by stalled(): they fail, as offline. */
let release: () => void = () => {};

afterEach(async () => {
  // Every read left in the background ends before fetch is let out again.
  release();
  await sync.settled();
  vi.restoreAllMocks();
});

/** AIOStreams doesn't answer until the test is over: a sync waiting on the read would never end. */
function stalled() {
  const gate = new Promise<void>((resolve) => (release = resolve));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await gate;
    throw new TypeError("offline");
  });
}

afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const ep = episode(501);
/** A dub spoken 0.2 s after the original's voices: the track alone times it a beat off. */
const dub = dubbed(ep, 502, { lag: 440 });
const voices = heardVoices(dub.voices, 503);
const cues = (sub: SubLine[]): Cue[] => sub.map(({ start, end }) => ({ start, end }));
/** How far each caption start lands from where it belongs, at most. */
const worst = (sub: SubLine[], shift: (start: number) => number) => Math.max(...sub.map((l) => Math.abs(l.start + shift(l.start) - l.truth)));

describe("dub captions refined by the dub's voices", () => {
  const heardFile = (): FileAnchors => indexFile(ep.duration, [ep.lines], voices);

  it("moves captions the track timed a beat off onto the voices", () => {
    // The track's answer, 0.25 s early; where they belong is where they are written.
    const track = () => -250;
    const refined = sync.refineBySpeech(heardFile(), cues(dub.captions), track);
    expect(refined).toBeDefined();
    expect(refined!.windows).toBeGreaterThanOrEqual(3);
    expect(worst(dub.captions, refined!.shift)).toBeLessThanOrEqual(80);
  });

  it("keeps the track's steps, and moves each stretch by its own windows", () => {
    // Written for a release cut differently at 10 minutes, and timed by the track a beat off on
    // either side of the cut, each side by its own amount.
    const cut = 600_000;
    const written = dub.captions.map((l) => ({ ...l, start: l.start + (l.truth < cut ? 800 : -1200), end: l.end + (l.truth < cut ? 800 : -1200) }));
    const track = (start: number) => (start < cut + 800 ? -800 - 200 : 1200 + 150);
    const refined = sync.refineBySpeech(heardFile(), cues(written), track);
    expect(refined?.moves.map((m) => m.own)).toEqual([true, true]);
    expect(worst(written, refined!.shift)).toBeLessThanOrEqual(80);
  });

  it("needs two windows to move a stretch far from the rest", () => {
    // One window (at half the runtime) sits in a stretch the track put 0.5 s later than the rest.
    const from = 0.45 * ep.duration;
    const to = 0.55 * ep.duration;
    const track = (start: number) => (start >= from && start < to ? 400 : -100);
    const refined = sync.refineBySpeech(heardFile(), cues(dub.captions), track);
    expect(refined?.moves.map((m) => m.own)).toEqual([true, false, true]);
    // That stretch moves as the file does, not by its one window.
    expect(refined!.moves[1].by).toBe(refined!.moves[0].by);
  });

  it("places a service's own captions further ahead of the voices than uploads", () => {
    const track = () => -250;
    const upload = sync.refineBySpeech(heardFile(), cues(dub.captions), track);
    const official = sync.refineBySpeech(heardFile(), cues(dub.captions), track, sync.OFFICIAL_CAPTIONS_LEAD_MS);
    expect(official!.moves.map((m) => m.by)).toEqual(upload!.moves.map((m) => m.by - (sync.OFFICIAL_CAPTIONS_LEAD_MS - sync.VOICE_LEAD_MS)));
    // Which files those are: a release's own captions track, as Anime Tosho's are stored.
    expect(sync.voiceLeadFor("/cache/subtitles/at0a1b2c3d-2-3.ass")).toBe(sync.OFFICIAL_CAPTIONS_LEAD_MS);
    expect(sync.voiceLeadFor("/cache/subtitles/sd1000001-2000001-2-1.ass")).toBe(sync.VOICE_LEAD_MS);
    expect(sync.voiceLeadFor("/cache/subtitles/1000002-2-2.ass")).toBe(sync.VOICE_LEAD_MS);
  });

  it("tells the file's own track from captions that only follow it", () => {
    const fit = (offset: number, score = 1) => ({ measured: { offset, score } });
    // The track itself: every window at one shift, its lines met whole.
    expect(sync.fitsOwnTrack([0, 0, 5, 0, 0, -5, 0, 0, 0, 0].map((o) => fit(o)))).toBe(true);
    // One window of ten reading a stretch of songs differently still is.
    expect(sync.fitsOwnTrack([...[0, 0, 0, 0, 0, 0, 0, 0, 0].map((o) => fit(o)), fit(-640, 0.8)])).toBe(true);
    // An upload that follows a track scores as high, but its windows spread over hundreds of ms.
    expect(sync.fitsOwnTrack([-520, -240, -170, -160, -110, -320, -240, -80, -400, -320].map((o) => fit(o, 0.98)))).toBe(false);
    // One shift, but lines that are only like the track's.
    expect(sync.fitsOwnTrack([0, 0, 0, 0, 0, 0].map((o) => fit(o, 0.8)))).toBe(false);
    // Too few windows to tell.
    expect(sync.fitsOwnTrack([0, 0, 0, 0].map((o) => fit(o)))).toBe(false);
  });

  it("leaves the track's timing when the voices are another episode's", () => {
    const elsewhere = heardVoices(dubbed(episode(601), 602, { lag: 440 }).voices, 603);
    expect(sync.refineBySpeech(indexFile(ep.duration, [ep.lines], elsewhere), cues(dub.captions), () => -250)).toBeUndefined();
  });

  it("needs three windows of voices", () => {
    const record = heardFile();
    let kept = 0;
    const two = { ...record, windows: record.windows.filter((w) => !w.heard || kept++ < 2) };
    expect(sync.refineBySpeech(two, cues(dub.captions), () => -250)).toBeUndefined();
  });

  it("only hears the dub in English audio, or audio whose language isn't tagged", () => {
    expect(sync.refineBySpeech({ ...heardFile(), audioLang: "jpn" }, cues(dub.captions), () => -250)).toBeUndefined();
    expect(sync.refineBySpeech({ ...heardFile(), audioLang: "eng" }, cues(dub.captions), () => -250)).toBeDefined();
  });

  it("needs speech heard by Silero", () => {
    const { speechBy: _speechBy, ...unheard } = heardFile();
    expect(sync.refineBySpeech(unheard, cues(dub.captions), () => -250)).toBeUndefined();
  });
});

describe("the English audio heard in the background for dub captions", () => {
  const AIOSTREAMS = "https://aiostreams.invalid/stremio/u/p/manifest.json";
  let n = 0;
  /** A file timed from its index, stored as fileAnchors keeps it, and a subtitle for it on disk. */
  async function play(record: FileAnchors, subtitle: SubLine[], name?: string) {
    const filename = `Show.S01E${String(++n).padStart(2, "0")}.mkv`;
    const { cacheKey, cachePath } = await import("../src/cache.js");
    await mkdir(cachePath("anchors"), { recursive: true });
    const anchors = path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename })}.json`);
    await writeFile(anchors, JSON.stringify({ ...record, filename }));
    await mkdir(cachePath("subs"), { recursive: true });
    const file = path.join(cachePath("subs"), name ?? `${filename}.srt`);
    const lines = [...subtitle].sort((a, b) => a.start - b.start);
    await writeFile(file, srt(lines));
    const caption = vi.fn(async () => ({ file }));
    const key = sync.syncKey(`ss${n}`, 1, n, filename);
    const run = (lang?: string) => sync.syncCaptions(key, caption, AIOSTREAMS, `tt0000001:1:${n}`, "series", filename, lang);
    const off = async (served: string) => {
      const starts = srtStarts(await readFile(served, "utf8"));
      return Math.max(...lines.map((l, i) => Math.abs(starts[i] - l.truth)));
    };
    return { filename, anchors, caption, run, off, store: (r: FileAnchors) => writeFile(anchors, JSON.stringify({ ...r, filename })) };
  }
  const unheard = (): FileAnchors => ({ ...indexFile(ep.duration, [ep.lines]), audio: 1 });

  it("serves the track's timing at once, then reads the audio without being waited on", async () => {
    const fetch = stalled();
    const p = await play(unheard(), shifted(dub.captions, 1600));
    const result = await p.run();
    expect(result?.anchors.length).toBeGreaterThan(0);
    expect(result?.voicesPending).toBe(true);
    expect(result?.voiceShift).toBeUndefined();
    // The read has started: the file's stream is being looked up (once, with no asking again).
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("/stream/series/");
  });

  it("syncs again by the voices once they are heard, and only then", async () => {
    stalled();
    const p = await play(unheard(), shifted(dub.captions, 1600));
    const first = await p.run();
    const byTrack = await p.off(first!.file);
    expect(byTrack).toBeGreaterThan(120);
    // Asked again before the audio is in: the same answer, not synced again.
    p.caption.mockClear();
    expect((await p.run())?.voicesPending).toBe(true);
    expect(p.caption).not.toHaveBeenCalled();
    // The audio is in (as the background read stores it): the next request is timed by the voices.
    await p.store(indexFile(ep.duration, [ep.lines], voices));
    const again = await p.run();
    expect(p.caption).toHaveBeenCalled();
    expect(again?.voicesPending).toBeUndefined();
    expect(again?.voiceShift).toBeGreaterThan(100);
    expect(again?.file).toBe(first?.file);
    expect(await p.off(again!.file)).toBeLessThan(80);
  });

  it("leaves dub captions that are the file's own track as the track times them", async () => {
    const fetch = stalled();
    // The file's own lines as dub captions, on a file whose English audio is heard: the voices would
    // move them (they speak 0.44 s after the original), but the track's timing is the file's own.
    const record = indexFile(ep.duration, [ep.lines], voices);
    const own = faithful(ep.lines);
    expect(sync.refineBySpeech(record, cues(own), () => 0)?.moves.some((m) => m.by !== 0)).toBe(true);
    const p = await play(record, own);
    const result = await p.run();
    expect(result?.anchors.length).toBeGreaterThan(0);
    expect(result?.anchors.every((a) => a.offset === 0)).toBe(true);
    expect(result?.voiceShift).toBeUndefined();
    expect(result?.voicesPending).toBeUndefined();
    expect(await p.off(result!.file)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    // Captions that only follow the track are still moved onto the voices, on the same file.
    const upload = await play(record, shifted(dub.captions, 1600));
    expect((await upload.run())?.voiceShift).toBeGreaterThan(100);
  });

  it("times a service's own captions by speech at their own lead, as when moving them onto the voices", async () => {
    stalled();
    // A file with no subtitle track, all ten spots heard: dub captions are timed by its voices.
    const record = speechOnlyFile(ep.duration, voices, { more: true });
    const captions = shifted(dub.captions, 1500);
    const upload = await (await play(record, captions)).run();
    const official = await (await play(record, captions, "at0a1b2c3d-1-1.srt")).run();
    expect(upload?.bySpeech && official?.bySpeech).toBe(true);
    const median = (anchors: Array<{ offset: number }>) => [...anchors].map((a) => a.offset).sort((a, b) => a - b)[anchors.length >> 1];
    expect(median(official!.anchors) - median(upload!.anchors)).toBe(-(sync.OFFICIAL_CAPTIONS_LEAD_MS - sync.VOICE_LEAD_MS));
  });

  it("isn't started for translations, which keep their timing as it is", async () => {
    const fetch = stalled();
    const p = await play(unheard(), shifted(dub.captions, 1600));
    const result = await p.run("Arabic");
    expect(result?.anchors.length).toBeGreaterThan(0);
    expect(result?.voicesPending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isn't started for audio in another language than English", async () => {
    const fetch = stalled();
    const p = await play({ ...unheard(), audioLang: "jpn" }, shifted(dub.captions, 1600));
    expect((await p.run())?.voicesPending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is held back while today's reads leave too little for syncs a viewer waits on", async () => {
    const before = config.dailyReadGb;
    try {
      const fetch = stalled();
      // 5 windows of 40 s at 2 Mb/s are 50 MB: more than 80% of a 60 MB day.
      config.dailyReadGb = 0.06;
      const p = await play({ ...unheard(), bitrate: 2_000_000 }, shifted(dub.captions, 1600));
      const result = await p.run();
      expect(result?.voicesPending).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      config.dailyReadGb = before;
    }
  });

  it("isn't started for a file too heavy to hear in the background", async () => {
    const fetch = stalled();
    // 20 s windows at 70 Mb/s: 875 MB, past the 315 MB a background read may cost.
    expect(sync.hearingCost({ bitrate: 70_000_000 })).toBeGreaterThan(800e6);
    expect(sync.hearingCost({ bitrate: 2_200_000 })).toBeLessThan(60e6);
    const p = await play({ ...unheard(), bitrate: 70_000_000 }, shifted(dub.captions, 1600));
    expect((await p.run())?.voicesPending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves no read running once the read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const p = await play(unheard(), shifted(dub.captions, 1600));
    expect((await p.run())?.voicesPending).toBe(true);
    await sync.settled();
    // The file still counts as unheard, so a later request may try again.
    const stored = JSON.parse(await readFile(p.anchors, "utf8")) as FileAnchors;
    expect(sync.voicesToHear(stored)).toBe(true);
  });
});

describe("what a background read may spend", () => {
  it("leaves the last fifth of the day's limit to syncs a viewer waits on", async () => {
    const before = config.dailyReadGb;
    try {
      config.dailyReadGb = 1000;
      reads.noteRead(1_000_000);
      const { countedToday } = await import("../src/stats.js");
      const counted = countedToday("sync.readBytes");
      config.dailyReadGb = 0.01; // 10 MB: background reads up to 8 MB
      expect(reads.backgroundReadFits(8_000_000 - counted)).toBe(true);
      expect(reads.backgroundReadFits(8_000_000 - counted + 1)).toBe(false);
      config.dailyReadGb = 0;
      expect(reads.backgroundReadFits(1e15)).toBe(true);
    } finally {
      config.dailyReadGb = before;
    }
  });
});
