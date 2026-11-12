/**
 * The sync benchmark as a table: every scenario in test/scenarios.ts served through the live sync,
 * offline, and scored against where its lines belong (docs/benchmark.md).
 *
 *   npm run bench                       the table
 *   npm run bench -- --json out.json    also write the results as JSON, to compare two runs
 *   npm run bench -- --only dub         only scenarios whose name holds "dub"
 *   npm run bench -- --log              also print what the sync logged for each
 *
 * It exits 1 wherever test/benchmark.test.ts would fail: a scenario below its floor, another
 * episode's subtitle served as synced, a positive no longer served synced, or a known gap that closed
 * (served synced now: set today.synced and raise its floors). An unknown option, or one missing its
 * value, exits 2 before anything runs.
 */
import { writeFile } from "node:fs/promises";
import { openBench, type Outcome, type Scenario } from "../test/serve.js";
import { SCENARIOS } from "../test/scenarios.js";

const argv = process.argv.slice(2);
const WITH_VALUE = ["--json", "--only"];
const known = new Set([...WITH_VALUE, "--log"]);
/** A typo would otherwise run the whole benchmark and quietly ignore what was asked for. */
function refuse(why: string): never {
  console.error(`bench: ${why}. Usage: npm run bench -- [--json <out.json>] [--only <text>] [--log]`);
  process.exit(2);
}
for (const [i, a] of argv.entries()) {
  if (WITH_VALUE.includes(argv[i - 1])) continue;
  if (!known.has(a)) refuse(`unknown option ${a}`);
}
const valueOf = (flag: string) => {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) refuse(`${flag} needs a value`);
  return value;
};
const jsonPath = valueOf("--json");
const only = valueOf("--only");
const showLog = argv.includes("--log");

/** How far above its floor a scenario may score before the table asks for the floor to be raised. */
const RAISE_ABOVE = 0.03;

const bench = await openBench(".cache-bench");
const rows: Array<{ outcome: Outcome; floor: Scenario["today"]["floor"]; expected: boolean; negative: boolean; file: string; lang: string; verdict: string }> = [];
let failed = 0;
try {
  for (const scenario of SCENARIOS.filter((s) => !only || s.name.includes(only))) {
    const outcome = await bench.serve(scenario);
    const { floor } = scenario.today;
    const share = (within: "0.3" | "0.1") => outcome.within?.[within] ?? 0;
    const below = (["0.3", "0.1"] as const).filter((w) => !scenario.negative && share(w) < floor[w]);
    const above = (["0.3", "0.1"] as const).filter((w) => !scenario.negative && share(w) > floor[w] + RAISE_ABOVE);
    // The same verdicts as test/benchmark.test.ts, each of them a failure there.
    const problems = [
      ...(outcome.synced !== scenario.today.synced ? [scenario.negative ? "SERVED AS SYNCED" : outcome.synced ? "KNOWN GAP CLOSED: set today.synced, raise its floors" : "NO LONGER SYNCED"] : []),
      ...(!scenario.negative && outcome.within === undefined ? ["NOTHING SERVED"] : []),
      ...below.map((w) => `BELOW ${w} s FLOOR`)
    ];
    const better = problems.length === 0 && above.length ? `raise ${above.join(" and ")} s floor` : "";
    if (problems.length) failed++;
    rows.push({ outcome, floor, expected: scenario.today.synced, negative: Boolean(scenario.negative), file: scenario.file, lang: scenario.lang ?? "(dub)", verdict: [...problems, better].filter(Boolean).join(", ") || "ok" });
    if (showLog) console.log(`\n${scenario.name}\n  ${outcome.log.join("\n  ")}`);
  }
} finally {
  await bench.close();
}

const pct = (x: number | undefined) => (x === undefined ? "-" : `${Math.round(x * 100)}%`);
const table = [
  ["scenario", "file", "lang", "method", "synced", "<=0.1s", "<=0.3s", "<=1s", "median", "floors 0.1/0.3", "ms", "note"],
  ...rows.map(({ outcome: o, floor, negative, file, lang, verdict }) => [
    o.name,
    file,
    lang,
    o.method + (o.factor ? ` x${o.factor.toFixed(4)}` : ""),
    o.synced ? "yes" : "no",
    pct(o.within?.["0.1"]),
    pct(o.within?.["0.3"]),
    pct(o.within?.["1"]),
    o.medianMs === undefined ? "-" : `${o.medianMs} ms`,
    negative ? "never synced" : `${pct(floor["0.1"])} / ${pct(floor["0.3"])}`,
    String(o.ms),
    [verdict, o.why].filter((x) => x && x !== "ok").join("; ") || "ok"
  ])
];
const widths = table[0].map((_, c) => Math.max(...table.map((r) => r[c].length)));
for (const [i, row] of table.entries()) {
  console.log(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
  if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
}
console.log(`\n${rows.length} scenarios, ${failed} failing`);

if (jsonPath) {
  const scenarios = rows.map(({ outcome: { log: _log, ...o }, floor, expected, negative, file, lang }) => ({ ...o, file, lang, negative, expectedSynced: expected, floor }));
  await writeFile(jsonPath, JSON.stringify({ scenarios }, null, 2) + "\n");
  console.log(`written to ${jsonPath}`);
}
process.exitCode = failed ? 1 : 0;
