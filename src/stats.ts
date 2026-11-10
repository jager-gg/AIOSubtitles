/**
 * The dashboard's numbers (usage and health), so the owner can see what the addon costs this server. Counts
 * per day go to cache/stats/<date>.json (the cache survives deploys), written
 * every minute and on shutdown. Only numbers and anonymous link ids are kept:
 * never keys, URLs or what anyone watched.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, statfs, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cachePath } from "./cache.js";
import { knownLinks, linkSummary, type LinkSummary } from "./profile.js";

type Counters = Record<string, number>;

interface Day {
  date: string;
  total: Counters;
  /** Per link (Profile.name: AIOStreams uuid prefix and key tag), with lastSeen as epoch ms. */
  links: Record<string, Counters>;
  /** Highest memory seen: Node alone (rssMb), and the whole container with any ffmpeg running (memMb). */
  peak: { load1?: number; rssMb?: number; memMb?: number };
  /**
   * Per API key ("subsource:3fa2c1", an anonymous id from a hash of the key): calls, calls the
   * service refused, the busiest minute, and the quota the service reported, if it ever did.
   */
  keys?: Record<string, KeyUsage>;
}

export interface KeyUsage {
  /** Every call made with the key, downloads included. */
  calls: number;
  /** The calls that were downloads (SubDL limits them on their own). */
  downloads?: number;
  refused: number;
  busiestMinute: number;
  /** The link that used it last. */
  link?: string;
  lastAt?: number;
  lastRefusedAt?: number;
  /** The site's own rate-limit headers from the newest call, as sent (numbers and times, never the key). */
  headers?: Record<string, string>;
}

/** Calls made with one key in the last minute, hour and 24 hours, for limits counted that way. */
export interface KeyWindows {
  minute: number;
  hour: number;
  day: number;
}

/** One request, for the recent-activity list: the owner's own view, so the episode is kept. */
export interface Activity {
  at: number;
  link: string;
  kind: "list" | "download";
  what: string;
  result: string;
  ms: number;
}

/** Which link a request is for, carried through everything it starts (searches, downloads, syncs). */
export const requestContext = new AsyncLocalStorage<{ link: string }>();

export interface ErrorNote {
  at: number;
  where: string;
  message: string;
  /** The link whose request it happened in, and what that request was for, when known. */
  link?: string;
  what?: string;
}

const KEEP_DAYS = 60;
const started = Date.now();
let today: Day = emptyDay(dateOf(Date.now()));
/** How many recent errors are kept for the dashboard; a count since a clear can't go past it. */
export const ERRORS_KEPT = 30;
let errors: ErrorNote[] = [];
/** When the owner last cleared the recent errors (errors-cleared.json); 0 for never. */
let errorsClearedAt = 0;
let activity: Activity[] = [];
let loaded = false;
let dirty = false;

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyDay(date: string): Day {
  return { date, total: {}, links: {}, peak: {} };
}

function dir(): string {
  return cachePath("stats");
}

function rollover(): void {
  const date = dateOf(Date.now());
  if (today.date === date) return;
  void flush(today);
  today = emptyDay(date);
}

/** Adds n to a counter for today, and to the link's: the one given, or the request's for calls to sites. */
export function count(name: string, n = 1, link: string | undefined = /^(api|fetch)\./.test(name) ? requestContext.getStore()?.link : undefined): void {
  if (!Number.isFinite(n) || n === 0) return;
  rollover();
  today.total[name] = (today.total[name] ?? 0) + n;
  if (link) {
    const mine = (today.links[link] ??= {});
    mine[name] = (mine[name] ?? 0) + n;
    mine.lastSeen = Date.now();
  }
  dirty = true;
}

/** Today's total for a counter so far. */
export function countedToday(name: string): number {
  rollover();
  return today.total[name] ?? 0;
}

/** Busiest minute per key, kept in memory: the minute being counted and its calls so far. */
const minutes = new Map<string, { minute: number; calls: number }>();

/** The anonymous id of a key: the service and a short hash, never the key. */
export function keyId(service: string, key: string): string {
  return `${service}:${createHash("sha256").update(key).digest("hex").slice(0, 6)}`;
}

/**
 * One call made with a key: counted for that key and the request's link, with the busiest minute,
 * a refusal when the service answers 429 (too many requests), and any quota the service reports.
 */
