import { describe, expect, it } from "vitest";
import { alignLines, lineShifts, longestUnpairedRun, sameDialogue, timingByLines, withoutStrays } from "../src/align.js";
import type { Cue } from "../src/sync.js";

/** A repeatable stand-in for chance. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Dialogue: lines of 0.8 to 4 s with pauses of 0.1 to 6 s, and now and then a long one. */
function dialogue(count: number, seed: number): Cue[] {
  const next = random(seed);
  const cues: Cue[] = [];
  let t = 30000;
  for (let i = 0; i < count; i++) {
    const length = 800 + Math.round(next() * 3200);
    cues.push({ start: t, end: t + length });
    t += length + 100 + Math.round(next() * (next() < 0.1 ? 40000 : 6000));
  }
  return cues;
}

/** The same lines as someone else timed them: each start off by a wandering amount, each length a little different. */
function retimedByHand(lines: Cue[], seed: number): Cue[] {
  const next = random(seed);
  let wander = -2500;
  return lines.map((l) => {
    wander += (next() - 0.47) * 900;
    const length = l.end - l.start + Math.round((next() - 0.5) * 500);
    const start = Math.round(l.start - wander);
    return { start, end: start + Math.max(400, length) };
  });
}

describe("timing a subtitle line by line", () => {
  const file = dialogue(400, 7);

  it("pairs the file's own dialogue however its timing wanders, and puts each line on its own", () => {
    const captions = retimedByHand(file, 11);
    const alignment = alignLines(captions, file);
    expect(alignment.captionShare).toBeGreaterThan(0.97);
    expect(sameDialogue(alignment, captions, file)).toBe(true);
    const timed = timingByLines(captions, file);
    expect(timed).toBeDefined();
    const landed = captions.map((c) => c.start + (timed!.shifts.get(c.start) ?? NaN));
    const exact = landed.filter((at, i) => at === file[i].start).length;
    expect(exact / captions.length).toBeGreaterThan(0.97);
  });

  it("copes with lines only one side has, and moves an unpaired line with its neighbours", () => {
    const captions = retimedByHand(file, 13);
    // A sign and a credit the file doesn't have; three lines of the file the subtitle merged away.
    const extra: Cue[] = [{ start: captions[50].end + 150, end: captions[50].end + 950 }, { start: captions[200].end + 120, end: captions[200].end + 2120 }];
    const withExtras = [...captions.filter((_, i) => ![120, 121, 300].includes(i)), ...extra].sort((a, b) => a.start - b.start);
    const timed = timingByLines(withExtras, file);
    expect(timed).toBeDefined();
    expect(longestUnpairedRun(timed!.alignment, withExtras.length)).toBeLessThanOrEqual(2);
    // Every caption has a shift, and they stay in order once moved.
    const moved = withExtras.map((c) => c.start + (timed!.shifts.get(c.start) as number));
    expect(moved.every((at) => Number.isFinite(at))).toBe(true);
    expect(moved.every((at, i) => i === 0 || at >= moved[i - 1])).toBe(true);
    // The extra sign sits between its neighbours' new times.
    const sign = withExtras.findIndex((c) => c.start === extra[0].start);
    expect(moved[sign]).toBeGreaterThan(moved[sign - 1]);
    expect(moved[sign]).toBeLessThan(moved[sign + 1]);
  });

  it("refuses another dialogue, however alike in length and pace", () => {
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const other = dialogue(400, seed);
      expect(timingByLines(other, file), `seed ${seed}`).toBeUndefined();
      // Shifted to start together, still another dialogue.
      const together = other.map((c) => ({ start: c.start - other[0].start + file[0].start, end: c.end - other[0].start + file[0].start }));
      expect(timingByLines(together, file), `seed ${seed}, aligned at the start`).toBeUndefined();
    }
  });

  it("refuses a subtitle that is the file's dialogue for only part of it", () => {
    const captions = retimedByHand(file, 31);
    // The first half is right; the second half is another dialogue.
    const second = dialogue(200, 41).map((c) => ({ start: c.start + captions[199].end, end: c.end + captions[199].end }));
    expect(timingByLines([...captions.slice(0, 200), ...second], file)).toBeUndefined();
    // A stretch of twenty lines missing from the file's track.
    const gapInFile = file.filter((_, i) => i < 150 || i >= 170);
    const timed = timingByLines(captions, gapInFile);
    expect(timed).toBeUndefined();
  });

  it("refuses when there is too little to go on", () => {
    const few = dialogue(40, 5);
    expect(timingByLines(retimedByHand(few, 6), few)).toBeUndefined();
    expect(timingByLines([], file)).toBeUndefined();
    expect(timingByLines(file, [])).toBeUndefined();
  });

  it("counts layered lines once and gives every layer the same shift", () => {
    const captions = retimedByHand(file, 17);
    const layered = [...captions, ...captions.slice(0, 50).map((c) => ({ ...c }))];
    const timed = timingByLines(layered, file);
    expect(timed).toBeDefined();
    expect(timed!.shifts.size).toBe(captions.length);
  });

  it("drops a pair that stands far from the pairs on both sides, and keeps a change that lasts", () => {
    const lines: Cue[] = Array.from({ length: 12 }, (_, k) => ({ start: 10000 + k * 4000, end: 11500 + k * 4000 }));
    // Captions 2 s late throughout, except that caption 5 was paired with a line 20 s off.
    const captions: Cue[] = lines.map((l) => ({ start: l.start + 2000, end: l.end + 2000 }));
    const pairs: Array<[number, number]> = lines.map((_, k) => [k, k]);
    pairs[5] = [5, 10];
    const stray = { pairs: pairs.filter(([, j], k) => k === 5 || j !== 10), captionShare: 1, lineShare: 1, lengthShare: 1, steadyShare: 1 };
    const cleaned = withoutStrays(stray, captions, lines);
    expect(cleaned.pairs.some(([i]) => i === 5)).toBe(false);
    expect(cleaned.pairs).toHaveLength(stray.pairs.length - 1);
    // Freed, it moves with its neighbours: 2 s.
    expect(lineShifts(captions, lines, cleaned).get(captions[5].start)).toBe(-2000);
    // A timing that changes by 8 s and stays there is kept whole.
    const stepped: Cue[] = lines.map((l, k) => ({ start: l.start + (k < 6 ? 2000 : -6000), end: l.end + (k < 6 ? 2000 : -6000) }));
    const whole = { pairs: lines.map((_, k) => [k, k] as [number, number]), captionShare: 1, lineShare: 1, lengthShare: 1, steadyShare: 1 };
    expect(withoutStrays(whole, stepped, lines).pairs).toHaveLength(12);
  });

  it("gives an unpaired line before the first pair, or after the last, its neighbour's shift", () => {
    const captions: Cue[] = [{ start: 1000, end: 2000 }, { start: 5000, end: 6000 }, { start: 9000, end: 10000 }];
    const lines: Cue[] = [{ start: 5400, end: 6400 }];
    const shifts = lineShifts(captions, lines, { pairs: [[1, 0]], captionShare: 1 / 3, lineShare: 1, lengthShare: 1, steadyShare: 1 });
    expect([...shifts.values()]).toEqual([400, 400, 400]);
  });
});
