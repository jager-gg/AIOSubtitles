import { describe, expect, it } from "vitest";
import { byStarts, farTiming, judge, landing, measureStarts, measureWindow, planShifts, startsTrial, wideFit, type Cue } from "../src/sync.js";
import { dubCaptions, episode, extendedCut, faithful, indexFile, runOn, shifted, stepped, unrelated, windowFile, type SubLine } from "./synthetic.js";

const cues = (sub: SubLine[]): Cue[] => [...sub].sort((a, b) => a.start - b.start).map((l) => ({ start: l.start, end: l.end }));
const starts = (sub: SubLine[]) => [...new Set(sub.map((l) => l.start))].sort((a, b) => a - b);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** A drama's episode, 43 minutes with four breaks, and its official translation: lines run on, stepping +3 s or so at each break. */
const drama = episode(505, { minutes: 43, breaks: 4 });
const STEPS = [1500, 4600, 7400, 10300, 13100, 15800];
const runOnStepped = (ep = drama, seed = 122) => stepped(runOn(faithful(ep.lines), seed, { merge: 0.6, hold: 6000 }), ep.cuts.slice(1), STEPS);

describe("where lines start, when how they overlap can't tell", () => {
  it("finds a window's shift by its line starts, whatever the lines' lengths", () => {
    const window = drama.lines.filter((c) => c.start >= 600000 && c.start < 660000);
    const sub = shifted(runOn(faithful(drama.lines), 7, { merge: 0.6, hold: 6000 }), 4200);
    const measured = measureStarts(window, starts(sub));
    expect(measured).toBeDefined();
    expect(Math.abs(measured!.offset - -4200)).toBeLessThanOrEqual(200);
  });

  it("finds nothing where too few lines start together", () => {
    const window = drama.lines.filter((c) => c.start >= 600000 && c.start < 660000);
    expect(measureStarts(window, [1000, 50000, 90000])).toBeUndefined();
    expect(measureStarts(window.slice(0, 2), starts(faithful(drama.lines)))).toBeUndefined();
  });

  it("counts the windows on the timing, and the longest run of them off it", () => {
    const w = (from: number, offset?: number) => ({ from, ...(offset === undefined ? {} : { measured: { offset, score: 0.4, alternatives: [] } }) });
    const anchors = [{ from: 0, to: 60000, offset: 1000, score: 0.4 }, { from: 600000, to: 660000, offset: 5000, score: 0.4 }];
    expect(landing([w(0, 1200), w(60000, -15000), w(120000), w(180000, 800), w(600000, 5300), w(660000, 9000)], anchors)).toEqual({ landed: 3, astray: 2 });
    expect(landing([w(0, 1200)], [])).toEqual({ landed: 0, astray: 1 });
  });

  it("times an official translation that steps at every break, which overlap refuses", () => {
    const sub = runOnStepped();
    const record = indexFile(drama.duration, [drama.lines]);
    // As before: overlap's fits scatter, so the shift per stretch is refused...
    const verdict = judge(record, cues(sub));
    expect(verdict.verdict).toBe("synced");
    expect(verdict.byStarts).toBe(true);
    // ...and line starts give every stretch its own shift.
    const timed = byStarts(record, cues(sub))!;
    const nearest = (offset: number) => STEPS.reduce((a, b) => (Math.abs(-b - offset) < Math.abs(-a - offset) ? b : a));
    for (const a of timed.anchors) expect(Math.abs(-nearest(a.offset) - a.offset)).toBeLessThanOrEqual(400);
    expect(new Set(timed.anchors.map((a) => nearest(a.offset))).size).toBe(STEPS.length);
    expect(timed.landed / timed.windows).toBeGreaterThan(0.9);
  });

  it("refuses another episode's translation of the same drama, whose lines also run on and step", () => {
    const other = episode(606, { like: drama });
    const record = indexFile(drama.duration, [drama.lines]);
    const sub = runOnStepped(other, 144).map((l) => ({ ...l, truth: NaN }));
    expect(byStarts(record, cues(sub))).toBeUndefined();
    const trial = startsTrial(record, cues(sub))!;
    expect(trial.landed / trial.windows).toBeLessThan(0.3);
    expect(judge(record, cues(sub)).verdict).not.toBe("synced");
  });

  it("only times files whose every line is known, with enough windows", () => {
    const sub = cues(runOnStepped());
    // Five windows of a file read without its index: too little for line starts alone.
    expect(byStarts(windowFile(drama.duration, drama.lines), sub)).toBeUndefined();
    // An index file with 20 minutes of dialogue: too few windows, though its lines start where the file's do.
    const short = episode(707, { minutes: 21, opening: false, breaks: 0 });
    const timedBy = (ep: typeof short) => startsTrial(indexFile(ep.duration, [ep.lines]), cues(runOn(faithful(ep.lines), 8, { merge: 0.6, hold: 6000 })));
    expect(timedBy(short)).toBeUndefined();
    expect(byStarts(indexFile(short.duration, [short.lines]), cues(runOn(faithful(short.lines), 8, { merge: 0.6, hold: 6000 })))).toBeUndefined();
    // Five minutes more, and it is timed.
    const longer = episode(707, { minutes: 26, opening: false, breaks: 0 });
    expect(timedBy(longer)!.windows).toBeGreaterThanOrEqual(24);
    expect(byStarts(indexFile(longer.duration, [longer.lines]), cues(runOn(faithful(longer.lines), 8, { merge: 0.6, hold: 6000 })))).toBeDefined();
  });

  it("follows a shift that creeps between its steps, where a shift per stretch takes one for all", () => {
    // Windows a minute apart, read 2.4 s rising to 4.0 s: never half a second from one to the next.
    const offsets = [2400, 2560, 2720, 2880, 3040, 3200, 3360, 3520, 3680, 3840, 4000];
    const anchors = offsets.map((offset, k) => ({ from: k * 60000, to: k * 60000 + 60000, offset, score: 0.4 }));
    const captions = offsets.map((_, k) => ({ start: k * 60000 + 30000 - 3000, end: k * 60000 + 32000 - 3000 }));
    const steady = planShifts(anchors, captions);
    const follow = planShifts(anchors, captions, [], true);
    // One shift for the run, its median.
    expect(steady(0)).toBe(3200);
    expect(steady(600000)).toBe(3200);
    // Each window's own shift at its middle, and in proportion between two.
    expect(follow(30000 - 2400)).toBe(2400);
    expect(follow(5 * 60000 + 30000 - 3200)).toBe(3200);
    expect(follow(10 * 60000 + 30000 - 4000)).toBe(4000);
    expect(Math.abs(follow(60000 - 2480) - 2480)).toBeLessThanOrEqual(5);
    // Before the first window and after the last, the nearest one's.
    expect(follow(0)).toBe(2400);
    expect(follow(2000000)).toBe(4000);
  });

  it("follows a stretch's creep and still steps between stretches", () => {
    const anchors = [0, 1, 2, 3, 10, 11, 12, 13].map((k) => ({ from: k * 60000, to: k * 60000 + 60000, offset: k < 10 ? 1000 + k * 100 : 8000 + (k - 10) * 100, score: 0.4 }));
    const captions = Array.from({ length: 140 }, (_, i) => ({ start: i * 6000, end: i * 6000 + 2500 }));
    const follow = planShifts(anchors, captions, [], true);
    expect(follow(30000 - 1000)).toBe(1000);
    expect(follow(2 * 60000 + 30000 - 1200)).toBe(1200);
    expect(Math.abs(follow(120000 - 1150) - 1150)).toBeLessThanOrEqual(5);
    expect(follow(13 * 60000 + 30000 - 8300)).toBe(8300);
  });

  it("refuses a timing that misses more than four windows in a row: a stretch it doesn't hold for", () => {
    // The last third of the subtitle belongs to another episode.
    const ep = drama;
    const other = episode(606, { like: drama });
    const cut = ep.duration * 0.62;
    const mixed = [...runOnStepped().filter((l) => l.truth < cut), ...runOn(faithful(other.lines), 9, { merge: 0.6, hold: 6000 }).filter((l) => l.start >= cut + 20000)];
    const trial = startsTrial(indexFile(ep.duration, [ep.lines]), cues(mixed))!;
    expect(trial.astray).toBeGreaterThan(4);
    expect(byStarts(indexFile(ep.duration, [ep.lines]), cues(mixed))).toBeUndefined();
  });
});