export function noteKeyCall(service: string, key: string | undefined, response: Response | undefined, download = false): void {
  if (!key) return;
  rollover();
  const id = keyId(service, key);
  const usage = ((today.keys ??= {})[id] ??= { calls: 0, refused: 0, busiestMinute: 0 });
  usage.calls++;
  if (download) usage.downloads = (usage.downloads ?? 0) + 1;
  usage.lastAt = Date.now();
  const times = (recentCalls[id] ??= []);
  times.push(Date.now());
  // A day of calls at most: enough for a 24-hour window, and capped well above a free plan's day.
  if (times.length > 12000 || Date.now() - times[0] > DAY_MS) recentCalls[id] = times.filter((t) => Date.now() - t < DAY_MS).slice(-12000);
  const link = requestContext.getStore()?.link;
  if (link) usage.link = link;
  const minute = Math.floor(Date.now() / 60000);
  const current = minutes.get(id);
  const now = current && current.minute === minute ? { minute, calls: current.calls + 1 } : { minute, calls: 1 };
  minutes.set(id, now);
  usage.busiestMinute = Math.max(usage.busiestMinute, now.calls);
  if (response) {
    if (response.status === 429) {
      usage.refused++;
      usage.lastRefusedAt = Date.now();
    }
    // SubSource says it sends rate-limit headers but not their names: keep whatever looks like one.
    const rate: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (/rate|limit|quota|retry-after|remaining|usage/i.test(name) && value.length <= 64) rate[name] = value;
    });
    if (Object.keys(rate).length) usage.headers = rate;
  }
  dirty = true;
}

const DAY_MS = 86_400_000;
/** Each key's call times over the last day, kept across restarts (keys-recent.json). */
let recentCalls: Record<string, number[]> = {};

/** Calls in the last minute, hour and 24 hours for each key. */
export function keyWindows(): Record<string, KeyWindows> {
  const now = Date.now();
  const out: Record<string, KeyWindows> = {};
  for (const [id, times] of Object.entries(recentCalls)) {
    let minute = 0;
    let hour = 0;
    let day = 0;
    for (const t of times) {
      const age = now - t;
      if (age < DAY_MS) day++;
      if (age < 3_600_000) hour++;
      if (age < 60_000) minute++;
    }
    if (day) out[id] = { minute, hour, day };
  }
  return out;
}

/**
 * A link's keys, noted on each of its requests even when nothing is fetched (a cached list), so
 * every key shows on the usage page from the link's first use, before its first call.
 */
export function noteLinkKeys(link: string, keys: Array<[service: string, key: string | undefined]>): void {
  rollover();
  for (const [service, key] of keys) {
    if (!key) continue;
    const usage = ((today.keys ??= {})[keyId(service, key)] ??= { calls: 0, refused: 0, busiestMinute: 0 });
    if (usage.link !== link && !usage.lastAt) {
      usage.link = link;
      dirty = true;
    }
  }
}

/** Names links were given on the configure page, by link id (labels.json). */
let labels: Record<string, string> = {};

/** The name a link carries, noted from its requests so the dashboard can show it. */
export function noteLinkLabel(link: string, label: string | undefined): void {
  if (!label || labels[link] === label) return;
  labels = { ...labels, [link]: label };
  dirty = true;
}

/** How much activity is kept: the last 7 days, at most this many (about 750 KB on disk). */
const ACTIVITY_DAYS = 7;
const ACTIVITY_MAX = 5000;
export const ACTIVITY_PAGE = 50;

/** One finished request, for the activity list (see ACTIVITY_DAYS). */
export function noteActivity(entry: Omit<Activity, "at">): void {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  activity = [{ at: Date.now(), ...entry }, ...activity.filter((a) => a.at >= since)].slice(0, ACTIVITY_MAX);
  dirty = true;
}

/** One page of activity, newest first, of one link and one kind ("list" or "download") when given. */
export function activityPage(query: { offset?: number; link?: string; kind?: string; limit?: number } = {}): { rows: Activity[]; total: number; offset: number } {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  const matching = activity.filter((a) => a.at >= since && (!query.link || a.link === query.link) && (!query.kind || (query.kind === "error" ? a.result.startsWith("error") : a.kind === query.kind)));
  // As many as fit the viewer's screen (the page asks), from 3 to ACTIVITY_PAGE.
  const size = Math.min(ACTIVITY_PAGE, Math.max(3, Math.floor(query.limit || ACTIVITY_PAGE)));
  const last = Math.max(0, Math.floor((matching.length - 1) / size) * size);
  const offset = Math.min(Math.max(0, Math.floor((query.offset ?? 0) / size) * size), last);
  return { rows: matching.slice(offset, offset + size), total: matching.length, offset };
}

