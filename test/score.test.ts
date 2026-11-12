import { describe, expect, it } from "vitest";
import {
  activityNames,
  combine,
  dialogueText,
  dubDecision,
  gapsTo,
  hideLines,
  nearestGap,
  onsets,
  pairChanges,
  precision,
  signedGapsTo,
  signedMedian,
  titleOf
} from "../scripts/score-metrics.js";

const cue = (start: number, end = start + 1000) => ({ start, end });
/** A translation's lead ahead of its voice, as the score takes it from src/sync.ts (SPEECH_LEAD_MS). */
const SPEECH_LEAD_MS = 200;

describe("the distance to the nearest reference line", () => {
  it("looks both ways", () => {
    const refs = [1000, 2000, 5000];
    expect(nearestGap(refs, 1900)).toBe(100);
    expect(nearestGap(refs, 2100)).toBe(100);
    expect(nearestGap(refs, 2000)).toBe(0);
    expect(nearestGap(refs, 3600)).toBe(1400);
  });

  it("works past either end, and is infinite with nothing to judge by", () => {
    expect(nearestGap([1000, 2000], 0)).toBe(1000);
    expect(nearestGap([1000, 2000], 9000)).toBe(7000);
    expect(nearestGap([], 1000)).toBe(Infinity);
  });
});

describe("shares within 0.1, 0.3 and 1 s", () => {
  it("counts each tolerance, and the median of the lines within 1 s", () => {
    const p = precision([0, 50, 200, 250, 800, 4000]);
    expect(p.lines).toBe(6);
    expect(p.within).toEqual([2, 4, 5]);
    expect(p.shares).toEqual([0.3333, 0.6667, 0.8333]);
    // 0, 50, 200, 250, 800: the 4 s line is too far off to say how tight the close ones are.
    expect(p.medianMs).toBe(200);
  });

  it("gives nothing for no lines", () => {
    expect(precision([])).toEqual({ lines: 0, within: [0, 0, 0], shares: [0, 0, 0] });
  });

  it("judges only lines inside what was read", () => {
    const gaps = gapsTo([1000, 5000, 20_000], [1100, 5000, 20_000], 0, [{ from: 0, to: 10_000 }]);
    expect(gaps).toEqual([100, 0]);
  });

  it("repeats in the reference don't matter", () => {
    expect(gapsTo([1000], [900, 900, 1300])).toEqual([100]);
  });
});

describe("speech onsets with the line's lead", () => {
  it("takes a start only after a pause of 250 ms", () => {
    // 1.0-2.0, then 2.1 (100 ms pause: same stretch), then 2.6 after 2.1-2.4 ended (200 ms), then 3.0 after 2.6-2.7 (300 ms).
    const speech = [cue(1000, 2000), cue(2100, 2400), cue(2600, 2700), cue(3000, 3500)];
    expect(onsets(speech)).toEqual([1000, 3000]);
  });

  it("follows the longest end when speech overlaps, in any order", () => {
    expect(onsets([cue(3000), cue(1000, 2900), cue(1200, 1500)])).toEqual([1000]);
  });

  it("judges a line 200 ms ahead of the voice as on time", () => {
    const voices = onsets([cue(10_000, 12_000), cue(20_000, 21_000)]);
    expect(gapsTo([9800, 19_500], voices, SPEECH_LEAD_MS)).toEqual([0, 300]);
    // Without the lead the on-time line would be 200 ms early.
    expect(gapsTo([9800], voices)).toEqual([200]);
  });

  it("counts a line by where it is judged, the lead included", () => {
    // 9.9 s + 0.2 s lands at 10.1 s, inside the window read from 10 s.
    expect(gapsTo([9900, 9700], [10_000], SPEECH_LEAD_MS, [{ from: 10_000, to: 20_000 }])).toEqual([100]);
  });

  it("gives the gaps signed too: early lines negative, late ones positive", () => {
    const voices = [10_000, 20_000, 30_000];
    expect(signedGapsTo([9700, 20_100, 29_800], voices, SPEECH_LEAD_MS)).toEqual([-100, 300, 0]);
    expect(signedGapsTo([1000], [])).toEqual([]);
  });

  it("shows a lead that is off as the median signed gap, where shares at that lead hide which way", () => {
    // Every line 120 ms ahead of its voice, judged at a 200 ms lead: all 80 ms late.
    const voices = [10_000, 20_000, 30_000, 40_000];
    const lines = voices.map((v) => v - 120);
    expect(signedMedian(signedGapsTo(lines, voices, SPEECH_LEAD_MS))).toBe(80);
    // Lines more than 1 s off don't count, and with none left there is no median.
    expect(signedMedian([-50, 30, 70, 4000])).toBe(30);
    expect(signedMedian([-4000])).toBeUndefined();
  });
});

