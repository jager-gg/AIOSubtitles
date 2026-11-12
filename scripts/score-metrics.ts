/**
 * The yardstick behind the sync score (scripts/score.ts, docs/scoring.md): how close a subtitle's
 * line starts sit to the playing file's own line starts, or to where speech starts in its audio.
 *
 * Kept apart from src/sync.ts on purpose: a change to the sync code must not move the yardstick it
 * is judged by. The one exception is how far ahead of its voice a line is meant to start (the lead),
 * which is where the sync means to put it: score.ts takes it from src/sync.ts (SPEECH_LEAD_MS,
 * voiceLeadFor) rather than keep a copy that can fall out of step. So that a lead that is wrong can
 * still show, the gaps to the voices are also given signed (signedGapsTo): their median is how far
 * the lines sit from that lead. Everything here is pure, so test/score.test.ts can check it on small
 * made-up timelines.
 */

export interface Cue {
  start: number;
  end: number;
}

/** A stretch of the file that was read, ms: [from, to). */
export interface Span {
  from: number;
  to: number;
}

/** How far off a line may start and still count: 0.1 s looks exact, 0.3 s close, past 1 s plainly wrong. */
export const TOLERANCES_MS = [100, 300, 1000] as const;
/** A voice "starts" after at least this much silence: inside a stretch of speech nothing marks a line's start. */
export const ONSET_PAUSE_MS = 250;

/** Sorted, without repeats. */
export function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Distance from t to the nearest value of a sorted list; Infinity when the list is empty. */
export function nearestGap(sorted: number[], t: number): number {
  return Math.abs(nearestSigned(sorted, t));
}

/** t less the nearest value of a sorted list (positive: t comes after it); Infinity when the list is empty. */
export function nearestSigned(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < sorted.length ? sorted[lo] - t : Infinity;
  const before = lo > 0 ? t - sorted[lo - 1] : Infinity;
  if (after === Infinity && before === Infinity) return Infinity;
  // On a point: 0, never -0.
  if (after === 0) return 0;
  return before <= after ? before : -after;
}

/** Where speech starts after a pause of at least `pause` ms: the points a line start can be judged by. */
export function onsets(cues: Cue[], pause = ONSET_PAUSE_MS): number[] {
  const out: number[] = [];
  let lastEnd = -Infinity;
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    if (c.start - lastEnd >= pause) out.push(c.start);
    lastEnd = Math.max(lastEnd, c.end);
  }
  return out;
}

export function inSpans(t: number, spans: Span[]): boolean {
  return spans.some((s) => t >= s.from && t < s.to);
}

/**
 * Each line's distance to the nearest reference point, after adding `lead` to the line's start (a
 * line judged against speech should start about 200 ms before the voice). With `spans`, only lines
 * whose judged moment falls inside them count: outside what was read there is nothing to judge by.
 */
export function gapsTo(starts: number[], reference: number[], lead = 0, spans?: Span[]): number[] {
  return signedGapsTo(starts, reference, lead, spans).map(Math.abs);
}

/** gapsTo, signed: positive where the line (with its lead) starts after the nearest point, late; negative, early. */
export function signedGapsTo(starts: number[], reference: number[], lead = 0, spans?: Span[]): number[] {
  const sorted = sortedUnique(reference);
  if (sorted.length === 0) return [];
  return starts.map((s) => s + lead).filter((t) => !spans || inSpans(t, spans)).map((t) => nearestSigned(sorted, t));
}

/**
 * The median of signed gaps within the widest tolerance, ms, rounded: how far early (negative) or
 * late the close lines sit on the whole. Undefined when none are that close.
 */
