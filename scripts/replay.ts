/**
 * Replay check: runs today's sync decisions over every past play kept in the server's cache, and
 * shows what a change would do before it ships.
 *
 *   npm run replay              pull the cache from the server, replay, compare
 *   npm run replay -- --local   replay what was pulled last time
 *   npm run replay -- --save    also keep this run as the baseline for the next one
 *   npm run replay -- --all     print every pair, not only the ones that changed
 *
 * Everything lives in .replay/ (gitignored: it holds the file names of what was played):
 *   cache/          anchors, subtitles and sync results copied from the server
 *   baseline.json   the last --save run
 *   expect.json     known answers: { "<file name>|<subtitle file>": { "verdict": "synced", "offset": 0, "known": true } }
 *                   "offset" (ms, ±300) is optional; "known": true marks a case still failing on purpose.
 *
 * Each pair is a played file and a cached subtitle for it. Pairs come from past syncs, plus every
 * other cached subtitle numbered for the same episode (another show's, or another episode's), whose
 * verdict should stay "wrong". The speech column is the same decision timed against speech heard in
 * the file's audio instead of its subtitle track, where the file kept both.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheKey } from "../src/cache.js";
import { type FileAnchors, SYNC_VERSION, type SyncResult, judge, parseCues } from "../src/sync.js";
import { decodeSubtitle } from "../src/text.js";

const HOST = process.env.REPLAY_HOST ?? "";
const CONTAINER = process.env.REPLAY_CONTAINER ?? "aiosubtitles";
const root = path.resolve(".replay");
const cache = path.join(root, "cache");
const args = new Set(process.argv.slice(2));

type Verdict = "synced" | "wrong" | "rejected" | "unsynced" | "no windows";
interface Row {
  pair: string;
  verdict: Verdict;
  offset?: number;
  speech?: Verdict;
  speechOffset?: number;
  served?: string;
}

function run(command: string, argv: string[], options: { cwd?: string } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString().trim()}`))));
  });
}

/** Windows' own OpenSSH has the agent with the server's key; Git's ssh doesn't. */
const ssh = process.platform === "win32" && existsSync("C:\\Windows\\System32\\OpenSSH\\ssh.exe") ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "ssh";
const tar = process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe") ? "C:\\Windows\\System32\\tar.exe" : "tar";

async function pull(): Promise<void> {
  const inside = "cd /app/cache && tar -cz anchors subtitles stats/activity.json $(ls synced/*.json 2>/dev/null)";
  const archive = await run(ssh, [HOST, `docker exec ${CONTAINER} sh -c '${inside}'`]);
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(root, "cache.tgz"), archive);
  await run(tar, ["-xzf", path.join("..", "cache.tgz")], { cwd: cache });
  await rm(path.join(root, "cache.tgz"));
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function files(folder: string): Promise<string[]> {
  try {
    return await readdir(path.join(cache, folder));
  } catch {
    return [];
  }
}

/** A cached subtitle's name: "<ref>-<season|movie>-<episode|full>.<ext>". */
function parseStem(name: string): { ref: string; season?: number; episode?: number; place: string } | undefined {
  const m = name.match(/^(.+)-(movie|\d+)-(full|\d+)\.(srt|ass|ssa|vtt|sub)$/i);
  if (!m) return undefined;
  return {
    ref: /^\d+$/.test(m[1]) ? `ss${m[1]}` : m[1],
    season: m[2] === "movie" ? undefined : Number(m[2]),
    episode: m[3] === "full" ? undefined : Number(m[3]),
    place: `${m[2]}-${m[3]}`
  };
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);