/** What the subtitles players fetched in the last 7 days came out as. */
export function syncOutcomes(): { served: number; synced: number; byAudio: number; asIs: number; failed: number } {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  const out = { served: 0, synced: 0, byAudio: 0, asIs: 0, failed: 0 };
  for (const a of activity) {
    if (a.at < since || a.kind !== "download") continue;
    out.served++;
    if (a.result.startsWith("error")) out.failed++;
    else if (a.result.startsWith("synced") || a.result === "first-pass timing") {
      out.synced++;
      if (a.result.includes("audio")) out.byAudio++;
    } else out.asIs++;
  }
  return out;
}

/** Every link in the kept activity, for the dashboard's link filter. */
export function activityLinks(): string[] {
  return [...new Set(activity.map((a) => a.link))];
}

/** The owner's names for links, as the dashboard shows them (names.json, then configure-page names). */
export async function linkNames(): Promise<Record<string, string>> {
  return { ...(await readNames()), ...labels };
}

/** Text with addresses and long tokens taken out, since upstream messages can quote them. */
export function scrub(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<token>")
    .slice(0, 300);
}

/** A failure worth showing on the stats page (also counted as errors.<where>). */
export function noteError(where: string, error: unknown, what?: string): void {
  // A pack refused for not holding the episode is AIOSubtitles doing its job, not an error.
  if (error instanceof Error && error.name === "EpisodeNotInPack") {
    count("downloads.notInPack");
    return;
  }
  const message = scrub(error instanceof Error ? error.message : String(error));
  count(`errors.${where}`);
  const link = requestContext.getStore()?.link;
  errors = [{ at: Date.now(), where, message, ...(link ? { link } : {}), ...(what ? { what } : {}) }, ...errors].slice(0, ERRORS_KEPT);
  dirty = true;
}

/**
 * Empties the recent-errors list, so errors after a fix stand out. The per-day error counts stay:
 * they're the history the charts draw.
 */
export async function clearErrors(): Promise<void> {
  undoClear = { errors, clearedAt: errorsClearedAt };
  errors = [];
  errorsClearedAt = Date.now();
  dirty = true;
  await flush();
}

/** The list and clear time from before the last clear, for Undo (in memory; gone on restart). */
let undoClear: { errors: ErrorNote[]; clearedAt: number } | undefined;

/** Puts back what the last clear removed, with any errors since then on top. */
export async function undoClearErrors(): Promise<boolean> {
  if (!undoClear) return false;
  errors = [...errors, ...undoClear.errors].slice(0, ERRORS_KEPT);
  errorsClearedAt = undoClear.clearedAt;
  undoClear = undefined;
  dirty = true;
  await flush();
  return true;
}

/** Whether the last clear can still be undone. */
export function canUndoClear(): boolean {
  return Boolean(undoClear);
}

async function flush(day: Day = today): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    await writeFile(path.join(dir(), `${day.date}.json`), JSON.stringify(day));
    await writeFile(path.join(dir(), "errors.json"), JSON.stringify(errors));
    await writeFile(path.join(dir(), "errors-cleared.json"), JSON.stringify({ at: errorsClearedAt }));
    await writeFile(path.join(dir(), "activity.json"), JSON.stringify(activity));
    await writeFile(path.join(dir(), "keys-recent.json"), JSON.stringify(recentCalls));
    await writeFile(path.join(dir(), "labels.json"), JSON.stringify(labels));
    dirty = false;
  } catch (error) {
    console.error(`stats: not saved: ${error instanceof Error ? error.message : error}`);
  }
}

let lastCpu = process.cpuUsage();

/**
 * What this container uses, from its own counters: the cgroup holds
 * AIOSubtitles and every ffmpeg it starts, and the network namespace sees only its
 * traffic. Nothing else on the machine is in these numbers. Undefined where
 * they can't be read (outside a container, on another OS).
 */
interface Own {
  at: number;
  cpuUsec?: number;
  memBytes?: number;
  memPeakBytes?: number;
  rx?: number;
  tx?: number;
}

