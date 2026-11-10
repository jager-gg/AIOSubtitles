import { describe, expect, it } from "vitest";
import { type Cue, type FileAnchors, judge, sparseTrack, trackChoice } from "../src/sync.js";

/** Lines of uneven length and spacing, the way dialogue comes (deterministic, no randomness). */
function lines(from: number, to: number, seed: number): Cue[] {
  const cues: Cue[] = [];
  let at = from;
  let n = seed;
  while (at < to) {
    n = (n * 1103515245 + 12345) % 2147483648;
    const length = 900 + (n % 2600);
    const gap = 300 + ((n >> 8) % 2200);
    cues.push({ start: at, end: at + length });
    at += length + gap;
  }
  return cues;
}

const DURATION = 1_420_000;
const SPOTS = [0.15, 0.32, 0.5, 0.68, 0.85];
const captions = lines(0, 1_360_000, 7);
const shifted = (cues: Cue[], by: number) => cues.map((c) => ({ start: c.start + by, end: c.end + by }));
const inside = (cues: Cue[], from: number) => cues.filter((c) => c.start >= from && c.end <= from + 40000);

/** A file read at the usual spots: its first track's lines, and other text tracks' by index. */
function file(first: Cue[], others: Record<number, Cue[]> = {}): FileAnchors {
  const ids = Object.keys(others).map(Number);
  return {
    duration: DURATION,
    ...(ids.length ? { others: ids } : {}),
    windows: SPOTS.map((spot) => {
      const from = Math.round(DURATION * spot);
      return { from, to: from + 40000, cues: inside(first, from), others: Object.fromEntries(ids.map((id) => [String(id), inside(others[id], from)])) };
    })
  };
}

describe("which of the file's subtitle tracks to time by", () => {
  it("keeps the first track when it fits", () => {
    const found = file(shifted(captions, 600), { 5: shifted(captions, -3000) });
    expect(trackChoice(found, captions)).toBe("first");
    const verdict = judge(found, captions);
    expect(verdict.verdict).toBe("synced");
    for (const a of verdict.anchors) expect(Math.abs(a.offset - 600)).toBeLessThanOrEqual(60);
  });

  it("skips a first track with under half as many lines (an unlabelled signs track)", () => {
    const signs = shifted(captions, 600).filter((_, i) => i % 4 === 0);
    const found = file(signs, { 5: shifted(captions, 800) });
    expect(sparseTrack(file(signs), captions)).toBe(true);
    expect(trackChoice(found, captions)).toBe(5);
    const verdict = judge(found, captions);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.track).toBe(5);
    for (const a of verdict.anchors) expect(Math.abs(a.offset - 800)).toBeLessThanOrEqual(60);
  });

  it("tries the next track when the first doesn't fit", () => {
    const found = file(lines(0, 1_400_000, 4242), { 6: shifted(captions, -1500) });
    expect(trackChoice(found, captions)).toBe(6);
    expect(judge(found, captions)).toMatchObject({ verdict: "synced", track: 6 });
  });

  it("keeps the first track that isn't sparse when none fits yet, and none when all are sparse", () => {
    const other = lines(0, 1_400_000, 4242);
    expect(trackChoice(file(other, { 6: lines(0, 1_400_000, 99) }), captions)).toBe("first");
    const sparse = shifted(captions, 600).filter((_, i) => i % 4 === 0);
    expect(trackChoice(file(sparse, { 6: sparse }), captions)).toBeUndefined();
    expect(judge(file(sparse, { 6: sparse }), captions).verdict).not.toBe("synced");
  });

  it("counts a full track as full, whatever its shift", () => {
    expect(sparseTrack(file(shifted(captions, 15000)), captions)).toBe(false);
    // Two lines of it for three of the captions is still full.
    expect(sparseTrack(file(captions.filter((_, i) => i % 3 !== 0)), captions)).toBe(false);
  });
});