describe("adding up pairs", () => {
  const long = precision([...new Array(90).fill(0), ...new Array(10).fill(2000)]);
  const short = precision([0, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]);

  it("weighs lines or pairs", () => {
    const t = combine([long, short]);
    expect(t.pairs).toBe(2);
    expect(t.lines).toBe(110);
    // 91 of 110 lines; (0.9 + 0.1) / 2 per pair.
    expect(t.lineWeighted[1]).toBe(0.8273);
    expect(t.pairAveraged[1]).toBe(0.5);
  });

  it("leaves out pairs with nothing judged", () => {
    expect(combine([long, precision([])]).pairs).toBe(1);
    expect(combine([long, precision([])]).pairAveraged[1]).toBe(0.9);
  });

  it("takes the median over every close line when given the gaps", () => {
    expect(combine([precision([10, 20]), precision([30, 5000])], [[10, 20], [30, 5000]]).medianMs).toBe(20);
  });

  it("is zero for an empty group", () => {
    expect(combine([])).toEqual({ pairs: 0, lines: 0, lineWeighted: [0, 0, 0], pairAveraged: [0, 0, 0] });
  });
});

describe("comparing two runs", () => {
  const run = (id: string, method: string, shares: number[]) => ({ id, method, synced: !["not synced", "wrong file"].includes(method), served: { lines: 100, within: shares.map((s) => s * 100), shares } });

  it("puts a pair that stopped syncing first, then the biggest drop within 0.3 s", () => {
    const before = [run("a", "shift", [0.5, 0.8, 0.9]), run("b", "shift", [0.5, 0.8, 0.9]), run("c", "shift", [0.5, 0.8, 0.9]), run("d", "shift", [0.5, 0.8, 0.9])];
    const after = [run("a", "shift", [0.5, 0.7, 0.9]), run("b", "not synced", [0.1, 0.2, 0.5]), run("c", "shift", [0.5, 0.4, 0.9]), run("d", "shift", [0.5, 0.8, 0.9])];
    const changes = pairChanges(before, after);
    expect(changes.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(changes[0].flipped).toBe("no longer synced");
    expect(changes[1].delta[1]).toBe(-0.4);
  });

  it("notes pairs that start syncing, change method, or are in one run only", () => {
    const changes = pairChanges([run("a", "not synced", [0, 0.1, 0.3]), run("b", "shift", [1, 1, 1]), run("gone", "shift", [1, 1, 1])], [run("a", "speech", [0.2, 0.6, 0.8]), run("b", "lines", [1, 1, 1]), run("new", "shift", [1, 1, 1])]);
    const byId = new Map(changes.map((c) => [c.id, c]));
    expect(byId.get("a")?.flipped).toBe("now synced");
    expect(byId.get("b")?.methodChanged).toBe(true);
    expect(byId.get("gone")?.after).toBeUndefined();
    expect(byId.get("new")?.before).toBeUndefined();
  });
});

describe("hiding lines from the sync, to judge by them", () => {
  const starts = (cues: Array<{ start: number }>) => cues.map((c) => c.start);

  it("takes every nth line out of the reading and gives back their starts", () => {
    const reading = { windows: [{ from: 0, to: 60_000, cues: [1000, 2000, 3000, 4000, 5000, 6000].map((t) => cue(t)) }, { from: 60_000, to: 120_000, cues: [61_000, 62_000, 63_000, 64_000].map((t) => cue(t)) }] };
    const { kept, hidden } = hideLines(reading, 3);
    // Counted over the whole file, not per window: the 3rd, 6th and 9th lines.
    expect(hidden).toEqual([3000, 6000, 63_000]);
    expect(starts(kept.windows[0].cues)).toEqual([1000, 2000, 4000, 5000]);
    expect(starts(kept.windows[1].cues)).toEqual([61_000, 62_000, 64_000]);
    // The reading given is left as it was, and what else a window holds is kept.
    expect(reading.windows[0].cues).toHaveLength(6);
    expect(kept.windows[1].from).toBe(60_000);
  });

  it("hides a line from every track at once, a start a few ms off on another track included", () => {
    const reading = { windows: [{ cues: [1000, 2000, 3000, 4000].map((t) => cue(t)), others: { "3": [1010, 2000, 3020, 4000, 9000].map((t) => cue(t)) } }] };
    const { kept, hidden } = hideLines(reading, 2);
    // Lines: 1000(+1010), 2000, 3000(+3020), 4000, 9000: the 2nd and 4th are hidden.
    expect(hidden).toEqual([2000, 4000]);
    expect(starts(kept.windows[0].cues)).toEqual([1000, 3000]);
    expect(starts(kept.windows[0].others["3"])).toEqual([1010, 3020, 9000]);
  });

  it("leaves speech alone, and a file with only speech has nothing to hide", () => {
    const heard = { cues: [] as Array<{ start: number; end: number }>, speech: [cue(1000)], heard: true };
    const { kept } = hideLines({ windows: [{ cues: [cue(500), cue(700)] }, heard] }, 2);
    expect(kept.windows[1]).toBe(heard);
    const speechOnly = { speechOnly: true, windows: [{ cues: [cue(1000), cue(2000)] }] };
    expect(hideLines(speechOnly, 2)).toEqual({ kept: speechOnly, hidden: [] });
  });
});

describe("telling dub captions from translations", () => {
  const stem = "Show.S01E02.1080p.WEB-DL.x264-TEAM";

  it("finds a file in the activity list, shortened or with its episode in front", () => {
    expect(activityNames(`English Dub · ${stem}`, stem)).toBe(true);
    expect(activityNames("Arabic · Show.S01E02.1080p.WEB…", stem)).toBe(true);
    expect(activityNames("Arabic · S01E02 · a1b2c3", "a1b2c3")).toBe(true);
    expect(activityNames("Arabic · Show.S01E03.1080p.WEB…", stem)).toBe(false);
    expect(activityNames(`Arabic · ${stem}.extra`, stem)).toBe(false);
  });

  it("goes by the file's own downloads first", () => {
    expect(dubDecision([`English Dub · ${stem}`, "English · Show.S01E03.1080p-TEAM"], stem).dub).toBe(true);
    expect(dubDecision([`English · ${stem}`, "English Dub · Show.S01E03.1080p-TEAM"], stem).dub).toBe(false);
  });

  it("borrows other episodes of the title when the file isn't listed", () => {
    expect(dubDecision(["English Dub · Show.S01E03.1080p-TEAM", "Arabic · Film.2020.1080p-TEAM"], stem)).toEqual({ dub: true, by: "not in the activity list; other files of the title were downloaded as English Dub" });
    // Both ways, or nothing known: a translation.
    expect(dubDecision(["English Dub · Show.S01E03.1080p-TEAM", "English · Show.S01E04.1080p-TEAM"], stem).dub).toBe(false);
    expect(dubDecision(["English Dub · Film.2020.1080p-TEAM"], stem).dub).toBe(false);
  });

  it("reads a title from the words before the episode or year", () => {
    expect(titleOf("Show.Name.S01E02.1080p-TEAM")).toBe("show name");
    expect(titleOf("Show Name S2 - 02")).toBe("show name");
    expect(titleOf("Film.Name.2020.2160p")).toBe("film name");
  });

  it("tells an ASS file's language by its lines, not its styles", () => {
    const ass = "[V4+ Styles]\nStyle: Default,Some Font Name,24,&H00FFFFFF\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}مرحبا, يا صديقي\\Nكيف حالك";
    expect(dialogueText(ass, ".ass")).toBe(" مرحبا, يا صديقي كيف حالك");
    expect(dialogueText("1\n00:00:01,000 --> 00:00:02,000\nhello\n", ".srt")).toContain("hello");
  });
});
