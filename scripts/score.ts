/**
 * Sync score: syncs every past play again with today's code, offline, and measures how close the
 * served lines land to the playing file's own lines (and, for dub captions, to where the voices
 * start). What the numbers mean, and what they can't tell: docs/scoring.md.
 *
 *   npm run score                                   data in .replay/cache, written to .replay/score-current.json
 *   npm run score -- --data <dir> --label <name>    another data folder; written to .replay/score-<name>.json
 *   npm run score -- --compare <score json>         also what changed since that run, worst first
 *   npm run score -- --only <text>                  only pairs whose file or subtitle name holds <text>
 *   npm run score -- --brief                        no table of every pair
 *   npm run score -- --holdout 5                    every 5th line of the file's tracks hidden from the sync, and served lines judged against those
 *   npm run negatives                               the cross check: every played file with every subtitle known to be another's (score.ts --negatives)
 *   npm run negatives -- --sample 4 --jobs 8        a quarter of those pairs, picked the same way every run; 8 processes at once
 *
 * The data folder is a replay cache (scripts/replay.ts): anchors/, subtitles/, synced/ and
 * stats/activity.json. Pairs are the (played file, subtitle) of every stored sync result whose file
 * readings and subtitle are both kept. Each is synced again by the real syncCaptions against a copy
 * of the data in which nothing more can be read: every file counts as fully read, speech never
 * stored counts as already heard (there's none), fetch is refused and ffmpeg can't start. Anything
 * that still tries is listed per pair. The data folder itself is only read.
 *
 * With --negatives, the pairs are instead every played file with every cached subtitle the data
 * shows to belong to another episode or another title (scripts/cross-pairs.ts), synced the same way.
 * None of them should be served as synced: each one that is gets listed, and the run exits 1.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import type { FileAnchors, SyncResult } from "../src/sync.js";
import { crossPairs, sameDialogueGroups, sampleOrder, type CrossPair } from "./cross-pairs.js";
import {
  combine,
  dialogueText,
  dubDecision,
  gapsTo,
  hideLines,
  onsets,
  pairChanges,
  precision,
  type Precision,
  signedGapsTo,
  signedMedian,
  type Span,
  sortedUnique,
  TOLERANCES_MS,
  type Totals
} from "./score-metrics.js";

// ---------- arguments ----------

function parseArgs(argv: string[]) {
  const known = new Set(["--data", "--label", "--compare", "--only", "--brief", "--holdout", "--negatives", "--own", "--sample", "--jobs", "--shard"]);
  for (const a of argv) if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown option ${a}`);
  const option = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    return value;
  };
  const whole = (name: string, least: number): number | undefined => {
    const value = option(name);
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < least) throw new Error(`${name} takes a whole number of ${least} or more`);
    return n;
  };
  const label = option("--label") ?? "current";
  if (!/^[\w.-]+$/.test(label)) throw new Error("--label takes letters, digits, '.', '-' and '_' only");
  const holdout = whole("--holdout", 2);
  const negatives = argv.includes("--negatives");
  if (negatives && holdout) throw new Error("--negatives and --holdout don't go together");
  if (!negatives && ["--sample", "--jobs", "--own"].some((a) => argv.includes(a))) throw new Error("--sample, --jobs and --own go with --negatives");
  return {
    data: path.resolve(option("--data") ?? path.join(".replay", "cache")),
    label,
    compare: option("--compare"),
    only: option("--only"),
    brief: argv.includes("--brief"),
    holdout,
    negatives,
    own: argv.includes("--own"),
    sample: whole("--sample", 1) ?? 1,
    jobs: whole("--jobs", 1) ?? Math.max(1, Math.min(8, os.cpus().length - 1)),
    shard: option("--shard")
  };
}

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
const { data: dataDir, label, compare: comparePath, only, brief, holdout, negatives, own, sample, jobs, shard } = args;

/** Where the copy of the data lives while the score runs: under .replay (gitignored), relative, as CACHE_DIR must be. */
const work = path.join(".replay", `score-work-${process.pid}`);
const outFile = path.resolve(".replay", `${negatives ? "negatives" : "score"}-${label}.json`);
/** The code being scored, for the record (read before ffmpeg and friends are refused below). */
const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
})();

// ---------- nothing leaves the machine ----------

/** What a pair tried to read from outside while it synced: should stay empty. */
let attempts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "?";
  try {
    host = new URL(url).host;
  } catch {}
  attempts.push(`fetch ${host}`);
  throw new Error("offline: the score never fetches");
}) as typeof fetch;
// ffmpeg and ffprobe (src/sync.ts runs them with execFile): refused before they start. The module's
// named exports are synced so an `import { execFile }` sees the stand-in too.
const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
childProcess.execFile = ((cmd: string, ...rest: unknown[]) => {
  attempts.push(`run ${path.basename(String(cmd))}`);
  const callback = rest.find((r): r is (error: Error) => void => typeof r === "function");
  setImmediate(() => callback?.(new Error(`offline: ${cmd} not run`)));
  return undefined;
}) as unknown as typeof childProcess.execFile;
syncBuiltinESMExports();

// The cache folder is read when the config loads, so it is set before any src module is imported.
process.env.CACHE_DIR = work;
const { cacheKey } = await import("../src/cache.js");
const sync = await import("../src/sync.js");
const { decodeSubtitle } = await import("../src/text.js");
const { writtenIn } = await import("../src/subtitlecat.js");

// ---------- the data ----------

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** A cached subtitle's name: "<ref>-<season|movie>-<episode|full>.<ext>", ref as callers pass it ("ss123", "sd1-2"). */
function parseStem(name: string): { ref: string; season?: number; episode?: number } | undefined {
  const m = name.match(/^(.+)-(movie|\d+)-(full|\d+)\.(srt|ass|ssa|vtt|sub)$/i);
  if (!m) return undefined;
  return { ref: /^\d+$/.test(m[1]) ? `ss${m[1]}` : m[1], season: m[2] === "movie" ? undefined : Number(m[2]), episode: m[3] === "full" ? undefined : Number(m[3]) };
}

/** How a sync ended, in the score's words. */
function methodOf(r: SyncResult | undefined): string {
  if (!r) return "failed";
  if (r.noFit) return "wrong file";
  if (r.anchors.length === 0) return "not synced";
  if (r.speechOnly) return "speech (no track)";
  if (r.bySpeech) return "speech";
  if (r.byLines) return "lines";
  if (r.byStarts) return "starts";
  if (r.factor && r.factor !== 1) return `rate x${r.factor.toFixed(4)}`;
  return "shift";
}
const isSynced = (method: string) => !["not synced", "wrong file", "failed", "skipped"].includes(method);

