import { describe, expect, it } from "vitest";
import { agreeAnchors, dialogueCues, imageCues, measureWindow, parseCues, planShifts, retime, type Cue } from "../src/sync.js";

const ASS = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:09:56.78,0:10:02.74,Signs,,0,0,0,,{\\pos(320,40)}28th Wizard King
Dialogue: 0,0:09:58.70,0:10:04.04,Default,,0,0,0,,{\\an8}What am I doing?
Dialogue: 0,0:10:05.00,0:10:07.50,Default,,0,0,0,,I'm strolling, of course.
Dialogue: 1,0:10:05.00,0:10:07.50,Default,,0,0,0,,I'm strolling, of course.
Dialogue: 0,0:10:08.00,0:10:09.00,OP,,0,0,0,,{\\k20}la la
Dialogue: 0,0:10:10.00,0:10:12.00,Default,,0,0,0,,{\\i1}Asta!{\\i0}
`;

/** Speech-like cues every ~3.5 s with varied lengths, from `from` for `count` lines. */
function speech(from: number, count: number): Cue[] {
  const cues: Cue[] = [];
  let t = from;
  for (let i = 0; i < count; i++) {
    const len = 1200 + ((i * 7919) % 2300);
    cues.push({ start: t, end: t + len });
    t += len + 300 + ((i * 104729) % 1700);
  }
  return cues;
}

describe("anchor sync", () => {
  it("keeps spoken lines and drops signs, songs, positioned text and duplicate layers", () => {
    expect(dialogueCues(ASS)).toEqual([
      { start: 605000, end: 607500 },
      { start: 610000, end: 612000 }
    ]);
  });

  it("reads picture subtitle timing from packet times and sizes", () => {
    const csv = "715.006000,4231\n716.007000,30\n716.216000,24477\n718.760000,30\n718.968000,19846\n721.429000,30\n";
    expect(imageCues(csv)).toEqual([
      { start: 715006, end: 716007 },
      { start: 716216, end: 718760 },
      { start: 718968, end: 721429 }
    ]);
  });

  it("parses SRT and ASS cues", () => {
    expect(parseCues("1\n00:00:01,460 --> 00:00:02,920\nhi\n", ".srt")).toEqual([{ start: 1460, end: 2920 }]);
    expect(parseCues(ASS, ".ass")).toHaveLength(6);
  });

  it("retimes SRT and ASS lines by a per-line shift", () => {
    expect(retime("1\n00:00:01,460 --> 00:00:02,920\nhi\n", ".srt", () => -1000)).toBe("1\n00:00:00,460 --> 00:00:01,920\nhi\n");
    expect(retime("Dialogue: 0,0:00:05.25,0:00:07.00,Default,,0,0,0,,Hi\n", ".ass", () => -1000)).toBe(
      "Dialogue: 0,0:00:04.25,0:00:06.00,Default,,0,0,0,,Hi\n"
    );
    expect(retime("1\n00:00:00,500 --> 00:00:03,000\nx\n", ".srt", () => -1000)).toBe("1\n00:00:00,000 --> 00:00:02,000\nx\n");
  });

  it("finds the offset in a window even when lines are split differently", () => {
    const embedded = speech(600000, 12);
    // Captions: the same speech 1 s later, each line cut in two, with a little jitter.
    const captions = embedded.flatMap((c, i) => {
      const mid = (c.start + c.end) / 2;
      const j = (i % 3) * 60 - 60;
      return [
        { start: c.start + 1000 + j, end: mid + 1000 },
        { start: mid + 1000, end: c.end + 1000 + j }
      ];
    });
    const measured = measureWindow(embedded, captions);
    expect(measured).toBeDefined();
    expect(Math.abs(measured!.offset - -1000)).toBeLessThanOrEqual(60);
    expect(measured!.score).toBeGreaterThan(0.8);
  });

  it("refuses a window with no real match", () => {
    expect(measureWindow(speech(600000, 12), [{ start: 0, end: 1000 }, { start: 2000, end: 3000 }, { start: 4000, end: 5000 }])).toBeUndefined();
    expect(measureWindow([{ start: 1, end: 2 }], speech(0, 10))).toBeUndefined();
  });

  it("drops a lone chance match and keeps a real change that later windows share", () => {
    const w = (from: number, offset: number, alternatives: Array<{ offset: number; score: number }> = []) => ({
      from, to: from + 40000, measured: { offset, score: 0.9, alternatives }
    });
    // 716 s fit best at +16.1 s by chance, with the true -0.84 s close behind.
    expect(agreeAnchors([w(215000, -920), w(458000, -960), w(716000, 16120, [{ offset: -840, score: 0.88 }]), w(1217000, -905)]).map((a) => a.offset))
      .toEqual([-920, -960, -840, -905]);
    // No alternative: the lone outlier is set aside.
    expect(agreeAnchors([w(215000, -920), w(458000, -960), w(716000, 16120), w(1217000, -905)]).map((a) => a.offset)).toEqual([-920, -960, -905]);
    // A recap inserted halfway: the last two windows agree with each other, so both stay.
    expect(agreeAnchors([w(215000, -900), w(458000, -950), w(716000, 4000), w(974000, 4050)]).map((a) => a.offset)).toEqual([-900, -950, 4000, 4050]);
  });

  it("finds the shift most windows support even when most best fits are chance matches", () => {
    const w = (from: number, offset: number, alternatives: Array<{ offset: number; score: number }> = []) => ({
      from, to: from + 40000, measured: { offset, score: 0.9, alternatives }
    });
    // Iron Lantern E14 iAHD (picture subtitles).
    expect(
      agreeAnchors([
        w(458000, 17080, [{ offset: 400, score: 0.88 }]),
        w(716000, -120, [{ offset: 320, score: 0.85 }]),
        w(974000, 320),
        w(1217000, -11400, [{ offset: 160, score: 0.86 }])
      ]).map((a) => a.offset)
    ).toEqual([400, 320, 320, 160]);
  });

  it("uses one shift when anchors agree", () => {
    const shift = planShifts(
      [
        { from: 100000, to: 145000, offset: -1000, score: 0.9 },
        { from: 500000, to: 545000, offset: -1100, score: 0.9 },
        { from: 900000, to: 945000, offset: -950, score: 0.9 },
        { from: 1200000, to: 1245000, offset: -1300, score: 0.9 }
      ],
      speech(0, 300)
    );
    expect(shift(0)).toBe(-1000);
    expect(shift(1200000)).toBe(-1000);
  });

  it("changes shift at the longest silence between disagreeing anchors", () => {
    const captions = [...speech(0, 120), ...speech(700000, 120)].sort((a, b) => a.start - b.start);
    const shift = planShifts(
      [
        { from: 200000, to: 245000, offset: -1000, score: 0.9 },
        { from: 900000, to: 945000, offset: 4000, score: 0.9 }
      ],
      captions
    );
    const lastBefore = speech(0, 120).at(-1)!.end;
    expect(shift(lastBefore - 1)).toBe(-1000);
    expect(shift(700000)).toBe(4000);
  });
});

describe("adaptive windows", async () => {
  const { refinementStarts } = await import("../src/sync.js");
  const w = (from: number) => ({ from, to: from + 40000, cues: [] });
  const a = (from: number, offset: number) => ({ from, to: from + 40000, offset, score: 0.9 });

  it("reads nothing more when every spot matched and agreed", () => {
    const found = { duration: 1430000, windows: [w(214000), w(456000), w(712000), w(968000), w(1210000)] };
    expect(refinementStarts(found, [a(214000, 900), a(456000, 950), a(712000, 880), a(968000, 920), a(1210000, 900)])).toEqual([]);
  });

  it("reads around empty spots, between disagreeing ones, and early on (Odd Journey S1E7)", () => {
    const found = { duration: 1430000, windows: [w(214000), w(456000), w(712000), w(968000), w(1210000)] };
    const starts = refinementStarts(found, [a(712000, 2810), a(968000, 2935), a(1210000, 2920)]);
    expect(starts.length).toBeGreaterThan(2);
    expect(starts.length).toBeLessThanOrEqual(6);
    expect(starts.some((t) => t < 214000)).toBe(true); // before the first empty spot
    expect(starts.every((t) => t >= 0 && t <= 1430000 - 60000)).toBe(true);
  });

  it("bridges the stretch between disagreeing anchors, capped, and nothing when they agree", async () => {
    const { bridgeSpans } = await import("../src/sync.js");
    expect(bridgeSpans({ windows: [] }, [a(496000, 1200), { from: 604000, to: 664000, offset: 1240, score: 0.9 }, a(712000, 2810)])).toEqual([{ from: 664000, length: 48000 }]);
    expect(bridgeSpans({ windows: [] }, [a(100000, 1200), a(712000, 2810)])).toEqual([{ from: 336000, length: 180000 }]);
    expect(bridgeSpans({ windows: [] }, [a(100000, 1200), a(712000, 1300)])).toEqual([]);
  });

  it("puts the step at the pause that lets the most reference lines fit", async () => {
    const { placeStep } = await import("../src/sync.js");
    // Captions every 4 s; the reference follows them +1.0 s until 60 s (caption time), +3.0 s after.
    const captions: Cue[] = [];
    for (let t = 0; t < 120000; t += 4000) captions.push({ start: t, end: t + 2500 });
    const reference = captions.map((c) => {
      const shift = c.start < 60000 ? 1000 : 3000;
      return { start: c.start + shift, end: c.end + shift };
    });
    const at = placeStep({ from: 0, to: 30000, offset: 1000, score: 0.9 }, { from: 90000, to: 120000, offset: 3000, score: 0.9 }, captions, reference);
    expect(at).toBeGreaterThan(56500);
    expect(at).toBeLessThan(60000);
  });
});
