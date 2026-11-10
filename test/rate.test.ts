import { describe, expect, it } from "vitest";
import { type Cue, type FileAnchors, RATE_FACTORS, judge, retime, scaleCues } from "../src/sync.js";

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

const SPOTS = [0.15, 0.32, 0.5, 0.68, 0.85];
const DURATION = 1_420_000;

/** The file's own subtitle track, read at the usual five spots. */
function fileWith(track: Cue[]): FileAnchors {
  return {
    duration: DURATION,
    windows: SPOTS.map((spot) => {
      const from = Math.round(DURATION * spot);
      return { from, to: from + 40000, cues: track.filter((c) => c.start >= from && c.end <= from + 40000) };
    })
  };
}

const PAL_ON_FILM = 25 / (24000 / 1001);
const written = lines(0, 1_360_000, 7);

describe("subtitles made for another frame rate", () => {
  it("rescales a 25 fps subtitle on a 23.976 fps file and syncs it", () => {
    // As played, every line lands 4.3% later than written, plus 0.6 s.
    const track = written.map((c) => ({ start: Math.round(c.start * PAL_ON_FILM) + 600, end: Math.round(c.end * PAL_ON_FILM) + 600 }));
    const verdict = judge(fileWith(track), written);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeCloseTo(PAL_ON_FILM, 6);
    expect(verdict.anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of verdict.anchors) expect(Math.abs(anchor.offset - 600)).toBeLessThanOrEqual(60);
  });

  it("rescales the slow drift of 24 against 23.976 fps", () => {
    const factor = 24 / (24000 / 1001);
    const track = written.map((c) => ({ start: Math.round(c.start * factor) - 300, end: Math.round(c.end * factor) - 300 }));
    const verdict = judge(fileWith(track), written);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeCloseTo(factor, 6);
  });

  it("leaves captions alone when they already fit at one shift", () => {
    const track = written.map((c) => ({ start: c.start + 1200, end: c.end + 1200 }));
    const verdict = judge(fileWith(track), written);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeUndefined();
  });

  it("keeps a real step as a step, not a drift", () => {
    // A cut halfway: +0.4 s before it, +3.4 s after.
    const track = written.map((c) => {
      const d = c.start < 700_000 ? 400 : 3400;
      return { start: c.start + d, end: c.end + d };
    });
    expect(judge(fileWith(track), written).factor).toBeUndefined();
  });

  it("finds no rate for another episode's captions", () => {
    const track = lines(0, 1_360_000, 4242);
    const verdict = judge(fileWith(track), written);
    expect(verdict.factor).toBeUndefined();
    expect(verdict.verdict).not.toBe("synced");
  });

  it("rescales the written times before shifting them", () => {
    const srt = "1\n00:10:00,000 --> 00:10:02,000\nhi\n";
    expect(retime(srt, ".srt", () => 600, PAL_ON_FILM)).toBe("1\n00:10:26,225 --> 00:10:28,310\nhi\n");
    const ass = "Dialogue: 0,0:10:00.00,0:10:02.00,Default,,0,0,0,,Hi\n";
    expect(retime(ass, ".ass", () => 0, PAL_ON_FILM)).toBe("Dialogue: 0,0:10:25.63,0:10:27.71,Default,,0,0,0,,Hi\n");
    expect(scaleCues([{ start: 1000, end: 2000 }], 2)).toEqual([{ start: 2000, end: 4000 }]);
    expect(RATE_FACTORS).toHaveLength(6);
  });
});
