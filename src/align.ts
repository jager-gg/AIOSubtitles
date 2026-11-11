/**
 * Lining a subtitle up with the file's own lines one by one.
 *
 * A shift per stretch of the file (sync.ts) fits a subtitle made for another cut. It can't fit one
 * timed by hand to another recording, where every line sits a little differently: a Dutch subtitle
 * timed to a cinema recording needed anything from -2.7 to +9.2 s on the web release of the same
 * film, moving back and forth through it. But it was the same dialogue, line for line (413 lines
 * against the file's 411), and then nothing has to be measured: each line takes the start of the
 * file's line it corresponds to.
 *
 * Which line corresponds to which is read from the rhythm. Two timings of the same dialogue differ
 * in where a line starts, far less in how long the pause to the next line is and how long a line
 * lasts. The two lists are aligned in order, as two texts are compared: pairing two lines costs how
 * much their pause since the previous pair and their lengths differ, and a line on either side may
 * be left out at a fixed cost (a line split in two, a sign, a credit).
 *
 * This needs every line of the file, so it only applies to files timed from their index (mkv.ts).
 */
import type { Cue } from "./sync.js";

export interface Alignment {
  /** Caption index to file line index, for the captions that were paired. */
  pairs: Array<[number, number]>;
  /** Share of the captions that found a line, and of the file's lines that were used. */
  captionShare: number;
  lineShare: number;
  /** Share of paired lines that last within LENGTH_CLOSE_MS of their file line. */
  lengthShare: number;
  /** Share of steps from one paired line to the next where the shift moves by under STEADY_MS. */
  steadyShare: number;
}

/** Leaving a line out, in ms of mismatch: a pause off by more than this is better explained by a skipped line. */
const SKIP_COST = 1500;
/** A pause can't count against a pair for more than this (a scene break differs by any amount). */
const MAX_PAUSE_COST = 4000;
const MAX_LENGTH_COST = 2000;
/** Lengths weigh less than pauses: translators merge and split lines. */
const LENGTH_WEIGHT = 0.25;
const LENGTH_CLOSE_MS = 1000;
const STEADY_MS = 2000;

/** The captions paired with the file's lines, in order. Both lists sorted by start. */
export function alignLines(captions: Cue[], lines: Cue[]): Alignment {
  const n = captions.length;
  const m = lines.length;
  const none: Alignment = { pairs: [], captionShare: 0, lineShare: 0, lengthShare: 0, steadyShare: 0 };
  if (n === 0 || m === 0) return none;
  const width = m + 1;
  // How each cell was reached: 1 a caption left out, 2 a file line left out, 3 the two paired.
  const from = new Uint8Array((n + 1) * width);
  let row = new Float64Array(width).fill(Infinity);
  row[0] = 0;
  for (let j = 1; j <= m; j++) {
    row[j] = row[j - 1] + SKIP_COST;
    from[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    const next = new Float64Array(width).fill(Infinity);
    next[0] = row[0] + SKIP_COST;
    from[i * width] = 1;
    const caption = captions[i - 1];
    const captionGap = i > 1 ? caption.start - captions[i - 2].start : 0;
    const captionLength = caption.end - caption.start;
    for (let j = 1; j <= m; j++) {
      const line = lines[j - 1];
      const pause = i > 1 && j > 1 ? Math.min(Math.abs(captionGap - (line.start - lines[j - 2].start)), MAX_PAUSE_COST) : 0;
      const length = Math.min(Math.abs(captionLength - (line.end - line.start)), MAX_LENGTH_COST) * LENGTH_WEIGHT;
      let best = row[j - 1] + pause + length;
      let how = 3;
      if (row[j] + SKIP_COST < best) (best = row[j] + SKIP_COST), (how = 1);
      if (next[j - 1] + SKIP_COST < best) (best = next[j - 1] + SKIP_COST), (how = 2);
      next[j] = best;
      from[i * width + j] = how;
    }
    row = next;
  }
  const pairs: Array<[number, number]> = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const how = from[i * width + j];
    if (how === 3) pairs.push([--i, --j]);
    else if (how === 1) i--;
    else j--;
  }
  pairs.reverse();
  if (pairs.length === 0) return none;
  const shifts = pairs.map(([i, j]) => lines[j].start - captions[i].start);
  let steady = 0;
  for (let k = 1; k < shifts.length; k++) if (Math.abs(shifts[k] - shifts[k - 1]) <= STEADY_MS) steady++;
  const close = pairs.filter(([i, j]) => Math.abs(captions[i].end - captions[i].start - (lines[j].end - lines[j].start)) <= LENGTH_CLOSE_MS).length;
  return {
    pairs,
    captionShare: pairs.length / n,
    lineShare: pairs.length / m,
    lengthShare: close / pairs.length,
    steadyShare: shifts.length > 1 ? steady / (shifts.length - 1) : 1
  };
}

// ---------- when an alignment is trusted, and the timing it gives ----------

/** Fewer lines than this on either side is too little rhythm to tell dialogues apart. */
const MIN_LINES = 60;
/**
 * What an alignment must reach to be used. Over the stored plays (56 pairs of a file
 * with a subtitle of its own dialogue, 4,573 with another episode's, show's or film's), no wrong
 * pair came near all three: their steadiest reached 0.81 and none passed 0.80 on lengths at the
 * same time, while the subtitle this was built for scored 0.95, 0.97 and 0.97. A subtitle cached
 * under the wrong episode number passed on the episode it really was.
 */
