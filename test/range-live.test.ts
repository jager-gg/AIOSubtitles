/**
 * Timing by line starts and far beyond the usual search, through the live sync (syncCaptions, as
 * the benchmark serves a play): line starts time translations only, never dub captions, whose
 * lines are the dub's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBench, type Bench, type Scenario } from "./serve.js";
import { episode, faithful, heard, indexFile, runOn, stepped } from "./synthetic.js";

let bench: Bench;

beforeAll(async () => {
  bench = await openBench(".cache-range-test");
});

afterAll(async () => {
  await bench?.close();
});

/** A drama's official translation whose lines run on and merge, stepping at every break (as runon-steps-index). */
function runOnSteps(lang?: string): Scenario {
  return {
    name: `runon-${lang ?? "dub"}`,
    about: "",
    file: "index",
    ...(lang ? { lang } : {}),
    today: { synced: true, floor: { "0.3": 0, "0.1": 0 } },
    build: () => {
      const ep = episode(505, { minutes: 43, breaks: 4 });
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 121)), subtitle: stepped(runOn(faithful(ep.lines), 122, { merge: 0.6, hold: 6000 }), ep.cuts.slice(1), [1500, 4600, 7400, 10300, 13100, 15800]) };
    }
  };
}

describe("timing by line starts, live", () => {
  it("times a translation whose lines overlap the file's at every shift alike", async () => {
    const outcome = await bench.serve(runOnSteps("Arabic"));
    expect(outcome.method).toBe("starts");
    expect(outcome.within!["0.3"]).toBeGreaterThan(0.95);
    expect(outcome.log.some((line) => /the line starts do: \d+ of \d+ windows/.test(line))).toBe(true);
  });

  it("never times dub captions by line starts", async () => {
    const outcome = await bench.serve(runOnSteps());
    expect(outcome.synced).toBe(false);
    expect(outcome.log.some((line) => /line starts do/.test(line))).toBe(false);
  });
});