interface Pair {
  id: string;
  file: string;
  subtitle: string;
  /** The newest stored result for the pair: what the server did, at the SYNC_VERSION it ran. */
  live?: { version?: number; method: string };
}

async function loadPairs(): Promise<Pair[]> {
  const pairs = new Map<string, Pair>();
  const names = (await readdir(path.join(dataDir, "synced"))).filter((n) => n.endsWith(".json")).sort();
  for (const name of names) {
    const meta = await readJson<SyncResult>(path.join(dataDir, "synced", name));
    if (!meta?.filename || !meta.source) continue;
    if (!existsSync(path.join(dataDir, "anchors", `${cacheKey({ kind: "file-anchors", filename: meta.filename })}.json`))) continue;
    if (!existsSync(path.join(dataDir, "subtitles", meta.source))) continue;
    const stem = parseStem(meta.source);
    if (!stem) continue;
    const id = `${meta.filename}|${meta.source}`;
    const key = name.replace(/\.json$/, "");
    let version: number | undefined;
    for (let v = 1; v <= sync.SYNC_VERSION; v++) {
      if (cacheKey({ kind: "synced", subtitleId: stem.ref, season: stem.season, episode: stem.episode, filename: meta.filename, version: v }) === key) version = v;
    }
    const pair = pairs.get(id) ?? { id, file: meta.filename, subtitle: meta.source };
    if (!pair.live || (version ?? 0) > (pair.live.version ?? 0)) pair.live = { ...(version ? { version } : {}), method: methodOf(meta) };
    pairs.set(id, pair);
  }
  return [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

type Activity = { kind?: string; what?: string };

/**
 * The subtitle's language, and whether it is a dub caption (synced with no language, as the server
 * does for English that follows an English dub). The text decides the language (Arabic, Dutch,
 * English, else "Other"); an English subtitle is a dub caption when the activity list has an
 * "English Dub" download for the file, or, for a file it doesn't name, for the other files of its
 * title (see dubDecision). docs/scoring.md says where that can be wrong.
 */
function languageOf(raw: Buffer, ext: string, file: string, downloads: string[]): { kind: "translation" | "dub"; lang: string; langBy: string } {
  const { lang, langBy: text } = textLanguage(raw, ext);
  if (lang !== "English") return { kind: "translation", lang, langBy: text };
  const { dub, by } = dubDecision(downloads, sync.fileName(file).replace(/\.(mkv|mp4|avi|m4v|webm)$/i, ""));
  return { kind: dub ? "dub" : "translation", lang: dub ? "English Dub" : lang, langBy: `${text}; ${by}` };
}

/** The language the subtitle's text reads as: Arabic, Dutch or English, else "Other". */
function textLanguage(raw: Buffer, ext: string): { lang: string; langBy: string } {
  const named = ([["arabic", "Arabic"], ["dutch", "Dutch"], ["english", "English"]] as const)
    .filter(([name, lang]) => writtenIn(dialogueText(decodeSubtitle(raw, lang), ext), name))
    .map(([, lang]) => lang);
  return { lang: named[0] ?? "Other", langBy: `text reads as ${named.length ? named.join(" and ") : "none of Arabic, Dutch, English"}` };
}

// ---------- the copy that can't read ----------

/**
 * The stored reading, changed so syncing it reads nothing: every round of extra windows counts as
 * done (MAX_ROUNDS), and a file timed from its index whose audio was never heard counts as heard,
 * with no speech (addSpeech would read it). The second is recorded per pair. Whether syncCaptions
 * takes a stored reading as it is at all is its own rule, stillValid.
 */
function offline(found: FileAnchors): { copy: FileAnchors; speechUnread: boolean } {
  const speechUnread = found.source === "index" && found.audio !== undefined && found.speechBy === undefined;
  return { copy: { ...found, rounds: sync.MAX_ROUNDS, ...(speechUnread ? { speechBy: "silero" as const } : {}) }, speechUnread };
}

// ---------- what the score judges by ----------

interface Reference {
  /** Starts of the file's own lines, every text track read. */
  lines: number[];
  /** Where lines count: undefined for a file timed from its index (all of it is known). */
  lineSpans?: Span[];
  /** Speech onsets heard in the audio (Silero only), and the windows they were heard in. */
  speech: number[];
  speechSpans: Span[];
}

function referenceOf(found: FileAnchors): Reference {
  const lineWindows = found.speechOnly ? [] : found.windows.filter((w) => !w.heard);
  const lines = sortedUnique(lineWindows.flatMap((w) => [...w.cues, ...Object.values(w.others ?? {}).flat()]).map((c) => c.start));
  const heard = found.speechBy === "silero"
    ? found.windows.flatMap((w) => {
        const speech = found.speechOnly ? w.cues : w.speech;
        return speech?.length ? [{ from: w.from, to: w.to, speech }] : [];
      })
    : [];
  return {
    lines,
    ...(found.source === "index" ? {} : { lineSpans: lineWindows.map(({ from, to }) => ({ from, to })) }),
    // Onsets per window: a window starts after a stretch nobody heard.
    speech: sortedUnique(heard.flatMap((w) => onsets(w.speech))),
    speechSpans: heard.map(({ from, to }) => ({ from, to }))
  };
}

// ---------- one pair ----------

interface PairScore {
  id: string;
  file: string;
  subtitle: string;
  kind: "translation" | "dub";
  lang: string;
  langBy: string;
  /** How the file was read: its Matroska index (every line), or windows of it. */
  source: "index" | "windows";
  speechOnly: boolean;
  method: string;
  synced: boolean;
  live?: Pair["live"];
  /** Other file refs with the same stored reading, merged into this pair (see prepare). */
  sameAs?: string[];
  anchors: number;
  offsets?: { min: number; max: number };
  factor?: number;
  /** What the served and uploaded lines are judged against ("hidden lines": see --holdout). */
  reference: "file lines" | "hidden lines" | "speech" | "none";
  referencePoints: number;
  captionLines: number;
  served: Precision;
  uploaded: Precision;
  /**
   * Dub captions: the same against where the voices start, at the lead the sync places this subtitle
   * at (leadMs, voiceLeadFor in src/sync.ts), with the median signed gap of the lines within 1 s
   * (positive: later than that lead).
   */
  speech?: { leadMs: number; served: Precision; uploaded: Precision; servedSignedMs?: number; uploadedSignedMs?: number } | "no reference";
  /** The file's audio was never heard, so speech, the last resort, wasn't there to fall back on. */
  speechUnread?: boolean;
  /** Reads the sync still tried (refused). */
  blocked?: string[];
  skipped?: string;
  log: string[];
}

/** Held out (--holdout): the starts hidden from each file's reading, by file ref. */
const hiddenLines = new Map<string, number[]>();

/** Gaps kept in memory for the medians of the groups; not written out. */
const gapsOf = new Map<string, { served: number[]; uploaded: number[]; speechServed?: number[]; speechUploaded?: number[]; speechServedSigned?: number[]; speechUploadedSigned?: number[] }>();

/** A pair ready to sync: its stored reading, the subtitle as uploaded and the language it goes with. */
interface Prepared extends Pair {
  found: FileAnchors;
  raw: Buffer;
  ext: string;
  kind: "translation" | "dub";
  lang: string;
  langBy: string;
  /** Other file refs whose stored reading is the same, byte for byte: synced once, counted once. */
  sameAs: string[];
}

/**
 * Every pair with its language, pairs that would sync identically merged: two names for one file
 * (with and without its size), or two releases whose index holds the same subtitle track. Syncing
 * reads nothing but the reading, the subtitle and the language, so they'd give the same numbers
 * and only weigh twice.
 */
async function prepare(pairs: Pair[], downloads: string[]): Promise<Prepared[]> {
  const out = new Map<string, Prepared>();
  for (const pair of pairs) {
    const found = (await readJson<FileAnchors>(path.join(dataDir, "anchors", `${cacheKey({ kind: "file-anchors", filename: pair.file })}.json`))) as FileAnchors;
    const raw = await readFile(path.join(dataDir, "subtitles", pair.subtitle));
    const ext = path.extname(pair.subtitle).toLowerCase();
    const language = languageOf(raw, ext, pair.file, downloads);
    const { filename: _name, ...reading } = found;
    const same = `${cacheKey(reading)}|${pair.subtitle}|${language.kind}|${language.lang}`;
    const first = out.get(same);
    if (first) first.sameAs.push(pair.file);
    else out.set(same, { ...pair, found, raw, ext, ...language, sameAs: [] });
  }
  return [...out.values()];
}

async function scorePair(pair: Prepared): Promise<{ score: PairScore; ms: number }> {
  const { found, raw, ext, kind, lang, langBy } = pair;
  const subtitlePath = path.resolve(work, "subtitles", pair.subtitle);
  const stem = parseStem(pair.subtitle)!;
  const passLang = kind === "dub" ? undefined : lang;
  const { speechUnread } = offline(found);

  attempts = [];
  const log: string[] = [];
  const keep = (...args: unknown[]) => void log.push(format(...args));
  const { log: realLog, error: realError } = console;
  let result: SyncResult | undefined;
  let skipped: string | undefined;
  const started = performance.now();
  if (!sync.stillValid(found)) skipped = "the stored reading would be read again (speech not heard by Silero)";
  else {
    console.log = keep;
    console.error = keep;
    try {
      const key = sync.syncKey(stem.ref, stem.season, stem.episode, pair.file);
      result = await sync.syncCaptions(key, async () => ({ file: subtitlePath }), "http://offline.invalid/manifest.json", "tt0000000", stem.season === undefined ? "movie" : "series", pair.file, passLang);
      // Nothing should be left reading in the background (every audio counts as heard), but if it is, it is refused here too.
      await sync.settled();
    } finally {
      console.log = realLog;
      console.error = realError;
    }
  }
  const ms = performance.now() - started;
  const method = skipped ? "skipped" : methodOf(result);

  const uploadedStarts = sync.parseCues(decodeSubtitle(raw, passLang), ext).map((c) => c.start);
  const servedStarts = result && result.anchors.length > 0 ? sync.parseCues(decodeSubtitle(await readFile(result.file), passLang), ext).map((c) => c.start) : uploadedStarts;
  const ref = referenceOf(found);
  // Held out (--holdout): judged by the lines the sync never saw, each line against the nearest
  // served start. A file with no subtitle track has none, so it isn't judged then.
  const held = holdout ? (hiddenLines.get(pair.file) ?? []) : undefined;
  // A file with no subtitle track has only speech to judge by, whatever the language.
  const bySpeech = Boolean(found.speechOnly) && !held;
  const points = bySpeech ? ref.speech : (held ?? ref.lines);
  // Each line is judged at the lead the sync places it at: dub captions lead their voices by less
  // than translations do, and a service's own captions by more than uploads (voiceLeadFor).
  const voiceLead = sync.voiceLeadFor(pair.subtitle);
  const lead = kind === "dub" ? voiceLead : sync.SPEECH_LEAD_MS;
  const judge = (starts: number[]) =>
    bySpeech ? gapsTo(starts, ref.speech, lead, ref.speechSpans) : held ? gapsTo(held, starts, 0, ref.lineSpans) : gapsTo(starts, ref.lines, 0, ref.lineSpans);
  const gaps = { served: judge(servedStarts), uploaded: judge(uploadedStarts) };
  let speech: PairScore["speech"];
  if (kind === "dub") {
    if (ref.speech.length === 0) speech = "no reference";
    else {
      const speechServedSigned = signedGapsTo(servedStarts, ref.speech, voiceLead, ref.speechSpans);
      const speechUploadedSigned = signedGapsTo(uploadedStarts, ref.speech, voiceLead, ref.speechSpans);
      const speechServed = speechServedSigned.map(Math.abs);
      const speechUploaded = speechUploadedSigned.map(Math.abs);
      const servedSignedMs = signedMedian(speechServedSigned);
      const uploadedSignedMs = signedMedian(speechUploadedSigned);
      speech = {
        leadMs: voiceLead,
        served: precision(speechServed),
        uploaded: precision(speechUploaded),
        ...(servedSignedMs === undefined ? {} : { servedSignedMs }),
        ...(uploadedSignedMs === undefined ? {} : { uploadedSignedMs })
      };
      Object.assign(gaps, { speechServed, speechUploaded, speechServedSigned, speechUploadedSigned });
    }
  }
  gapsOf.set(pair.id, gaps);
  const offsets = result?.anchors.map((a) => a.offset) ?? [];
  const score: PairScore = {
    id: pair.id,
    file: pair.file,
    subtitle: pair.subtitle,
    kind,
    lang,
    langBy,
    source: found.source === "index" ? "index" : "windows",
    speechOnly: bySpeech,
    method,
    synced: isSynced(method),
    ...(pair.live ? { live: pair.live } : {}),
    ...(pair.sameAs.length ? { sameAs: pair.sameAs } : {}),
    anchors: offsets.length,
    ...(offsets.length ? { offsets: { min: Math.min(...offsets), max: Math.max(...offsets) } } : {}),
    ...(result?.factor ? { factor: result.factor } : {}),
    reference: points.length === 0 ? "none" : bySpeech ? "speech" : held ? "hidden lines" : "file lines",
    referencePoints: points.length,
    captionLines: uploadedStarts.length,
    served: precision(gaps.served),
    uploaded: precision(gaps.uploaded),
    ...(speech ? { speech } : {}),
    ...(speechUnread ? { speechUnread } : {}),
    ...(attempts.length ? { blocked: [...new Set(attempts)] } : {}),
    ...(skipped ? { skipped } : {}),
    log
  };
  return { score, ms };
}

// ---------- groups ----------

interface Group {
  name: string;
  pairs: number;
  synced: number;
  served: Totals;
  uploaded: Totals;
  /** Dub captions with speech stored, against the voices, with the median signed gap over all their lines within 1 s. */
  speech?: { served: Totals; uploaded: Totals; servedSignedMs?: number; uploadedSignedMs?: number };
}

const signedOf = (which: "served" | "uploaded", ms: number | undefined) => (ms === undefined ? {} : { [`${which}SignedMs`]: ms });

function group(name: string, members: PairScore[]): Group {
  const judged = members.filter((p) => p.reference !== "none");
  const speeched = members.flatMap((p) => (p.speech && p.speech !== "no reference" ? [{ p, s: p.speech }] : []));
  return {
    name,
    pairs: members.length,
    synced: members.filter((p) => p.synced).length,
    served: combine(judged.map((p) => p.served), judged.map((p) => gapsOf.get(p.id)?.served ?? [])),
    uploaded: combine(judged.map((p) => p.uploaded), judged.map((p) => gapsOf.get(p.id)?.uploaded ?? [])),
    ...(speeched.length
      ? {
          speech: {
            served: combine(speeched.map(({ s }) => s.served), speeched.map(({ p }) => gapsOf.get(p.id)?.speechServed ?? [])),
            uploaded: combine(speeched.map(({ s }) => s.uploaded), speeched.map(({ p }) => gapsOf.get(p.id)?.speechUploaded ?? [])),
            ...signedOf("served", signedMedian(speeched.flatMap(({ p }) => gapsOf.get(p.id)?.speechServedSigned ?? []))),
            ...signedOf("uploaded", signedMedian(speeched.flatMap(({ p }) => gapsOf.get(p.id)?.speechUploadedSigned ?? [])))
          }
        }
      : {})
  };
}

/** Every group the table shows: by kind, kind and how the file was read, and those by method. */
function groups(scores: PairScore[]): Group[] {
  const out: Group[] = [];
  const add = (name: string, members: PairScore[]) => members.length && out.push(group(name, members));
  for (const kind of ["translation", "dub"] as const) {
    const ofKind = scores.filter((p) => p.kind === kind);
    add(kind, ofKind);
    add(`${kind}, synced`, ofKind.filter((p) => p.synced));
    for (const source of ["index", "windows"] as const) {
      const here = ofKind.filter((p) => p.source === source);
      add(`${kind} · ${source}`, here);
      for (const method of [...new Set(here.map((p) => p.method))].sort()) add(`${kind} · ${source} · ${method}`, here.filter((p) => p.method === method));
    }
  }
  return out;
}

interface Headline {
  /** Translations that synced: share of their served lines within 0.3 s and 1 s of the file's own, all lines together. */
  score: number;
  score1s: number;
  syncedTranslations: number;
  translations: number;
  /** Every translation pair as served (an unsynced one as it came): what a viewer actually gets. */
  asServed: number;
  asServed1s: number;
}

function headlineOf(groupsFound: Group[], scores: PairScore[]): Headline {
  const synced = groupsFound.find((g) => g.name === "translation, synced");
  const all = groupsFound.find((g) => g.name === "translation");
  return {
    score: synced?.served.lineWeighted[1] ?? 0,
    score1s: synced?.served.lineWeighted[2] ?? 0,
    syncedTranslations: scores.filter((p) => p.kind === "translation" && p.synced).length,
    translations: scores.filter((p) => p.kind === "translation").length,
    asServed: all?.served.lineWeighted[1] ?? 0,
    asServed1s: all?.served.lineWeighted[2] ?? 0
  };
}

// ---------- printing ----------

const pc = (x: number | undefined) => (x === undefined ? "   -" : `${(x * 100).toFixed(0)}%`.padStart(4));
const signed = (ms: number | undefined) => (ms === undefined ? "-" : `${ms > 0 ? "+" : ""}${ms}`).padStart(5);
const three = (xs: number[]) => xs.map(pc).join(" ");
const shortFile = (file: string, width: number) => {
  const name = sync.fileName(file).replace(/\.(mkv|mp4)$/i, "");
  return (name.length > width ? `${name.slice(0, width - 1)}…` : name).padEnd(width);
};
const offsetsText = (p: PairScore) => (p.offsets ? (p.offsets.min === p.offsets.max ? `${p.offsets.min}` : `${p.offsets.min}..${p.offsets.max}`) : "-");

function printPairs(scores: PairScore[]): void {
  const order = (p: PairScore) => (p.kind === "translation" ? 0 : 1);
  const sorted = [...scores].sort((a, b) => order(a) - order(b) || Number(b.synced) - Number(a.synced) || a.served.shares[1] - b.served.shares[1] || a.id.localeCompare(b.id));
  console.log("\nevery pair (served and uploaded: share of lines within 0.1 / 0.3 / 1 s of the reference)");
  console.log(`  ${"kind".padEnd(5)} ${"lang".padEnd(11)} ${"read".padEnd(7)} ${"method".padEnd(17)} ${"lines".padStart(5)}  served         uploaded       med  ${"shift ms".padEnd(13)} file / subtitle`);
  for (const p of sorted) {
    const flags = [p.reference === "speech" ? "vs speech" : p.reference === "none" ? "no reference" : "", p.speechUnread && !p.synced ? "audio never heard" : "", p.blocked ? `tried ${p.blocked.join(", ")}` : "", p.skipped ?? ""].filter(Boolean).join("; ");
    console.log(
      `  ${(p.kind === "dub" ? "dub" : "tr").padEnd(5)} ${p.lang.padEnd(11)} ${p.source.padEnd(7)} ${p.method.padEnd(17)} ${String(p.served.lines).padStart(5)}  ${three(p.served.shares)}  ${three(p.uploaded.shares)} ${String(p.served.medianMs ?? "-").padStart(4)}  ${offsetsText(p).padEnd(13)} ${shortFile(p.file, 50)} ${p.subtitle}${flags ? `  (${flags})` : ""}`
    );
  }
  const dubs = sorted.filter((p) => p.kind === "dub");
  if (dubs.length) {
    console.log("\ndub captions against the voices (line start + its lead against speech onsets after a 250 ms pause; signed: median gap within 1 s, + late)");
    console.log(`  ${"method".padEnd(17)} ${"lead".padStart(4)} ${"lines".padStart(5)}  served         uploaded       signed`);
    for (const p of dubs) {
      const s = p.speech;
      const cells = s === "no reference" || !s ? "no reference" : `${String(s.leadMs).padStart(4)} ${String(s.served.lines).padStart(5)}  ${three(s.served.shares)}  ${three(s.uploaded.shares)}  ${signed(s.servedSignedMs)}/${signed(s.uploadedSignedMs)}`;
      console.log(`  ${p.method.padEnd(17)} ${cells.padEnd(60)}  ${shortFile(p.file, 50)} ${p.subtitle}`);
    }
  }
}

function printGroups(found: Group[]): void {
  console.log("\ngroups (line-weighted shares within 0.1 / 0.3 / 1 s; pair-averaged within 0.3 s; median gap of lines within 1 s)");
  console.log(`  ${"group".padEnd(42)} ${"pairs".padStart(5)} ${"synced".padStart(6)} ${"lines".padStart(6)}  served         uploaded       avg 0.3 s   med`);
  for (const g of found) {
    console.log(
      `  ${g.name.padEnd(42)} ${String(g.pairs).padStart(5)} ${String(g.synced).padStart(6)} ${String(g.served.lines).padStart(6)}  ${three(g.served.lineWeighted)}  ${three(g.uploaded.lineWeighted)}  ${pc(g.served.pairAveraged[1])}/${pc(g.uploaded.pairAveraged[1])} ${String(g.served.medianMs ?? "-").padStart(5)}`
    );
  }
  const speech = found.filter((g) => g.speech && g.name.startsWith("dub"));
  if (speech.length) {
    console.log("\ndub groups against the voices (dub pairs with speech stored: served, uploaded; signed: median gap within 1 s, + late)");
    for (const g of speech) console.log(`  ${g.name.padEnd(42)} ${String(g.speech!.served.pairs).padStart(5)} pairs ${String(g.speech!.served.lines).padStart(6)} lines  ${three(g.speech!.served.lineWeighted)}  ${three(g.speech!.uploaded.lineWeighted)}  ${signed(g.speech!.servedSignedMs)}/${signed(g.speech!.uploadedSignedMs)}`);
  }
}

interface Run {
  label: string;
  commit?: string;
  /** Every this many lines of the file's tracks was hidden from the sync and judged by (--holdout). */
  holdout?: number;
  tolerancesMs: readonly number[];
  headline: Headline;
  groups: Group[];
  pairs: PairScore[];
}

function printComparison(before: Run, now: Run): void {
  const d = (x: number, y: number) => {
    const points = (y - x) * 100;
    return `${points >= 0 ? "+" : ""}${points.toFixed(1)}`;
  };
  console.log(`\ncompared with ${before.label}${before.commit ? ` (${before.commit})` : ""}`);
  if (before.holdout !== now.holdout) console.log(`  WARNING: that run held out ${before.holdout ? `every ${before.holdout}th line` : "no lines"}, this one ${now.holdout ? `every ${now.holdout}th line` : "none"}: the numbers aren't comparable`);
  const h0 = before.headline;
  const h1 = now.headline;
  console.log(`  score (0.3 s)  ${pc(h0.score)} -> ${pc(h1.score)}  (${d(h0.score, h1.score)} points)`);
  console.log(`  within 1 s     ${pc(h0.score1s)} -> ${pc(h1.score1s)}  (${d(h0.score1s, h1.score1s)} points)`);
  console.log(`  synced translations ${h0.syncedTranslations}/${h0.translations} -> ${h1.syncedTranslations}/${h1.translations}`);
  console.log(`  as served, every translation (0.3 s) ${pc(h0.asServed)} -> ${pc(h1.asServed)}  (${d(h0.asServed, h1.asServed)} points)`);
  console.log("\n  groups (served, line-weighted: change in points within 0.1 / 0.3 / 1 s; synced pairs before and now)");
  const old = new Map(before.groups.map((g) => [g.name, g]));
  for (const g of now.groups) {
    const o = old.get(g.name);
    if (!o) {
      console.log(`    ${g.name.padEnd(42)} new`);
      continue;
    }
    const deltas = g.served.lineWeighted.map((x, i) => d(o.served.lineWeighted[i], x).padStart(6)).join(" ");
    console.log(`    ${g.name.padEnd(42)} ${deltas}   synced ${o.synced} -> ${g.synced}`);
  }
  for (const o of before.groups) if (!now.groups.some((g) => g.name === o.name)) console.log(`    ${o.name.padEnd(42)} gone`);
  const changes = pairChanges(before.pairs, now.pairs);
  if (changes.length === 0) {
    console.log("\n  no pair changed");
    return;
  }
  console.log(`\n  pairs that changed (${changes.length}), worst first: method, served within 0.1 / 0.3 / 1 s`);
  const nowById = new Map(now.pairs.map((p) => [p.id, p]));
  for (const c of changes) {
    const p = nowById.get(c.id);
    const [file, subtitle] = c.id.split("|");
    const flag = c.flipped ? `  ** ${c.flipped.toUpperCase()} **` : "";
    const was = c.before ? `${c.before.method} ${three(c.before.served.shares)}` : "absent";
    const is = c.after ? `${c.after.method} ${three(c.after.served.shares)}` : "absent";
    console.log(`    ${(p?.kind ?? "").padEnd(11)} ${shortFile(file, 44)} ${subtitle.padEnd(30)} ${was} -> ${is}  (${c.delta.map((x) => d(0, x)).join(" / ")})${flag}`);
  }
}

// ---------- the cross check: subtitles that belong elsewhere (--negatives) ----------

/** A pair of the cross check, as a process is handed it: files with the same reading merged into it. */
interface CrossJob extends CrossPair {
  id: string;
  sameAs: string[];
}

/** What the cross check records of one pair. */
interface NegativeScore {
  id: string;
  belongs: CrossPair["belongs"];
  samePlace: boolean;
  lang: string;
  source: "index" | "windows";
  speechOnly: boolean;
  method: string;
  synced: boolean;
  ms: number;
  sameAs?: string[];
  /** For a pair served as synced, what tells why: how long each side is, and how the timing sits. */
  detail?: {
    filePlaces: string[];
    subtitlePlaces: string[];
    /** The file's length and the subtitle's first start and last end, minutes. */
    fileMinutes: number;
    captionSpan: [number, number];
    captionLines: number;
    /** The file's own lines (every window read, first track). */
    fileLines: number;
    anchors: number;
    offsets?: { min: number; max: number };
    served: Precision;
    uploaded: Precision;
    log: string[];
  };
  /** For a refused pair, the last reason the sync gave for not counting it as synced. */
  why?: string;
  blocked?: string[];
  skipped?: string;
}

const minutes = (ms: number) => Math.round(ms / 600) / 100;

/** The last reason a sync's log gives for leaving a subtitle unsynced, without the file's name. */
function refusal(log: string[]): string | undefined {
  return log
    .filter((l) => /not counted as synced|don't match this file|left as they are|captions don't match/.test(l))
    .pop()
    ?.replace(/^sync: .*?: (?=[a-z0-9])/i, "");
}

/**
 * Every pair of a played file and a cached subtitle the data shows to belong elsewhere
 * (scripts/cross-pairs.ts), in a fixed order. Files whose readings are the same byte for byte sync
 * alike, so each such set is synced once (its other names under sameAs). With --sample n, only the
 * pairs whose hash falls on every nth: the same ones each run.
 */
async function crossJobs(): Promise<{ jobs: CrossJob[]; readings: Map<string, FileAnchors>; all: number }> {
  const readings = new Map<string, FileAnchors>();
  for (const name of (await readdir(path.join(dataDir, "anchors"))).filter((n) => n.endsWith(".json")).sort()) {
    const found = await readJson<FileAnchors>(path.join(dataDir, "anchors", name));
    if (found?.filename) readings.set(found.filename, found);
  }
  const names = (await readdir(path.join(dataDir, "subtitles"))).sort();
  const subtitles = names.filter((n) => parseStem(n));
  const missing = names.filter((n) => n.endsWith(".missing")).map((n) => n.slice(0, -".missing".length));
  const byBytes = new Map<string, string[]>();
  const texts = new Map<string, string[]>();
  for (const name of subtitles) {
    const raw = await readFile(path.join(dataDir, "subtitles", name));
    const hash = createHash("sha256").update(raw).digest("hex");
    byBytes.set(hash, [...(byBytes.get(hash) ?? []), name]);
    // The words shown, not the numbers and timings around them, to find the same dialogue under other names.
    const ext = path.extname(name).toLowerCase();
    texts.set(name, dialogueText(decodeSubtitle(raw, textLanguage(raw, ext).lang), ext).split(/\r?\n/).filter((l) => l.trim() && !l.includes("-->") && !/^\d+$/.test(l.trim()) && !/^WEBVTT/.test(l)));
  }
  const served: Array<{ file: string; subtitle: string }> = [];
  for (const name of (await readdir(path.join(dataDir, "synced"))).filter((n) => n.endsWith(".json")).sort()) {
    const meta = await readJson<SyncResult>(path.join(dataDir, "synced", name));
    if (meta?.filename && meta.source) served.push({ file: meta.filename, subtitle: meta.source });
  }
  const pairs = crossPairs({ files: [...readings.keys()], subtitles, served, missing, sameBytes: [...byBytes.values()].filter((g) => g.length > 1), sameDialogue: sameDialogueGroups(texts) }, { own });
  const readingOf = new Map([...readings].map(([file, { filename: _name, ...reading }]) => [file, cacheKey(reading)]));
  const merged = new Map<string, CrossJob>();
  for (const pair of pairs) {
    const same = `${readingOf.get(pair.file)}|${pair.subtitle}`;
    const first = merged.get(same);
    if (first) first.sameAs.push(pair.file);
    else merged.set(same, { ...pair, id: `${pair.file}|${pair.subtitle}`, sameAs: [] });
  }
  let jobs = [...merged.values()];
  const all = jobs.length;
  if (sample > 1) jobs = jobs.filter((j) => sampleOrder(j.id) % sample === 0);
  if (only) jobs = jobs.filter((j) => j.id.toLowerCase().includes(only.toLowerCase()));
  return { jobs, readings, all };
}

/** Each subtitle's language, told once per process: its text doesn't change from pair to pair. */
const languages = new Map<string, { lang: string; langBy: string }>();

/** One pair of the cross check, synced as a translation in the language its text reads as. */
async function negativeScore(job: CrossJob, found: FileAnchors): Promise<NegativeScore> {
  const raw = await readFile(path.join(dataDir, "subtitles", job.subtitle));
  const ext = path.extname(job.subtitle).toLowerCase();
  // A translation is tried by every timing a dub caption is, and by line and by line starts too:
  // whatever a dub caption could be served as synced by, a translation could as well.
  const { lang, langBy } = languages.get(job.subtitle) ?? languages.set(job.subtitle, textLanguage(raw, ext)).get(job.subtitle)!;
  const { score, ms } = await scorePair({ id: job.id, file: job.file, subtitle: job.subtitle, found, raw, ext, kind: "translation", lang, langBy, sameAs: job.sameAs });
  gapsOf.delete(job.id);
  const captions = sync.parseCues(decodeSubtitle(raw, lang), ext);
  const fileLines = found.windows.filter((w) => !w.heard && !w.bridge).reduce((n, w) => n + w.cues.length, 0);
  return {
    id: job.id,
    belongs: job.belongs,
    samePlace: job.samePlace,
    lang,
    source: score.source,
    speechOnly: Boolean(found.speechOnly),
    method: score.method,
    synced: score.synced,
    ms: Math.round(ms),
    ...(job.sameAs.length ? { sameAs: job.sameAs } : {}),
    ...(score.synced
      ? {
          detail: {
            filePlaces: job.filePlaces,
            subtitlePlaces: job.subtitlePlaces,
            fileMinutes: minutes(found.duration),
            captionSpan: [minutes(Math.min(...captions.map((c) => c.start))), minutes(Math.max(...captions.map((c) => c.end)))],
            captionLines: captions.length,
            fileLines,
            anchors: score.anchors,
            ...(score.offsets ? { offsets: score.offsets } : {}),
            served: score.served,
            uploaded: score.uploaded,
            log: score.log.filter((l) => l.startsWith("sync:"))
          }
        }
      : {}),
    ...(!score.synced && refusal(score.log) ? { why: refusal(score.log) } : {}),
    ...(score.blocked ? { blocked: score.blocked } : {}),
    ...(score.skipped ? { skipped: score.skipped } : {})
  };
}

/** Syncs these pairs in this process, against a copy of their data that can't read. */
async function runNegatives(jobs: CrossJob[], readings: Map<string, FileAnchors>): Promise<NegativeScore[]> {
  await rm(work, { recursive: true, force: true });
  for (const dir of ["anchors", "subtitles", "synced"]) await mkdir(path.join(work, dir), { recursive: true });
  const out: NegativeScore[] = [];
  try {
    for (const file of new Set(jobs.map((j) => j.file))) {
      await writeFile(path.join(work, "anchors", `${cacheKey({ kind: "file-anchors", filename: file })}.json`), JSON.stringify(offline(readings.get(file)!).copy));
    }
    for (const subtitle of new Set(jobs.map((j) => j.subtitle))) await copyFile(path.join(dataDir, "subtitles", subtitle), path.join(work, "subtitles", subtitle));
    for (const job of jobs) out.push(await negativeScore(job, readings.get(job.file)!));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return out;
}

/**
 * The pairs split over `count` processes of this script (--shard), each with a copy of the data of
 * its own: a sync keeps its state in the module and its cache folder, so one process syncs one pair
 * at a time. Pairs are dealt out in turn, so each process gets files of every length.
 */
async function runInShards(jobs: CrossJob[], count: number): Promise<NegativeScore[]> {
  const shards = Array.from({ length: count }, (_, k) => jobs.filter((_, i) => i % count === k)).filter((s) => s.length);
  const script = fileURLToPath(import.meta.url);
  await mkdir(path.resolve(".replay"), { recursive: true });
  const results = await Promise.all(
    shards.map(async (part, k) => {
      const handed = path.resolve(".replay", `negatives-shard-${process.pid}-${k}.json`);
      await writeFile(handed, JSON.stringify(part));
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [...process.execArgv, script, "--negatives", "--data", dataDir, "--shard", handed], { stdio: ["ignore", "ignore", "inherit"] });
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`shard ${k} exited with ${code}`))));
        });
        return (await readJson<NegativeScore[]>(`${handed}.out.json`)) ?? [];
      } finally {
        await rm(handed, { force: true });
        await rm(`${handed}.out.json`, { force: true });
      }
    })
  );
  const order = new Map(jobs.map((j, i) => [j.id, i]));
  return results.flat().sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

