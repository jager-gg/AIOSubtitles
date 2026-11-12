/**
 * Serves a benchmark scenario (test/scenarios.ts) through the live sync, offline, and scores what a
 * player would get. syncCaptions runs as it does for a real play: the file's readings are stored in
 * the cache as fileAnchors keeps them, the caption loader hands it the written subtitle, and every
 * fetch is refused, so nothing more of the file can be read (window files keep their first pass).
 * The served file is then compared line by line with where each line belongs (synthetic.ts).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileAnchors, SyncResult } from "../src/sync.js";
import { srt, srtStarts, type SubLine } from "./synthetic.js";

export interface Scenario {
  /** A short id: what the table and the JSON call it. */
  name: string;
  /** What it stands for in real life, in a sentence. */
  about: string;
  /** How the file was read: its Matroska index, five windows, or (no subtitle track) speech alone. */
  file: "index" | "windows" | "speech";
  /** Set for translations (snapping and line-by-line timing apply); unset for dub captions, as live. */
  lang?: string;
  /** Another episode's subtitle: it must never be served as synced. */
  negative?: boolean;
  /** What today's code does with it: see docs/benchmark.md for how floors move. */
  today: {
    synced: boolean;
    /**
     * Shares of served lines within 0.3 s and within 0.1 s of where they belong: today's, less a
     * small margin. 0.3 s guards the timing; 0.1 s guards snapping, which only moves lines already
     * that close.
     */
    floor: { "0.3": number; "0.1": number };
    /** A positive that isn't served synced today: why, in the code's terms. */
    gap?: string;
  };
  build: () => { record: FileAnchors; subtitle: SubLine[] };
}

export type Method = "shift" | "rate" | "lines" | "starts" | "speech" | "unsynced" | "wrong" | "failed";

export interface Outcome {
  name: string;
  method: Method;
  /** Served as synced: the sync found timing it trusts (anchors), whichever way. */
  synced: boolean;
  /** Share of served lines within 0.1, 0.3 and 1 s of where they belong (not for negatives). */
  within?: { "0.1": number; "0.3": number; "1": number };
  /** Median distance of a served line from where it belongs, ms. */
  medianMs?: number;
  lines: number;
  anchors: number;
  factor?: number;
  /** The sync's own reason when it didn't sync, from its log. */
  why?: string;
  /** What the sync logged for this scenario. */
  log: string[];
  ms: number;
}

/** The ways syncCaptions says it left captions alone, shortened for the table. */
const REASONS: Array<[RegExp, string]> = [
  [/best fits scattered/, "fits scattered"],
  [/second-best fits/, "second-best fits"],
  [/shift jumps (\d+) times/, "shift jumps $1 times"],
  [/% of its lines start within the file/, "mostly outside the file"],
  [/it has lines in only \d+ of the file's/, "covers too little of the file"],
  [/its timing rests on only \d+ of the file's/, "rests on too few windows"],
  [/speech in the audio doesn't time/, "speech unclear"],
  [/no anchor matched/, "no anchor"]
];

export interface Bench {
  serve(scenario: Scenario): Promise<Outcome>;
  close(): Promise<void>;
}

/**
 * Opens the benchmark on a cache folder of its own, `dir` under the working directory. It must run
 * before anything loads src/config.ts, which reads CACHE_DIR once.
 */
export async function openBench(dir: string): Promise<Bench> {
  process.env.CACHE_DIR = dir;
  const { cacheKey, cachePath } = await import("../src/cache.js");
  if (cachePath() !== path.join(process.cwd(), dir)) throw new Error(`the cache is at ${cachePath()}, not ${dir}: src/ was loaded before the benchmark chose its folder`);
  const { settled, syncCaptions, SYNC_VERSION } = await import("../src/sync.js");
  await rm(cachePath(), { recursive: true, force: true });
  let served = 0;

  async function serve(scenario: Scenario): Promise<Outcome> {
    const { record, subtitle } = scenario.build();
    // Subtitle files list their lines by start; retiming keeps that order, so line k stays line k.
    const lines = [...subtitle].sort((a, b) => a.start - b.start);
    const n = ++served;
    const filename = `Show.S01E${String(n).padStart(2, "0")}.${scenario.name}.mkv`;
    await mkdir(cachePath("anchors"), { recursive: true });
    await writeFile(path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename })}.json`), JSON.stringify({ ...record, filename }));
    await mkdir(cachePath("bench"), { recursive: true });
    const written = path.join(cachePath("bench"), `${scenario.name}.srt`);
    await writeFile(written, srt(lines));

    const log: string[] = [];
    const quiet = { log: console.log, error: console.error, fetch: globalThis.fetch };
    console.log = (...args: unknown[]) => void log.push(args.map(String).join(" "));
    console.error = console.log;
    // Nothing leaves this machine: AIOStreams and the file's host are never reached.
    globalThis.fetch = async () => {
      throw new TypeError("offline: the benchmark reads nothing more of the file");
    };
    const started = Date.now();
    let result: SyncResult | undefined;
    try {
      result = await syncCaptions(`bench-${n}-${scenario.name}-v${SYNC_VERSION}`, async () => ({ file: written }), "https://aiostreams.example.com/stremio/bench/manifest.json", "tt0000951:1:1", "series", filename, scenario.lang);
      // A read the sync left running in the background (the English audio for dub captions) meets the
      // refused fetch too, before fetch is let out again.
      await settled();
    } finally {
      console.log = quiet.log;
      console.error = quiet.error;
      globalThis.fetch = quiet.fetch;
    }
    const ms = Date.now() - started;
    const method: Method = !result ? "failed" : result.noFit ? "wrong" : result.anchors.length === 0 ? "unsynced" : result.byLines ? "lines" : result.byStarts ? "starts" : result.bySpeech ? "speech" : result.factor ? "rate" : "shift";
    const synced = Boolean(result && result.anchors.length > 0);
    // The first reason it gives is the cause; later lines follow from it.
    const why = synced
      ? undefined
      : log.flatMap((line) => {
          const hit = REASONS.find(([pattern]) => pattern.test(line));
          return hit ? [line.match(hit[0])![0].replace(hit[0], hit[1])] : [];
        })[0];
    const outcome: Outcome = { name: scenario.name, method, synced, lines: lines.length, anchors: result?.anchors.length ?? 0, ...(result?.factor ? { factor: result.factor } : {}), ...(why ? { why } : {}), log, ms };
    if (scenario.negative || !result) return outcome;

    const starts = srtStarts(await readFile(result.file, "utf8"));
    if (starts.length !== lines.length) throw new Error(`${scenario.name}: served ${starts.length} lines of ${lines.length}`);
    const off = lines.map((l, i) => Math.abs(starts[i] - l.truth)).sort((a, b) => a - b);
    const share = (ms: number) => Math.round((off.filter((d) => d <= ms).length / off.length) * 1000) / 1000;
    return { ...outcome, within: { "0.1": share(100), "0.3": share(300), "1": share(1000) }, medianMs: off[Math.floor(off.length / 2)] };
  }

  return { serve, close: () => rm(cachePath(), { recursive: true, force: true }) };
}
