import { describe, expect, it } from "vitest";
import { followShifts, inOrder, meetStarts, placeSteps, planShifts, stepByStarts, timingByStarts, type Anchor, type Cue, type FileAnchors } from "../src/sync.js";

/** Dialogue of uneven lines and pauses from `from` to `to`, the same on every run. */
function dialogue(from: number, to: number, seed = 1): Cue[] {
  const cues: Cue[] = [];
  let n = seed;
  let at = from + 500;
  for (;;) {
    n = (n * 1103515245 + 12345) % 2147483648;
    const length = 900 + (n % 2600);
    const pause = 250 + ((n >> 8) % 1800);
    if (at + length > to) break;
    cues.push({ start: at, end: at + length });
    at += length + pause;
  }
  return cues;
}

/**
 * The file's lines as a translation for another release has them: each written `need(start)` early
 * (so that is the shift it needs), and held 700 ms longer than the file's, as translators often do.
 */
const translated = (lines: Cue[], need: (t: number) => number, jitter = (_i: number) => 0) =>
  lines.map((l, i) => ({ start: l.start - need(l.start) + jitter(i), end: l.end - need(l.start) + 700 }));

/** A beat off for line i, within ±spread ms, mostly well inside it: the same on every run. */
const beat = (spread: number, seed: number) => (i: number) => {
  let n = (i + 1) * 2654435761 + seed * 97;
  n = (n ^ (n >>> 13)) * 1274126177;
  const u = ((n >>> 0) % 10007) / 10007;
  const v = ((n >>> 7) % 10009) / 10009;
  return Math.round((u + v - 1) * spread);
};

/** A minute window of the file with the shift its overlap read there. */
const minute = (m: number, offset: number): Anchor => ({ from: m * 60000, to: (m + 1) * 60000, offset, score: 0.9 });

/** Share of the captions served within `ms` of the file line each belongs to. */
function within(lines: Cue[], captions: Cue[], shift: (start: number) => number, ms: number): number {
  const close = captions.filter((c, i) => Math.abs(c.start + shift(c.start) - lines[i].start) <= ms).length;
  return close / captions.length;
}

describe("a window's shift by where its lines start", () => {
  const lines = dialogue(600000, 660000).map((l) => l.start);
  const starts = lines.map((t) => t - 1300);

  it("finds where the line starts meet, near the shift measured", () => {
    const met = meetStarts(lines, starts, () => 1000);
    expect(met?.correction).toBe(300);
    expect(met?.met).toBe(lines.length);
    // The shift may change from line to line.
    const stepped = lines.map((t) => t - (t < 630000 ? 1300 : 1400));
    expect(meetStarts(lines, stepped, (t) => (t < 630000 ? 1000 : 1100))?.correction).toBe(300);
  });

  it("finds nothing with too few lines, or where no shift near makes them meet", () => {
    expect(meetStarts(lines.slice(0, 3), starts, () => 1300)).toBeUndefined();
    const elsewhere = dialogue(600000, 660000, 77).map((l) => l.start - 1300);
    expect(meetStarts(lines, elsewhere, () => 1300)).toBeUndefined();
  });
});