type NegativeRun = { label: string; commit?: string; sample: number; pairs: NegativeScore[] };

function printNegatives(run: NegativeRun, all: number, seconds: number, before?: NegativeRun): void {
  const classes = ["sibling", "other", "elsewhere", "own"] as const;
  const what: Record<(typeof classes)[number], string> = {
    sibling: "another episode of the file's show",
    other: "another title (another show, or a film against an episode)",
    elsewhere: "another episode, of a show no played file is",
    own: "the file's own, the same show and place (--own): to stay synced"
  };
  const shown = classes.filter((c) => c !== "own" || run.pairs.some((p) => p.belongs === "own"));
  const negativePairs = run.pairs.filter((p) => p.belongs !== "own");
  console.log(`\ncross check: ${negativePairs.length} pairs of a played file and a subtitle that belongs elsewhere${run.sample > 1 ? ` (1 in ${run.sample} of ${all}, by hash)` : ""}`);
  console.log(`  ${"class".padEnd(10)} ${"pairs".padStart(6)} ${"synced".padStart(6)}  how the synced ones were timed`);
  for (const c of shown) {
    const members = run.pairs.filter((p) => p.belongs === c);
    const synced = members.filter((p) => p.synced);
    const methods = [...new Set(synced.map((p) => p.method))].sort().map((m) => `${m} ${synced.filter((p) => p.method === m).length}`);
    console.log(`  ${c.padEnd(10)} ${String(members.length).padStart(6)} ${String(synced.length).padStart(6)}  ${methods.join(", ") || "-"}   (${what[c]})`);
  }
  const refused = new Map<string, number>();
  for (const p of negativePairs.filter((x) => !x.synced)) refused.set(p.method, (refused.get(p.method) ?? 0) + 1);
  console.log(`  refused: ${[...refused].map(([m, n]) => `${m} ${n}`).join(", ")}`);
  const accepted = negativePairs.filter((p) => p.synced);
  if (accepted.length) {
    console.log(`\nSERVED AS SYNCED (${accepted.length}): class, method, places (file / subtitle), file length, subtitle's span, lines (subtitle / file), shift, served within 0.1 / 0.3 / 1 s`);
    for (const p of accepted) {
      const d = p.detail!;
      const [file, subtitle] = p.id.split("|");
      const shift = d.offsets ? (d.offsets.min === d.offsets.max ? `${d.offsets.min}` : `${d.offsets.min}..${d.offsets.max}`) : "-";
      console.log(
        `  ${p.belongs.padEnd(9)} ${p.method.padEnd(10)} ${d.filePlaces.join(",")} / ${d.subtitlePlaces.join(",")}  ${d.fileMinutes} min  ${d.captionSpan[0]}-${d.captionSpan[1]} min  ${d.captionLines}/${d.fileLines} lines  ${shift} ms  ${three(d.served.shares)}  ${p.lang}  ${shortFile(file, 44)} ${subtitle}`
      );
      for (const line of d.log) console.log(`      ${line.replace(/^sync: [^:]*: /, "")}`);
    }
  }
  const blocked = run.pairs.filter((p) => p.blocked);
  const skipped = run.pairs.filter((p) => p.skipped);
  if (blocked.length) console.log(`WARNING: ${blocked.length} pairs still tried to read (refused)`);
  if (skipped.length) console.log(`skipped ${skipped.length} (stored reading would be read again)`);
  if (before) {
    const was = new Map(before.pairs.map((p) => [p.id, p]));
    const now = new Set(run.pairs.map((p) => p.id));
    console.log(`\ncompared with ${before.label}${before.commit ? ` (${before.commit})` : ""}${before.sample !== run.sample ? `; WARNING: that run sampled 1 in ${before.sample}, this one 1 in ${run.sample}` : ""}`);
    for (const c of shown) {
      const count = (r: NegativeRun) => r.pairs.filter((p) => p.belongs === c && p.synced).length;
      console.log(`  ${c.padEnd(10)} synced ${count(before)} -> ${count(run)}`);
    }
    const only = [run.pairs.filter((p) => !was.has(p.id)).length, before.pairs.filter((p) => !now.has(p.id)).length];
    if (only[0] || only[1]) console.log(`  ${only[0]} pairs only in this run, ${only[1]} only in that one (the data or how pairs are told changed)`);
    for (const p of run.pairs) {
      const o = was.get(p.id);
      if (!o || o.synced === p.synced) continue;
      const flag = p.belongs === "own" ? (p.synced ? "own now synced  " : "** OWN LOST **  ") : p.synced ? "** NOW SYNCED **" : "now refused     ";
      console.log(`  ${flag} ${p.belongs.padEnd(9)} ${o.method} -> ${p.method}  ${p.id}`);
      if (p.why) console.log(`        ${p.why}`);
    }
  }
  const owned = run.pairs.filter((p) => p.belongs === "own");
  const slow = [...run.pairs].sort((a, b) => b.ms - a.ms)[0];
  console.log(`\n${accepted.length} of ${negativePairs.length} served as synced${owned.length ? `; own pairs ${owned.filter((p) => p.synced).length} of ${owned.length} synced` : ""}; ${seconds.toFixed(0)} s${slow ? ` (slowest pair ${(slow.ms / 1000).toFixed(1)} s)` : ""}`);
}