const MIN_CAPTION_SHARE = 0.9;
const MIN_LENGTH_SHARE = 0.85;
const MIN_STEADY_SHARE = 0.9;
/** More captions than this in a row without a line: a stretch of the subtitle isn't in the file. */
const MAX_UNPAIRED_RUN = 8;
/** No real pair sits further apart than this. */
const MAX_SHIFT_MS = 5 * 60 * 1000;

/** A pair this far from the pairs on both sides of it is a mispairing, not a line. */
const STRAY_MS = 5000;

/**
 * The alignment without its strays: a pair whose shift stands more than STRAY_MS from the pair
 * before it and from the pair after it (or from its only neighbour, at either end). The pairing
 * goes by rhythm, and now and then a line's rhythm fits a line far off better than its own: on the
 * film this was built on, one line of 413 was put 22 s early between neighbours 1 to 2 s early. A
 * real change of timing holds for the lines after it, so it has a neighbour that agrees. The
 * captions freed this way are left out and move with their neighbours.
 */
export function withoutStrays(alignment: Alignment, captions: Cue[], lines: Cue[]): Alignment {
  let pairs = alignment.pairs;
  for (let pass = 0; pass < 3; pass++) {
    const shifts = pairs.map(([i, j]) => lines[j].start - captions[i].start);
    const far = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) > STRAY_MS;
    const kept = pairs.filter((_, k) => pairs.length < 2 || !(far(shifts[k - 1], shifts[k]) && far(shifts[k + 1], shifts[k])));
    if (kept.length === pairs.length) break;
    pairs = kept;
  }
  if (pairs.length === alignment.pairs.length) return alignment;
  const shifts = pairs.map(([i, j]) => lines[j].start - captions[i].start);
  let steady = 0;
  for (let k = 1; k < shifts.length; k++) if (Math.abs(shifts[k] - shifts[k - 1]) <= STEADY_MS) steady++;
  const close = pairs.filter(([i, j]) => Math.abs(captions[i].end - captions[i].start - (lines[j].end - lines[j].start)) <= LENGTH_CLOSE_MS).length;
  return {
    pairs,
    captionShare: pairs.length / captions.length,
    lineShare: pairs.length / lines.length,
    lengthShare: pairs.length ? close / pairs.length : 0,
    steadyShare: shifts.length > 1 ? steady / (shifts.length - 1) : 1
  };
}

/** The longest run of captions in a row that found no line. */
export function longestUnpairedRun(alignment: Alignment, captions: number): number {
  const paired = new Set(alignment.pairs.map(([i]) => i));
  let run = 0;
  let longest = 0;
  for (let i = 0; i < captions; i++) {
    run = paired.has(i) ? 0 : run + 1;
    if (run > longest) longest = run;
  }
  return longest;
}

/** Whether the two lists are the same dialogue, surely enough to retime one by the other. */
export function sameDialogue(alignment: Alignment, captions: Cue[], lines: Cue[]): boolean {
  if (captions.length < MIN_LINES || lines.length < MIN_LINES) return false;
  if (alignment.captionShare < MIN_CAPTION_SHARE || alignment.lengthShare < MIN_LENGTH_SHARE || alignment.steadyShare < MIN_STEADY_SHARE) return false;
  if (longestUnpairedRun(alignment, captions.length) > MAX_UNPAIRED_RUN) return false;
  return alignment.pairs.every(([i, j]) => Math.abs(lines[j].start - captions[i].start) <= MAX_SHIFT_MS);
}

/**
 * The shift for every caption start: a paired caption moves onto its file line; one left out moves
 * with its neighbours (between two paired captions, in proportion to where it sits between them).
 */
export function lineShifts(captions: Cue[], lines: Cue[], alignment: Alignment): Map<number, number> {
  const shifts = new Map<number, number>();
  const known = alignment.pairs.map(([i, j]) => ({ at: captions[i].start, shift: lines[j].start - captions[i].start }));
  for (const k of known) shifts.set(k.at, k.shift);
  let next = 0;
  for (const caption of captions) {
    if (shifts.has(caption.start)) continue;
    while (next < known.length && known[next].at < caption.start) next++;
    const before = known[next - 1];
    const after = known[next];
    let shift = 0;
    if (before && after) shift = before.shift + ((after.shift - before.shift) * (caption.start - before.at)) / Math.max(1, after.at - before.at);
    else if (before) shift = before.shift;
    else if (after) shift = after.shift;
    shifts.set(caption.start, Math.round(shift));
  }
  return shifts;
}

/**
 * The captions' timing by the file's lines, or undefined when they aren't surely the same dialogue.
 * Captions sharing a start (layers of one line) count once.
 */
export function timingByLines(captions: Cue[], lines: Cue[]): { shifts: Map<number, number>; alignment: Alignment } | undefined {
  const once: Cue[] = [];
  for (const caption of [...captions].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (once.length === 0 || once[once.length - 1].start !== caption.start) once.push(caption);
  }
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  const alignment = withoutStrays(alignLines(once, sorted), once, sorted);
  if (!sameDialogue(alignment, once, sorted)) return undefined;
  return { shifts: lineShifts(once, sorted, alignment), alignment };
}