export function signedMedian(gaps: number[]): number | undefined {
  const mid = median(gaps.filter((g) => Math.abs(g) <= TOLERANCES_MS[TOLERANCES_MS.length - 1]));
  return mid === undefined ? undefined : Math.round(mid);
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** How a set of lines sits against its reference. */
export interface Precision {
  /** Lines judged. */
  lines: number;
  /** How many start within each of TOLERANCES_MS. */
  within: number[];
  /** The same as shares of `lines` (0 when there are none), rounded to 4 places. */
  shares: number[];
  /** Median gap of the lines within the widest tolerance, ms: how tight the close ones are. */
  medianMs?: number;
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

export function precision(gaps: number[]): Precision {
  const within = TOLERANCES_MS.map((t) => gaps.filter((g) => g <= t).length);
  const close = gaps.filter((g) => g <= TOLERANCES_MS[TOLERANCES_MS.length - 1]);
  const mid = median(close);
  return {
    lines: gaps.length,
    within,
    shares: within.map((n) => (gaps.length ? round4(n / gaps.length) : 0)),
    ...(mid === undefined ? {} : { medianMs: Math.round(mid) })
  };
}

/** Many pairs' precision at once. */
export interface Totals {
  /** Pairs counted (those with at least one line judged). */
  pairs: number;
  lines: number;
  /** All lines together: a long film weighs more than a short episode. */
  lineWeighted: number[];
  /** Each pair's shares averaged: every pair weighs the same. */
  pairAveraged: number[];
  /** Median gap over every line within the widest tolerance, when the gaps were given. */
  medianMs?: number;
}

export function combine(items: Precision[], gaps?: number[][]): Totals {
  const counted = items.filter((p) => p.lines > 0);
  const lines = counted.reduce((sum, p) => sum + p.lines, 0);
  const lineWeighted = TOLERANCES_MS.map((_, i) => (lines ? round4(counted.reduce((sum, p) => sum + p.within[i], 0) / lines) : 0));
  const pairAveraged = TOLERANCES_MS.map((_, i) => (counted.length ? round4(counted.reduce((sum, p) => sum + p.shares[i], 0) / counted.length) : 0));
  const widest = TOLERANCES_MS[TOLERANCES_MS.length - 1];
  const mid = gaps ? median(gaps.flat().filter((g) => g <= widest)) : undefined;
  return { pairs: counted.length, lines, lineWeighted, pairAveraged, ...(mid === undefined ? {} : { medianMs: Math.round(mid) }) };
}

/** What a run says about one pair, as far as comparing two runs needs. */
export interface PairSummary {
  id: string;
  method: string;
  synced: boolean;
  served: Precision;
}

export interface PairChange {
  id: string;
  /** Change in the served share within each tolerance (after minus before). */
  delta: number[];
  before?: PairSummary;
  after?: PairSummary;
  /** Synced in one run and not in the other: the change that matters most. */
  flipped?: "now synced" | "no longer synced";
  methodChanged: boolean;
}

/**
 * The pairs two runs judge differently, worst first: a pair that stopped syncing, then the largest
 * drop within 0.3 s (the score's tolerance), then within 1 s. Pairs in one run only are listed too.
 */
export function pairChanges(before: PairSummary[], after: PairSummary[]): PairChange[] {
  const old = new Map(before.map((p) => [p.id, p]));
  const now = new Map(after.map((p) => [p.id, p]));
  const ids = sortedIds([...old.keys(), ...now.keys()]);
  const changes: PairChange[] = [];
  for (const id of ids) {
    const b = old.get(id);
    const a = now.get(id);
    const delta = TOLERANCES_MS.map((_, i) => round4((a?.served.shares[i] ?? 0) - (b?.served.shares[i] ?? 0)));
    const flipped = a && b && a.synced !== b.synced ? (a.synced ? "now synced" : "no longer synced") : undefined;
    const methodChanged = Boolean(a && b && a.method !== b.method);
    if (a && b && !flipped && !methodChanged && delta.every((d) => d === 0) && a.served.lines === b.served.lines) continue;
    changes.push({ id, delta, ...(b ? { before: b } : {}), ...(a ? { after: a } : {}), ...(flipped ? { flipped } : {}), methodChanged });
  }
  const rank = (c: PairChange) => (c.flipped === "no longer synced" ? 0 : 1);
  return changes.sort((x, y) => rank(x) - rank(y) || x.delta[1] - y.delta[1] || x.delta[2] - y.delta[2] || x.id.localeCompare(y.id));
}

function sortedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * The file part of an activity entry's "what" ("Arabic · <name>"), and whether it names the file
 * whose name without its extension is `stem`. The dashboard shortens names past 70 characters to
 * 67 and "…", and puts "S01E02 · " in front of a name that doesn't say its episode.
 */
export function activityNames(what: string, stem: string): boolean {
  const parts = what.split(" · ");
  if (parts.length < 2) return false;
  const named = parts.slice(1).join(" · ").replace(/^S\d{2,}E\d{2,} · /, "");
  if (named.endsWith("…")) return named.length > 1 && stem.startsWith(named.slice(0, -1));
  return named === stem;
}

/** The language label of an activity entry's "what": "English Dub", "Arabic", ... */
export function activityLanguage(what: string): string {
  return what.split(" · ")[0];
}

/**
 * The words a subtitle shows, to tell its language by: an ASS file's styles and headers name fonts
 * and settings in Latin letters, enough to hide that the lines are Arabic.
 */
export function dialogueText(text: string, ext: string): string {
  if (ext !== ".ass" && ext !== ".ssa") return text;
  // Text is the last of an event's ten fields, and may hold commas itself.
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Dialogue:"))
    .map((line) => line.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, " ").replace(/\\[Nnh]/g, " "))
    .join("\n");
}

/**
 * A file name's title: its words before the season, episode or year ("Show.S01E02.1080p" and
 * "Show S1 - 02" are both "show"). Used to borrow the decision of another episode of the same title
 * when the activity list doesn't name the file itself.
 */
export function titleOf(name: string): string {
  const words = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ");
  const cut = words.findIndex((w, i) => i > 0 && /^(s\d{1,2}(e\d{1,4})?|\d{1,2}x\d{1,3}|e?p?\d{2,4})$/.test(w));
  return (cut === -1 ? words : words.slice(0, cut)).join(" ");
}

/**
 * Whether an English subtitle on this file was a dub caption: the activity list's downloads of the
 * file decide ("English Dub" against "English"); when it names the file in neither, the downloads of
 * other files with the same title do, if they all agree.
 */
export function dubDecision(whats: string[], stem: string): { dub: boolean; by: string } {
  const english = (entries: string[]) => new Set(entries.map(activityLanguage).filter((l) => l === "English" || l === "English Dub"));
  const own = english(whats.filter((w) => activityNames(w, stem)));
  if (own.has("English Dub")) return { dub: true, by: own.has("English") ? "downloaded as English Dub (and as English)" : "downloaded as English Dub" };
  if (own.has("English")) return { dub: false, by: "downloaded as English" };
  const title = titleOf(stem);
  const kin = english(whats.filter((w) => titleOf(w.split(" · ").slice(1).join(" · ").replace(/^S\d{2,}E\d{2,} · /, "")) === title));
  if (kin.size === 1) return { dub: kin.has("English Dub"), by: `not in the activity list; other files of the title were downloaded as ${[...kin][0]}` };
  return { dub: false, by: kin.size ? "not in the activity list; other files of the title both ways" : "not in the activity list, nor its title" };
}

/** A file's stored reading, as far as hiding some of its lines needs. */
export interface Reading {
  speechOnly?: boolean;
  /** heard: a window that holds only speech heard in the audio, no lines. */
  windows: Array<{ cues: Cue[]; others?: Record<string, Cue[]>; heard?: boolean }>;
}

/**
 * Line starts of different tracks this close count as one line: two text tracks of one release are
 * often timed alike, and a line hidden from one but left on the other would still be seen.
 */
export const SAME_LINE_MS = 50;

/**
 * The reading with every `every`th line of the file's tracks taken out, and the starts taken out:
 * the held-out check (--holdout in scripts/score.ts). A sync that moves lines onto the file's own
 * lines scores those lines by construction; the lines it never saw can't be met that way. The file's
 * lines are counted in order over all its text tracks at once, a start within SAME_LINE_MS of the
 * one before counting as the same line, so a line is hidden from every track or from none. A file
 * with no subtitle track (speech only) has no lines to hide.
 */
export function hideLines<R extends Reading>(found: R, every: number): { kept: R; hidden: number[] } {
  if (found.speechOnly || every < 2) return { kept: found, hidden: [] };
  const starts = sortedUnique(found.windows.filter((w) => !w.heard).flatMap((w) => [...w.cues, ...Object.values(w.others ?? {}).flat()]).map((c) => c.start));
  const hidden = new Set<number>();
  let line = -1;
  let first = -Infinity;
  for (const start of starts) {
    if (start - first > SAME_LINE_MS) {
      line++;
      first = start;
    }
    if (line % every === every - 1) hidden.add(start);
  }
  const keep = (cues: Cue[]) => cues.filter((c) => !hidden.has(c.start));
  const windows = found.windows.map((w) =>
    w.heard ? w : { ...w, cues: keep(w.cues), ...(w.others ? { others: Object.fromEntries(Object.entries(w.others).map(([track, cues]) => [track, keep(cues)])) } : {}) }
  );
  return { kept: { ...found, windows }, hidden: [...hidden].sort((a, b) => a - b) };
}
