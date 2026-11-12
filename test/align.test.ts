import { describe, expect, it } from "vitest";
import { alignLines, keptInOrder, lineShifts, linesOverShift, longestUnpairedRun, sameDialogue, timingByLines, withoutStrays } from "../src/align.js";
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
function dialogue(count: number, seed: number, from = 30000): Cue[] {
  const next = random(seed);
  const cues: Cue[] = [];
  let t = from;
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

describe("moving lines onto their own over a shift", () => {
  const file = dialogue(400, 7);
  /** The file's lines 2 s late, each a beat off on its own (within ±0.2 s), and drift(t) more. */
  const translated = (seed: number, drift: (t: number) => number = () => 0, lines = file) => {
    const next = random(seed);
    return lines.map((l) => {
      const by = 2000 + Math.round((next() - 0.5) * 400 + drift(l.start));
      return { start: l.start + by, end: l.end + by };
    });
  };
  /** The shift a shift per stretch found: the 2 s. */
  const shift = () => -2000;
  /** How many captions moved onto their own line (the line of the same index in `own`), and onto another. */
  const tally = (captions: Cue[], moves: Map<number, number>, own: Cue[] = file) => {
    let right = 0;
    let wrong = 0;
    captions.forEach((c, i) => {
      const d = moves.get(c.start);
      if (d === undefined) return;
      if (c.start + d === own[i].start) right++;
      else wrong++;
    });
    return { right, wrong };
  };

  it("puts a subtitle that creeps between its cuts onto its own lines, where the shift is up to 0.6 s off", () => {
    // Running slow by 0.4 s a minute, back on time every 3 minutes: -0.6 to +0.6 s around the shift.
    const captions = translated(41, (t) => (((t - 30000) % 180000) / 180000) * 1200 - 600);
    const over = linesOverShift(captions, file, shift);
    expect(over).toBeDefined();
    const { right, wrong } = tally(captions, over!.moves);
    expect(right / captions.length).toBeGreaterThan(0.95);
    expect(wrong).toBe(0);
  });

  it("follows a drift past a second, out from the lines it confirmed first", () => {
    // The shift is right at the start and 1.8 s off by the end.
    const span = file[file.length - 1].start - file[0].start;
    const captions = translated(43, (t) => ((t - file[0].start) / span) * 1800);
    const over = linesOverShift(captions, file, shift)!;
    const { right, wrong } = tally(captions, over.moves);
    expect(right / captions.length).toBeGreaterThan(0.95);
    expect(wrong).toBe(0);
    // The last tenth too, 1.6 to 1.8 s off the shift: only the second pass reaches it.
    const late = captions.slice(360);
    expect(tally(late, over.moves, file.slice(360)).right / late.length).toBeGreaterThan(0.9);
  });

  it("doesn't move a line whose own line the file's track lacks onto its neighbour's", () => {
    for (const seed of [7, 8, 9, 10]) {
      const own = dialogue(400, seed);
      const captions = translated(seed + 100, () => 0, own);
      // Every 25th line isn't on the file's track: the pairing gives one or two of their captions a neighbour's line.
      const track = own.filter((_, i) => i % 25 !== 12);
      const alignment = withoutStrays(alignLines(captions, track), captions, track);
      expect(alignment.pairs.some(([i, j]) => track[j].start !== own[i].start), `seed ${seed}: no wrong pair to hold back`).toBe(true);
      const { right, wrong } = tally(captions, linesOverShift(captions, track, shift)!.moves, own);
      expect(wrong, `seed ${seed}`).toBe(0);
      expect(right / captions.length, `seed ${seed}`).toBeGreaterThan(0.9);
    }
  });

  it("holds back a run of pairs one line off, where a line is missing in quick exchange", () => {
    for (const seed of [4, 7]) {
      // Lines of 1.4 to 1.6 s every 1.7 s or so between two stretches of usual dialogue: rhythm can't tell them apart.
      const first = dialogue(150, seed);
      const next = random(seed + 9);
      const quick: Cue[] = [];
      let t = first[first.length - 1].end + 2000;
      for (let i = 0; i < 40; i++) {
        const length = 1400 + Math.round(next() * 200);
        quick.push({ start: t, end: t + length });
        t += length + 250 + Math.round(next() * 100);
      }
      const own = [...first, ...quick, ...dialogue(150, seed + 1, t + 3000)];
      const captions = translated(seed + 100, () => 0, own);
      // The file's track lacks one line of the exchange: the pairing takes every line after it one line late.
      const track = own.filter((_, i) => i !== 155);
      const alignment = withoutStrays(alignLines(captions, track), captions, track);
      expect(alignment.pairs.filter(([i, j]) => track[j].start !== own[i].start).length, `seed ${seed}`).toBeGreaterThanOrEqual(10);
      expect(tally(captions, linesOverShift(captions, track, shift)!.moves, own).wrong, `seed ${seed}`).toBe(0);
    }
  });

  it("leaves a stretch that isn't the file's dialogue alone, beyond what snapping would move", () => {
    for (const seed of [7, 8, 9]) {
      const own = translated(seed);
      // Captions 150 to 249 are another dialogue over the same stretch.
      const other = dialogue(200, seed + 50, own[150].start).filter((c) => c.end < own[249].end);
      const captions = [...own.slice(0, 150), ...other, ...own.slice(250)];
      const over = linesOverShift(captions, file, shift)!;
      const strays = other.filter((c) => over.moves.has(c.start));
      expect(strays.length, `seed ${seed}`).toBeLessThanOrEqual(1);
      for (const c of strays) expect(Math.abs(over.moves.get(c.start)! + 2000), `seed ${seed}`).toBeLessThanOrEqual(300);
      expect(tally(own, over.moves).wrong, `seed ${seed}`).toBe(0);
    }
  });

  it("moves nothing when there is too little to go on, and moves the layers of a line together", () => {
    const few = dialogue(40, 5);
    expect(linesOverShift(few, few, () => 0)).toBeUndefined();
    const captions = translated(47);
    const layered = [...captions, ...captions.slice(0, 50).map((c) => ({ ...c }))];
    const over = linesOverShift(layered, file, shift)!;
    // One move per start, shared by its layers.
    expect(over.moves.size).toBeLessThanOrEqual(captions.length);
    expect(over.moves.size / captions.length).toBeGreaterThan(0.95);
  });
});

describe("keeping lines that move one by one in order and apart", () => {
  const cue = (start: number, end = start + 800): Cue => ({ start, end });
  const none = () => 0;
  const landed = (captions: Cue[], kept: { shift: (start: number) => number }) => captions.map((c) => c.start + kept.shift(c.start));
  const moving = (moves: Array<[number, number]>, rest: (start: number) => number = none) => {
    const map = new Map(moves);
    return { shift: (s: number) => map.get(s) ?? rest(s), fixed: new Set(map.keys()) };
  };

  it("moves a line that would pass a moved neighbour, or come within half a second of it, along with it", () => {
    const captions = [cue(10000), cue(11000), cue(12500), cue(20000)];
    // The first moved 1.6 s later onto its line: the second would start before it, the third 0.1 s after it.
    const later = moving([[10000, 1600]]);
    expect(landed(captions, keptInOrder(captions, later.shift, later.fixed, none))).toEqual([11600, 12600, 14100, 20000]);
    // The third moved 1.8 s earlier: the lines before it move back with it.
    const sooner = moving([[12500, -1800]]);
    expect(landed(captions, keptInOrder(captions, sooner.shift, sooner.fixed, none))).toEqual([8200, 9200, 10700, 20000]);
  });

  it("puts the lines between two moved lines in proportion when moving with a neighbour isn't enough", () => {
    const captions = [cue(10000), cue(10500), cue(11000), cue(11500)];
    // The first moved 0.8 s later, the last 0.4 s earlier: they now land 0.3 s apart.
    const both = moving([[10000, 800], [11500, -400]]);
    expect(landed(captions, keptInOrder(captions, both.shift, both.fixed, none))).toEqual([10800, 10900, 11000, 11100]);
  });

  it("leaves lines the shift already put out of order as they were", () => {
    // A shift that steps back 3 s in a 1 s pause: the line after the step starts before the one before it.
    const captions = [cue(10000), cue(11000), cue(12000), cue(30000)];
    const stepped = (s: number) => (s >= 11500 ? -3000 : 0);
    const one = moving([[30000, 400]], stepped);
    expect(landed(captions, keptInOrder(captions, one.shift, one.fixed, stepped))).toEqual([10000, 11000, 9000, 30400]);
  });

  it("ends a line where a moved line now starts, and keeps overlaps no larger than they were", () => {
    const captions = [cue(10000, 11800), cue(12000, 13000), cue(14000, 16000), cue(15000, 15800)];
    // The second line moved 0.5 s earlier, into the end of the first.
    const second = moving([[12000, -500]]);
    const kept = keptInOrder(captions, second.shift, second.fixed, none);
    expect(kept.end(10000, 11800)).toBe(11500);
    expect(kept.end(12000, 13000)).toBe(12500);
    // Written overlapping (two people at once): left as written.
    expect(kept.end(14000, 16000)).toBe(16000);
    // The line inside it moved 0.3 s earlier: the overlap stays the 1 s it was.
    const inside = moving([[15000, -300]]);
    expect(keptInOrder(captions, inside.shift, inside.fixed, none).end(14000, 16000)).toBe(15700);
  });
});