async function negativesMain(): Promise<void> {
  const started = performance.now();
  if (shard) {
    // One process's part of the pairs (see runInShards): synced, and written beside the list handed in.
    const part = (await readJson<CrossJob[]>(shard)) ?? [];
    const readings = new Map<string, FileAnchors>();
    for (const file of new Set(part.map((j) => j.file))) readings.set(file, (await readJson<FileAnchors>(path.join(dataDir, "anchors", `${cacheKey({ kind: "file-anchors", filename: file })}.json`)))!);
    await writeFile(`${shard}.out.json`, JSON.stringify(await runNegatives(part, readings)));
    return;
  }
  if (!existsSync(path.join(dataDir, "synced"))) throw new Error(`no replay cache at ${dataDir} (pass --data <folder with anchors/, subtitles/, synced/>)`);
  const { jobs: list, readings, all } = await crossJobs();
  if (list.length === 0) throw new Error("no pairs to check");
  console.log(`cross check: ${list.length} pairs, ${Math.min(jobs, list.length)} processes`);
  const pairs = jobs > 1 && list.length > 1 ? await runInShards(list, Math.min(jobs, list.length)) : await runNegatives(list, readings);
  // Only what tells a refusal apart is kept of a refused pair, so the file stays small.
  const run: NegativeRun = { label, ...(commit ? { commit } : {}), sample, pairs: pairs.map((p) => (p.synced ? p : { id: p.id, belongs: p.belongs, samePlace: p.samePlace, lang: p.lang, source: p.source, speechOnly: p.speechOnly, method: p.method, synced: false, ms: p.ms, ...(p.why ? { why: p.why } : {}), ...(p.skipped ? { skipped: p.skipped } : {}), ...(p.blocked ? { blocked: p.blocked } : {}) })) };
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(run, null, 1)}\n`);
  const before = comparePath ? await readJson<NegativeRun>(path.resolve(comparePath)) : undefined;
  if (comparePath && !before) throw new Error(`can't read ${comparePath}`);
  printNegatives(run, all, (performance.now() - started) / 1000, before);
  console.log(`written to ${path.relative(process.cwd(), outFile)}`);
  if (run.pairs.some((p) => p.synced && p.belongs !== "own")) process.exitCode = 1;
}