async function readNumber(file: string, key?: string): Promise<number | undefined> {
  try {
    const text = await readFile(file, "utf8");
    const raw = key ? text.match(new RegExp(`^${key}\\s+(\\d+)`, "m"))?.[1] : text.trim();
    const value = Number(raw);
    return raw && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readOwn(): Promise<Own> {
  const own: Own = {
    at: Date.now(),
    cpuUsec: await readNumber("/sys/fs/cgroup/cpu.stat", "usage_usec"),
    memBytes: await readNumber("/sys/fs/cgroup/memory.current"),
    memPeakBytes: await readNumber("/sys/fs/cgroup/memory.peak")
  };
  try {
    for (const name of await readdir("/sys/class/net")) {
      if (name === "lo") continue;
      const rx = await readNumber(`/sys/class/net/${name}/statistics/rx_bytes`);
      const tx = await readNumber(`/sys/class/net/${name}/statistics/tx_bytes`);
      if (rx !== undefined) own.rx = (own.rx ?? 0) + rx;
      if (tx !== undefined) own.tx = (own.tx ?? 0) + tx;
    }
  } catch {}
  return own;
}

let lastOwn: Own | undefined;
/** Share of one core the container used over the last minute, percent. */
let cpuPercent: number | undefined;

/** Growth since the last reading; a counter that went back (the container restarted) counts from zero. */
function grew(now?: number, before?: number): number | undefined {
  if (now === undefined || before === undefined) return undefined;
  return now >= before ? now - before : now;
}

/** Once a minute (and on shutdown): the container's CPU time, data in and out, and memory, then save. */
async function sample(): Promise<void> {
  rollover();
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  count("cpu.ms", Math.round((cpu.user + cpu.system) / 1000));
  today.peak.rssMb = Math.max(today.peak.rssMb ?? 0, Math.round(process.memoryUsage().rss / 1048576));
  const own = await readOwn();
  if (lastOwn) {
    const cpuUsec = grew(own.cpuUsec, lastOwn.cpuUsec);
    if (cpuUsec !== undefined) {
      count("own.cpu.ms", Math.round(cpuUsec / 1000));
      cpuPercent = (cpuUsec / 1000 / Math.max(1, own.at - lastOwn.at)) * 100;
    }
    count("net.rx", grew(own.rx, lastOwn.rx) ?? 0);
    count("net.tx", grew(own.tx, lastOwn.tx) ?? 0);
  }
  lastOwn = own;
  if (own.memBytes !== undefined) today.peak.memMb = Math.max(today.peak.memMb ?? 0, Math.round(own.memBytes / 1048576));
  if (dirty) await flush();
}

/** Loads today's counts and recent errors, starts the minute timer, saves on shutdown, prunes old days. */
export async function startStats(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(await readFile(path.join(dir(), `${today.date}.json`), "utf8")) as Day;
    // Counts made before the file was read are added on top.
    for (const [k, v] of Object.entries(today.total)) saved.total[k] = (saved.total[k] ?? 0) + v;
    today = { ...saved, links: { ...saved.links, ...today.links }, peak: saved.peak ?? {}, keys: { ...(saved.keys ?? {}), ...(today.keys ?? {}) } };
  } catch {}
  try {
    // Refused packs were once noted as errors; they aren't (see noteError), so old notes go.
    errors = (JSON.parse(await readFile(path.join(dir(), "errors.json"), "utf8")) as ErrorNote[]).filter((e) => !/is an archive without S\d+E\d+/.test(e.message));
  } catch {}
  try {
    errorsClearedAt = (JSON.parse(await readFile(path.join(dir(), "errors-cleared.json"), "utf8")) as { at?: number }).at ?? 0;
  } catch {}
  try {
    activity = JSON.parse(await readFile(path.join(dir(), "activity.json"), "utf8")) as Activity[];
  } catch {}
  try {
    const saved = JSON.parse(await readFile(path.join(dir(), "keys-recent.json"), "utf8")) as Record<string, number[]>;
    for (const [id, times] of Object.entries(saved)) recentCalls[id] = [...times.filter((t) => Date.now() - t < DAY_MS), ...(recentCalls[id] ?? [])];
  } catch {}
  try {
    labels = { ...(JSON.parse(await readFile(path.join(dir(), "labels.json"), "utf8")) as Record<string, string>), ...labels };
  } catch {}
  lastOwn = await readOwn();
  setInterval(() => void sample(), 60_000).unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      // The last minute's CPU and data are counted before saving.
      void sample()
        .then(() => flush())
        .finally(() => process.exit(0));
    });
  }
  try {
    const cutoff = dateOf(Date.now() - KEEP_DAYS * 86400_000);
    for (const name of await readdir(dir())) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < cutoff) await rm(path.join(dir(), name));
    }
  } catch {}
}

