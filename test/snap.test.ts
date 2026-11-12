import { describe, expect, it } from "vitest";
import { lineNudges, retime } from "../src/sync.js";

const cue = (start: number, end = start + 1500) => ({ start, end });
const none = () => 0;

describe("snapping lines onto the file's own line starts", () => {
  it("moves a line a beat off onto the file's line", () => {
    const nudges = lineNudges([cue(10_000), cue(14_000)], none, [cue(10_180), cue(13_900)]);
    expect(nudges.get(10_000)).toBe(180);
    expect(nudges.get(14_000)).toBe(-100);
  });

  it("measures after the shift", () => {
    // Shifted by +2 s, the caption at 8 s lands at 10 s, 150 ms before the file's line.
    expect(lineNudges([cue(8_000)], () => 2000, [cue(10_150)]).get(8_000)).toBe(150);
  });

  it("leaves lines that are on time, or too far off to be the same line", () => {
    const nudges = lineNudges([cue(10_000), cue(20_000)], none, [cue(10_020), cue(20_450)]);
    expect(nudges.size).toBe(0);
  });

  it("leaves a line between two of the file's lines alone", () => {
    // 10.15 s and 10.5 s both start near it: which one it is isn't clear.
    expect(lineNudges([cue(10_000)], none, [cue(10_150, 10_400), cue(10_500)]).size).toBe(0);
  });

  it("moves only the nearer of two caption lines onto one line of the file", () => {
    const nudges = lineNudges([cue(10_000, 10_100), cue(10_250)], none, [cue(10_200)]);
    expect(nudges.get(10_250)).toBe(-50);
    expect(nudges.has(10_000)).toBe(false);
  });

  it("carries the move into the written file, end and all", () => {
    const nudges = lineNudges([cue(10_000, 12_000)], () => 1000, [cue(11_200)]);
    const srt = "1\n00:00:10,000 --> 00:00:12,000\nhi\n";
    expect(retime(srt, ".srt", (start) => 1000 + (nudges.get(start) ?? 0))).toBe("1\n00:00:11,200 --> 00:00:13,200\nhi\n");
  });

  it("writes the end it is given, when lines are kept apart one by one", () => {
    // Given the line's start and end as written (after any frame rate), the end function decides where it ends.
    const ends: Array<[number, number]> = [];
    const end = (start: number, last: number) => (ends.push([start, last]), last + 500);
    const srt = "1\n00:00:10,000 --> 00:00:12,000\nhi\n";
    expect(retime(srt, ".srt", () => 1000, 1, end)).toBe("1\n00:00:11,000 --> 00:00:12,500\nhi\n");
    const ass = "Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Hi\n";
    expect(retime(ass, ".ass", () => 1000, 1, end)).toBe("Dialogue: 0,0:00:11.00,0:00:12.50,Default,,0,0,0,,Hi\n");
    expect(ends).toEqual([[10_000, 12_000], [10_000, 12_000]]);
    // Made for another frame rate: start and end are scaled first.
    expect(retime(srt, ".srt", () => 0, 2, (_start, last) => last)).toBe("1\n00:00:20,000 --> 00:00:24,000\nhi\n");
  });
});