async function main(): Promise<void> {
  await mkdir(root, { recursive: true });
  if (!args.has("--local")) {
    if (!HOST) throw new Error("Set REPLAY_HOST to the ssh host that runs the addon (REPLAY_CONTAINER: its container, default aiosubtitles), or pass --local");
    process.stdout.write(`pulling the cache from ${HOST}... `);
    await pull();
    console.log("done");
  }
  if (!existsSync(cache)) throw new Error("nothing pulled yet: run without --local first");

  // Played files, by the hash their anchors are stored under.
  const anchors = new Map<string, FileAnchors>();
  for (const name of await files("anchors")) {
    const found = await readJson<FileAnchors>(path.join(cache, "anchors", name));
    if (found) anchors.set(name.replace(/\.json$/, ""), found);
  }
  // Audio recorded from past plays (.replay/audio, see scripts/vad-eval.ts): its speech is heard
  // again with today's detector, in place of what the server kept, so detector changes replay too.
  const audioRoot = path.join(root, "audio");
  let reheard = 0;
  if (existsSync(audioRoot)) {
    const { heardSpeech } = await import("../src/vad.js");
    for (const dir of await readdir(audioRoot)) {
      const meta = await readJson<{ filename: string }>(path.join(audioRoot, dir, "meta.json"));
      const key = meta && cacheKey({ kind: "file-anchors", filename: meta.filename });
      const found = key ? anchors.get(key) : undefined;
      if (!key || !found) continue;
      const windows = await Promise.all(
        found.windows.map(async (w) => {
          const pcm = path.join(audioRoot, dir, `${w.from}.pcm`);
          if (w.bridge || !existsSync(pcm)) return found.speechOnly ? { ...w, cues: [] } : { ...w, speech: undefined };
          const speech = await heardSpeech(await readFile(pcm), w.from);
          return found.speechOnly ? { ...w, cues: speech } : { ...w, speech };
        })
      );
      anchors.set(key, { ...found, windows, speechBy: "silero" });
      reheard++;
    }
  }
  const results: SyncResult[] = [];
  for (const name of (await files("synced")).filter((n) => n.endsWith(".json"))) {
    const result = await readJson<SyncResult>(path.join(cache, "synced", name));
    if (result) results.push({ ...result, key: name.replace(/\.json$/, "") } as SyncResult & { key: string });
  }
  const subtitles = (await files("subtitles")).filter((n) => parseStem(n));

  // Names of played files: stored with newer anchors and results; older ones are found by hashing
  // names seen in the activity list, in results, or listed in expect.json.
  const expect = (await readJson<Record<string, { verdict: Verdict; offset?: number; known?: boolean }>>(path.join(root, "expect.json"))) ?? {};
  const activity = (await readJson<Array<{ what?: string }>>(path.join(cache, "stats", "activity.json"))) ?? [];
  const guesses = new Set<string>([
    ...[...anchors.values()].flatMap((a) => (a.filename ? [a.filename] : [])),
    ...results.flatMap((r) => (r.filename ? [r.filename] : [])),
    ...Object.keys(expect).map((k) => k.split("|")[0]),
    ...activity.flatMap((a) => (a.what ? [a.what.split(" · ").at(-1) as string] : []))
  ]);
  const nameOf = new Map<string, string>();
  for (const guess of guesses) {
    for (const name of [guess, `${guess}.mkv`, `${guess}.mp4`]) {
      const key = cacheKey({ kind: "file-anchors", filename: name });
      if (anchors.has(key)) nameOf.set(key, name);
    }
  }

  // Pairs from past syncs. Older results don't name their pair: matched by hashing every known file
  // with every cached subtitle, the way syncKey builds the key.
  const resultByKey = new Map(results.map((r) => [(r as SyncResult & { key: string }).key, r]));
  const pairs = new Map<string, { filename: string; subtitle: string; served?: string }>();
  const servedText = (r: SyncResult) => (r.noFit ? "wrong" : r.anchors.length ? `synced ${median(r.anchors.map((a) => a.offset))}ms` : "unsynced");
  for (const r of results) if (r.filename && r.source) pairs.set(`${r.filename}|${r.source}`, { filename: r.filename, subtitle: r.source, served: servedText(r) });
  for (const filename of nameOf.values()) {
    for (const subtitle of subtitles) {
      const stem = parseStem(subtitle)!;
      for (let version = 1; version <= SYNC_VERSION; version++) {
        const key = cacheKey({ kind: "synced", subtitleId: stem.ref, season: stem.season, episode: stem.episode, filename, version });
        const r = resultByKey.get(key);
        if (r) pairs.set(`${filename}|${subtitle}`, { filename, subtitle, served: `${servedText(r)}${version < SYNC_VERSION ? ` (v${version})` : ""}` });
      }
    }
  }
  // Every other subtitle numbered like one already paired with a file: these should stay "wrong",
  // unless they're another upload for the same episode.
  for (const { filename, subtitle } of [...pairs.values()]) {
    const place = parseStem(subtitle)!.place;
    for (const other of subtitles.filter((s) => parseStem(s)!.place === place)) {
      const id = `${filename}|${other}`;
      if (!pairs.has(id)) pairs.set(id, { filename, subtitle: other });
    }
  }
  for (const id of Object.keys(expect)) {
    const [filename, subtitle] = id.split("|");
    if (!pairs.has(id)) pairs.set(id, { filename, subtitle });
  }

  // Replay.
  const rows: Row[] = [];
  // One file can be known under two names (with and without its extension): replayed once.
  const replayed = new Set<string>();
  for (const [id, { filename, subtitle, served }] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
    const fileKey = cacheKey({ kind: "file-anchors", filename });
    if (replayed.has(`${fileKey}|${subtitle}`)) continue;
    replayed.add(`${fileKey}|${subtitle}`);
    const found = anchors.get(fileKey);
    let text: string;
    try {
      text = decodeSubtitle(await readFile(path.join(cache, "subtitles", subtitle)));
    } catch {
      continue;
    }
    if (!found || found.windows.length === 0) {
      rows.push({ pair: id, verdict: "no windows", served });
      continue;
    }
    const captions = parseCues(text, path.extname(subtitle).toLowerCase());
    const now = judge(found, captions);
    const row: Row = { pair: id, verdict: now.verdict, offset: median(now.anchors.map((a) => a.offset)), served };
    const heard = found.speechOnly ? [] : found.windows.filter((w) => w.speech && w.speech.length >= 3);
    if (heard.length >= 3) {
      const bySpeech = judge({ ...found, windows: heard.map((w) => ({ from: w.from, to: w.to, cues: w.speech! })) }, captions);
      row.speech = bySpeech.verdict;
      row.speechOffset = median(bySpeech.anchors.map((a) => a.offset));
    }
    rows.push(row);
  }

  // Compare.
  const baseline = new Map((await readJson<Row[]>(path.join(root, "baseline.json")) ?? []).map((r) => [r.pair, r]));
  const show = (r?: Pick<Row, "verdict" | "offset">) => (!r ? "-" : r.verdict === "synced" ? `synced ${r.offset}ms` : r.verdict);
  const speechText = (r: Row) => (r.speech ? (r.speech === "synced" ? `speech ${r.speechOffset}ms` : `speech ${r.speech}`) : "");
  const short = (pair: string) => {
    const [filename, subtitle] = pair.split("|");
    return `${filename.replace(/\.(mkv|mp4)$/, "").slice(0, 46).padEnd(46)} ${subtitle.padEnd(28)}`;
  };
  const changed = rows.filter((r) => {
    const before = baseline.get(r.pair);
    return before && (before.verdict !== r.verdict || Math.abs((before.offset ?? 0) - (r.offset ?? 0)) > 300);
  });
  const failures: string[] = [];
  const knownFailing: string[] = [];
  for (const [id, want] of Object.entries(expect)) {
    const row = rows.find((r) => r.pair === id);
    const ok = row && row.verdict === want.verdict && (want.offset === undefined || Math.abs((row.offset ?? 0) - want.offset) <= 300);
    if (ok) continue;
    const line = `${short(id)} want ${show(want)}, got ${show(row)}${row?.speech ? ` (${speechText(row)})` : ""}`;
    (want.known ? knownFailing : failures).push(line);
  }

  if (args.has("--all")) {
    console.log("\nall pairs (now · served by the server · by speech):");
    for (const r of rows) console.log(`  ${short(r.pair)} ${show(r).padEnd(16)} ${(r.served ?? "").padEnd(20)} ${speechText(r)}`);
  }
  const verdicts = rows.reduce<Record<string, number>>((n, r) => ((n[r.verdict] = (n[r.verdict] ?? 0) + 1), n), {});
  console.log(`\n${nameOf.size} files, ${rows.length} pairs: ${Object.entries(verdicts).map(([v, n]) => `${n} ${v}`).join(", ")}`);
  // The server keeps one flag for both ways a subtitle can fail to fit.
  const asServer = (v: Verdict) => (v === "rejected" ? "wrong" : v);
  const fromServer = rows.filter((r) => r.served && !r.served.includes("(v") && r.served.split(" ")[0] !== asServer(r.verdict));
  if (fromServer.length) {
    console.log(`\ndecided differently from the server's own result (${fromServer.length}):`);
    for (const r of fromServer) console.log(`  ${short(r.pair)} server ${r.served}, now ${show(r)}`);
  }
  if (baseline.size) {
    console.log(changed.length ? `\nchanged since the baseline (${changed.length}):` : "\nno change since the baseline");
    for (const r of changed) console.log(`  ${short(r.pair)} ${show(baseline.get(r.pair))} -> ${show(r)}`);
  } else console.log("\nno baseline yet: run with --save to keep this run as one");
  const bySpeech = rows.filter((r) => r.verdict === "synced" && r.speech);
  if (bySpeech.length) {
    const close = bySpeech.filter((r) => r.speech === "synced" && Math.abs((r.speechOffset ?? 0) - (r.offset ?? 0)) <= 500).length;
    console.log(`\nspeech: ${close} of ${bySpeech.length} synced pairs land within 0.5 s of the subtitle-track timing when timed by speech instead`);
  }
  if (knownFailing.length) {
    console.log(`\nknown failing (${knownFailing.length}):`);
    for (const line of knownFailing) console.log(`  ${line}`);
  }
  if (failures.length) {
    console.log(`\nFAILED expectations (${failures.length}):`);
    for (const line of failures) console.log(`  ${line}`);
  } else if (Object.keys(expect).length) console.log(`\nexpectations: all ${Object.keys(expect).length - knownFailing.length} pass`);
  if (args.has("--save")) {
    await writeFile(path.join(root, "baseline.json"), JSON.stringify(rows, null, 1));
    console.log("saved as the baseline");
  }
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
