/**
 * Limits on reading the playing file from wherever it is hosted (a debrid service, a usenet proxy).
 * The reads use the viewer's own account there, so the addon holds back in two cases:
 *
 * - The host refuses. HTTP 429 (too many requests) pauses reads from that host at once. HTTP 403
 *   pauses them only after REFUSALS_BEFORE_PAUSE in a row, since one 403 is usually a link that
 *   expired, not an account being limited. A pause lasts PAUSE_MS, doubling each time the host
 *   refuses again straight after one, up to MAX_PAUSE_MS. A read that works clears it.
 * - The day's limit is spent (DAILY_READ_GB, counted over everyone, UTC days as the dashboard's).
 *
 * While paused, nothing new is read: subtitles are listed unsynced and syncing picks up afterwards.
 */
import { config } from "./config.js";
import { count, countedToday } from "./stats.js";

/** Reading the file is paused (see above). Not a failure to list on the dashboard each time. */
export class ReadsPaused extends Error {
  override name = "ReadsPaused";
}

const REFUSALS_BEFORE_PAUSE = 3;
const PAUSE_MS = 5 * 60 * 1000;
const MAX_PAUSE_MS = 60 * 60 * 1000;

interface HostState {
  /** 403s in a row with no read working in between. */
  refusals: number;
  /** Pauses in a row with no read working in between. */
  pauses: number;
  pausedUntil: number;
  status?: number;
}

const hosts = new Map<string, HostState>();

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The refusal (403 or 429) an error from ffmpeg, ffprobe or a range read reports, if it is one. */
export function refusalStatus(message: string): 403 | 429 | undefined {
  const m = /(?:Server returned|HTTP error|HTTP)\s+(403|429)\b/.exec(message);
  return m ? (Number(m[1]) as 403 | 429) : undefined;
}

/** Bytes read from playing files today, by the day's limit. */
const READ_COUNTER = "sync.readBytes";

/** Throws ReadsPaused when nothing more may be read today, or (given the file's URL) from its host for now. */
export function checkReads(url?: string, now = Date.now()): void {
  const limit = config.dailyReadBytes;
  if (limit > 0 && countedToday(READ_COUNTER) >= limit) throw new ReadsPaused(`the day's read limit (${config.dailyReadGb} GB) is spent; syncing new files resumes tomorrow (UTC)`);
  const host = url ? hostOf(url) : undefined;
  const state = host ? hosts.get(host) : undefined;
  if (state && state.pausedUntil > now) {
    throw new ReadsPaused(`the file's host refused reads (HTTP ${state.status}); paused for another ${Math.ceil((state.pausedUntil - now) / 60000)} min`);
  }
}

/** Bytes read from a playing file (measured, or estimated for ffmpeg's windows). */
export function noteRead(bytes: number): void {
  count(READ_COUNTER, Math.round(bytes));
}

/** A read from this URL's host worked: it isn't refusing. */
export function noteReadOk(url: string): void {
  const host = hostOf(url);
  if (host) hosts.delete(host);
}

/** The host refused a read. Returns how long reads from it are now paused for, in ms (0: not paused). */
export function noteRefusal(url: string, status: 403 | 429, now = Date.now()): number {
  const host = hostOf(url);
  if (!host) return 0;
  const state = hosts.get(host) ?? { refusals: 0, pauses: 0, pausedUntil: 0 };
  hosts.set(host, state);
  state.status = status;
  state.refusals++;
  count("sync.refused");
  if (status === 403 && state.refusals < REFUSALS_BEFORE_PAUSE) return 0;
  const pause = Math.min(PAUSE_MS * 2 ** state.pauses, MAX_PAUSE_MS);
  state.pauses++;
  state.refusals = 0;
  state.pausedUntil = now + pause;
  count("sync.paused");
  console.error(`sync: the file's host refused reads (HTTP ${status}); no reads from it for ${Math.round(pause / 60000)} min`);
  return pause;
}

/** For tests: forget every host. */
export function resetReads(): void {
  hosts.clear();
}
