/**
 * The sync benchmark (docs/benchmark.md): every scenario in test/scenarios.ts served through the live
 * sync, offline, and scored against where its lines belong. Another episode's subtitle is never
 * served as synced; this episode's is served as synced unless it is a known gap; and the shares of
 * lines within 0.3 s and 0.1 s of where they belong never fall below the scenario's floors. A floor
 * is a ratchet: raise it in the change that improves it (npm run bench says which), never lower it
 * without saying why.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCENARIOS } from "./scenarios.js";
import { openBench, type Bench } from "./serve.js";

let bench: Bench;

beforeAll(async () => {
  bench = await openBench(".cache-bench-test");
});

afterAll(async () => {
  await bench?.close();
});

describe("the sync benchmark", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: ${scenario.about}`, async () => {
      const outcome = await bench.serve(scenario);
      if (scenario.negative) {
        expect(outcome.synced, `served as synced (${outcome.method}), but it is another episode's subtitle`).toBe(false);
        return;
      }
      if (scenario.today.gap) {
        expect(outcome.synced, `a known gap closed: it is served synced now (${outcome.method}); set today.synced and raise its floor`).toBe(false);
      } else {
        expect(outcome.synced, `no longer served as synced (${outcome.method}${outcome.why ? `: ${outcome.why}` : ""})`).toBe(true);
      }
      expect(outcome.within, "the sync failed: nothing was served").toBeDefined();
      for (const within of ["0.3", "0.1"] as const) {
        expect(outcome.within![within], `share of lines within ${within} s fell below its floor (${outcome.method})`).toBeGreaterThanOrEqual(scenario.today.floor[within]);
      }
    }, 30000);
  }
});