async function dirSize(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files++;
        bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(root);
  return { bytes, files };
}

export interface StatsView {
  version: string;
  uptimeS: number;
  now: {
    cores: number;
    /** Share of one core over the last minute, percent (AIOSubtitles and its ffmpeg). */
    cpuPercent?: number;
    /** The container's memory now and its highest since it started, MB. */
    memMb?: number;
    memPeakMb?: number;
    rssMb: number;
    cache: { bytes: number; files: number };
    disk?: { freeBytes: number; totalBytes: number };
  };
  /** Newest first, today included. */
  days: Day[];
  errors: ErrorNote[];
  /** When the recent errors were last cleared; 0 for never. */
  errorsClearedAt: number;
  /** The first page of activity (see activityPage), the number kept, and every link in it. */
  activity: Activity[];
  activityTotal: number;
  activityLinks: string[];
  /** What this week's subtitles came out as (see syncOutcomes), and whether the last clear can be undone. */
  outcomes: ReturnType<typeof syncOutcomes>;
  canUndoClear: boolean;
  /** The owner's names for links (cache/stats/names.json), by link id or its AIOStreams uuid prefix. */
  names: Record<string, string>;
  /** Each link's configure page ("/<token>/configure") and settings, for the links seen since this was kept. */
  configure: Record<string, string>;
  settings: Record<string, LinkSummary>;
  /** Calls per key in the last minute, hour and 24 hours. */
  windows: Record<string, KeyWindows>;
}

/** The owner's names for links: { "a87f48f1": "Sara" }. Missing or broken means none. */
async function readNames(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir(), "names.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => typeof v === "string" && v.length <= 40 && k.length <= 40)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Everything the stats page shows: the last `days` days and the machine right now. */
export async function statsView(version: string, days = 14): Promise<StatsView> {
  rollover();
  // Live numbers: what the container used since the last minute's sample is added to today's
  // view (not saved), and CPU is measured over that same stretch, so nothing waits for a sample.
  const own = await readOwn();
  const live: Day = { ...today, total: { ...today.total } };
  let cpuNow = cpuPercent;
  if (lastOwn) {
    const cpuUsec = grew(own.cpuUsec, lastOwn.cpuUsec);
    if (cpuUsec !== undefined) {
      live.total["own.cpu.ms"] = (live.total["own.cpu.ms"] ?? 0) + Math.round(cpuUsec / 1000);
      if (own.at - lastOwn.at >= 2000) cpuNow = (cpuUsec / 1000 / (own.at - lastOwn.at)) * 100;
    }
    live.total["net.rx"] = (live.total["net.rx"] ?? 0) + (grew(own.rx, lastOwn.rx) ?? 0);
    live.total["net.tx"] = (live.total["net.tx"] ?? 0) + (grew(own.tx, lastOwn.tx) ?? 0);
  }
  const list: Day[] = [live];
  for (let i = 1; i < days; i++) {
    const date = dateOf(Date.now() - i * 86400_000);
    try {
      list.push(JSON.parse(await readFile(path.join(dir(), `${date}.json`), "utf8")) as Day);
    } catch {
      list.push(emptyDay(date));
    }
  }
  let disk: StatsView["now"]["disk"];
  try {
    const fs = await statfs(cachePath());
    disk = { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
  } catch {}
  return {
    version,
    uptimeS: Math.round((Date.now() - started) / 1000),
    now: {
      cores: os.availableParallelism(),
      cpuPercent: cpuNow,
      memMb: own.memBytes !== undefined ? Math.round(own.memBytes / 1048576) : undefined,
      memPeakMb: own.memPeakBytes !== undefined ? Math.round(own.memPeakBytes / 1048576) : undefined,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      cache: await dirSize(cachePath()),
      disk
    },
    days: list,
    activity: activityPage().rows,
    activityTotal: activityPage().total,
    activityLinks: activityLinks(),
    outcomes: syncOutcomes(),
    canUndoClear: canUndoClear(),
    windows: keyWindows(),
    // Hand-written names first; a name given on the configure page wins for its link.
    names: { ...(await readNames()), ...labels },
    configure: Object.fromEntries(Object.entries(knownLinks()).map(([link, token]) => [link, `/${token}/configure`])),
    settings: Object.fromEntries(Object.entries(knownLinks()).flatMap(([link, token]) => {
      const summary = linkSummary(token);
      return summary ? [[link, summary]] : [];
    })),
    errors,
    errorsClearedAt
  };
}