describe("following a translation's shift through the file", () => {
  it("takes a stretch's shift from where all of its lines start, not from the windows' overlap", () => {
    const lines = dialogue(0, 900000);
    const captions = translated(lines, () => 1300);
    // Lines held longer read late by overlap, a few hundred ms off and differently in each window.
    const anchors = [1550, 1700, 1450, 1800, 1600, 1500, 1750, 1650, 1600, 1450, 1800, 1550, 1700, 1500, 1650].map((offset, m) => minute(m, offset));
    const { shift, anchors: served, byStarts } = followShifts(anchors, captions, lines);
    expect(byStarts).toBe(true);
    expect(within(lines, captions, shift, 20)).toBe(1);
    expect(served.every((a) => Math.abs(a.offset - 1300) <= 20)).toBe(true);
    // A median of the windows, as before, serves most lines more than 0.1 s off.
    expect(within(lines, captions, planShifts(anchors, captions, lines), 100)).toBeLessThan(0.5);
  });

  it("follows a shift that creeps through a stretch", () => {
    const lines = dialogue(0, 900000);
    // Running a touch slow: 0.2 s more every minute, 3 s over the stretch.
    const need = (t: number) => 2000 + (200 * t) / 60000;
    const captions = translated(lines, need);
    const anchors = Array.from({ length: 15 }, (_, m) => minute(m, Math.round(need(m * 60000 + 30000)) + (m % 2 ? 150 : -150)));
    const { shift } = followShifts(anchors, captions, lines);
    expect(within(lines, captions, shift, 50)).toBeGreaterThan(0.99);
    // Every window within 0.5 s of the next: one median for all of it.
    expect(within(lines, captions, planShifts(anchors, captions, lines), 300)).toBeLessThan(0.3);
  });

  it("doesn't let a window across a step join the shifts on either side into one", () => {
    const lines = dialogue(0, 900000, 5);
    // The release is cut in a pause near 9:30: before it, lines need 4.95 s; after, 5.94 s.
    const cut = lines.find((l, i) => l.start > 565000 && lines[i - 1] && l.start - lines[i - 1].end > 1000)!.start - 200;
    const need = (t: number) => (t < cut ? 4950 : 5940);
    const captions = translated(lines, need);
    // The window holding the cut reads in between, within 0.5 s of both neighbours.
    const anchors = [...Array.from({ length: 9 }, (_, m) => minute(m, 4950)), minute(9, 5440), ...Array.from({ length: 5 }, (_, m) => minute(10 + m, 5940))];
    const { shift } = followShifts(anchors, captions, lines);
    expect(within(lines, captions, shift, 50)).toBeGreaterThan(0.98);
    // As one stretch with one median, every line on one side of the cut is half a second off or more.
    expect(within(lines, captions, planShifts(anchors, captions, lines), 300)).toBeLessThan(0.7);
  });

  it("joins again a stretch cut off by one window that has too few lines to fit", () => {
    const all = dialogue(0, 600000, 21);
    // The file's track has only three lines in minute 5, whose overlap read 0.7 s off.
    const lines = all.filter((l) => l.start < 300000 || l.start >= 360000 || l.start < 309000);
    expect(lines.filter((l) => l.start >= 300000 && l.start < 360000).length).toBeLessThan(4);
    const captions = translated(all, () => 1300);
    const anchors = Array.from({ length: 10 }, (_, m) => minute(m, m === 5 ? 2000 : 1300));
    const { shift, anchors: served } = followShifts(anchors, captions, lines);
    expect(served.map((a) => a.offset)).toEqual(Array(10).fill(1300));
    expect(within(all, captions, shift, 20)).toBe(1);
  });

  it("keeps one shift where only a few of each window's lines meet, rather than follow their noise", () => {
    const lines = dialogue(0, 900000, 3);
    // A translation timed loosely: every line its own beat off, up to 0.7 s, so that only about a
    // quarter of each window's lines start within 0.12 s of the file's at the true shift (1.3 s).
    const captions = translated(lines, () => 1300, beat(700, 3));
    const anchors = Array.from({ length: 15 }, (_, m) => minute(m, 1300 + beat(300, 8)(m)));
    const { shift, anchors: served } = followShifts(anchors, captions, lines);
    // Each window's own fit is a few hundred ms off, differently in each: a step or a slope through
    // them fits that noise (it served 1.16 to 1.71 s). One shift for all of it is right.
    expect(new Set(served.map((a) => a.offset)).size).toBe(1);
    expect(Math.abs(served[0].offset - 1300)).toBeLessThanOrEqual(50);
    expect(within(lines, captions, shift, 300)).toBeGreaterThanOrEqual(within(lines, captions, () => 1300, 300) - 0.02);
  });

  it("joins a stretch whose lines don't meet to the neighbour its overlap lands on, not to one a few of its lines meet by chance", () => {
    // A scene change at 8:00 where the release is cut: lines need 5.0 s before it, 7.7 s after.
    const lines = [...dialogue(0, 476000, 31), ...dialogue(484000, 960000, 32)];
    const need = (t: number) => (t < 480000 ? 5000 : 7700);
    // In minutes 8 and 9 the translation's lines each sit their own way off, none within 0.2 s of its
    // own line, and two of them happen to sit where the earlier shift would put them.
    const inTwo = (t: number) => t >= 480000 && t < 600000;
    const scatter = [900, -900, 1300, -1300, 1700, -1700];
    let k = 0;
    const off = (t: number) => (!inTwo(t) ? 0 : ++k === 5 || k === 11 ? 2700 : scatter[k % scatter.length]);
    const captions = lines.map((l) => ({ start: l.start - need(l.start) + off(l.start), end: l.end - need(l.start) + 700 }));
    // Their overlap read them near the later shift, just over 0.5 s from it.
    const anchors = Array.from({ length: 16 }, (_, m) => minute(m, m < 8 ? 5000 : m === 8 ? 7100 : m === 9 ? 7150 : 7700));
    const { shift, anchors: served } = followShifts(anchors, captions, lines);
    expect(served.map((a) => a.offset)).toEqual([...Array(8).fill(5000), ...Array(8).fill(7700)]);
    // Its lines can't say where in it the step goes (it took the middle of the pauses they tie on),
    // but most of them take the later shift; joined to the earlier one, all but one were 2.7 s off.
    const two = captions.filter((_, i) => inTwo(lines[i].start));
    expect(two.filter((c) => shift(c.start) === 7700).length).toBeGreaterThan(two.length / 2);
  });

  it("steps at the pause after which the lines start at the new shift, not at a longer one before it", () => {
    const lines = [...dialogue(0, 100000, 9), ...dialogue(112000, 160000, 10), ...dialogue(166000, 240000, 11)];
    // The cut is at the 6 s pause; the 12 s one before it is only a scene change.
    const need = (t: number) => (t < 163000 ? 1000 : 3000);
    const captions = translated(lines, need);
    const starts = captions.map((c) => c.start).sort((a, b) => a - b);
    const at = stepByStarts(minute(1, 1000), minute(2, 3000), captions, lines.map((l) => l.start), starts);
    expect(at).toBeGreaterThan(160000 - 1000);
    expect(at).toBeLessThan(166000 - 3000);
  });

  it("keeps the timing it was given where the file's lines don't meet it, and says so", () => {
    // Timing heard in speech is taken from the lines only when they confirm it (syncCaptions).
    const lines = dialogue(0, 600000);
    const captions = translated(dialogue(0, 600000, 33), () => 1000);
    const followed = followShifts(Array.from({ length: 10 }, (_, m) => minute(m, 1000)), captions, lines);
    expect(followed.byStarts).toBe(false);
    expect(followed.anchors.map((a) => a.offset)).toEqual(Array(10).fill(1000));
    expect(captions.every((c) => followed.shift(c.start) === 1000)).toBe(true);
  });

  it("takes timing heard in speech from the file's lines only when they meet it", () => {
    const lines = dialogue(0, 1200000, 41);
    const captions = translated(lines, () => -2800);
    // Speech windows at the usual spots, heard 180 ms early (a line shows a beat before its voice).
    const heard = [180000, 384000, 600000, 816000, 1020000].map((from) => ({ from, to: from + 40000, offset: -2980, score: 0.6 }));
    const followed = timingByStarts(heard, captions, lines, true);
    expect(followed?.anchors.every((a) => Math.abs(a.offset - -2800) <= 10)).toBe(true);
    expect(within(lines, captions, followed!.shift, 20)).toBe(1);
    // Another dialogue on the track: the timing heard stays (undefined: planShifts).
    expect(timingByStarts(heard, captions, dialogue(0, 1200000, 42), true)).toBeUndefined();
    // Timing that fits the track is always taken from its lines; nothing to take it from without lines.
    expect(timingByStarts(heard, captions, dialogue(0, 1200000, 42), false)).toBeDefined();
    expect(timingByStarts(heard, captions, [], false)).toBeUndefined();
  });

  it("given the file, keeps the plan when the timing taken from its lines no longer accounts for the whole of it", () => {
    const lines = dialogue(0, 600000, 51);
    const captions = translated(lines, () => 1000);
    const anchors = Array.from({ length: 10 }, (_, m) => minute(m, 1000));
    const file: FileAnchors = { duration: 600000, windows: anchors.map((a) => ({ from: a.from, to: a.to, cues: lines.filter((l) => l.start >= a.from && l.start < a.to) })), source: "index" };
    expect(timingByStarts(anchors, captions, lines, false, file)).toBeDefined();
    // A file said to end halfway through these lines: the timing puts half of them past its end, so
    // it isn't served (undefined: the plan the checks judged is).
    expect(timingByStarts(anchors, captions, lines, false, { ...file, duration: 300000 })).toBeUndefined();
  });

  it("never lets a shift that changes from line to line put a line before the one ahead of it, nor over it", () => {
    const captions: Cue[] = [
      { start: 8000, end: 9000 },
      { start: 9000, end: 9900 },
      { start: 9900, end: 11000 },
      { start: 11100, end: 12000 }
    ];
    // A shift that creeps earlier by 40 ms a line, the lines written end to end.
    const held = inOrder(captions, (start) => (start < 9000 ? 0 : start < 9900 ? -40 : -80));
    const served = captions.map((c) => ({ start: c.start + held(c.start), end: c.end + held(c.start) }));
    for (let i = 1; i < served.length; i++) expect(served[i].start).toBeGreaterThanOrEqual(served[i - 1].end);
    // Where the pause has room for it, the shift is made in full.
    expect(held(11100)).toBe(-80);
  });

  it("leaves a step back larger than its pause to the step, without pushing the lines after it", () => {
    // A step 4 s back placed in a 1.5 s pause, and five lines after it 0.6 s apart. Held in order,
    // they were pushed 2.5, 1.9, 1.3, 0.7 and 0.1 s late, one after another.
    const captions: Cue[] = [
      { start: 8000, end: 12000 },
      { start: 13500, end: 14900 },
      { start: 15500, end: 16900 },
      { start: 17500, end: 18900 },
      { start: 19500, end: 20900 },
      { start: 21500, end: 22900 },
      { start: 23500, end: 24900 }
    ];
    const held = inOrder(captions, (start) => (start < 13000 ? 0 : -4000));
    expect(captions.map((c) => held(c.start))).toEqual([0, -4000, -4000, -4000, -4000, -4000, -4000]);
  });

  it("keeps the steps either side of a one-window stretch in order", () => {
    // Lines every 5 s that all meet at shift 0, and a stretch of one window between two others read
    // 3 s off: each step, looked for across that whole window, would take all of it for its outer
    // neighbour, the one after it before the one ahead of it.
    const captions: Cue[] = Array.from({ length: 60 }, (_, k) => ({ start: k * 5000, end: k * 5000 + 1000 }));
    const starts = captions.map((c) => c.start);
    const at = (from: number, offset: number): Anchor => ({ from, to: from + 60000, offset, score: 1 });
    const stretches = [
      { first: at(0, 0), last: at(60000, 0) },
      { first: at(120000, 3000), last: at(120000, 3000) },
      { first: at(180000, 0), last: at(240000, 0) }
    ];
    const unordered = [stepByStarts(stretches[0].last, stretches[1].first, captions, starts, starts), stepByStarts(stretches[1].last, stretches[2].first, captions, starts, starts)];
    expect(unordered[1]).toBeLessThan(unordered[0]);
    // Placed again, each on its own half of the window: the stretch between keeps lines of its own.
    const bounds = placeSteps(stretches, captions, starts, starts);
    expect(bounds[0]).toBeLessThan(bounds[1]);
    expect(bounds[0]).toBeLessThanOrEqual(150000);
    expect(bounds[1]).toBeGreaterThanOrEqual(150000 - 3000);
  });
});