describe("timing further off than the usual search", () => {
  const ep = episode(101);
  /** The played file opens with a 45 s recap the subtitle's release doesn't have. */
  const recap = 45000;
  const fileLines = ep.lines.map((c) => ({ start: c.start + recap, end: c.end + recap }));

  it("measures a window around a centre as if the captions had been moved there", () => {
    const window = fileLines.filter((c) => c.start >= 600000 && c.start < 660000);
    const own = cues(faithful(ep.lines));
    const around = measureWindow(window, own, 20000, 45000)!;
    const moved = measureWindow(window, own.map((c) => ({ start: c.start + 45000, end: c.end + 45000 })))!;
    expect(around.offset).toBe(moved.offset + 45000);
    expect(around.score).toBe(moved.score);
    expect(Math.abs(around.offset - recap)).toBeLessThanOrEqual(40);
    // Searched around 0, the window finds nothing at 45 s.
    expect(Math.abs((measureWindow(window, own)?.offset ?? 0) - recap)).toBeGreaterThan(20000);
  });

  it("finds one shift 45 s off from the line starts over the whole file", () => {
    const fit = wideFit(indexFile(ep.duration + recap, [fileLines]), cues(faithful(ep.lines)))!;
    expect(Math.abs(fit.offset - recap)).toBeLessThanOrEqual(200);
    expect(fit.margin).toBeGreaterThan(0.5);
    // Another episode's lines single out no shift.
    const other = wideFit(indexFile(ep.duration, [ep.lines]), cues(unrelated(episode(303, { like: ep }).lines)))!;
    expect(other.margin).toBeLessThan(0.1);
  });

  it("syncs dub captions 45 s off, measured again around that shift", () => {
    const dub = dubCaptions(ep, 79);
    const far = farTiming(indexFile(ep.duration + recap, [fileLines]), cues(dub))!;
    expect(far).toBeDefined();
    expect(Math.abs(far.centre - recap)).toBeLessThanOrEqual(1000);
    expect(Math.abs(median(far.anchors.map((a) => a.offset)) - recap)).toBeLessThanOrEqual(300);
    expect(judge(indexFile(ep.duration + recap, [fileLines]), cues(dub)).far).toBeDefined();
  });

  it("leaves a shift the usual search reaches to the usual search", () => {
    expect(farTiming(indexFile(ep.duration, [ep.lines]), cues(shifted(faithful(ep.lines), 6000)))).toBeUndefined();
  });

  it("refuses another episode's subtitle, and a longer cut's", () => {
    const sibling = episode(303, { like: ep });
    expect(farTiming(indexFile(ep.duration, [ep.lines]), cues(shifted(unrelated(sibling.lines), 45000)))).toBeUndefined();
    // Scenes of 70, 80 and 90 s more: no one shift holds for most of the file.
    expect(farTiming(indexFile(ep.duration, [ep.lines]), cues(extendedCut(faithful(ep.lines), ep.cuts.slice(1), [70000, 80000, 90000], 146)))).toBeUndefined();
  });

  it("refuses a longer cut with one scene more after its cold open, whose cold open would go before the start", () => {
    const longer = cues(extendedCut(faithful(ep.lines), [ep.cuts[0]], [70000], 148));
    const record = indexFile(ep.duration, [ep.lines]);
    // Line starts single out -70 s, and every window after the cold open lands on it...
    const fit = wideFit(record, longer)!;
    expect(Math.abs(fit.offset - -70000)).toBeLessThanOrEqual(200);
    // ...but the cold open's lines would start before the file does.
    expect(farTiming(record, longer)).toBeUndefined();
    expect(judge(record, longer).verdict).not.toBe("synced");
  });
});