// ---------- the run ----------

async function main(): Promise<void> {
  const started = performance.now();
  if (!existsSync(path.join(dataDir, "synced"))) throw new Error(`no replay cache at ${dataDir} (pass --data <folder with anchors/, subtitles/, synced/>)`);
  let pairs = await loadPairs();
  if (only) pairs = pairs.filter((p) => p.id.toLowerCase().includes(only.toLowerCase()));
  if (pairs.length === 0) throw new Error("no pairs to score");
  const activity = (await readJson<Activity[]>(path.join(dataDir, "stats", "activity.json"))) ?? [];
  const downloads = activity.flatMap((a) => (a.kind === "download" && a.what ? [a.what] : []));
  const prepared = await prepare(pairs, downloads);

  await rm(work, { recursive: true, force: true });
  await mkdir(path.join(work, "anchors"), { recursive: true });
  await mkdir(path.join(work, "subtitles"), { recursive: true });
  await mkdir(path.join(work, "synced"), { recursive: true });
  const scores: PairScore[] = [];
  const times: Array<{ id: string; ms: number }> = [];
  try {
    for (const file of new Set(pairs.map((p) => p.file))) {
      const name = `${cacheKey({ kind: "file-anchors", filename: file })}.json`;
      const found = (await readJson<FileAnchors>(path.join(dataDir, "anchors", name))) as FileAnchors;
      const { copy } = offline(found);
      // The sync is given the reading without the held-out lines; they are kept to judge by.
      const held = holdout ? hideLines(copy, holdout) : undefined;
      if (held) hiddenLines.set(file, held.hidden);
      await writeFile(path.join(work, "anchors", name), JSON.stringify(held ? held.kept : copy));
    }
    for (const subtitle of new Set(pairs.map((p) => p.subtitle))) await copyFile(path.join(dataDir, "subtitles", subtitle), path.join(work, "subtitles", subtitle));
    for (const pair of prepared) {
      const { score, ms } = await scorePair(pair);
      scores.push(score);
      times.push({ id: pair.id, ms });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const found = groups(scores);
  const headline = headlineOf(found, scores);
  const run: Run = { label, ...(commit ? { commit } : {}), ...(holdout ? { holdout } : {}), tolerancesMs: TOLERANCES_MS, headline, groups: found, pairs: scores };
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(run, null, 1)}\n`);

  if (!brief) printPairs(scores);
  printGroups(found);
  const blocked = scores.filter((p) => p.blocked);
  const skipped = scores.filter((p) => p.skipped);
  const differ = scores.filter((p) => p.live && p.live.version === sync.SYNC_VERSION && p.live.method !== p.method);
  console.log(`\n${scores.length} pairs (${scores.filter((p) => p.kind === "translation").length} translations, ${scores.filter((p) => p.kind === "dub").length} dub captions), ${scores.filter((p) => p.synced).length} synced; ${pairs.length - scores.length} more merged into them (same reading, subtitle and language)`);
  if (blocked.length) console.log(`WARNING: ${blocked.length} pairs still tried to read (refused): ${blocked.map((p) => `${p.id} [${p.blocked!.join(", ")}]`).join("; ")}`);
  if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.map((p) => p.id).join("; ")}`);
  console.log(`${differ.length} pairs end differently from the server's own result at sync version ${sync.SYNC_VERSION}`);
  const slow = [...times].sort((a, b) => b.ms - a.ms);
  console.log(`slowest pair ${(slow[0].ms / 1000).toFixed(1)} s (${slow[0].id})${slow.some((t) => t.ms > 5000) ? `; WARNING: ${slow.filter((t) => t.ms > 5000).length} took over 5 s` : ""}`);
  if (holdout) console.log(`\nscore, held out: ${pc(headline.score)} of the hidden lines have a synced translation's line within 0.3 s (${pc(headline.score1s)} within 1 s), over ${headline.syncedTranslations} of ${headline.translations} translation pairs`);
  else console.log(`\nscore: ${pc(headline.score)} of synced translations' lines within 0.3 s of the file's own (${pc(headline.score1s)} within 1 s), over ${headline.syncedTranslations} of ${headline.translations} translation pairs`);
  console.log(`as served, every translation pair: ${pc(headline.asServed)} within 0.3 s, ${pc(headline.asServed1s)} within 1 s`);
  if (holdout) console.log(`held out: every ${holdout}th line of the file's tracks hidden from the sync; each hidden line judged against the nearest served line start (files with no subtitle track left out)`);
  if (comparePath) {
    const before = await readJson<Run>(path.resolve(comparePath));
    if (!before) throw new Error(`can't read ${comparePath}`);
    printComparison(before, run);
  }
  console.log(`\nwritten to ${path.relative(process.cwd(), outFile)}; ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

(negatives ? negativesMain() : main()).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
