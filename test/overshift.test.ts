/**
 * Lines moved onto their own line over a trusted shift (linesOverShift in src/align.ts), as a play
 * gets them from syncCaptions: for translations on a file timed from its index, never for dub
 * captions, whose lines follow the dub and not the file's track.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBench, type Bench, type Scenario } from "./serve.js";
import { creeping, episode, faithful, heard, indexFile, type SubLine } from "./synthetic.js";

let bench: Bench;

beforeAll(async () => {
  bench = await openBench(".cache-overshift-test");
});

afterAll(async () => {
  await bench?.close();
});

/** A subtitle that runs slow by 0.5 s a minute between its cuts, on a file timed from its index (as creep-index). */
function creep(): ReturnType<Scenario["build"]> {
  const ep = episode(101);
  return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 6)), subtitle: creeping(faithful(ep.lines), [ep.cuts[0], ep.cuts[2], ep.cuts[3]], [-1200, 800, 2400, -400], 500) };
}

const scenario = (name: string, lang?: string): Scenario => ({
  name,
  about: "a creeping subtitle",
  file: "index",
  ...(lang ? { lang } : {}),
  today: { synced: true, floor: { "0.3": 0, "0.1": 0 } },
  build: creep
});

describe("moving lines onto their own line over a shift, in a play", () => {
  it("moves a translation's lines onto the file's own", async () => {
    const outcome = await bench.serve(scenario("creep-translation", "Dutch"));
    expect(outcome.method).toBe("shift");
    expect(outcome.log.some((line) => /lines moved onto their own line/.test(line))).toBe(true);
    expect(outcome.within!["0.3"]).toBeGreaterThan(0.97);
  });

  it("leaves dub captions as the shift puts them", async () => {
    const outcome = await bench.serve(scenario("creep-dub"));
    expect(outcome.method).toBe("shift");
    expect(outcome.log.some((line) => /moved onto their own line|snapped/.test(line))).toBe(false);
    // Exactly the shift per stretch, then moved by the voices heard (dub captions follow the dub,
    // see refineBySpeech): the same timing worked out here from the same readings.
    const sync = await import("../src/sync.js");
    const { record, subtitle } = creep();
    const lines = [...subtitle].sort((a, b) => a.start - b.start);
    const judged = sync.judge(record, lines);
    const byShift = sync.planShifts(judged.anchors, lines, record.windows.flatMap((w) => w.cues));
    const plan = sync.refineBySpeech(record, lines, byShift)?.shift ?? byShift;
    const share = (ms: number, sub: SubLine[]) => Math.round((sub.filter((l) => Math.abs(l.start + plan(l.start) - l.truth) <= ms).length / sub.length) * 1000) / 1000;
    expect(outcome.within!["0.3"]).toBe(share(300, lines));
    expect(outcome.within!["0.1"]).toBe(share(100, lines));
    expect(outcome.within!["0.3"]).toBeLessThan(0.8);
  });
});
