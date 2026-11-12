/**
 * Syncing a subtitle to the file being played. A subtitle is usually timed to some other release;
 * this lines it up with the playing one. The file is found through the viewer's AIOStreams, and the
 * timing of its own subtitle lines is read (never their words): for a Matroska file from its index
 * (mkv.ts), about 1 MB for the whole file; otherwise ffmpeg reads a few short windows, seeking with
 * the file's index so only those are downloaded. The subtitle's shift is measured window by window,
 * so timing that steps mid-episode is followed. When the subtitle fits none of the file's tracks, or
 * the file has none, it is timed by where speech starts in the audio of a few windows (vad.ts). Dub
 * captions, which follow the English voices rather than the original audio the track follows, are
 * moved from the track's timing onto those voices where the audio has been heard (refineBySpeech).
 * Reads of the file are held back when its host refuses them or the day's limit is spent (reads.ts).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheKey, cachePath } from "./cache.js";
import { decodeSubtitle } from "./text.js";
import { count, noteError, scrub } from "./stats.js";
import { heardSpeech } from "./vad.js";
import { dialogueLines, isTextCodec, pictureLines, readMkvTiming, readMkvTracks, type MkvTrack } from "./mkv.js";
import { keptInOrder, linesOverShift, timingByLines } from "./align.js";
import { backgroundReadFits, checkReads, noteRead, noteReadOk, noteRefusal, ReadsPaused, refusalStatus } from "./reads.js";

export interface Cue {
  start: number;
  end: number;
}

export interface Anchor {
  /** Window in the file, ms. */
  from: number;
  to: number;
  /** ms to add to the caption times here (negative = earlier). */
  offset: number;
  /** Share of the embedded speech the captions cover at that offset, 0..1. */
  score: number;
}

// ---------- subtitle text ----------

function srtTime(value: string): number {
  const m = value.match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return NaN;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

function assTime(value: string): number {
  const m = value.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) return NaN;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function formatSrt(ms: number, sep: string): string {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3600000), 2)}:${pad(Math.floor(t / 60000) % 60, 2)}:${pad(Math.floor(t / 1000) % 60, 2)}${sep}${pad(t % 1000, 3)}`;
}

function formatAss(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60, 2)}:${pad(Math.floor(cs / 100) % 60, 2)}.${pad(cs % 100, 2)}`;
}

const isAss = (ext: string) => ext === ".ass" || ext === ".ssa";

/** Splits an ASS Dialogue line into its fields (Text keeps its commas). */
function assFields(line: string, format: string[]): Record<string, string> | undefined {
  const body = line.replace(/^Dialogue:\s*/, "");
  const parts: string[] = [];
  let rest = body;
  for (let i = 0; i < format.length - 1; i++) {
    const comma = rest.indexOf(",");
    if (comma === -1) return undefined;
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return Object.fromEntries(format.map((name, i) => [name, parts[i] ?? ""]));
}

function assFormat(text: string): string[] {
  const events = text.split(/\[Events\]/i)[1] ?? text;
  const line = events.match(/^Format:\s*(.+)$/im)?.[1];
  return (line ?? "Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text").split(",").map((s) => s.trim().toLowerCase());
}

/** Timed lines of a caption file. */
export function parseCues(text: string, ext: string): Cue[] {
  const cues: Cue[] = [];
  if (isAss(ext)) {
    const format = assFormat(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const f = assFields(line, format);
      if (!f) continue;
      const start = assTime(f.start);
      const end = assTime(f.end);
      if (end > start) cues.push({ start, end });
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("-->")) continue;
      const [a, b] = line.split("-->");
      const start = srtTime(a);
      const end = srtTime(b);
      if (end > start) cues.push({ start, end });
    }
  }
  return cues.sort((x, y) => x.start - y.start);
}

const SIGN_STYLE = /sign|song|op\b|ed\b|opening|ending|kara|title|insert|note|logo|screen|text/i;
const SIGN_TAGS = /\\(?:pos|move|org|k[fo]?\d|an[1345789])\b|\\p[1-9]/;

/** Spoken lines from an embedded ASS track: signs, songs and positioned text left out. */
export function dialogueCues(assText: string): Cue[] {
  const format = assFormat(assText);
  const cues: Cue[] = [];
  for (const line of assText.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const f = assFields(line, format);
    if (!f) continue;
    if (SIGN_STYLE.test(f.style ?? "") || SIGN_TAGS.test(f.text ?? "")) continue;
    if (!(f.text ?? "").replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, "").trim()) continue;
    const start = assTime(f.start);
    const end = assTime(f.end);
    if (end > start) cues.push({ start, end });
  }
  // Duplicate layers (shadow copies) would count twice.
  const seen = new Set<string>();
  return cues
    .filter((c) => (seen.has(`${c.start}-${c.end}`) ? false : (seen.add(`${c.start}-${c.end}`), true)))
    .sort((x, y) => x.start - y.start);
}

/**
 * Rewrites every cue's times: first scaled by `factor` (a subtitle made for another frame rate, see
 * RATE_FACTORS), then moved by delta(scaled start). With `end`, a line ends at end(scaled start,
 * scaled end) instead of moving its end by the same delta (see keptInOrder).
 */
export function retime(text: string, ext: string, delta: (start: number) => number, factor = 1, end?: (start: number, end: number) => number): string {
  const scale = (ms: number) => Math.round(ms * factor);
  const ending = (start: number, last: number, d: number) => (end ? end(start, last) : last + d);
  if (isAss(ext)) {
    return text.replace(/^(Dialogue:[^,]*,)(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2})/gm, (_all, head, a, b) => {
      const start = scale(assTime(a));
      const d = delta(start);
      return `${head}${formatAss(start + d)},${formatAss(ending(start, scale(assTime(b)), d))}`;
    });
  }
  return text.replace(/^.*-->.*$/gm, (line) => {
    const [a] = line.split("-->");
    const start = scale(srtTime(a));
    const d = delta(start);
    let stamps = 0;
    // The first stamp is the start, the second the end.
    return line.replace(/(?:\d{1,2}:)?\d{2}:\d{2}([,.])\d{3}/g, (stamp, sep) => {
      const at = scale(srtTime(stamp));
      return formatSrt(stamps++ === 1 ? ending(start, at, d) : at + d, sep);
    });
  });
}

// ---------- per-line snapping ----------

/**
 * After the shift, each caption line that lands near one of the file's own line starts is moved onto
 * it ("snapping"), where the file was read. A translation is often timed by someone else, a line
 * here or there a beat off: inside the windows read, synced lines sat 150 ms from the file's line
 * starts at the median, and 46% sat 80 to 300 ms off (replay data). Only clear pairs move: the file's
 * line is the only one within SNAP_CLEAR_MS, no other caption line is nearer to it, and the move is
 * at most SNAP_MAX_MS. Dub captions never snap: the file's lines follow the original audio, not the dub.
 * Returns the extra move per caption start (in the captions' own, possibly rescaled, time).
 */
export function lineNudges(captions: Cue[], shift: (start: number) => number, reference: Cue[]): Map<number, number> {
  const refs = [...new Set(reference.map((c) => c.start))].sort((a, b) => a - b);
  const nudges = new Map<number, number>();
  if (refs.length === 0) return nudges;
  const placed = captions.map((c) => c.start + shift(c.start)).sort((a, b) => a - b);
  // The nearest of a sorted list to x, and the distance to the one after it.
  const nearest = (list: number[], x: number): { at: number; second: number } | undefined => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    const near = [list[lo - 2], list[lo - 1], list[lo], list[lo + 1]].filter((v): v is number => v !== undefined).sort((a, b) => Math.abs(a - x) - Math.abs(b - x));
    return near.length ? { at: near[0], second: near[1] === undefined ? Infinity : Math.abs(near[1] - x) } : undefined;
  };
  for (const c of captions) {
    if (nudges.has(c.start)) continue;
    const at = c.start + shift(c.start);
    const ref = nearest(refs, at);
    if (!ref) continue;
    const move = ref.at - at;
    if (Math.abs(move) > SNAP_MAX_MS || Math.abs(move) < SNAP_MIN_MS || ref.second <= SNAP_CLEAR_MS) continue;
    // No other caption line may be nearer to that line start (or as near): it belongs to this one.
    const back = nearest(placed, ref.at);
    if (!back || back.at !== at || back.second <= Math.abs(move)) continue;
    nudges.set(c.start, move);
  }
  return nudges;
}

/** Moves smaller than this aren't worth making; larger than SNAP_MAX_MS aren't the same line. */
const SNAP_MIN_MS = 40;
const SNAP_MAX_MS = 300;
/** The file's next line start must be farther than this from the caption, so the pair is clear. */
const SNAP_CLEAR_MS = 600;

// ---------- frame rate ----------

const FILM = 24000 / 1001;

/**
 * What a subtitle's times are multiplied by when it was made for one frame rate and the file plays at
 * another: a 25 fps (PAL: DVD, European TV) subtitle on a 23.976 fps web or Blu-ray file runs 4.3%
 * fast, about a minute by the end of an episode; 24 against 23.976 drifts 1.4 s over 24 minutes.
 */
export const RATE_FACTORS = [25 / FILM, 25 / 24, 24 / FILM, FILM / 24, 24 / 25, FILM / 25];

/** The captions as they'd play at another frame rate. */
export function scaleCues(cues: Cue[], factor: number): Cue[] {
  return cues.map((c) => ({ ...c, start: Math.round(c.start * factor), end: Math.round(c.end * factor) }));
}

/** How far apart the anchors' shifts are. */
function spread(anchors: Anchor[]): number {
  if (anchors.length === 0) return Infinity;
  const offsets = anchors.map((a) => a.offset);
  return Math.max(...offsets) - Math.min(...offsets);
}

type Measurement = { measuredWindows: Array<{ from: number; to: number; measured: Measured }>; anchors: Anchor[] };

/**
 * A long measurement written as steps: each `yield` is a point where the server may answer other
 * requests before going on. Measuring a film against six frame rates takes seconds of CPU, and
 * Node runs it on the one thread that also answers lists and downloads (seen on a long film:
 * 12 s during which a download couldn't even be told to stop waiting).
 */
type Steps<T> = Generator<void, T, void>;

/** Runs the steps in one go: for tests and the replay check, where nothing else is waiting. */
function finish<T>(steps: Steps<T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Runs the steps, letting waiting requests through between them. */
async function finishBetweenRequests<T>(steps: Steps<T>): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = steps.next();
  }
  return step.value;
}

type Rescaled = Measurement & { factor: number; captions: Cue[] };

/** Whether measured windows give a sync to trust (the same tests syncCaptions makes). */
function trusted(m: Measurement): boolean {
  return fitsFile(m.measuredWindows) && m.anchors.length > 0 && landsOnTiming(m.measuredWindows, m.anchors) && holdsTogether(m.anchors);
}

/**
 * How many times the shift jumps (by more than JUMP_MS) from one anchor to the next. Smaller moves
 * don't count: a subtitle running a touch fast or slow creeps by half a second a minute or so
 * between its cuts (seen: an English subtitle on one web release).
 */
export function shiftChanges(anchors: Anchor[]): number {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  let changes = 0;
  for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i].offset - sorted[i - 1].offset) > JUMP_MS) changes++;
  return changes;
}

const JUMP_MS = 1000;

/**
 * Whether a timing changes no more often than cuts can explain. A subtitle made for another cut of
 * the file needs a new shift at each place the cuts differ: a handful of times (four on the episodes
 * seen so far, five on one release). A shift that jumps about from window to window is something a
 * shift per stretch can't follow, whatever the cause: chance fits of a subtitle that isn't this
 * file's, or a subtitle timed by hand to another recording, where each line sits differently (a
 * Dutch subtitle of a film, timed to a cinema recording: 13 jumps over 27 windows, between -2.5 and
 * +8.4 s; the steps placed between them were served as synced and weren't). Such a subtitle is left
 * to byLines, which times it line by line when it is the file's own dialogue. Allowed: one jump per
 * CHANGE_EVERY anchors, and at least MIN_CHANGES_ALLOWED.
 */
export function holdsTogether(anchors: Anchor[]): boolean {
  return shiftChanges(anchors) <= Math.max(MIN_CHANGES_ALLOWED, Math.floor(anchors.length / CHANGE_EVERY));
}

const MIN_CHANGES_ALLOWED = 3;
const CHANGE_EVERY = 6;

/**
 * The captions rescaled to the file's frame rate, when that is what fits: they then land at one shift
 * (within AGREE_MS) in at least RATE_MIN_ANCHORS windows spread over the file, where as written they
 * fit nowhere, or only with steps. A step mid-episode (a cut, a moved break) stays a step: it isn't a
 * straight line from start to end. Undefined when the captions already fit at one shift.
 */
export function rescaled(found: FileAnchors, captions: Cue[], asWritten: Measurement): Rescaled | undefined {
  return finish(rescaledSteps(found, captions, asWritten));
}

/** rescaled, one frame rate per step. */
function* rescaledSteps(found: FileAnchors, captions: Cue[], asWritten: Measurement): Steps<Rescaled | undefined> {
  if (found.speechOnly || !found.duration) return undefined;
  if (trusted(asWritten) && spread(asWritten.anchors) <= AGREE_MS) return undefined;
  let best: (Rescaled & { score: number }) | undefined;
  for (const factor of RATE_FACTORS) {
    yield;
    const scaled = scaleCues(captions, factor);
    const m = measureAll(found, scaled);
    if (m.anchors.length < RATE_MIN_ANCHORS || !trusted(m) || spread(m.anchors) > AGREE_MS) continue;
    // Drift only shows across the file: the anchors must reach from its early part to its late part.
    const sorted = [...m.anchors].sort((a, b) => a.from - b.from);
    if (sorted[sorted.length - 1].to - sorted[0].from < found.duration * RATE_MIN_REACH) continue;
    // Steps that fit as written, in more windows, are kept: a real cut isn't a drift.
    if (trusted(asWritten) && asWritten.anchors.length > m.anchors.length) continue;
    // Line starts must meet at that one shift too (see lineStartFit).
    const median = [...m.anchors.map((a) => a.offset)].sort((a, b) => a - b)[Math.floor(m.anchors.length / 2)];
    const lines = lineStartFit(found, scaled, median);
    if (lines.score < RATE_MIN_LINE_SCORE || lines.margin < RATE_MIN_LINE_MARGIN) continue;
    const score = m.anchors.reduce((sum, a) => sum + a.score, 0);
    if (!best || m.anchors.length > best.anchors.length || (m.anchors.length === best.anchors.length && score > best.score)) best = { ...m, factor, captions: scaled, score };
  }
  if (!best) return undefined;
  const { score: _score, ...result } = best;
  return result;
}

/**
 * How well the captions' line starts meet the file's own line starts at `offset`, over every measured
 * window at once, against the best fit more than a second away. Overlap alone can't vouch for a
 * rescaled fit (dense dialogue covers itself at many shifts, and six rates are tried), but line starts
 * meet at one shift only. score: the share of the file's line starts met; margin: score minus that
 * rival. Over the replay data (186 pairs), the rate fits taken scored 0.58 to 0.89 with margins 0.36 to
 * 0.63 (all 24 against 23.976 fps); the best rate fit of a pair refused was 0.21, other episodes' 0.12.
 */
export function lineStartFit(found: FileAnchors, captions: Cue[], offset: number, range = 20000): { score: number; margin: number } {
  const { matched, total } = fileStartCurve(found, captions, range);
  if (total === 0) return { score: 0, margin: 0 };
  const steps = matched.length;
  const at = (i: number) => matched[i] / total;
  const centre = Math.round((offset + range) / LINE_STEP_MS);
  let score = 0;
  let rival = 0;
  for (let i = 0; i < steps; i++) {
    const distance = Math.abs(i - centre) * LINE_STEP_MS;
    if (distance <= AGREE_MS) score = Math.max(score, at(i));
    else if (distance > 1000) rival = Math.max(rival, at(i));
  }
  return { score: Math.round(score * 100) / 100, margin: Math.round((score - rival) * 100) / 100 };
}

/** Caption starts, sorted, each once: what startCurve takes. */
function captionStarts(captions: Cue[]): number[] {
  return [...new Set(captions.map((c) => c.start))].sort((a, b) => a - b);
}

/**
 * For each shift from -range to +range, LINE_STEP_MS apart: how many of `lines` have a caption start
 * within LINE_TOLERANCE_MS of their own start once the captions are moved by it. Each line counts
 * once per shift. `starts`: the captions' starts, sorted (captionStarts). Added into `into` when given.
 */
function startCurve(lines: Cue[], starts: number[], range: number, into?: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> {
  const steps = Math.round((2 * range) / LINE_STEP_MS) + 1;
  const matched = into ?? new Int32Array(steps);
  const seen = new Int32Array(steps).fill(-1);
  const own = lines.map((c) => c.start).sort((a, b) => a - b);
  let a = 0;
  own.forEach((line, k) => {
    // Every shift where a caption start lands within LINE_TOLERANCE_MS of this line's start.
    while (a < starts.length && starts[a] < line - range - LINE_TOLERANCE_MS) a++;
    for (let j = a; j < starts.length && starts[j] <= line + range + LINE_TOLERANCE_MS; j++) {
      const shift = line - starts[j];
      const first = Math.max(0, Math.ceil((shift - LINE_TOLERANCE_MS + range) / LINE_STEP_MS));
      const last = Math.min(steps - 1, Math.floor((shift + LINE_TOLERANCE_MS + range) / LINE_STEP_MS));
      for (let i = first; i <= last; i++) {
        if (seen[i] === k) continue;
        seen[i] = k;
        matched[i]++;
      }
    }
  });
  return matched;
}

/** startCurve over every measured window of the file at once, and how many lines that is. */
function fileStartCurve(found: FileAnchors, captions: Cue[], range: number): { matched: Int32Array<ArrayBuffer>; total: number } {
  const starts = captionStarts(captions);
  let matched = new Int32Array(Math.round((2 * range) / LINE_STEP_MS) + 1);
  let total = 0;
  for (const w of found.windows) {
    if (w.bridge || w.cues.length < 3) continue;
    total += w.cues.length;
    matched = startCurve(w.cues, starts, range, matched);
  }
  return { matched, total };
}

/**
 * The shift, over ±range, at which the captions' line starts meet the most of the file's own line
 * starts in every measured window at once (see lineStartFit): score, the share met; margin, score
 * minus the best shift more than a second away. Undefined when no window has lines.
 */
export function wideFit(found: FileAnchors, captions: Cue[], range = WIDE_RANGE_MS): { offset: number; score: number; margin: number } | undefined {
  const { matched, total } = fileStartCurve(found, captions, range);
  if (total === 0) return undefined;
  let best = 0;
  for (let i = 1; i < matched.length; i++) if (matched[i] > matched[best]) best = i;
  // A plateau of equal counts counts once, at its middle.
  let end = best;
  while (end + 1 < matched.length && matched[end + 1] === matched[best]) end++;
  const at = Math.round((best + end) / 2);
  let rival = 0;
  for (let i = 0; i < matched.length; i++) if (Math.abs(i - at) * LINE_STEP_MS > 1000) rival = Math.max(rival, matched[i]);
  return { offset: -range + at * LINE_STEP_MS, score: Math.round((matched[at] / total) * 100) / 100, margin: Math.round(((matched[at] - rival) / total) * 100) / 100 };
}

const WIDE_RANGE_MS = 120000;

const LINE_STEP_MS = 20;
const LINE_TOLERANCE_MS = 200;
/** What a rescaled fit needs from lineStartFit. */
const RATE_MIN_LINE_SCORE = 0.35;
const RATE_MIN_LINE_MARGIN = 0.25;

/** At least this many windows must agree on one shift after rescaling... */
const RATE_MIN_ANCHORS = 3;
/** ...from first to last covering at least this share of the file. */
const RATE_MIN_REACH = 0.4;

// ---------- measuring ----------

/** Total overlap between a and b shifted by `shift`. Both sorted by start. */
function overlap(a: Cue[], b: Cue[], shift: number): number {
  let total = 0;
  let j = 0;
  for (const x of a) {
    while (j < b.length && b[j].end + shift <= x.start) j++;
    for (let k = j; k < b.length && b[k].start + shift < x.end; k++) {
      total += Math.max(0, Math.min(x.end, b[k].end + shift) - Math.max(x.start, b[k].start + shift));
    }
  }
  return total;
}

/**
 * The shift that makes the captions cover the embedded speech in one window
 * best, searched over ±range ms. Returns undefined when the window has too
 * little speech or no shift fits well.
 */
export interface Measured {
  offset: number;
  score: number;
  /** Other good fits (score within 10% of the best), best first. */
  alternatives: Array<{ offset: number; score: number }>;
}

/**
 * Where a line starts after a pause, and where someone starts talking after one: the points speech
 * and lines share. Dialogue covers most of a scene, so how much two timelines overlap barely changes
 * when one is shifted by seconds; where speech starts doesn't (seen: speech started within 0.1 s
 * of 10 of 16 lines).
 */
function onsets(cues: Cue[], pause: number): number[] {
  const out: number[] = [];
  let lastEnd = -Infinity;
  for (const c of cues) {
    if (c.start - lastEnd >= pause) out.push(c.start);
    lastEnd = Math.max(lastEnd, c.end);
  }
  return out;
}

/** How many of `a` have one of `b` (sorted) within tolerance once b is shifted. */
function matchedOnsets(a: number[], b: number[], shift: number, tolerance: number): number {
  // A line usually shows a little before the voice starts: it may lead by ONSET_LEAD_MS, trail by less.
  const lead = ONSET_LEAD_MS;
  const lag = tolerance;
  let matched = 0;
  let j = 0;
  for (const x of a) {
    while (j < b.length && b[j] + shift < x - lead) j++;
    if (j < b.length && b[j] + shift <= x + lag) matched++;
  }
  return matched;
}

const ONSET_LEAD_MS = 200;

const ONSET_PAUSE_MS = 250;
const ONSET_TOLERANCE_MS = 200;

/**
 * measureWindow for speech heard in the audio: the shift that lines the captions' line starts up
 * with where speech starts, searched over ±range ms. The score is the share of speech starts that
 * meet a line start.
 */
/** Per shift (every SPEECH_STEP_MS over ±range), how many speech starts meet a line start. */
export function speechCurve(speech: Cue[], captions: Cue[], range = 20000): { matched: number[]; heard: number } | undefined {
  const heard = onsets(speech, ONSET_PAUSE_MS);
  if (heard.length < 4) return undefined;
  const from = heard[0] - range - 1000;
  const to = heard[heard.length - 1] + range + 1000;
  // Every line start counts: streaming subtitles run line into line with 80 ms between, inside one
  // stretch of speech. Each start of speech should meet one of them.
  const said = captions.filter((c) => c.end >= from && c.start <= to).map((c) => c.start);
  if (said.length < 4) return undefined;
  const windowStart = heard[0];
  const windowEnd = speech[speech.length - 1].end;
  const matched: number[] = [];
  for (let shift = -range; shift <= range; shift += SPEECH_STEP_MS) {
    const inside = said.filter((x) => x + shift >= windowStart - ONSET_TOLERANCE_MS && x + shift <= windowEnd + ONSET_TOLERANCE_MS).length;
    matched.push(inside < 3 ? 0 : matchedOnsets(heard, said, shift, ONSET_TOLERANCE_MS));
  }
  return { matched, heard: heard.length };
}

const SPEECH_STEP_MS = 20;

/** The peaks of a curve, best first: a plateau of equal values counts once, at its middle. */
function curvePeaks(values: number[], range: number): Array<{ offset: number; score: number }> {
  const peaks: Array<{ offset: number; score: number }> = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0 || values[i] < (values[i - 1] ?? 0) || values[i] < (values[i + 1] ?? 0)) continue;
    let k = i;
    while (k + 1 < values.length && values[k + 1] === values[i]) k++;
    peaks.push({ offset: -range + Math.round((i + k) / 2) * SPEECH_STEP_MS, score: values[i] });
    i = k;
  }
  return peaks.sort((a, b) => b.score - a.score);
}

/** measureWindow for speech heard in one window of the audio (see speechCurve). */
export function measureSpeech(speech: Cue[], captions: Cue[], range = 20000): Measured | undefined {
  const curve = speechCurve(speech, captions, range);
  if (!curve) return undefined;
  const peaks = curvePeaks(curve.matched.map((m) => Math.round((m / curve.heard) * 100) / 100), range);
  const best = peaks[0];
  if (!best || best.score < 0.45) return undefined;
  const alternatives = peaks.slice(1).filter((p) => p.score >= best.score * 0.9 && Math.abs(p.offset - best.offset) > 400);
  return { offset: best.offset, score: best.score, alternatives };
}

/**
 * Speech across all of a file's windows at once. One window's best fit is right only about half the
 * time (a chance alignment of a few starts can win), but chance alignments land somewhere else in
 * every window while the true shift is the same: the windows' curves are added up, and each window
 * then takes its own best fit within SPEECH_DRIFT_MS of the total's peak, for timing that drifts.
 * score: the share of all speech starts that meet a line at the peak; margin: how far the peak
 * stands above the best shift more than a second away from it.
 */
export function measureSpeechFile(windows: Array<{ from: number; to: number; speech: Cue[] }>, captions: Cue[], range = 20000): SpeechFit | undefined {
  const curves = speechCurves(windows, captions, range);
  return curves.length < SPEECH_MIN_ANCHORS ? undefined : fitCurves(curves, range);
}

/** A fit of speech to captions over some windows (see measureSpeechFile); heard: the speech starts it counts. */
type SpeechFit = { offset: number; score: number; margin: number; anchors: Anchor[]; heard: number };

/** Each window's speechCurve, in the windows' order; windows with too little speech or too few lines have none. */
function speechCurves(windows: Array<{ from: number; to: number; speech: Cue[] }>, captions: Cue[], range = 20000): Array<{ w: { from: number; to: number }; curve: { matched: number[]; heard: number } }> {
  return windows.flatMap((w) => {
    const curve = speechCurve(w.speech, captions, range);
    return curve ? [{ w, curve }] : [];
  });
}

/** measureSpeechFile over windows whose curves are already drawn. */
function fitCurves(curves: Array<{ w: { from: number; to: number }; curve: { matched: number[]; heard: number } }>, range = 20000): SpeechFit | undefined {
  if (curves.length === 0) return undefined;
  const heard = curves.reduce((sum, c) => sum + c.curve.heard, 0);
  const total = curves[0].curve.matched.map((_, i) => curves.reduce((sum, c) => sum + c.curve.matched[i], 0) / heard);
  const peaks = curvePeaks(total, range);
  const best = peaks[0];
  if (!best) return undefined;
  const rival = peaks.find((p) => Math.abs(p.offset - best.offset) > 1000)?.score ?? 0;
  const anchors = curves.flatMap(({ w, curve }) => {
    const lo = Math.max(0, Math.round((best.offset - SPEECH_DRIFT_MS + range) / SPEECH_STEP_MS));
    const hi = Math.min(curve.matched.length - 1, Math.round((best.offset + SPEECH_DRIFT_MS + range) / SPEECH_STEP_MS));
    let at = -1;
    for (let i = lo; i <= hi; i++) if (at < 0 || curve.matched[i] > curve.matched[at] || (curve.matched[i] === curve.matched[at] && Math.abs(i - (best.offset + range) / SPEECH_STEP_MS) < Math.abs(at - (best.offset + range) / SPEECH_STEP_MS))) at = i;
    const score = at < 0 ? 0 : curve.matched[at] / curve.heard;
    return score >= 0.45 ? [{ from: w.from, to: w.to, offset: -range + at * SPEECH_STEP_MS, score: Math.round(score * 100) / 100 }] : [];
  });
  return { offset: best.offset, score: Math.round(best.score * 100) / 100, margin: Math.round((best.score - rival) * 100) / 100, anchors, heard };
}

const SPEECH_DRIFT_MS = 600;

export function measureWindow(embedded: Cue[], captions: Cue[], range = 20000, centre = 0): Measured | undefined {
  if (centre !== 0) {
    // Searched over centre ± range: the captions moved by centre first, then measured as usual.
    const moved = measureWindow(embedded, captions.map((c) => ({ start: c.start + centre, end: c.end + centre })), range);
    return moved && { offset: moved.offset + centre, score: moved.score, alternatives: moved.alternatives.map((a) => ({ offset: a.offset + centre, score: a.score })) };
  }
  if (embedded.length < 3) return undefined;
  const speech = embedded.reduce((sum, c) => sum + (c.end - c.start), 0);
  const from = embedded[0].start - range - 1000;
  const to = embedded[embedded.length - 1].end + range + 1000;
  const near = captions.filter((c) => c.end >= from && c.start <= to);
  if (near.length < 3) return undefined;

  const scores: number[] = [];
  for (let shift = -range; shift <= range; shift += 40) scores.push(overlap(embedded, near, shift));
  // Local peaks, each refined to 5 ms.
  const peaks: Array<{ offset: number; score: number }> = [];
  // The two ends of the range aren't peaks: the fit may still be rising past them, towards a shift
  // that wasn't searched (seen: windows "fitting" at exactly -20.0 s).
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] <= 0 || scores[i] < scores[i - 1] || scores[i] < scores[i + 1]) continue;
    let peak = { offset: -range + i * 40, score: scores[i] };
    for (let shift = peak.offset - 40; shift <= peak.offset + 40; shift += 5) {
      const score = overlap(embedded, near, shift);
      if (score > peak.score) peak = { offset: shift, score };
    }
    peaks.push({ offset: peak.offset, score: Math.round((peak.score / speech) * 100) / 100 });
  }
  peaks.sort((a, b) => b.score - a.score);
  const best = peaks[0];
  if (!best || best.score < 0.45) return undefined;
  const alternatives = peaks.slice(1).filter((p) => p.score >= best.score * 0.9 && Math.abs(p.offset - best.offset) > 400);
  return { offset: best.offset, score: best.score, alternatives };
}

/**
 * Settles each window on one of its fits (its best, or a near-best one), by following the timing
 * through the file. A chance match can beat the true fit inside one window, but the true timing
 * carries on from one window to the next, and a real change (an inserted recap, a moved break)
 * holds in every window after it. So the windows are walked in order and the run of fits is taken
 * that scores highest in total, where changing the shift between one window and the next costs
 * STEP_COST and a window may be passed over. A fit off on its own costs two changes, more than one
 * window can score, so it is passed over; a new timing that lasts is followed.
 *
 * This replaced taking the one shift most windows support and pulling every window towards it:
 * on an episode whose shift changes four times (seen: a Dutch subtitle
 * needing -2.2, -4.5, -7.0, -9.6 and -12.1 s) that read minutes 13 to 25 at the first shift, 2.3 to 4.8 s
 * late, though most of those windows' own best fits were right.
 *
 * A window that still disagrees with every other one by more than 1.5 s is dropped: a change seen
 * in one window only isn't trusted until another window confirms it.
 */
export function agreeAnchors(windows: Array<{ from: number; to: number; measured: Measured }>): Anchor[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  const fits = sorted.map((w) => [{ offset: w.measured.offset, score: w.measured.score }, ...w.measured.alternatives]);
  // Each state is a run ending at one shift: the best total for it, and how it was reached.
  type State = { offset: number | undefined; total: number; prev: number; pick: number };
  const steps: State[][] = [];
  let states: State[] = [{ offset: undefined, total: 0, prev: -1, pick: -1 }];
  for (const options of fits) {
    const next = new Map<number | undefined, State>();
    const keep = (state: State) => {
      const known = next.get(state.offset);
      if (!known || state.total > known.total) next.set(state.offset, state);
    };
    // Passing this window over: every run carries on as it is.
    states.forEach((state, j) => keep({ offset: state.offset, total: state.total, prev: j, pick: -1 }));
    options.forEach((option, k) => {
      let best: State | undefined;
      states.forEach((state, j) => {
        const changed = state.offset !== undefined && Math.abs(option.offset - state.offset) > AGREE_MS;
        const total = state.total + option.score - (changed ? STEP_COST : 0);
        if (!best || total > best.total) best = { offset: option.offset, total, prev: j, pick: k };
      });
      if (best) keep(best);
    });
    steps.push(states);
    states = [...next.values()].sort((a, b) => b.total - a.total).slice(0, MAX_RUNS);
  }
  // Back from the best run's end to its start.
  const picks = new Array<number>(fits.length).fill(-1);
  let state = states[0];
  for (let i = fits.length - 1; i >= 0; i--) {
    picks[i] = state.pick;
    state = steps[i][state.prev];
  }
  const chosen = sorted.flatMap((w, i) => (picks[i] < 0 ? [] : [{ from: w.from, to: w.to, offset: fits[i][picks[i]].offset, score: fits[i][picks[i]].score }]));
  if (chosen.length < 3) return chosen;
  return chosen.filter((anchor, i) => chosen.some((o, j) => j !== i && Math.abs(o.offset - anchor.offset) <= 1500));
}

/** What a change of shift between two windows costs, in window scores (a window scores 0.45 to 1). */
const STEP_COST = 0.6;
/** How many runs are followed at once. */
const MAX_RUNS = 64;

/**
 * Turns the anchors into a shift per caption line. Anchors that agree (within
 * AGREE_MS) share one shift. Where they differ, the change is placed at the
 * longest silence in the captions between the two windows, which is where a
 * cut, recap or break usually sits.
 */
/**
 * Windows measure the same release a few hundred ms apart, because dub lines
 * and translated lines never start at quite the same moment (seen: -0.88 to
 * -1.16 s within one episode). Differences under this are noise.
 */
const AGREE_MS = 500;

/** How much of a reference line the captions cover when shifted. */
function coverage(line: Cue, captions: Cue[], shift: number): number {
  let total = 0;
  for (const c of captions) {
    if (c.start + shift >= line.end) break;
    total += Math.max(0, Math.min(line.end, c.end + shift) - Math.max(line.start, c.start + shift));
  }
  return total / (line.end - line.start);
}

/**
 * Where the shift changes from a to b, in caption time. Every pause between
 * caption lines in the span is a candidate; the one that lets the most
 * reference lines fit (lines before it at a's shift, after it at b's) wins.
 * Each line only has to choose between two known shifts, which holds up with
 * few lines where measuring an offset would not. Without reference lines in
 * the span, the longest pause is used.
 */
export function placeStep(a: Anchor, b: Anchor, captions: Cue[], reference: Cue[]): number {
  const lo = a.from - a.offset;
  const hi = b.to - b.offset;
  const gaps: Array<{ at: number; width: number }> = [];
  for (let k = 0; k < captions.length - 1; k++) {
    const gapStart = captions[k].end;
    const gapEnd = captions[k + 1].start;
    if (gapEnd <= gapStart || gapStart < lo || gapEnd > hi) continue;
    gaps.push({ at: (gapStart + gapEnd) / 2, width: gapEnd - gapStart });
  }
  if (gaps.length === 0) return ((a.to - a.offset) + (b.from - b.offset)) / 2;
  const lines = reference.filter((r) => r.start >= a.from && r.end <= b.to);
  if (lines.length === 0) return gaps.reduce((x, y) => (y.width > x.width ? y : x)).at;

  // Each line's fit at either shift, worked out once.
  const fits = lines.map((r) => ({ start: r.start, atA: coverage(r, captions, a.offset), atB: coverage(r, captions, b.offset) }));
  let best = { at: gaps[0].at, score: -Infinity };
  for (const gap of gaps) {
    // In reference time a line before the switch sits before gap+a, after it past gap+b.
    let score = 0;
    for (const f of fits) {
      if (f.start < gap.at + a.offset) score += f.atA;
      else if (f.start >= gap.at + b.offset) score += f.atB;
    }
    if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && gap.width > 0)) best = { at: gap.at, score };
  }
  return best.at;
}

/**
 * A shift that follows a run of anchors from one to the next instead of taking their median: each
 * anchor's shift (the median of it and its neighbours in the run, against a window read a little off)
 * holds at the middle of its window, and between two anchors the shift moves in proportion. For timing
 * by line starts, whose windows are each read to a line: a subtitle's shift can creep between its
 * steps (seen: +2.4 s rising to +4.0 s over 20 minutes, all within half a second from one window to
 * the next), and one shift for the run left its ends a second off.
 */
function followRun(run: Anchor[]): (start: number) => number {
  const offsets = run.map((a) => a.offset);
  const points = run
    .map((a, k) => {
      const near = offsets.slice(Math.max(0, k - 1), k + 2).sort((x, y) => x - y);
      const offset = near.length === 3 ? near[1] : a.offset;
      return { at: (a.from + a.to) / 2 - offset, offset };
    })
    .sort((x, y) => x.at - y.at);
  return (start) => {
    if (start <= points[0].at) return points[0].offset;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      if (start <= b.at) return Math.round(a.offset + ((b.offset - a.offset) * (start - a.at)) / Math.max(1, b.at - a.at));
    }
    return points[points.length - 1].offset;
  };
}

/**
 * A shift per caption start from the anchors (see the runs below). `follow`: within a run the shift
 * follows its anchors (followRun) instead of taking their median.
 */
export function planShifts(anchors: Anchor[], captions: Cue[], reference: Cue[] = [], follow = false): (start: number) => number {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  if (sorted.length === 0) return () => 0;
  const offsets = sorted.map((a) => a.offset);
  if (follow && Math.max(...offsets) - Math.min(...offsets) <= AGREE_MS) return followRun(sorted);
  if (Math.max(...offsets) - Math.min(...offsets) <= AGREE_MS) {
    const median = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)];
    return () => median;
  }

  // Runs of anchors whose neighbours agree: a step sits only where two neighbours differ by more than
  // AGREE_MS. Each run takes the median of its own anchors' shifts, as a file with one run does
  // above. (It used to take the shift of the anchor that started it, for the whole run: a subtitle
  // whose windows read +0.46, +0.15, -0.20, ... around a true 0 was served 0.46 s late throughout.)
  const runs: Anchor[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].offset - sorted[i - 1].offset) > AGREE_MS) runs.push([]);
    runs[runs.length - 1].push(sorted[i]);
  }
  const shiftOf = runs.map((run) => {
    const offsets = run.map((a) => a.offset).sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)];
  });
  // Boundaries in caption time (the times as written in the caption file).
  const bounds: Array<{ at: number; offset: number }> = [];
  for (let i = 0; i < runs.length - 1; i++) {
    const a = { ...runs[i][runs[i].length - 1], offset: shiftOf[i] };
    const b = { ...runs[i + 1][0], offset: shiftOf[i + 1] };
    bounds.push({ at: placeStep(a, b, captions, reference), offset: b.offset });
  }
  if (follow) {
    const within = runs.map(followRun);
    return (start) => {
      let run = 0;
      bounds.forEach((bound, i) => {
        if (start >= bound.at) run = i + 1;
      });
      return within[run](start);
    };
  }
  return (start) => {
    let offset = shiftOf[0];
    for (const bound of bounds) if (start >= bound.at) offset = bound.offset;
    return offset;
  };
}

// ---------- following a translation's shift through the file ----------

/**
 * A translation is timed to the playing file's own lines, so where those lines start says its timing
 * more exactly than overlap does. Overlap reads each window a few hundred ms off, differently from one
 * window to the next (lines held longer, split or merged differently), and planShifts serves that as
 * it reads it. Over the replay data that also glued two shifts into one where a window straddled a cut
 * (-4.95 and -5.95 s joined by a window read at -5.48 s, served half a second off for ten minutes),
 * and flattened subtitles that creep (one went from +1.0 to +4.4 s over 37 minutes) into one median.
 * Dub captions follow the dub, not the file's lines: they keep planShifts.
 */

/** t minus the start nearest to it, of a sorted list (Infinity when it's empty). */
function gapToStart(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < starts.length ? starts[lo] - t : Infinity;
  const before = lo > 0 ? t - starts[lo - 1] : Infinity;
  return after < before ? -after : before;
}

/** How many of the file's line starts meet a caption start within `tolerance`, the captions moved by shift(t). */
function meetCount(lines: number[], starts: number[], shift: (t: number) => number, tolerance: number): number {
  return lines.filter((t) => Math.abs(gapToStart(starts, t - shift(t))) <= tolerance).length;
}

/**
 * How far the captions' line starts (sorted) are from meeting the file's line starts `lines`, once
 * moved by base(t): the correction within ±reach at which the most of them meet a caption start
 * within `tolerance`, and how many meet then. Undefined when fewer than MEET_MIN_LINES, or under
 * MEET_MIN_SHARE of the lines, meet at best.
 */
export function meetStarts(lines: number[], starts: number[], base: (t: number) => number, reach = MEET_REACH_MS, tolerance = MEET_TOLERANCE_MS): { correction: number; met: number } | undefined {
  if (lines.length < MEET_MIN_LINES || starts.length === 0) return undefined;
  const moved = lines.map((t) => t - base(t));
  const metAt = (c: number) => moved.filter((t) => Math.abs(gapToStart(starts, t - c)) <= tolerance).length;
  const counts: number[] = [];
  for (let c = -reach; c <= reach; c += MEET_STEP_MS) counts.push(metAt(c));
  const best = Math.max(...counts);
  if (best < MEET_MIN_LINES || best < MEET_MIN_SHARE * lines.length) return undefined;
  // The middle of the widest stretch of corrections at the best count, then the median gap of the
  // lines that meet there: a count alone is flat over a stretch as wide as the tolerance.
  let from = 0;
  let width = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] !== best) continue;
    let k = i;
    while (k + 1 < counts.length && counts[k + 1] === best) k++;
    if (k - i + 1 > width) (from = i), (width = k - i + 1);
    i = k;
  }
  const middle = -reach + (from + (width - 1) / 2) * MEET_STEP_MS;
  const gaps = moved.map((t) => gapToStart(starts, t - middle)).filter((d) => Math.abs(d) <= tolerance).sort((a, b) => a - b);
  const correction = Math.round(middle + gaps[gaps.length >> 1]);
  return { correction, met: metAt(correction) };
}

/** How far from its overlap fit a window's line starts are looked for: overlap was seen up to 0.7 s off. */
const MEET_REACH_MS = 700;
/** A line start meets a caption start this close, in one window. */
const MEET_TOLERANCE_MS = 120;
const MEET_STEP_MS = 10;
/** Fewer lines meeting than this, or than this share of them, isn't a fit (chance meets about 8% at 120 ms). */
const MEET_MIN_LINES = 4;
const MEET_MIN_SHARE = 0.25;
/**
 * A whole stretch is fitted with a looser tolerance: its lines are many, and a translation's lines
 * each sit a beat off (at 120 ms the fit followed the beats of a few lines: wobble-windows lost 5 points).
 */
const STRETCH_TOLERANCE_MS = 400;
/** Two timings of a stretch are compared by how many of its line starts meet a caption start this close. */
const MEET_JUDGE_MS = 200;
/** A shift that moves along a stretch must move this much over it to be tried... */
const TREND_MIN_MS = 200;
/** ...and is taken only when it makes this share more lines meet than one shift does (and see beyondChance). */
const TREND_MARGIN = 0.03;
/**
 * How far past chance a step or a moving shift must take a stretch's lines (see beyondChance). A
 * count of lines that meet wanders by about its square root from one fit to the next, and a fit
 * with more freedom (two shifts, or one that moves) always finds some of that to gain. Over the
 * stored plays, with every fifth of the file's lines hidden from the sync in turn, 1.5 and 2 did
 * best for the hidden lines, 1 a little less.
 */
const CHANCE_Z = 1.5;
/** Windows' fits within this of one line through them are a subtitle that creeps: one stretch. */
const ALONG_MS = 250;
/** Tied pauses spread wider than this lie across a stretch that wasn't read. */
const TIED_SPAN_MS = 60000;

/**
 * How many more lines a timing with more freedom (a step, or a shift that moves along a stretch)
 * must make meet than the simpler one, which makes `met` of them meet: TREND_MARGIN of them, and
 * no fewer than CHANCE_Z times the square root of `met`, what fitting a count's noise can give.
 * Where only a quarter of each window's lines meet (a translation timed loosely, for a release cut
 * differently), a 3% margin was a line or two: a slope or a step fitted to a few lines a beat off
 * served whole minutes 0.3 s off (seen: minutes moved from -7.55 s, where they belong, to -7.24 and
 * -7.9 s).
 */
function beyondChance(met: number): number {
  return Math.max(TREND_MARGIN * met, CHANCE_Z * Math.sqrt(met));
}

/** The line most points agree with (Theil-Sen: the median of the slopes between pairs). */
function robustLine(points: Array<{ x: number; y: number }>): { intercept: number; slope: number } {
  const median = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) if (points[j].x !== points[i].x) slopes.push((points[j].y - points[i].y) / (points[j].x - points[i].x));
  const slope = slopes.length ? median(slopes) : 0;
  return { intercept: median(points.map((p) => p.y - slope * p.x)), slope };
}

/**
 * placeStep by line starts: of the pauses between caption lines in the span, the one that lets the
 * most of the file's line starts (sorted, `lines`) meet a caption start, those before it at a's shift
 * and those after it at b's. Overlap counts a line a beat off as half fitting; it put a step a minute
 * away from where the lines changed (seen on a translation around an opening song). Among pauses the
 * lines can't tell apart, the longest, where a cut most likely is; when those spread over a stretch
 * that wasn't read (a file read in windows), the middle one.
 */
export function stepByStarts(a: Anchor, b: Anchor, captions: Cue[], lines: number[], starts: number[]): number {
  const lo = a.from - a.offset;
  const hi = b.to - b.offset;
  const gaps: Array<{ at: number; width: number }> = [];
  for (let k = 0; k < captions.length - 1; k++) {
    const gapStart = captions[k].end;
    const gapEnd = captions[k + 1].start;
    if (gapEnd <= gapStart || gapStart < lo || gapEnd > hi) continue;
    gaps.push({ at: (gapStart + gapEnd) / 2, width: gapEnd - gapStart });
  }
  if (gaps.length === 0) return (a.to - a.offset + (b.from - b.offset)) / 2;
  const span = lines.filter((t) => t >= a.from && t < b.to);
  const meetsA = span.map((t) => Math.abs(gapToStart(starts, t - a.offset)) <= MEET_JUDGE_MS);
  const meetsB = span.map((t) => Math.abs(gapToStart(starts, t - b.offset)) <= MEET_JUDGE_MS);
  const scores = gaps.map((gap) => span.reduce((sum, t, i) => sum + (t < gap.at + a.offset ? Number(meetsA[i]) : t >= gap.at + b.offset ? Number(meetsB[i]) : 0), 0));
  const top = Math.max(...scores);
  const tied = gaps.filter((_, i) => scores[i] === top);
  if (tied[tied.length - 1].at - tied[0].at > TIED_SPAN_MS) return tied[(tied.length - 1) >> 1].at;
  return tied.reduce((x, y) => (y.width > x.width ? y : x)).at;
}

export interface Followed {
  shift: (start: number) => number;
  /** The anchors with the shift served at the middle of each window. */
  anchors: Anchor[];
  /** Whether the file's line starts set the timing of at least one stretch (enough of them met). */
  byStarts: boolean;
}

/**
 * planShifts for a translation, from the file's lines that were read (`lines`):
 * 1. Each window's shift is fitted again by its line starts (meetStarts), where they meet clearly.
 * 2. The windows are cut into stretches wherever neighbours differ by over AGREE_MS, and a stretch
 *    still spread wider than that is cut at its largest jump (a window across a cut reads between
 *    the two shifts, close enough to both to join them), unless its windows' fits lie along a line.
 * 3. Each stretch takes the one shift at which the most of all its line starts meet the captions',
 *    or a shift moving along it (a line through its windows' fits, for a subtitle that creeps) when
 *    that makes clearly more of them meet (beyondChance). Where too few meet, it keeps its windows'
 *    median overlap.
 * 4. Neighbouring stretches that one shift fits about as well (each side losing no more than chance
 *    accounts for) are joined again, the pair that loses least first (a stretch whose lines don't
 *    meet goes first with the neighbour its overlap lands on).
 * 5. Between stretches, the step is placed by stepByStarts.
 * 6. No line is moved before the one written ahead of it, nor over it (inOrder).
 */
export function followShifts(anchors: Anchor[], captions: Cue[], lines: Cue[]): Followed {
  if (anchors.length === 0) return { shift: () => 0, anchors, byStarts: false };
  const starts = [...new Set(captions.map((c) => c.start))].sort((a, b) => a - b);
  const fileStarts = lines.map((l) => l.start).sort((a, b) => a - b);
  const own = [...anchors].sort((a, b) => a.from - b.from).map((anchor) => {
    const inside = fileStarts.filter((t) => t >= anchor.from && t < anchor.to);
    const met = meetStarts(inside, starts, () => anchor.offset);
    return { anchor, offset: met ? anchor.offset + met.correction : anchor.offset, met: Boolean(met), lines: inside };
  });
  type Own = (typeof own)[number];
  const centre = (o: Own) => (o.anchor.from + o.anchor.to) / 2;
  const cut = (run: Own[]): Own[][] => {
    const offsets = run.map((o) => o.offset);
    if (run.length < 2 || Math.max(...offsets) - Math.min(...offsets) <= AGREE_MS) return [run];
    // Fits that lie along a line are a subtitle that creeps, not a cut.
    const fitted = run.filter((o) => o.met);
    if (fitted.length >= 3) {
      const line = robustLine(fitted.map((o) => ({ x: centre(o), y: o.offset })));
      if (fitted.every((o) => Math.abs(o.offset - line.intercept - line.slope * centre(o)) <= ALONG_MS)) return [run];
    }
    let at = 1;
    for (let i = 2; i < run.length; i++) if (Math.abs(offsets[i] - offsets[i - 1]) > Math.abs(offsets[at] - offsets[at - 1])) at = i;
    return [...cut(run.slice(0, at)), ...cut(run.slice(at))];
  };
  const runs: Own[][] = [[own[0]]];
  for (let i = 1; i < own.length; i++) {
    if (Math.abs(own[i].offset - own[i - 1].offset) > AGREE_MS) runs.push([]);
    runs[runs.length - 1].push(own[i]);
  }
  const settleRun = (run: Own[], mayMove = true) => {
    const lo = run[0].anchor.from;
    const hi = run[run.length - 1].anchor.to;
    const runLines = run.flatMap((o) => o.lines);
    const fitted = run.filter((o) => o.met);
    const values = (fitted.length ? fitted : run).map((o) => o.offset).sort((a, b) => a - b);
    // A timing for the stretch (one shift, or one moving along it and held at its ends), moved to
    // where all of its lines meet best if that makes no fewer of them meet; it holds when enough do.
    const settle = (intercept: number, slope: number) => {
      let at = (t: number) => intercept + slope * Math.min(hi, Math.max(lo, t));
      let met = meetCount(runLines, starts, at, MEET_JUDGE_MS);
      const pooled = meetStarts(runLines, starts, at, MEET_REACH_MS, STRETCH_TOLERANCE_MS);
      if (pooled) {
        const along = at;
        const moved = (t: number) => along(t) + pooled.correction;
        const now = meetCount(runLines, starts, moved, MEET_JUDGE_MS);
        if (now >= met) (at = moved), (met = now);
      }
      return { at, met, byStarts: met >= Math.max(MEET_MIN_LINES, MEET_MIN_SHARE * runLines.length) };
    };
    let plan = settle(values[values.length >> 1], 0);
    if (mayMove && fitted.length >= 2) {
      const line = robustLine(fitted.map((o) => ({ x: centre(o), y: o.offset })));
      if (Math.abs(line.slope) * (hi - lo) >= TREND_MIN_MS) {
        const moving = settle(line.intercept, line.slope);
        if (moving.byStarts && moving.met > plan.met + beyondChance(plan.met)) plan = moving;
      }
    }
    // Lines that don't meet the captions as a whole can still meet by chance in one window: then
    // the stretch keeps the median of its windows' overlap, as planShifts gives it.
    if (!plan.byStarts) {
      const overlap = run.map((o) => o.anchor.offset).sort((a, b) => a - b)[run.length >> 1];
      return { at: () => overlap, met: meetCount(runLines, starts, () => overlap, MEET_JUDGE_MS), byStarts: false };
    }
    return plan;
  };
  const stretches = runs.flatMap(cut);
  const plans = stretches.map((run) => settleRun(run));
  // A step must earn its place: two neighbouring stretches whose lines meet about as well at one
  // shift are joined again, where neither side loses more lines than chance accounts for
  // (beyondChance). A window's own fit can be a few hundred ms off where few of its lines meet,
  // enough to cut. The pair that loses least is joined first, then the one whose shifts differ least.
  // A stretch whose lines don't meet loses about as few at any shift, so they can't say where it
  // belongs: it goes first with a neighbour its windows' overlap lands on (LAND_MS, as landsOnTiming
  // counts it). Seen: two minutes read at -7.24 and -7.4 s, between stretches at -5.0 and -7.7 s,
  // joined to -5.0 s and served 2.5 s off. Overlap that lands on neither (chance fits at the edge of
  // the search) leaves it to the lines.
  const landsOn = (run: Own[], plan: (typeof plans)[number], at: (t: number) => number) =>
    plan.byStarts || run.filter((o) => Math.abs(at(centre(o)) - o.anchor.offset) <= LAND_MS).length * 2 >= run.length;
  for (;;) {
    let best: { at: number; plan: (typeof plans)[number]; lands: boolean; gain: number; step: number } | undefined;
    for (let i = 0; i < stretches.length - 1; i++) {
      const plan = settleRun([...stretches[i], ...stretches[i + 1]], false);
      const keeps = (k: number) => meetCount(stretches[k].flatMap((o) => o.lines), starts, plan.at, MEET_JUDGE_MS) + beyondChance(plans[k].met) >= plans[k].met;
      if (!keeps(i) || !keeps(i + 1)) continue;
      const step = Math.abs(plans[i].at(stretches[i][stretches[i].length - 1].anchor.to) - plans[i + 1].at(stretches[i + 1][0].anchor.from));
      const gain = plan.met - plans[i].met - plans[i + 1].met;
      const lands = landsOn(stretches[i], plans[i], plan.at) && landsOn(stretches[i + 1], plans[i + 1], plan.at);
      if (!best || (lands !== best.lands ? lands : gain > best.gain || (gain === best.gain && step < best.step))) best = { at: i, plan, lands, gain, step };
    }
    if (!best) break;
    stretches.splice(best.at, 2, [...stretches[best.at], ...stretches[best.at + 1]]);
    plans.splice(best.at, 2, best.plan);
  }
  const bounds = placeSteps(
    stretches.map((run, k) => {
      const first = run[0].anchor;
      const last = run[run.length - 1].anchor;
      return { first: { ...first, offset: Math.round(plans[k].at(first.from)) }, last: { ...last, offset: Math.round(plans[k].at(last.to)) } };
    }),
    captions,
    fileStarts,
    starts
  );
  // A plan gives the shift at a moment of the file; a caption start c lands at c + shift.
  const landed = (plan: (typeof plans)[number], c: number) => plan.at(c + plan.at(c + plan.at(c)));
  const raw = (start: number) => {
    let k = 0;
    while (k < bounds.length && start >= bounds[k]) k++;
    return Math.round(landed(plans[k], start));
  };
  const served = stretches.flatMap((run, k) => run.map((o) => ({ ...o.anchor, offset: Math.round(plans[k].at(centre(o))) })));
  return { shift: inOrder(captions, raw), anchors: served, byStarts: plans.some((p) => p.byStarts) };
}

/**
 * The steps between stretches of followShifts, in caption time and in order: each placed by
 * stepByStarts between the last window of one stretch and the first of the next (`first` and `last`
 * carry the stretch's shift at its two ends). A stretch of one window is both, so the steps on
 * either side of it are looked for across that same window and can come out the wrong way round,
 * and then the stretch would get no lines at all. Those two are placed again, each on its own half of
 * the stretch. A step still before the one ahead of it is held at that one: the lookup in
 * followShifts walks the steps in order.
 */
export function placeSteps(stretches: Array<{ first: Anchor; last: Anchor }>, captions: Cue[], lines: number[], starts: number[]): number[] {
  const place = (i: number, half?: number) => {
    const a = stretches[i].last;
    const b = stretches[i + 1].first;
    // The step after a stretch looks from its middle on, the step before it up to its middle.
    const from = half !== undefined && i === half ? Math.max(a.from, middle(stretches[i])) : a.from;
    const to = half !== undefined && i + 1 === half ? Math.min(b.to, middle(stretches[i + 1])) : b.to;
    return stepByStarts({ ...a, from }, { ...b, to }, captions, lines, starts);
  };
  const middle = (s: { first: Anchor; last: Anchor }) => (s.first.from + s.last.to) / 2;
  const bounds = stretches.slice(1).map((_, i) => place(i));
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] >= bounds[i - 1]) continue;
    bounds[i - 1] = place(i - 1, i);
    bounds[i] = place(i, i);
  }
  for (let i = 1; i < bounds.length; i++) bounds[i] = Math.max(bounds[i], bounds[i - 1]);
  return bounds;
}

/**
 * The timing a translation takes from the file's own lines (followShifts), or undefined to keep
 * planShifts. Timing heard in speech (`heard`) is taken from them only when enough of them meet it:
 * the captions fit no shift on that track, so it may not be their dialogue at all.
 *
 * Given `file`, the file these lines are read from, the timing must also account for the whole file
 * (accountsForFile), as the plan it refines already did. The checks of syncCaptions judge that plan,
 * before followShifts runs, so what followShifts does can never make a subtitle count as synced. It
 * only refines: each window within 0.7 s of what overlap read, and two stretches joined only where
 * neither loses more lines than chance accounts for (beyondChance). A join can still move a stretch
 * by a few seconds, so the timing served is held to the same test, and one that fails is dropped
 * for the plan it refined. Over the stored plays and the benchmark, none has failed.
 */
export function timingByStarts(anchors: Anchor[], captions: Cue[], lines: Cue[], heard: boolean, file?: FileAnchors): Followed | undefined {
  if (lines.length === 0) return undefined;
  const followed = followShifts(anchors, captions, lines);
  if (heard && !followed.byStarts) return undefined;
  return file && accountsForFile(file, captions, followed.shift) ? undefined : followed;
}

/**
 * A shift that changes from line to line, held so that no line moves before the one written ahead of
 * it, nor over it when they didn't overlap as written: it moves only as far as that line allows.
 *
 * Only the shift's changes from line to line are held so (a shift that creeps, or a stretch's lines
 * met a few ms apart). Where it steps back between two lines by more than STEP_BACK_MS, by more than
 * the pause the step sits in, the line after the step is left where the step puts it, as keptInOrder
 * leaves lines a step put out of order: that is the step's doing, and the lines after it are timed
 * by it. Held, it pushed them later one after another (seen: a step 4 s back in a 1.5 s pause put
 * the next five lines 2.5, 1.9, 1.3, 0.7 and 0.1 s late).
 */
export function inOrder(captions: Cue[], shift: (start: number) => number): (start: number) => number {
  const sorted = [...captions].sort((a, b) => a.start - b.start || b.end - a.end);
  const held = new Map<number, number>();
  let prev: { start: number; end: number; shift: number; asTimed: number } | undefined;
  for (const c of sorted) {
    if (held.has(c.start)) continue;
    const asTimed = shift(c.start);
    let s = asTimed;
    if (prev && prev.asTimed - asTimed <= STEP_BACK_MS) {
      const floor = c.start >= prev.end ? prev.end + prev.shift : prev.start + prev.shift;
      if (c.start + s < floor) s = floor - c.start;
    }
    held.set(c.start, s);
    prev = { start: c.start, end: c.end, shift: s, asTimed };
  }
  return (start) => held.get(start) ?? shift(start);
}

/**
 * A drop in the shift between two neighbouring lines past this is a step, not a change from line to
 * line (see inOrder). A shift that creeps moves by half a second over a minute at most (followRun),
 * a few ms from one line to the next.
 */
const STEP_BACK_MS = 100;

// ---------- reading the playing file ----------

/**
 * Most ffprobe/ffmpeg processes at once, across everyone. A new file that isn't timed from its
 * index reads 5 windows side by side; several people starting at the same moment queue here
 * instead of piling up on the machine.
 */
const MAX_PROCS = 6;
let runningProcs = 0;
const waitingProcs: Array<() => void> = [];

async function procSlot(): Promise<void> {
  if (runningProcs < MAX_PROCS) {
    runningProcs++;
    return;
  }
  count("proc.queued");
  // The slot is handed over by the one that finishes, so the count stays exact.
  await new Promise<void>((resolve) => waitingProcs.push(resolve));
}

function freeSlot(): void {
  const next = waitingProcs.shift();
  if (next) next();
  else runningProcs--;
}

/** ffprobe/ffmpeg, counted for the stats page: runs, wall time and failures are the addon's main cost. */
async function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  await procSlot();
  const startedAt = Date.now();
  // The file being read, to tell its host's refusals from other failures (see reads.ts).
  const url = args.find((a) => /^https?:\/\//.test(a));
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      freeSlot();
      count(`proc.${cmd}`);
      count(`proc.${cmd}.ms`, Date.now() - startedAt);
      if (error) {
        count(`proc.${cmd}.fail`);
        const refused = url ? refusalStatus(error.message) : undefined;
        if (url && refused) noteRefusal(url, refused);
        reject(error);
      } else {
        if (url) noteReadOk(url);
        resolve(stdout);
      }
    });
  });
}

/** A failed read of the playing file: logged, and listed on the dashboard unless reads are only paused. */
function readFailed(filename: string, error: unknown, what = ""): void {
  const message = scrub(error instanceof Error ? error.message : String(error));
  if (error instanceof ReadsPaused) {
    count("sync.heldBack");
    console.log(`sync: ${filename}: ${what}${message}`);
    return;
  }
  noteError("sync", error);
  console.error(`sync: ${filename}: ${what}${message}`);
}

/**
 * Roughly how many bytes ffmpeg reads for `ms` of the file: the stretch holds every track, so it is
 * the file's bit rate over that time (about WINDOW_BYTES per 40 s when the header doesn't say).
 */
function windowBytes(bitrate: number | undefined, ms: number): number {
  return bitrate ? (bitrate / 8) * (ms / 1000) : WINDOW_BYTES * (ms / WINDOW_MS);
}

/** Drops entries older than maxAgeMs from a map of things seen at a time, so it can't grow for ever. */
function forgetOld<V>(map: Map<string, V>, at: (value: V) => number, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, value] of map) if (at(value) < cutoff) map.delete(key);
}

/** How long a finished job for extra reads is remembered, so syncs running beside it don't read the same stretch twice. */
const JOB_KEPT_MS = 10 * 60 * 1000;

const PROTOCOLS = ["-protocol_whitelist", "http,https,tcp,tls,crypto"];

/** The playback URL AIOStreams gives for this exact file. */
async function streamUrl(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<string | undefined> {
  const base = aiostreamsUrl.replace(/\/manifest\.json$/, "");
  count("api.aiostreams");
  const response = await fetch(`${base}/stream/${type}/${encodeURIComponent(videoId)}.json`, { signal: AbortSignal.timeout(STREAM_LOOKUP_TIMEOUT_MS) });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { streams?: Array<{ url?: string; behaviorHints?: { filename?: string; videoSize?: number | string } }> };
  const listed = (body.streams ?? []).filter((s) => s.url && s.behaviorHints?.filename);
  const size = fileSize(filename);
  const sized = (s: (typeof listed)[number]) => size !== undefined && String(s.behaviorHints!.videoSize ?? "") === size;
  // Same name and same size first: two listed files can share a name. When none has exactly the
  // player's size, the nearest in size among those named alike (sizes are listed rounded, or
  // estimated, and the same file was seen listed 3% apart). Only among files with the right name.
  const wantedSize = size === undefined ? undefined : Number(size);
  const off = (s: (typeof listed)[number]) => (wantedSize !== undefined && Number(s.behaviorHints!.videoSize) > 0 ? Math.abs(Number(s.behaviorHints!.videoSize) - wantedSize) : Infinity);
  const pick = (same: (name: string) => boolean) => {
    const named = listed.filter((s) => same(s.behaviorHints!.filename!));
    return (named.find(sized) ?? named.reduce<(typeof listed)[number] | undefined>((best, s) => (best === undefined || off(s) < off(best) ? s : best), undefined))?.url;
  };
  const wanted = bareName(fileName(filename));
  const loose = releaseName(fileName(filename));
  return pick((name) => bareName(name) === wanted) ?? pick((name) => releaseName(name) === loose) ?? listed.find(sized)?.url;
}

/**
 * The playing file as one key: its name, and "/<bytes>" when the player sent its size. Synced timing
 * is stored under it, so two different files that share a name (a pack's "S01E06.mkv") don't share
 * timing. A name never holds "/", so the size comes back off unambiguously.
 */
export function fileRef(filename: string, size?: string): string {
  return size && /^[1-9]\d{0,15}$/.test(size) ? `${filename}/${size}` : filename;
}

/** The file name in a fileRef. */
export function fileName(ref: string): string {
  return ref.replace(/\/\d+$/, "");
}

function fileSize(ref: string): string | undefined {
  return /\/(\d+)$/.exec(ref)?.[1];
}

/** Usenet streams can name the file without its extension, so names are compared without one. */
function bareName(name: string): string {
  return name.toLowerCase().replace(/\.(mkv|mp4|avi|m4v|webm|ts)$/, "");
}

/**
 * A file's name without what changes between versions of the same release: the checksum tag
 * ("[E55294ED]") and the version after the episode ("01v2"). A debrid host can serve the first
 * version of a release that AIOStreams lists as its second, or the other way round.
 */
export function releaseName(name: string): string {
  return bareName(name)
    .replace(/\[[0-9a-f]{8}\]/g, "")
    .replace(/(\d)v\d\b/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface Probe {
  duration: number;
  track?: number;
  /** Picture subtitles (Blu-ray PGS, DVD): only their timing is read. */
  image?: boolean;
  /** More text tracks, next best first, read in the same pass as `track` (see trackChoice). */
  others?: number[];
  /** The audio track whose speech can stand in when there's no subtitle track (see pickAudio). */
  audio?: number;
  /** Its language as tagged, when it is. */
  audioLang?: string;
  /** Languages of the file's full text subtitle tracks (see fullTextLanguages). */
  languages: string[];
  /** Bits per second over the whole file, when the header says. */
  bitrate?: number;
}

const TEXT_CODECS = /^(ass|ssa|subrip|srt|webvtt|mov_text|text)$/;
const IMAGE_CODECS = /^(hdmv_pgs_subtitle|dvd_subtitle)$/;

type ProbedStream = { index: number; codec_type?: string; codec_name?: string; tags?: { language?: string; title?: string }; disposition?: { forced?: number } };

/**
 * Languages the file already has full subtitles in: text tracks, not signs, songs or forced lines,
 * as tagged ("ara", "eng"). Picture tracks (PGS) don't count: many players have to burn them in.
 */
export function fullTextLanguages(streams: ProbedStream[]): string[] {
  const signs = (s: ProbedStream) => /sign|song|forced/i.test(s.tags?.title ?? "") || Boolean(s.disposition?.forced);
  const tags = streams
    .filter((s) => s.codec_type === "subtitle" && TEXT_CODECS.test(s.codec_name ?? "") && !signs(s))
    .map((s) => (s.tags?.language ?? "").toLowerCase())
    .filter((l) => l && l !== "und");
  return [...new Set(tags)];
}

export function pickTrack(streams: ProbedStream[]): ProbedStream | undefined {
  return rankTracks(streams)[0];
}

/**
 * The file's subtitle tracks to time by, best first. Only their timing is used, never their words,
 * so the language matters little: a text track in any language beats a picture one (PGS, VobSub),
 * whose line times are known less exactly. Then English, then tracks titled Full or Dialogue. Signs,
 * songs and forced tracks time too few lines and are never candidates.
 */
export function rankTracks(streams: ProbedStream[]): ProbedStream[] {
  const signs = (s: ProbedStream) => /sign|song|forced/i.test(s.tags?.title ?? "") || Boolean(s.disposition?.forced);
  const usable = streams.filter((s) => s.codec_type === "subtitle" && (TEXT_CODECS.test(s.codec_name ?? "") || IMAGE_CODECS.test(s.codec_name ?? "")) && !signs(s));
  const rank = (s: ProbedStream) => {
    const language = s.tags?.language ?? "";
    let r = 0;
    if (TEXT_CODECS.test(s.codec_name ?? "")) r += 50;
    if (/^(eng?|und)?$/i.test(language)) r += 20;
    if (/^eng?$/i.test(language)) r += 1;
    if (/full|dialog/i.test(s.tags?.title ?? "")) r += 2;
    return r;
  };
  return [...usable].sort((x, y) => rank(y) - rank(x) || x.index - y.index);
}

/** More text tracks read beside the first one, to time by when it doesn't fit (see trackChoice). */
const MAX_OTHER_TRACKS = 2;

/**
 * The audio track to hear speech in: English first (dub captions follow the English dub), then the
 * file's default track, then the first one.
 */
export function pickAudio(streams: Array<ProbedStream & { disposition?: { default?: number } }>): number | undefined {
  const audio = streams.filter((s) => s.codec_type === "audio");
  const rank = (s: (typeof audio)[number]) => (/^eng?$/i.test(s.tags?.language ?? "") ? 2 : 0) + (s.disposition?.default ? 1 : 0);
  return [...audio].sort((a, b) => rank(b) - rank(a))[0]?.index;
}

/** Duration, the embedded subtitle track to time against (see pickTrack), and the audio track. */
async function probe(url: string): Promise<Probe> {
  const out = await run("ffprobe", [...PROTOCOLS, "-v", "error", "-show_entries", "format=duration,bit_rate:stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=forced,default", "-of", "json", url], 30000);
  const json = JSON.parse(out) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Array<{ index: number; codec_type?: string; codec_name?: string; tags?: { language?: string; title?: string }; disposition?: { forced?: number; default?: number } }>;
  };
  const ranked = rankTracks(json.streams ?? []);
  const track = ranked[0];
  const image = track ? IMAGE_CODECS.test(track.codec_name ?? "") : undefined;
  // Text tracks only: a picture track would take a read of its own per window.
  const others = image ? [] : ranked.slice(1).filter((s) => TEXT_CODECS.test(s.codec_name ?? "")).slice(0, MAX_OTHER_TRACKS).map((s) => s.index);
  const audio = pickAudio(json.streams ?? []);
  const audioLang = json.streams?.find((s) => s.index === audio)?.tags?.language;
  return {
    duration: Number(json.format?.duration ?? 0) * 1000,
    ...(Number(json.format?.bit_rate) > 0 ? { bitrate: Number(json.format?.bit_rate) } : {}),
    track: track?.index,
    image,
    ...(others.length ? { others } : {}),
    audio,
    ...(audioLang ? { audioLang } : {}),
    languages: fullTextLanguages(json.streams ?? [])
  };
}

// ---------- speech in the audio, for files without subtitles ----------

/** Whether a file with no subtitle track is synced to the speech in its audio (see bySpeech). */
export const SPEECH_SYNC = true;

/** Mono at 16 kHz, as Silero hears it (src/vad.ts). */
const SPEECH_AUDIO = ["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le"];
const SPEECH_RATE = 16000;
const FRAME_MS = 20;

/**
 * Where people speak in a stretch of audio (16 kHz mono, 16-bit), as cues starting at `from`. Loud
 * frames against the stretch's own quiet: the threshold sits between its floor and its peaks, so a
 * quiet scene and a loud one are judged alike. Short gaps join, short blips go, and stretches too
 * long to be one line of dialogue (music, action) are left out.
 */
export function speechCues(pcm: Buffer, from: number): Cue[] {
  const frameSamples = (SPEECH_RATE * FRAME_MS) / 1000;
  const levels: number[] = [];
  for (let offset = 0; offset + frameSamples * 2 <= pcm.length; offset += frameSamples * 2) {
    let sum = 0;
    for (let i = 0; i < frameSamples; i++) {
      const sample = pcm.readInt16LE(offset + i * 2);
      sum += sample * sample;
    }
    levels.push(10 * Math.log10(sum / frameSamples / (32768 * 32768) + 1e-12));
  }
  if (levels.length < 50) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)];
  const peak = sorted[Math.floor(sorted.length * 0.95)];
  if (peak - floor < 10) return []; // no contrast: silence, or wall-to-wall sound
  const threshold = Math.max(floor + 0.35 * (peak - floor), -60);
  const spans: Cue[] = [];
  levels.forEach((level, i) => {
    if (level < threshold) return;
    const start = i * FRAME_MS;
    const last = spans[spans.length - 1];
    if (last && start - last.end <= 300) last.end = start + FRAME_MS;
    else spans.push({ start, end: start + FRAME_MS });
  });
  return spans.filter((s) => s.end - s.start >= 250 && s.end - s.start <= 12000).map((s) => ({ start: from + s.start, end: from + s.end }));
}

/** A temporary file under the cache (the container's own disk is read-only). */
async function tempFile(ext: string): Promise<string> {
  await mkdir(cachePath("tmp"), { recursive: true });
  return path.join(cachePath("tmp"), `${randomUUID()}.${ext}`);
}

/** Speech in [from, from + length) of the file, from its audio track: for files with no subtitle track. */
async function readSpeechWindow(url: string, audio: number, from: number, length: number): Promise<Cue[]> {
  const pcm = await tempFile("pcm");
  try {
    await run("ffmpeg", [...PROTOCOLS, "-v", "error", "-ss", (from / 1000).toFixed(3), "-i", url, "-map", `0:${audio}`, "-t", (length / 1000).toFixed(3), ...SPEECH_AUDIO, "-y", pcm], 60000);
    return await heardSpeech(await readFile(pcm), from);
  } finally {
    await rm(pcm, { force: true });
  }
}

/**
 * Embedded dialogue lines in [from, from + length) of the file, ms. The seek
 * (-ss before -i) uses the file's index; the end must be an output -to, since
 * an input -t on a subtitle-only map doesn't stop the read and ffmpeg would
 * go through the whole file.
 */
/** One window's lines from the first track, speech heard in it, and the other text tracks' lines by track index. */
type WindowRead = { cues: Cue[]; speech?: Cue[]; others?: Record<string, Cue[]> };

/** As readWindowAndSpeech, but a failure hearing the audio never costs the lines: read again without it. */
async function readWindowAndSpeechSafely(url: string, track: number, audio: number | undefined, from: number, length: number, others: number[] = []): Promise<WindowRead> {
  if (audio === undefined) return readWindowAndSpeech(url, track, undefined, from, length, others);
  try {
    return await readWindowAndSpeech(url, track, audio, from, length, others);
  } catch (error) {
    console.error(`sync: speech not heard at ${Math.round(from / 1000)}s: ${scrub(error instanceof Error ? error.message : String(error))}`);
    return readWindowAndSpeech(url, track, undefined, from, length, others);
  }
}

/**
 * The window's dialogue lines and, from the same read, where people speak in it: the audio comes in
 * the same stretch of the file, so hearing it costs no extra download. Speech is kept beside the
 * lines (see FileAnchors) to measure how well it would time a file that has no subtitles.
 */
async function readWindowAndSpeech(url: string, track: number, audio: number | undefined, from: number, length: number, others: number[] = []): Promise<WindowRead> {
  const to = ((from + length) / 1000).toFixed(3);
  const pcm = audio === undefined ? undefined : await tempFile("pcm");
  // The other text tracks come in the same stretch of the file: writing them out costs no extra read.
  const extra = await Promise.all(others.map(async (index) => ({ index, file: await tempFile("ass") })));
  try {
    const out = await run(
      "ffmpeg",
      [
        ...PROTOCOLS, "-v", "error", "-probesize", "1000000", "-analyzeduration", "0",
        "-copyts", "-ss", (from / 1000).toFixed(3), "-i", url,
        "-map", `0:${track}`, "-to", to, "-c:s", "ass", "-f", "ass", "pipe:1",
        ...extra.flatMap(({ index, file }) => ["-map", `0:${index}`, "-to", to, "-c:s", "ass", "-f", "ass", "-y", file]),
        ...(pcm ? ["-map", `0:${audio}`, "-to", to, ...SPEECH_AUDIO, "-y", pcm] : [])
      ],
      pcm ? 60000 : 30000
    );
    const inWindow = (cues: Cue[]) => cues.filter((c) => c.start >= from && c.end <= from + length);
    const cues = inWindow(dialogueCues(out));
    const read: Record<string, Cue[]> = {};
    for (const { index, file } of extra) {
      try {
        read[index] = inWindow(dialogueCues(await readFile(file, "utf8")));
      } catch {}
    }
    let speech: Cue[] | undefined;
    if (pcm) {
      try {
        speech = await heardSpeech(await readFile(pcm), from);
      } catch {}
    }
    return { cues, ...(speech ? { speech } : {}), ...(Object.keys(read).length ? { others: read } : {}) };
  } finally {
    if (pcm) await rm(pcm, { force: true });
    await Promise.all(extra.map(({ file }) => rm(file, { force: true })));
  }
}

/**
 * Display times of a picture subtitle track in the window. A picture packet
 * shows a line and the next (tiny, clearing) packet ends it, so only packet
 * times and sizes are read (ffprobe -read_intervals), nothing is decoded.
 */
async function readImageWindow(url: string, track: number, from: number, length: number): Promise<Cue[]> {
  const out = await run(
    "ffprobe",
    [
      ...PROTOCOLS, "-v", "error", "-read_intervals", `${(from / 1000).toFixed(3)}%+${(length / 1000).toFixed(3)}`,
      "-select_streams", String(track), "-show_entries", "packet=pts_time,size", "-of", "csv=p=0", url
    ],
    30000
  );
  return imageCues(out).filter((c) => c.start >= from && c.end <= from + length);
}

/** "pts,size" rows to cues: a packet over 100 bytes shows a line until the next packet. */
export function imageCues(csv: string): Cue[] {
  const packets = csv
    .trim()
    .split(/\r?\n/)
    .map((row) => row.split(","))
    .map(([pts, size]) => ({ at: Math.round(Number(pts) * 1000), size: Number(size) }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.size))
    .sort((a, b) => a.at - b.at);
  const cues: Cue[] = [];
  for (let i = 0; i < packets.length - 1; i++) {
    const end = packets[i + 1].at;
    if (packets[i].size > 100 && end > packets[i].at && end - packets[i].at < 15000) cues.push({ start: packets[i].at, end });
  }
  return cues;
}

export interface FileAnchors {
  /** The file these were read from, kept for the replay check (scripts/replay.ts). */
  filename?: string;
  duration: number;
  /** bridge: read only to place a step between two anchors, not measured on its own. */
  windows: Array<{ from: number; to: number; cues: Cue[]; bridge?: boolean; speech?: Cue[]; others?: Record<string, Cue[]>; heard?: boolean }>;
  /** Bits per second, from the header: heavy files get shorter windows (windowMs). */
  bitrate?: number;
  /** "index": the lines come from the Matroska index, over the whole file (indexAnchors); heard windows hold only speech. */
  source?: "index";
  /** More text tracks read in each window (their lines in windows[].others), next best first: see trackChoice. */
  others?: number[];
  /** The embedded track the windows were read from, for reading more of them later. */
  track?: number;
  image?: boolean;
  /** The audio track speech is heard in (see pickAudio). */
  audio?: number;
  /** That audio track's language as tagged ("eng", "jpn"); unknown on older records. */
  audioLang?: string;
  /**
   * No subtitle track: the windows' cues are where people speak, heard in the audio. Otherwise the
   * windows also keep their speech beside the lines, to measure how well speech times a file.
   */
  speechOnly?: boolean;
  /**
   * How many rounds of extra windows have been read (at most MAX_ROUNDS). For a file with no
   * subtitle track, at most SPEECH_ROUNDS: the audio heard at MORE_SPOTS (see hearMoreSpeech).
   */
  rounds?: number;
  /**
   * On a file with no windows: written since files with no subtitle track are timed by speech.
   * Older empty records don't count (the file may have audio to time by): it is probed again.
   */
  speechChecked?: boolean;
  /** How the windows' speech was heard: "silero" (src/vad.ts). Older speech, from loudness alone, isn't used. */
  speechBy?: "silero";
  /** Languages the file already has full text subtitles in (see fullTextLanguages); unknown on older records. */
  subtitleLangs?: string[];
}

/**
 * A stored record still worth trusting: empty ones from before speech sync, and speech-only ones
 * heard by loudness alone, are read again.
 */
export function stillValid(found: FileAnchors): boolean {
  if (found.speechOnly) return found.speechBy === "silero";
  return found.windows.length > 0 || Boolean(found.speechChecked);
}

const WINDOW_SPOTS = [0.15, 0.32, 0.5, 0.68, 0.85];
const WINDOW_MS = 40000;
/**
 * A window's length for a file of this bit rate: 40 s, shorter for files so heavy that 40 s is
 * hundreds of MB (a 2160p remux carries about 10 times a web release's data per second), down to 20 s.
 * Reading 5 of them at 70 Mb/s took over 8 s, past what a player waits for its subtitle.
 */
export function windowMs(bitrate: number | undefined): number {
  if (!bitrate) return WINDOW_MS;
  return Math.round(Math.min(WINDOW_MS, Math.max(MIN_WINDOW_MS, ((WINDOW_BYTES * 8) / bitrate) * 1000)));
}
const MIN_WINDOW_MS = 20000;
/** About this much of a file per window. */
const WINDOW_BYTES = 60 * 1024 * 1024;

const fileAnchorJobs = new Map<string, Promise<FileAnchors | undefined>>();
/** Resolved playback URLs, kept in memory only (they expire), for reading extra windows. */
const playbackUrls = new Map<string, { url: string; at: number }>();

function anchorsFile(filename: string): string {
  return path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename })}.json`);
}

/**
 * Files AIOStreams didn't list, by when that was seen. A player names the stream that was picked; when
 * it was dead and AIOStreams failed over to another one, the picked one drops out of later lists
 * (seen: a dead usenet REMUX; three NZBs missing on the providers, then a file from
 * another service played while the player still named the first). AIOStreams drops
 * a failed NZB from later lists, and which file failover played is known only to it, so lists show
 * these tracks unsynced: timing from the named file would be wrong for the one playing. The list is
 * asked for a few times first (see lookUpStreamAgain); after that the lookup isn't repeated for
 * UNLISTED_MS.
 */
const unlisted = new Map<string, number>();
const UNLISTED_MS = 10 * 60 * 1000;
/** A search through every indexer can take a while the first time (one ran past 20 s); nothing waits on it but the sync. */
const STREAM_LOOKUP_TIMEOUT_MS = 45 * 1000;
/** One lookup per file at a time: the header read and the windows share it, so indexers are searched once. */
const lookups = new Map<string, Promise<string | undefined>>();

/** The playing file's stream URL from AIOStreams, by its name (see unlisted for when it isn't there). */
export function lookUpStream(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<string | undefined> {
  return streamUrl(aiostreamsUrl, videoId, type, filename);
}

/**
 * As lookUpStream, asking again when the file isn't listed. AIOStreams' list for one title differs
 * from one request to the next (a slow source misses one answer and is in the next): a film's file
 * wasn't in the list asked for at play and was in one asked for a minute later, and two
 * lists a second apart differed. It is asked again after each of `waits` before the file counts as
 * unlisted. A file failover replaced is in none of them, so that costs only the wait.
 */
export async function lookUpStreamAgain(aiostreamsUrl: string, videoId: string, type: string, filename: string, waits: number[] = LOOKUP_RETRY_MS): Promise<string | undefined> {
  let found = await lookUpStream(aiostreamsUrl, videoId, type, filename);
  for (const wait of waits) {
    if (found) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
    count("sync.lookupRetry");
    found = await lookUpStream(aiostreamsUrl, videoId, type, filename).catch(() => undefined);
    if (found) {
      count("sync.lookupRetryFound");
      console.log(`sync: ${filename}: not in AIOStreams' list at first, found on asking again`);
    }
  }
  return found;
}

/** How long to wait before each further look for a file AIOStreams didn't list. */
const LOOKUP_RETRY_MS = [5000, 15000];

/** Whether AIOStreams was just found not to list this file (see unlisted). */
export function notListed(filename: string): boolean {
  const at = unlisted.get(filename);
  if (at === undefined) return false;
  if (Date.now() - at < UNLISTED_MS) return true;
  unlisted.delete(filename);
  return false;
}

/**
 * The URL to read the playing file at. `background`: for a read nobody waits on (see hearDubVoices),
 * AIOStreams is asked once, with no asking again later, and a file it doesn't list isn't marked as
 * unlisted (that would label the next list's tracks unsynced).
 */
async function resolvePlayback(aiostreamsUrl: string, videoId: string, type: string, filename: string, background = false): Promise<string> {
  const known = playbackUrls.get(filename);
  if (known && Date.now() - known.at < PLAYBACK_KEPT_MS) {
    checkReads(known.url);
    return known.url;
  }
  checkReads();
  if (notListed(filename)) throw new Error(`no stream in AIOStreams named ${filename} (seen a moment ago)`);
  let lookup = lookups.get(filename);
  if (!lookup && background) lookup = lookUpStream(aiostreamsUrl, videoId, type, filename);
  else if (!lookup) {
    lookup = lookUpStreamAgain(aiostreamsUrl, videoId, type, filename).finally(() => lookups.delete(filename));
    lookups.set(filename, lookup);
  }
  const playback = await lookup;
  if (!playback) {
    if (background) throw new Error(`no stream in AIOStreams named ${filename} (asked once, for the audio)`);
    forgetOld(unlisted, (at) => at, UNLISTED_MS);
    unlisted.set(filename, Date.now());
    throw new Error(`no stream in AIOStreams named ${filename}`);
  }
  // Follow AIOStreams' redirect once, so each window's range request goes straight to the host.
  const head = await fetch(playback, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(20000) });
  await head.arrayBuffer();
  const url = head.ok ? head.url : playback;
  if (head.status === 403 || head.status === 429) noteRefusal(head.url || playback, head.status);
  checkReads(url);
  forgetOld(playbackUrls, (seen) => seen.at, PLAYBACK_KEPT_MS);
  playbackUrls.set(filename, { url, at: Date.now() });
  return url;
}

/** How long a resolved playback URL is used before asking AIOStreams again (they expire). */
const PLAYBACK_KEPT_MS = 20 * 60 * 1000;

const probeJobs = new Map<string, Promise<Probe | undefined>>();
/**
 * The languages of a Matroska file's full text subtitles from its first part alone (one read of
 * 512 KB, see mkv.ts), per file: known seconds before ffprobe's header read is done, so a first
 * play's list can already leave out the languages the file has (see embeddedLanguages).
 */
const headerLanguageJobs = new Map<string, Promise<string[] | undefined>>();

/** Full text subtitle languages among a Matroska file's tracks: not signs, songs or forced lines, as tagged. */
export function mkvTextLanguages(tracks: MkvTrack[]): string[] {
  const full = tracks.filter((t) => t.type === "subtitle" && isTextCodec(t.codec) && !t.forced && !/sign|song|forced/i.test(t.name));
  return [...new Set(full.map((t) => t.language.toLowerCase()).filter((l) => l && l !== "und"))];
}

/**
 * The playing file's header: duration and its English subtitle track, if any.
 * One job per file, shared by the list (to label tracks honestly on the first
 * play) and the sync. A file without one is written down at once, so later
 * lists and syncs know without asking again.
 */
function probeFile(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<Probe | undefined> {
  let job = probeJobs.get(filename);
  if (!job) {
    job = (async () => {
      const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
      if (!headerLanguageJobs.has(filename)) {
        headerLanguageJobs.set(
          filename,
          readMkvTracks(url).then((head) => (head ? mkvTextLanguages(head.tracks) : undefined), () => undefined)
        );
        setTimeout(() => headerLanguageJobs.delete(filename), 30 * 60 * 1000).unref();
      }
      const probed = await probe(url);
      if ((probed.track === undefined && (probed.audio === undefined || !SPEECH_SYNC)) || !probed.duration) {
        const none: FileAnchors = { filename, duration: probed.duration, windows: [], speechChecked: true, subtitleLangs: probed.languages };
        await mkdir(cachePath("anchors"), { recursive: true });
        await writeFile(anchorsFile(filename), JSON.stringify(none));
        count("sync.noSubtitles");
      }
      return probed;
    })().catch((error) => {
      readFailed(filename, error);
      return undefined;
    });
    probeJobs.set(filename, job);
    job.then((result) => {
      if (!result) probeJobs.delete(filename); // let a later request try again
      else setTimeout(() => probeJobs.delete(filename), 30 * 60 * 1000).unref();
    });
  }
  return job;
}

/**
 * Whether the playing file has embedded subtitles to sync to: from
 * earlier results when there are any, else from its header, waited on for at
 * most waitMs. Undefined when that isn't known in time.
 */
export async function fileHasSubtitles(aiostreamsUrl: string, videoId: string, type: string, filename: string, waitMs: number): Promise<boolean | "speech" | undefined> {
  try {
    if (notListed(filename)) return false;
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (stillValid(found)) return found.windows.length === 0 ? false : found.speechOnly ? "speech" : true;
  } catch {}
  const probed = await Promise.race([probeFile(aiostreamsUrl, videoId, type, filename), new Promise<"late">((resolve) => setTimeout(() => resolve("late"), waitMs).unref())]);
  if (notListed(filename)) return false;
  if (probed === "late" || !probed) return undefined;
  if (!probed.duration) return false;
  if (probed.track !== undefined) return true;
  // No subtitle track: timed by speech in the audio, when there is audio.
  return probed.audio !== undefined && SPEECH_SYNC ? "speech" : false;
}

/**
 * Languages the playing file already has full text subtitles in, from earlier reads of it, a header
 * read that has finished (fileHasSubtitles starts one on a first play), or the quick read of a
 * Matroska file's first part, waited on for at most waitMs. Undefined when not known in time.
 */
export async function embeddedLanguages(filename: string, waitMs = 0): Promise<string[] | undefined> {
  try {
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (Array.isArray(found.subtitleLangs)) return found.subtitleLangs;
  } catch {}
  const job = probeJobs.get(filename);
  // A header read that's already done.
  const probed = job ? await Promise.race([job, Promise.resolve(undefined)]) : undefined;
  if (probed) return probed.languages;
  const quick = headerLanguageJobs.get(filename);
  if (!quick) return undefined;
  return Promise.race([quick, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs).unref())]);
}

/** Index lines are cut into windows this long, end to end: every window of the file is measured. */
const INDEX_WINDOW_MS = 60000;
/** A text track needs at least this many dialogue lines in the index to be timed by it. */
const INDEX_MIN_LINES = 30;

/**
 * The file's anchors from its Matroska index (mkv.ts): every text subtitle track's dialogue lines over
 * the whole file, cut into windows so the usual measuring applies, and nothing more of the file to
 * read (rounds are done). Picture tracks, and files whose index has no usable text track, are read
 * the usual way (undefined).
 */
async function indexAnchors(url: string, filename: string, duration: number, audio: number | undefined, languages: string[], bitrate?: number, audioLang?: string): Promise<FileAnchors | undefined> {
  const timing = await readMkvTiming(url);
  if (!timing) return undefined;
  const CODECS: Record<string, string> = { "S_TEXT/ASS": "ass", "S_ASS": "ass", "S_TEXT/SSA": "ssa", "S_SSA": "ssa", "S_TEXT/UTF8": "subrip", "S_TEXT/ASCII": "subrip", "S_TEXT/WEBVTT": "webvtt", "S_HDMV/PGS": "hdmv_pgs_subtitle" };
  const lines = new Map<number, Cue[]>();
  const streams: ProbedStream[] = [];
  for (const t of timing.tracks) {
    if (t.type !== "subtitle" || !CODECS[t.codec]) continue;
    // Picture tracks (PGS) give shows and clears, not lengths: see pictureLines.
    const entries = timing.lines.get(t.number) ?? [];
    const dialogue = t.codec === "S_HDMV/PGS" ? pictureLines(entries) : dialogueLines(entries);
    if (dialogue.length < INDEX_MIN_LINES) continue;
    lines.set(t.index, dialogue);
    streams.push({ index: t.index, codec_type: "subtitle", codec_name: CODECS[t.codec], tags: { language: t.language, title: t.name }, disposition: { forced: t.forced ? 1 : 0 } });
  }
  const ranked = rankTracks(streams);
  if (!ranked.length) return undefined;
  // Text tracks first (rankTracks); a picture track is the reference only when there's no text one,
  // and other picture tracks aren't kept beside it (they'd need reading the same way).
  const firstIsPicture = ranked[0].codec_name === "hdmv_pgs_subtitle";
  const usable = firstIsPicture ? ranked.slice(0, 1) : ranked.filter((s) => s.codec_name !== "hdmv_pgs_subtitle");
  const [first, ...rest] = usable.slice(0, 1 + MAX_OTHER_TRACKS).map((s) => s.index);
  const length = duration || timing.duration;
  const windows: FileAnchors["windows"] = [];
  for (let from = 0; from < length; from += INDEX_WINDOW_MS) {
    const to = Math.min(length, from + INDEX_WINDOW_MS);
    const inside = (cues: Cue[]) => cues.filter((c) => c.start >= from && c.start < to);
    windows.push({ from, to, cues: inside(lines.get(first) ?? []), ...(rest.length ? { others: Object.fromEntries(rest.map((i) => [String(i), inside(lines.get(i) ?? [])])) } : {}) });
  }
  count("sync.files");
  count("sync.index");
  count("sync.indexBytes", timing.bytesRead);
  console.log(`sync: ${filename}: timing from the file's index (${Math.round(timing.bytesRead / 1024)} KB, ${lines.get(first)?.length ?? 0} lines on track ${first})`);
  return {
    filename, duration: length, windows, track: first, audio, ...(audioLang ? { audioLang } : {}), source: "index", rounds: MAX_ROUNDS, ...(bitrate ? { bitrate } : {}), ...(firstIsPicture ? { image: true } : {}),
    ...(rest.length ? { others: rest } : {}), subtitleLangs: languages
  };
}

/**
 * Speech for a file timed from its index: the audio at the usual spots, kept beside the index windows
 * (marked heard, so nothing measures them as lines). Read when the captions fit none of its tracks,
 * and in the `background` for dub captions the track timed (see hearDubVoices): then the spots are
 * read one after another, so the read holds one of the MAX_PROCS ffmpeg slots, not five, and a read
 * that failed at every spot isn't kept, so it can be tried again. Undefined when the file has no
 * audio to hear or it can't be read.
 */
function addSpeech(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string, background = false): Promise<FileAnchors | undefined> {
  const jobKey = `${filename}#speech`;
  let job = extendJobs.get(jobKey);
  if (job) return job;
  job = (async () => {
    if (stored.audio === undefined || stored.speechBy === "silero" || !SPEECH_SYNC) return undefined;
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename, background);
    count("sync.windows", WINDOW_SPOTS.length);
    const span = windowMs(stored.bitrate);
    count("sync.videoSeconds", (WINDOW_SPOTS.length * span) / 1000);
    noteRead(windowBytes(stored.bitrate, WINDOW_SPOTS.length * span));
    let failed = 0;
    const hear = async (spot: number) => {
      const from = Math.round(stored.duration * spot);
      const speech = await readSpeechWindow(url, stored.audio as number, from, span).catch(() => (failed++, [] as Cue[]));
      return { from, to: from + span, cues: [] as Cue[], speech, heard: true };
    };
    const heard: Array<Awaited<ReturnType<typeof hear>>> = [];
    if (background) for (const spot of WINDOW_SPOTS) heard.push(await hear(spot));
    else heard.push(...(await Promise.all(WINDOW_SPOTS.map(hear))));
    if (background && failed === WINDOW_SPOTS.length) throw new Error(`the audio couldn't be read at any of the ${WINDOW_SPOTS.length} spots`);
    const result: FileAnchors = { ...stored, windows: [...stored.windows, ...heard].sort((a, b) => a.from - b.from), speechBy: "silero" };
    // Whole or not at all: read in the background, it can land while a sync is reading the record.
    await writeWhole(anchorsFile(filename), JSON.stringify(result));
    console.log(`sync: ${filename}: read the audio at ${WINDOW_SPOTS.length} spots for speech`);
    return result;
  })().catch((error) => {
    readFailed(filename, error, "speech: ");
    return undefined;
  });
  keepJob(jobKey, job);
  return job;
}

/**
 * Whether dub captions timed by the track on this file wait for its English audio to be heard: a file
 * timed from its index, whose audio hasn't been read yet (the index holds no audio), is the dub's (see
 * voicesAreTheDub) and costs at most BACKGROUND_MAX_BYTES to hear. A file read in windows hears its
 * audio in the same reads as its lines.
 */
export function voicesToHear(stored: FileAnchors): boolean {
  return SPEECH_SYNC && stored.source === "index" && stored.audio !== undefined && stored.speechBy !== "silero" && voicesAreTheDub(stored) && hearingCost(stored) <= BACKGROUND_MAX_BYTES;
}

/** About how many bytes hearing the file's audio at the usual spots reads (addSpeech): its bit rate over 5 windows. */
export function hearingCost(stored: Pick<FileAnchors, "bitrate">): number {
  return windowBytes(stored.bitrate, WINDOW_SPOTS.length * windowMs(stored.bitrate));
}

/**
 * The most a background read of the audio may cost a file: 5 windows of WINDOW_BYTES (315 MB, with a
 * little room for rounding), what any file up to 25 Mb/s costs once its windows are shortened
 * (windowMs). Heavier files (a 2160p remux, whose 20 s windows would read 875 MB at 70 Mb/s) keep the
 * track's timing for dub captions.
 */
const BACKGROUND_MAX_BYTES = 320e6;

/** Background reads still running (see settled). */
const backgroundJobs = new Set<Promise<unknown>>();

/**
 * Reads the English audio of a file timed from its index, in the background, once dub captions were
 * synced to it by the track: from the next request on, its voices refine the timing of every dub
 * caption on the file (refineBySpeech). Nothing waits for it, so the first list and download are as
 * quick as before. The cost is the 5 windows addSpeech reads (hearingCost: the file's bit rate over
 * 5 x 40 s, shorter windows for heavy files, at most BACKGROUND_MAX_BYTES): read once per file, never
 * for a file whose audio was heard already, one spot at a time, counted against DAILY_READ_GB and held
 * back by the host's refusals (reads.ts), and only while the day's reads leave room for syncs a viewer
 * waits on (backgroundReadFits).
 */
function hearDubVoices(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string): void {
  if (!voicesToHear(stored)) return;
  if (!backgroundReadFits(hearingCost(stored))) {
    count("sync.voicesHeldBack");
    console.log(`sync: ${filename}: the English audio for dub captions is left unread: today's reads are nearly spent`);
    return;
  }
  const job = addSpeech(stored, aiostreamsUrl, videoId, type, filename, true);
  backgroundJobs.add(job);
  void job.finally(() => backgroundJobs.delete(job));
}

/**
 * Where more of a file with no subtitle track is heard, once its first five windows' speech didn't
 * time a subtitle clearly (see hearMoreSpeech): between those five, so the ten spread over the file
 * from a tenth of the way in.
 */
export const MORE_SPOTS = [0.1, 0.24, 0.41, 0.59, 0.76];
/** A file with no subtitle track gets one round of MORE_SPOTS, at most (FileAnchors.rounds). */
const SPEECH_ROUNDS = 1;
/**
 * A timing by speech that rests on fewer windows than this is worth hearing more of the file for. On
 * the stored plays, 8 of 18 subtitles on files with no subtitle track couldn't be timed (too few
 * voices heard in too many of the 5 windows), and 5 of the 10 timed rested on 3 windows.
 */
const SPEECH_SURE_WINDOWS = 4;

/**
 * Whether a file with no subtitle track may have more of its audio heard (hearMoreSpeech): its speech
 * was heard by Silero, MORE_SPOTS haven't been read yet, and they cost at most BACKGROUND_MAX_BYTES.
 */
export function moreSpeechToHear(stored: FileAnchors): boolean {
  return SPEECH_SYNC && Boolean(stored.speechOnly) && stored.audio !== undefined && stored.speechBy === "silero" && (stored.rounds ?? 0) < SPEECH_ROUNDS && moreSpeechCost(stored) <= BACKGROUND_MAX_BYTES;
}

/** About how many bytes hearing MORE_SPOTS reads: the file's bit rate over 5 windows, as the first pass. */
export function moreSpeechCost(stored: Pick<FileAnchors, "bitrate">): number {
  return windowBytes(stored.bitrate, MORE_SPOTS.length * windowMs(stored.bitrate));
}

/**
 * Hears a file with no subtitle track at MORE_SPOTS, in the background, when its speech didn't time a
 * subtitle clearly (no clear fit, one resting on fewer than SPEECH_SURE_WINDOWS windows, or a window
 * with speech enough to measure that lands elsewhere, where the timing may step): from
 * the next request on, every subtitle on the file is timed by ten windows of speech instead of five.
 * Nothing waits for it, so the first list and download are as quick as before. It costs what the first
 * pass did (moreSpeechCost: the file's bit rate over 5 windows of 40 s, shorter for heavy files, at
 * most BACKGROUND_MAX_BYTES), once per file; counted against DAILY_READ_GB, started only while the
 * day's reads leave room for syncs a viewer waits on (backgroundReadFits), read one spot at a time, and
 * stopped as soon as the file's host refuses or the day's limit is spent (reads.ts).
 */
function hearMoreSpeech(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string): void {
  if (!moreSpeechToHear(stored)) return;
  if (!backgroundReadFits(moreSpeechCost(stored))) {
    count("sync.speechHeldBack");
    console.log(`sync: ${filename}: more of the audio is left unheard: today's reads are nearly spent`);
    return;
  }
  const job = readMoreSpeech(stored, aiostreamsUrl, videoId, type, filename);
  backgroundJobs.add(job);
  void job.finally(() => backgroundJobs.delete(job));
}

/** The read behind hearMoreSpeech: kept with the file's readings whole, or not at all (it is tried again later). */
function readMoreSpeech(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<FileAnchors | undefined> {
  const jobKey = `${filename}#more-speech`;
  let job = extendJobs.get(jobKey);
  if (job) return job;
  job = (async () => {
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename, true);
    const span = windowMs(stored.bitrate);
    const heard: FileAnchors["windows"] = [];
    let failed = 0;
    for (const spot of MORE_SPOTS) {
      // A host that refused meanwhile, or the day's limit spent: stop here (ReadsPaused).
      checkReads(url);
      const from = Math.round(stored.duration * spot);
      count("sync.windows");
      count("sync.videoSeconds", span / 1000);
      noteRead(windowBytes(stored.bitrate, span));
      const cues = await readSpeechWindow(url, stored.audio as number, from, span).catch(() => (failed++, [] as Cue[]));
      heard.push({ from, to: from + span, cues });
    }
    if (failed === MORE_SPOTS.length) throw new Error(`the audio couldn't be read at any of the ${MORE_SPOTS.length} spots`);
    const now = (await storedAnchors(filename)) ?? stored;
    const result: FileAnchors = { ...now, windows: [...now.windows, ...heard].sort((a, b) => a.from - b.from), rounds: SPEECH_ROUNDS };
    await writeWhole(anchorsFile(filename), JSON.stringify(result));
    console.log(`sync: ${filename}: heard the audio at ${MORE_SPOTS.length} more spots (${heard.map((w) => `${Math.round(w.from / 1000)}s: ${w.cues.length}`).join(", ")})`);
    return result;
  })().catch((error) => {
    readFailed(filename, error, "more speech: ");
    return undefined;
  });
  keepJob(jobKey, job);
  return job;
}

/** Resolves once no background read is running: for tests, the benchmark and the score, before they let fetch out again. */
export async function settled(): Promise<void> {
  while (backgroundJobs.size) await Promise.allSettled([...backgroundJobs]);
}

/** The file's readings as stored, if any. */
async function storedAnchors(filename: string): Promise<FileAnchors | undefined> {
  try {
    return JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
  } catch {
    return undefined;
  }
}

/** Writes a file whole or not at all: a download reading it meanwhile gets the old one or the new one. */
async function writeWhole(file: string, data: string): Promise<void> {
  const part = `${file}.${randomUUID()}.part`;
  try {
    await writeFile(part, data);
    await rename(part, file);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/** Embedded dialogue at the anchor windows of the playing file, cached per file. */
export function fileAnchors(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<FileAnchors | undefined> {
  const key = cacheKey({ kind: "file-anchors", filename });
  let job = fileAnchorJobs.get(key);
  if (!job) {
    job = (async () => {
      const file = path.join(cachePath("anchors"), `${key}.json`);
      try {
        const stored = JSON.parse(await readFile(file, "utf8")) as FileAnchors;
        if (stillValid(stored)) return stored;
      } catch {}
      const probed = await probeFile(aiostreamsUrl, videoId, type, filename);
      if (!probed) throw new Error("file header not read");
      const { duration, track, image, audio, audioLang, languages, others, bitrate } = probed;
      const span = windowMs(bitrate);
      if ((track === undefined && (audio === undefined || !SPEECH_SYNC)) || !duration) return { filename, duration, windows: [], speechChecked: true, subtitleLangs: languages } satisfies FileAnchors;
      // No subtitle track: speech in the audio stands in for the lines.
      const speechOnly = track === undefined;
      const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
      // A Matroska file's index holds every subtitle line's timing: the whole file's lines from a few
      // hundred KB, instead of reading windows of the video (see mkv.ts).
      if (!speechOnly) {
        const fromIndex = await indexAnchors(url, filename, duration, audio, languages, bitrate, audioLang).catch((error) => {
          console.log(`sync: ${filename}: index not read (${scrub(error instanceof Error ? error.message : String(error))}), reading windows`);
          return undefined;
        });
        if (fromIndex) {
          await mkdir(cachePath("anchors"), { recursive: true });
          await writeFile(file, JSON.stringify(fromIndex));
          return fromIndex;
        }
      }
      count("sync.files");
      count("sync.windows", WINDOW_SPOTS.length);
      count("sync.videoSeconds", (WINDOW_SPOTS.length * span) / 1000);
      noteRead(windowBytes(bitrate, WINDOW_SPOTS.length * span));
      const windows = await Promise.all(
        WINDOW_SPOTS.map(async (spot) => {
          const from = Math.round(duration * spot);
          try {
            if (speechOnly) return { from, to: from + span, cues: await readSpeechWindow(url, audio as number, from, span) };
            if (image) return { from, to: from + span, cues: await readImageWindow(url, track, from, span) };
            return { from, to: from + span, ...(await readWindowAndSpeechSafely(url, track, audio, from, span, others)) };
          } catch {
            return { from, to: from + span, cues: [] };
          }
        })
      );
      if (speechOnly) {
        count("sync.speechOnly");
        console.log(`sync: ${filename}: no subtitle track, timing from speech in the audio`);
      }
      // A file with no subtitle track keeps its bit rate: hearing more of its audio later costs that (see moreSpeechCost).
      const result: FileAnchors = { filename, duration, windows, track, image, audio, ...(audioLang ? { audioLang } : {}), ...(others?.length && !speechOnly ? { others } : {}), ...(speechOnly ? { speechOnly, ...(bitrate ? { bitrate } : {}) } : {}), ...(audio !== undefined ? { speechBy: "silero" as const } : {}), subtitleLangs: languages };
      await mkdir(cachePath("anchors"), { recursive: true });
      await writeFile(file, JSON.stringify(result));
      return result;
    })().catch((error) => {
      readFailed(filename, error);
      return undefined;
    });
    fileAnchorJobs.set(key, job);
    // Only while it runs, so syncs started together share one read. A finished reading is on disk
    // (the next request loads it, with any windows added since); a failed one is tried again.
    void job.then(() => {
      if (fileAnchorJobs.get(key) === job) fileAnchorJobs.delete(key);
    });
  }
  return job;
}

const EXTRA_WINDOW_MS = 60000;
const MAX_EXTRA_WINDOWS = 6;
/** Round 1 covers gaps; round 2 reads the stretches where the timing steps. */
export const MAX_ROUNDS = 2;
/** A stretch between disagreeing anchors is read in full up to this long. */
const MAX_BRIDGE_MS = 180000;

/**
 * Where to read more of the file after a first pass: around spots that found
 * nothing usable, between neighbouring anchors that disagree (to find where
 * the timing steps), and early on when nothing covers the first quarter. A
 * streaming cut and a Blu-ray often differ at the breaks, so the shift can
 * step a few times in one episode, and a sparse spot can't show that.
 */
export function refinementStarts(
  found: Pick<FileAnchors, "duration" | "windows">,
  anchors: Anchor[],
  /** Later rounds only narrow down steps between disagreeing anchors. */
  stepsOnly = false
): number[] {
  const last = Math.max(0, found.duration - EXTRA_WINDOW_MS);
  const clamp = (t: number) => Math.min(last, Math.max(0, Math.round(t)));
  const wanted: number[] = [];
  if (!stepsOnly) {
    for (const w of found.windows) {
      if (anchors.some((a) => a.from === w.from)) continue;
      wanted.push(clamp(w.from - EXTRA_WINDOW_MS), clamp(w.to));
    }
  }
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  if (!stepsOnly) {
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      // Far apart: a measuring window between them first, so the stretch to bridge is short.
      if (Math.abs(a.offset - b.offset) > AGREE_MS && b.from - a.to > MAX_BRIDGE_MS) wanted.push(clamp((a.to + b.from) / 2 - EXTRA_WINDOW_MS / 2));
    }
  }
  if (!stepsOnly && !sorted.some((a) => a.from < found.duration * 0.25)) wanted.push(clamp(found.duration * 0.05));

  const taken = found.windows.map((w) => w.from);
  const out: number[] = [];
  for (const start of wanted) {
    const near = [...taken, ...out].some((t) => Math.abs(t - start) < EXTRA_WINDOW_MS / 2);
    if (!near) out.push(start);
    if (out.length >= MAX_EXTRA_WINDOWS) break;
  }
  return out.sort((a, b) => a - b);
}

/** The stretches between neighbouring anchors that disagree, to read in full (capped). */
export function bridgeSpans(found: Pick<FileAnchors, "windows">, anchors: Anchor[]): Array<{ from: number; length: number }> {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  const spans: Array<{ from: number; length: number }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (Math.abs(a.offset - b.offset) <= AGREE_MS) continue;
    const gap = b.from - a.to;
    if (gap <= 5000) continue;
    const from = gap > MAX_BRIDGE_MS ? Math.round((a.to + b.from) / 2 - MAX_BRIDGE_MS / 2) : a.to;
    const length = Math.min(gap, MAX_BRIDGE_MS);
    if (!found.windows.some((w) => w.bridge && w.from === from)) spans.push({ from, length });
  }
  return spans;
}

const extendJobs = new Map<string, Promise<FileAnchors | undefined>>();

/** Remembers a job for extra reads while it runs and for JOB_KEPT_MS after, then lets it go. */
function keepJob(jobKey: string, job: Promise<FileAnchors | undefined>): void {
  extendJobs.set(jobKey, job);
  void job.then(() => {
    setTimeout(() => {
      if (extendJobs.get(jobKey) === job) extendJobs.delete(jobKey);
    }, JOB_KEPT_MS).unref();
  });
}

/** Reads extra windows of the playing file once, and keeps them with the file's anchors. */
function extendAnchors(
  found: FileAnchors,
  spans: Array<{ from: number; length: number; bridge?: boolean }>,
  aiostreamsUrl: string,
  videoId: string,
  type: string,
  filename: string
): Promise<FileAnchors | undefined> {
  const round = (found.rounds ?? 0) + 1;
  const jobKey = `${filename}#${round}`;
  let job = extendJobs.get(jobKey);
  if (job) return job;
  job = (async () => {
    if (round > MAX_ROUNDS || spans.length === 0) return found;
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
    // Anchors cached before the track was recorded: look it up again (header only).
    if (found.track === undefined && !found.speechOnly) {
      const probed = await probe(url);
      if (probed.track === undefined) return found;
      found = { ...found, track: probed.track, image: probed.image, audio: probed.audio, ...(probed.audioLang ? { audioLang: probed.audioLang } : {}), ...(probed.others ? { others: probed.others } : {}) };
    }
    const read = async (from: number, length: number): Promise<{ cues: Cue[]; speech?: Cue[] }> => {
      if (found.speechOnly) return { cues: await readSpeechWindow(url, found.audio as number, from, length) };
      if (found.image) return { cues: await readImageWindow(url, found.track as number, from, length) };
      return readWindowAndSpeechSafely(url, found.track as number, found.audio, from, length, found.others);
    };
    count("sync.windows", spans.length);
    count("sync.videoSeconds", Math.round(spans.reduce((sum, s) => sum + s.length, 0) / 1000));
    noteRead(windowBytes(found.bitrate, spans.reduce((sum, s) => sum + s.length, 0)));
    const extra = await Promise.all(
      spans.map(async ({ from, length, bridge }) => {
        try {
          return { from, to: from + length, ...(await read(from, length)), ...(bridge ? { bridge } : {}) };
        } catch {
          return { from, to: from + length, cues: [], ...(bridge ? { bridge } : {}) };
        }
      })
    );
    const result: FileAnchors = { ...found, windows: [...found.windows, ...extra].sort((a, b) => a.from - b.from), rounds: round };
    await writeFile(anchorsFile(filename), JSON.stringify(result));
    // Captions synced before this point were measured without these windows.
    console.log(`sync: ${filename}: round ${round}: read ${extra.length} more windows at ${extra.map((w) => `${Math.round(w.from / 1000)}s (${w.cues.length} lines)`).join(", ")}`);
    return result;
  })().catch((error) => {
    readFailed(filename, error, "extra windows: ");
    return found;
  });
  keepJob(jobKey, job);
  return job;
}

/** Every window measured (measureWindow, searched over centre ± 20 s), and the anchors they agree on. */
function measureAll(found: FileAnchors, captions: Cue[], centre = 0) {
  const measuredWindows = found.windows.flatMap((w) => {
    if (w.bridge) return [];
    // An index minute with only a few lines (a cold open before the opening song) is too few to time
    // by; it takes its neighbours' timing (seen: 3 lines, 0.5 s off against the voices).
    if (found.source === "index" && w.cues.length < INDEX_MIN_WINDOW_LINES) return [];
    const measured = measureWindow(w.cues, captions, 20000, centre);
    return measured ? [{ from: w.from, to: w.to, measured }] : [];
  });
  const anchors = agreeAnchors(measuredWindows);
  return { measuredWindows, anchors: found.source === "index" ? dropSpikes(anchors) : anchors };
}

/**
 * On index windows, which follow each other minute by minute: a window whose shift is far from both
 * neighbours while they agree is a chance fit, not a cut (a cut changes every window after it). Seen with
 * an OpenSubtitles English: +1.24 s, +5.76 s, +1.27 s at 2, 3 and 4 minutes.
 */
export function dropSpikes(anchors: Anchor[]): Anchor[] {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  return sorted.filter((a, i) => {
    const before = sorted[i - 1];
    const after = sorted[i + 1];
    if (!before || !after) return true;
    const spike = Math.abs(a.offset - before.offset) > SPIKE_MS && Math.abs(a.offset - after.offset) > SPIKE_MS && Math.abs(before.offset - after.offset) <= AGREE_MS;
    return !spike;
  });
}

const SPIKE_MS = 1500;
/** Index windows with fewer lines aren't measured (minutes of dialogue held 8 to 27 on one episode). */
const INDEX_MIN_WINDOW_LINES = 6;

// ---------- what overlap can't place: timing far off, and lines that start right but last otherwise ----------

/**
 * How the windows' own best fits sit against the final timing, in the file's order: how many land
 * within LAND_MS of the timing there (as landsOnTiming counts them), and the longest run of windows
 * in a row that don't. A window with no fit of its own counts as not landing. A real subtitle misses
 * a window here and there, where a chance fit beat its own; a stretch the timing doesn't hold for
 * (a scene only one cut has, another episode's dialogue) misses window after window.
 */
export function landing(windows: Array<{ from: number; measured?: Measured }>, anchors: Anchor[]): { landed: number; astray: number } {
  if (anchors.length === 0) return { landed: 0, astray: windows.length };
  const timingAt = (from: number) => anchors.reduce((a, b) => (Math.abs(b.from - from) < Math.abs(a.from - from) ? b : a)).offset;
  let landed = 0;
  let run = 0;
  let astray = 0;
  for (const w of [...windows].sort((a, b) => a.from - b.from)) {
    if (w.measured && Math.abs(w.measured.offset - timingAt(w.from)) <= LAND_MS) {
      landed++;
      run = 0;
    } else astray = Math.max(astray, ++run);
  }
  return { landed, astray };
}

/** More windows in a row than this off the timing: a stretch it doesn't hold for (see landing). */
const MAX_ASTRAY_RUN = 4;

/**
 * measureWindow by line starts: the shift, over ±range, at which the most of the window's own line
 * starts have a caption start within LINE_TOLERANCE_MS. Overlap can't tell shifts apart when the
 * captions' lines last otherwise than the file's: an official translation that runs each line on
 * until the next and merges short lines covers the file's dialogue about as well at many shifts (seen:
 * official Arabic ones whose own best fits landed on their timing in only 10 to 15 of 39 to 43 index
 * minutes, 5 to 7 of the rest at the edge of the search), but its lines still start where the file's
 * do. The two ends of the range aren't peaks. `starts`: the captions' starts (captionStarts).
 */
export function measureStarts(lines: Cue[], starts: number[], range = 20000): Measured | undefined {
  if (lines.length < 3 || starts.length < 3) return undefined;
  const shares = Array.from(startCurve(lines, starts, range), (m) => m / lines.length);
  const peaks = curvePeaks(shares, range).filter((p) => Math.abs(p.offset) < range - LINE_TOLERANCE_MS);
  const best = peaks[0];
  if (!best || Math.round(best.score * lines.length) < STARTS_MIN_MATCHED) return undefined;
  const round = (p: { offset: number; score: number }) => ({ offset: p.offset, score: Math.round(p.score * 100) / 100 });
  return { ...round(best), alternatives: peaks.slice(1).filter((p) => p.score >= best.score * 0.9 && Math.abs(p.offset - best.offset) > 400).map(round) };
}

/** A window's best line-start fit must meet at least this many of its lines. */
const STARTS_MIN_MATCHED = 3;

/**
 * Timing by line starts alone (measureStarts per window), for a translation on a file timed from its
 * index that no shift fits by overlap. Every index window with lines counts, measured or not: at
 * least STARTS_MIN_LANDED of them must land on the final timing with their own best fit, never more
 * than MAX_ASTRAY_RUN in a row off it, and the timing must pass what a shift per stretch passes
 * (trusted: fitsFile, landsOnTiming, holdsTogether). Each line starts where it does in the
 * subtitle, so this is for translations only (dub captions' lines are the dub's own).
 *
 * Built for official Arabic subtitles of one show whose shift steps by about 3 s at each break
 * (+1.7, +5.1, +8.6, +11.1, +15.6 s through one episode): by overlap 10 to 15 of their 39 to 43
 * windows landed on the timing, by line starts 22 to 34. Against 3,611 pairs of a file with
 * another episode's or another show's subtitle, none passed (see STARTS_MIN_WINDOWS).
 */
export function byStarts(found: FileAnchors, captions: Cue[]): (Measurement & { landed: number; windows: number; astray: number }) | undefined {
  const trial = startsTrial(found, captions);
  if (!trial || !trusted(trial) || trial.landed < STARTS_MIN_LANDED * trial.windows || trial.astray > MAX_ASTRAY_RUN) return undefined;
  return trial;
}

/** What byStarts measures, before it decides: undefined when the file isn't one it can time. */
export function startsTrial(found: FileAnchors, captions: Cue[]): (Measurement & { landed: number; windows: number; astray: number }) | undefined {
  if (found.source !== "index" || found.image || found.speechOnly) return undefined;
  const considered = found.windows.filter((w) => !w.bridge && !w.heard && w.cues.length >= INDEX_MIN_WINDOW_LINES);
  if (considered.length < STARTS_MIN_WINDOWS) return undefined;
  const starts = captionStarts(captions);
  const all = considered.map((w) => ({ from: w.from, to: w.to, measured: measureStarts(w.cues, starts) }));
  const measuredWindows = all.flatMap((w) => (w.measured ? [{ from: w.from, to: w.to, measured: w.measured }] : []));
  const anchors = dropSpikes(agreeAnchors(measuredWindows));
  return { measuredWindows, anchors, windows: considered.length, ...landing(all, anchors) };
}

/**
 * Fewer index windows with lines than this is too little to time a file by line starts alone: chance
 * lands a larger share of few windows. Over 2,766 pairs of a file with another episode's or show's
 * subtitle, the most that landed was 44% of 12 to 19 windows (three of those passed trusted), 41% of 20
 * to 29, 37% of 30 to 39 and 33% of 40 or more, none of these passing trusted.
 */
const STARTS_MIN_WINDOWS = 24;
/** The share of those windows that must land on the timing with their own best line-start fit. */
const STARTS_MIN_LANDED = 0.5;

/**
 * Timing further off than the usual search reaches (±20 s around 0): a release that opens with a recap
 * or a longer cold open than the subtitle's moves every line by a minute or so. The line starts over
 * the whole file find that one shift (wideFit, over ±WIDE_RANGE_MS), and every window is then measured
 * again around it. Taken only when the line starts single it out (FAR_MIN_SCORE, FAR_MIN_MARGIN), it is
 * more than FAR_FROM_MS off (nearer, the usual search already covered it), the windows measured around
 * it pass what a shift per stretch passes (trusted), and nearly all of them land on it: at least
 * FAR_MIN_LANDED, never more than FAR_MAX_ASTRAY_RUN in a row off it (a recap of a minute or two), and
 * it moves no more than FAR_MAX_BEFORE_START lines to before the file starts. One shift for the
 * whole file, as a recap gives, not for most of it: a longer cut's subtitle with one scene more after
 * its cold open sits a minute off everywhere but the cold open, whose lines would go before the start.
 */
export function farTiming(found: FileAnchors, captions: Cue[]): (Measurement & { centre: number; landed: number; windows: number }) | undefined {
  if (found.speechOnly) return undefined;
  const wide = wideFit(found, captions);
  if (!wide || Math.abs(wide.offset) <= FAR_FROM_MS || wide.score < FAR_MIN_SCORE || wide.margin < FAR_MIN_MARGIN) return undefined;
  const m = measureAll(found, captions, wide.offset);
  if (!trusted(m)) return undefined;
  const fewest = found.source === "index" ? INDEX_MIN_WINDOW_LINES : 3;
  const considered = found.windows.filter((w) => !w.bridge && !w.heard && w.cues.length >= fewest);
  const { landed, astray } = landing(considered.map((w) => ({ from: w.from, measured: m.measuredWindows.find((x) => x.from === w.from)?.measured })), m.anchors);
  if (landed < FAR_MIN_LANDED * considered.length || astray > FAR_MAX_ASTRAY_RUN) return undefined;
  const shift = planShifts(m.anchors, captions);
  if (captions.filter((c) => c.start + shift(c.start) < 0).length > FAR_MAX_BEFORE_START) return undefined;
  return { ...m, centre: wide.offset, landed, windows: considered.length };
}

/** How far off the line starts' shift must be to search around it instead of around 0. */
const FAR_FROM_MS = 10000;
/**
 * What wideFit must find. Over 3,611 pairs of a file with another episode's or show's subtitle, the
 * best margin was 0.05; this file's own subtitles at one shift scored 0.2 to 0.84 (dub captions,
 * whose lines are their own, lower: their stretches of talk start where the file's do).
 */
const FAR_MIN_SCORE = 0.2;
const FAR_MIN_MARGIN = 0.1;
/** The share of the windows with lines that must land on the far timing with their own best fit... */
const FAR_MIN_LANDED = 0.75;
/** ...with no more than this many in a row off it (two index minutes)... */
const FAR_MAX_ASTRAY_RUN = 2;
/** ...and no more than this many lines moved to before the file starts (a credit at 0:00, say). */
const FAR_MAX_BEFORE_START = 2;

// ---------- which of the file's tracks to time by ----------

/** The file's windows as another of its text tracks read them (see FileAnchors.others). */
export function trackView(found: FileAnchors, track: number): FileAnchors {
  return { ...found, windows: found.windows.map((w) => ({ ...w, cues: w.others?.[track] ?? [] })) };
}

/** The file's windows with no lines at all: every track was too sparse, so only speech is left. */
function noLines(found: FileAnchors): FileAnchors {
  return { ...found, windows: found.windows.map((w) => ({ ...w, cues: [] })), rounds: MAX_ROUNDS };
}

/**
 * Whether a track has fewer than half as many lines as the captions, per minute: a track of signs,
 * songs or forced lines that wasn't labelled as one. Lines read in the windows are compared with
 * the captions' lines over their whole length, so a shift or a frame rate doesn't change it.
 */
export function sparseTrack(found: FileAnchors, captions: Cue[]): boolean {
  const windows = found.windows.filter((w) => !w.bridge && !w.heard);
  const readMs = windows.reduce((sum, w) => sum + (w.to - w.from), 0);
  const span = captions.length > 1 ? captions[captions.length - 1].end - captions[0].start : 0;
  if (readMs <= 0 || span <= 0) return false;
  const lines = windows.reduce((sum, w) => sum + w.cues.length, 0);
  return lines / readMs < SPARSE_SHARE * (captions.length / span);
}

const SPARSE_SHARE = 0.5;

/**
 * Which of the file's subtitle tracks to time these captions by: "first" (the best ranked, see
 * rankTracks), another text track read beside it (its index), or undefined when every track is too
 * sparse (see sparseTrack) and only speech can time them. A track is skipped when it's sparse; the
 * first one that fits on the windows read so far wins (as written or at another frame rate). When
 * none fits yet, the first track that isn't sparse is kept: extra windows may still fit it.
 */
export function trackChoice(found: FileAnchors, captions: Cue[]): "first" | number | undefined {
  return finish(trackChoiceSteps(found, captions)).track;
}

/**
 * The track chosen, with what was measured on the way so it isn't measured twice: the captions as
 * written on that track, and (when `rated` is there, even as undefined) what rescaled made of them.
 */
type TrackPick = { track: "first" | number | undefined; asWritten?: Measurement; rated?: Rescaled | undefined };

/** trackChoice, one measurement per step. */
function* trackChoiceSteps(found: FileAnchors, captions: Cue[]): Steps<TrackPick> {
  const candidates: Array<"first" | number> = ["first", ...(found.others ?? [])];
  let fallback: TrackPick | undefined;
  for (const track of candidates) {
    const view = track === "first" ? found : trackView(found, track);
    if (!view.windows.some((w) => w.cues.length) || sparseTrack(view, captions)) continue;
    yield;
    const asWritten = measureAll(view, captions);
    // Fits as written: whether it also wants rescaling (steps that are really a drift) is left to the caller.
    if (trusted(asWritten)) return { track, asWritten };
    const rated = yield* rescaledSteps(view, captions, asWritten);
    if (rated) return { track, asWritten, rated };
    fallback ??= { track, asWritten, rated: undefined };
  }
  return fallback ?? { track: undefined };
}

/**
 * What syncCaptions decides for these captions on windows already read, without reading more of the
 * file: the replay check (scripts/replay.ts) runs it over past plays. Live syncs check fitsFile on
 * the first windows, before extra rounds; here every stored window counts.
 */
export function judge(stored: FileAnchors, captions: Cue[]): { verdict: "synced" | "wrong" | "rejected" | "unsynced"; anchors: Anchor[]; offsets: number[]; bySpeech?: boolean; byLines?: boolean; byStarts?: boolean; far?: number; factor?: number; track?: "first" | number } {
  // Every timing must also account for the whole file (accountsForFile), as in syncCaptions.
  const whole = (view: FileAnchors, timed: Cue[], shift: (start: number) => number, perWindow?: Anchor[]) => !accountsForFile(view, timed, shift, perWindow);
  // Timed by speech, by its plan: one shift, or a shift per stretch where it steps (see syncCaptions).
  const heardWhole = (view: FileAnchors, timed: Cue[], speech: NonNullable<ReturnType<typeof bySpeech>>) => whole(view, timed, planShifts(speech.anchors, timed, speech.reference));
  if (stored.speechOnly) {
    const speech = bySpeech(stored, captions);
    return speech && heardWhole(stored, captions, speech) ? { verdict: "synced", anchors: speech.anchors, offsets: [], bySpeech: true } : { verdict: "unsynced", anchors: [], offsets: [] };
  }
  const track = trackChoice(stored, captions);
  const found = track === undefined ? noLines(stored) : track === "first" ? stored : trackView(stored, track);
  const asWritten = measureAll(found, captions);
  const rated = rescaled(found, captions, asWritten);
  // Made for another frame rate: from here on the captions are rescaled, as syncCaptions has them.
  const timed = rated ? rated.captions : captions;
  const { measuredWindows, anchors } = rated ?? asWritten;
  const offsets = measuredWindows.map((w) => w.measured.offset);
  // What no shift fits within the usual search: line by line first (live, for languages other than
  // the dub captions), then one shift far beyond it, then line starts (live, the same languages), then speech.
  const heard = () => {
    const lined = byLines(stored, timed);
    if (lined && whole(lined.track === "first" ? stored : trackView(stored, lined.track), timed, shiftLookup(lined.shifts))) return { verdict: "synced" as const, anchors: lined.anchors, offsets, byLines: true, track: lined.track };
    const far = farTiming(found, timed);
    if (far && whole(found, timed, planShifts(far.anchors, timed))) return { verdict: "synced" as const, anchors: far.anchors, offsets: far.measuredWindows.map((w) => w.measured.offset), far: far.centre, track };
    const started = byStarts(found, timed);
    if (started && whole(found, timed, planShifts(started.anchors, timed, [], true))) return { verdict: "synced" as const, anchors: started.anchors, offsets: started.measuredWindows.map((w) => w.measured.offset), byStarts: true, track };
    const speech = bySpeech(found, timed);
    return speech && heardWhole(found, timed, speech) ? { verdict: "synced" as const, anchors: speech.anchors, offsets, bySpeech: true } : undefined;
  };
  if (!fitsFile(measuredWindows)) return heard() ?? { verdict: "wrong", anchors: [], offsets };
  if (anchors.length === 0) return heard() ?? { verdict: "unsynced", anchors, offsets };
  if (!landsOnTiming(measuredWindows, anchors)) return heard() ?? { verdict: "rejected", anchors: [], offsets };
  if (!holdsTogether(anchors)) return heard() ?? { verdict: "rejected", anchors: [], offsets };
  if (!whole(found, timed, planShifts(anchors, timed, found.windows.flatMap((w) => w.cues)), anchors)) return heard() ?? { verdict: "rejected", anchors: [], offsets };
  return { verdict: "synced", anchors, offsets, track, ...(rated ? { factor: rated.factor } : {}) };
}

/**
 * Timing from speech heard in the audio (Silero, English audio first, see pickAudio): for a file with
 * no subtitle track, and as the last resort when captions fit the track nowhere (dub captions follow
 * the English audio, not the translated track). All windows are matched at once (measureSpeechFile).
 * Over 8 recorded files it landed within 0.36 s on each against the file's own lines, and refused
 * another file's lines on all 8 (best margin 0.13). `lead`: how far ahead of the voice a line goes,
 * SPEECH_LEAD_MS for a translation, VOICE_LEAD_MS for dub captions.
 *
 * A subtitle for a release cut differently steps at a break, and the windows on each side of it meet
 * the voices at a shift of their own (see speechStep). Each side is then timed by its own windows,
 * when each has at least SPEECH_STRETCH_WINDOWS that say so clearly on their own. A step that fewer
 * windows show can't be placed, and the one shift the others agree on would leave that side's lines
 * seconds off, so nothing is timed: more of the file is heard first (see hearMoreSpeech).
 */
export function bySpeech(found: FileAnchors, captions: Cue[], lead = SPEECH_LEAD_MS): { anchors: Anchor[]; reference: Cue[]; score: number; margin: number; windows: number; steps?: number } | undefined {
  if (found.speechBy !== "silero") return undefined;
  const heard = found.windows
    .filter((w) => !w.bridge)
    .map((w) => ({ from: w.from, to: w.to, speech: (found.speechOnly ? w.cues : w.speech) ?? [] }))
    .filter((w) => w.speech.length >= 3);
  if (heard.length < SPEECH_MIN_ANCHORS) return undefined;
  const curves = speechCurves(heard, captions);
  if (curves.length < SPEECH_MIN_ANCHORS) return undefined;
  // Lines show a little before the voice starts: a line start met at the voice is that much late.
  const placed = (anchors: Anchor[]) => anchors.map((a) => ({ ...a, offset: a.offset - lead }));
  const reference = heard.flatMap((w) => w.speech);
  const step = speechStep(curves, SPEECH_STRETCH_WINDOWS);
  if (step) return { anchors: placed([...step.before.anchors, ...step.after.anchors]), reference, score: Math.min(step.before.score, step.after.score), margin: Math.min(step.before.margin, step.after.margin), windows: curves.length, steps: 1 };
  const fit = fitCurves(curves);
  if (!clearSpeech(fit, SPEECH_MIN_ANCHORS)) return undefined;
  // The windows the one shift leaves out meet the voices at a shift of their own, too few to time by.
  if (speechStep(curves, SPEECH_STEP_SEEN_WINDOWS)) return undefined;
  return { anchors: placed(fit.anchors), reference, score: fit.score, margin: fit.margin, windows: curves.length };
}

/**
 * Whether a fit of speech says clearly where the captions go: enough windows on it, enough speech
 * met, and no rival close. Among few voices chance alone makes a peak stand out: the best shift must
 * meet more voices than any shift a second away by SPEECH_CHANCE times the square root of the voices
 * heard (the size of chance's spread), as well as by SPEECH_MIN_MARGIN of them.
 */
function clearSpeech(fit: SpeechFit | undefined, windows: number): fit is SpeechFit {
  return fit !== undefined && fit.anchors.length >= windows && fit.score >= SPEECH_MIN_SCORE && fit.margin >= Math.max(SPEECH_MIN_MARGIN, SPEECH_CHANCE / Math.sqrt(fit.heard));
}

/**
 * See clearSpeech. Over 12,000 made-up plays of another episode's or show's subtitle on a file with
 * no subtitle track whose voices were half to a fifth heard (5 and 10 windows), SPEECH_MIN_MARGIN
 * alone let 25 through; the two that came closest to this stood out by 1.09 and 1.13 times the
 * square root. Every timing by speech of the stored plays stands out by at least 1.24 (a subtitle
 * timed by 32 voices, margin 0.22). In between: it lets none of those 12,000 through, and costs 119 of
 * 5,931 timings (2%) of the episode's own subtitle on the same files, none where all voices are heard.
 */
const SPEECH_CHANCE = 1.2;

/**
 * Where the timing steps once, by speech: the windows (in order) cut in two, each side fitted on its
 * own (fitCurves) and clear (clearSpeech, with at least `windows` windows on its shift), the two
 * shifts more than SPEECH_STEP_MIN_MS apart. Of the cuts that do, the one meeting the most speech.
 * A subtitle that needs one shift has no such cut: each side's own best is that shift. Another
 * episode's subtitle would need two clear fits by chance, each over fewer windows than the whole.
 */
function speechStep(curves: Array<{ w: { from: number; to: number }; curve: { matched: number[]; heard: number } }>, windows: number): { before: SpeechFit; after: SpeechFit } | undefined {
  let best: { before: SpeechFit; after: SpeechFit; met: number } | undefined;
  for (let k = windows; k <= curves.length - windows; k++) {
    const before = fitCurves(curves.slice(0, k));
    const after = fitCurves(curves.slice(k));
    if (!clearSpeech(before, windows) || !clearSpeech(after, windows) || Math.abs(before.offset - after.offset) <= SPEECH_STEP_MIN_MS) continue;
    const met = before.score * before.heard + after.score * after.heard;
    if (!best || met > best.met) best = { before, after, met };
  }
  return best && { before: best.before, after: best.after };
}

/** Windows a stretch of speech needs of its own to be timed apart from the rest of the file (see bySpeech). */
const SPEECH_STRETCH_WINDOWS = 3;
/** Windows enough to show that the timing steps, though not to place the step (see bySpeech). */
const SPEECH_STEP_SEEN_WINDOWS = 2;
/** How far apart two stretches' shifts must be to count as a step: the drift a window may take (SPEECH_DRIFT_MS) is not one. */
const SPEECH_STEP_MIN_MS = 1000;

/**
 * Timing line by line (align.ts): for a subtitle that is the file's own dialogue but fits no shift
 * per stretch. Only on a file timed from its index, where every line of a text track is known. The
 * tracks are tried in order; the first one the captions surely share their dialogue with times them.
 * The anchors returned sum it up per window (the median shift of the lines landing there), for the
 * log and the dashboard: the timing itself is `shifts`, one per caption start.
 */
export function byLines(stored: FileAnchors, captions: Cue[]): { shifts: Map<number, number>; anchors: Anchor[]; track: "first" | number; paired: number } | undefined {
  if (stored.source !== "index" || stored.image || stored.speechOnly) return undefined;
  for (const track of ["first" as const, ...(stored.others ?? [])]) {
    const view = track === "first" ? stored : trackView(stored, track);
    const windows = view.windows.filter((w) => !w.bridge && !w.heard);
    const timed = timingByLines(captions, windows.flatMap((w) => w.cues));
    if (!timed) continue;
    const landed = [...timed.shifts].map(([start, shift]) => ({ at: start + shift, shift })).sort((a, b) => a.at - b.at);
    const score = Math.round(timed.alignment.captionShare * 100) / 100;
    const anchors = windows.flatMap((w) => {
      const here = landed.filter((l) => l.at >= w.from && l.at < w.to).map((l) => l.shift).sort((a, b) => a - b);
      return here.length ? [{ from: w.from, to: w.to, offset: here[Math.floor(here.length / 2)], score }] : [];
    });
    if (anchors.length === 0) continue;
    return { shifts: timed.shifts, anchors, track, paired: timed.alignment.pairs.length };
  }
  return undefined;
}

/** A shift for any caption start: its own when known, else that of the nearest start that has one. */
function shiftLookup(shifts: Map<number, number>): (start: number) => number {
  const starts = [...shifts.keys()].sort((a, b) => a - b);
  return (start) => {
    const own = shifts.get(start);
    if (own !== undefined) return own;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    const after = starts[lo];
    const before = starts[lo - 1];
    const nearest = before !== undefined && (after === undefined || start - before <= after - start) ? before : after;
    return nearest === undefined ? 0 : shifts.get(nearest) ?? 0;
  };
}

const SPEECH_MIN_ANCHORS = 3;
/** Over the recorded files: own lines scored 0.38 to 0.69, margins 0.14 to 0.42; another file's lines at most 0.40 and 0.13. */
const SPEECH_MIN_SCORE = 0.35;
const SPEECH_MIN_MARGIN = 0.15;
/**
 * How long before the voice it meets a translation timed by speech is placed. Lines lead the voice
 * Silero hears by an amount that depends on who timed them, so this is a compromise. Measured as the
 * shift at which speech best meets the lines where they belong: a file's own subtitle track 0.04 to
 * 0.26 s (median 0.07, 6 files), uploads to files with no subtitle track, as they came (taken to be
 * made for that release) 0.08 to 0.31 s (median about 0.23, 6 files). Over both, every lead from 0.14
 * to 0.2 s lands lines about as close (mean 83 to 86 ms off), so it stays at 0.2 s.
 */
export const SPEECH_LEAD_MS = 200;
/**
 * How long before the voice it meets a dub caption is placed: moved onto the voices (refineBySpeech)
 * or timed by speech alone. Dub caption uploads, where the voices put them, lead their voices by
 * about 0.12 to 0.23 s (4 uploads); English subtitle tracks lead English voices by 0.04 to 0.12 s
 * (3 files). The median over both is 0.12 s, 38 ms from each on average, against 82 ms at 0.2 s.
 */
export const VOICE_LEAD_MS = 120;

/**
 * How far ahead of the voices Silero hears a streaming service's own dub captions sit: further than
 * uploads. A dub release's own captions track (Anime Tosho's, see animetosho.ts) played on that very
 * file is right as it is, and the voice fit at VOICE_LEAD_MS would still have moved it 200 ms later
 * (score 0.70, 4 windows agreeing): the service starts a line about 0.32 s before the voice is heard.
 * The same captions moved onto two other releases' voices at VOICE_LEAD_MS were found "a little off"
 * (late) by the viewer. So those captions are moved to sit this far ahead instead.
 *
 * Provisional: it rests on that one file. On the release they came from, the captions fit its own
 * track exactly and aren't moved at all (fitsOwnTrack), whatever this says; it only places them on
 * other releases, where nothing has measured it yet.
 */
export const OFFICIAL_CAPTIONS_LEAD_MS = 320;

/** The lead a dub caption file is placed at ahead of its voices: a service's own captions (Anime Tosho's "at" files) sit further ahead. */
export function voiceLeadFor(file: string): number {
  return /^at[0-9a-f]{8}-/.test(path.basename(file)) ? OFFICIAL_CAPTIONS_LEAD_MS : VOICE_LEAD_MS;
}

/**
 * Whether captions fit the file's own subtitle track almost exactly: nearly every window measured
 * (OWN_TRACK_SHARE) at one shift (within OWN_TRACK_SPREAD_MS of the windows' median) with near
 * perfect overlap (OWN_TRACK_SCORE). That is the track itself, as a release's own captions played on
 * that release are (seen: 22 windows of 22 at 0 ms, every score 1.0). Then the track's timing is the
 * file's own, and it stands: dub captions aren't moved onto the voices, by any lead. Uploads that
 * follow a track score about as high but spread over hundreds of ms from window to window (seen:
 * 22 windows over 0.68 s, scores 0.97 and 0.98), so they are moved as before.
 */
export function fitsOwnTrack(windows: Array<{ measured: Pick<Measured, "offset" | "score"> }>): boolean {
  if (windows.length < OWN_TRACK_MIN_WINDOWS) return false;
  const offsets = windows.map((w) => w.measured.offset).sort((a, b) => a - b);
  const middle = offsets[offsets.length >> 1];
  const on = windows.filter((w) => Math.abs(w.measured.offset - middle) <= OWN_TRACK_SPREAD_MS && w.measured.score >= OWN_TRACK_SCORE).length;
  return on >= OWN_TRACK_SHARE * windows.length;
}

/** Windows enough to tell a track's own captions (fitsOwnTrack): the five of a first reading. */
const OWN_TRACK_MIN_WINDOWS = 5;
/** How far from one shift a window of the track's own captions may read (a window is read in 5 ms steps). */
const OWN_TRACK_SPREAD_MS = 50;
/** Overlap a window of the track's own captions reaches: the same lines, so all of the track's speech. */
const OWN_TRACK_SCORE = 0.95;
/** The share of windows that must say both: one may read a stretch of songs or signs differently. */
const OWN_TRACK_SHARE = 0.9;

/**
 * Dub captions (English that follows an English dub) timed closer by the dub's voices. The file's
 * subtitle track follows the original audio, and dub captions measured against it by overlap land a
 * beat off the English voices: checked live against the English audio at 5 spots, 0.12 to 0.28 s
 * early or late, where the uploads themselves were right by the voices. So once the English audio
 * has been heard, the timing the track gave (`shift`) is taken as the coarse answer and refined:
 *
 * - The captions as the track times them are matched against where the voices start, in every heard
 *   window at once (speechCurve), over only ±REFINE_RANGE_MS. Unless that says clearly where the
 *   voices are (see voiceFit: at least SPEECH_MIN_ANCHORS windows agreeing, a share of voices met and
 *   a margin over any other move), the track's timing stands as it is.
 * - Each stretch of the track's timing (the lines between two of its steps) then moves by its own
 *   heard windows, when they agree with each other; a stretch moving far from the others needs two
 *   windows to say so. A stretch with no window of its own, or none that says clearly, moves as the
 *   whole file does. Steps stay where the track put them.
 *
 * A move puts each line `lead` before the voice it meets (VOICE_LEAD_MS; OFFICIAL_CAPTIONS_LEAD_MS for a service's own captions, see voiceLeadFor). This only ever refines captions the
 * track already found to be this file's, and by under a second: speech alone never decides that
 * captions belong. Returns the refined shift and the move of each stretch.
 */
export function refineBySpeech(
  found: FileAnchors,
  captions: Cue[],
  shift: (start: number) => number,
  lead = VOICE_LEAD_MS
): { shift: (start: number) => number; moves: Array<{ from: number; by: number; own: boolean }>; score: number; margin: number; windows: number } | undefined {
  if (found.speechBy !== "silero" || found.speechOnly || !voicesAreTheDub(found)) return undefined;
  const lines = [...captions].sort((a, b) => a.start - b.start).map((c) => ({ at: c.start, shift: shift(c.start), start: c.start + shift(c.start), end: c.end + shift(c.start) }));
  if (lines.length === 0) return undefined;
  // The track's stretches: lines in a row at one shift, from the first one's start (caption time).
  const stretches: Array<{ from: number }> = [];
  const stretchOf = lines.map((l, i) => {
    if (i === 0 || l.shift !== lines[i - 1].shift) stretches.push({ from: l.at });
    return stretches.length - 1;
  });
  const placed = [...lines].sort((a, b) => a.start - b.start);
  const windows = found.windows.flatMap((w) => {
    if (w.bridge || (w.speech?.length ?? 0) < 3) return [];
    const curve = speechCurve(w.speech!, placed, REFINE_RANGE_MS);
    if (!curve) return [];
    // The stretch most of the window's lines belong to.
    const counts = new Map<number, number>();
    lines.forEach((l, i) => {
      if (l.start >= w.from && l.start < w.to) counts.set(stretchOf[i], (counts.get(stretchOf[i]) ?? 0) + 1);
    });
    const stretch = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return stretch === undefined ? [] : [{ curve, stretch }];
  });
  const all = voiceFit(windows, lead);
  if (!all || all.agree < SPEECH_MIN_ANCHORS || all.score < SPEECH_MIN_SCORE || all.margin < SPEECH_MIN_MARGIN) return undefined;
  const moves = stretches.map(({ from }, k) => {
    const own = windows.filter((w) => w.stretch === k);
    const fit = own.length ? voiceFit(own, lead) : undefined;
    const clear = fit !== undefined && fit.agree === own.length && fit.margin >= SPEECH_MIN_MARGIN && (own.length >= 2 || Math.abs(fit.peak - all.peak) <= REFINE_AGREE_MS);
    return { from, by: clear ? fit.by : all.by, own: clear };
  });
  const moveAt = (start: number) => {
    let k = 0;
    while (k + 1 < moves.length && moves[k + 1].from <= start) k++;
    return moves[k].by;
  };
  return { shift: (start) => shift(start) + moveAt(start), moves, score: all.score, margin: all.margin, windows: all.agree };
}

/**
 * Where the voices of these heard windows meet the placed line starts best, over ±REFINE_RANGE_MS
 * (their speechCurves added up). peak: that move, the middle of the curve's top (a voice meets a line
 * start anywhere within ONSET_TOLERANCE_MS either way, so the top is a plateau and its middle is where
 * most voices sit); score: the share of voices met there; margin: how far it stands above any move
 * REFINE_RIVAL_MS away; agree: how many windows on their own meet at least REFINE_WINDOW_SCORE of
 * their voices within REFINE_AGREE_MS of it. by: the move that puts the lines VOICE_LEAD_MS ahead
 * of their voices.
 */
function voiceFit(windows: Array<{ curve: { matched: number[]; heard: number } }>, lead = VOICE_LEAD_MS): { peak: number; by: number; score: number; margin: number; agree: number } | undefined {
  if (windows.length === 0) return undefined;
  const heard = windows.reduce((sum, w) => sum + w.curve.heard, 0);
  const total = windows[0].curve.matched.map((_, i) => windows.reduce((sum, w) => sum + w.curve.matched[i], 0) / heard);
  const best = curvePeaks(total, REFINE_RANGE_MS)[0];
  if (!best) return undefined;
  const at = (i: number) => -REFINE_RANGE_MS + i * SPEECH_STEP_MS;
  const rival = Math.max(0, ...total.filter((_, i) => Math.abs(at(i) - best.offset) > REFINE_RIVAL_MS));
  const agree = windows.filter(({ curve }) => Math.max(0, ...curve.matched.filter((_, i) => Math.abs(at(i) - best.offset) <= REFINE_AGREE_MS)) / curve.heard >= REFINE_WINDOW_SCORE).length;
  return { peak: best.offset, by: best.offset - lead, score: Math.round(best.score * 100) / 100, margin: Math.round((best.score - rival) * 100) / 100, agree };
}

/**
 * Whether the voices heard are the dub's: the audio heard is English (pickAudio takes English first),
 * or its language isn't tagged. Another language's voices (a file with no English audio) follow the
 * original, as the track does.
 */
export function voicesAreTheDub(found: Pick<FileAnchors, "audioLang">): boolean {
  return !found.audioLang || /^(en|eng|und)$/i.test(found.audioLang);
}

/** How far the track's timing of dub captions may be moved by their voices, either way. */
const REFINE_RANGE_MS = 1000;
/** A move this far from the best one is a rival: past the voices that meet the best one. */
const REFINE_RIVAL_MS = 400;
/** How near the best move a window's own best must be... */
const REFINE_AGREE_MS = 200;
/** ...meeting at least this share of the window's voices. */
const REFINE_WINDOW_SCORE = 0.45;

// ---------- syncing one caption file ----------

export interface SyncResult {
  file: string;
  anchors: Anchor[];
  /** The captions don't belong to this file (best fits scattered, e.g. another episode's). */
  noFit?: boolean;
  /** The playing file and the cached subtitle synced to it, kept for the replay check (scripts/replay.ts). */
  filename?: string;
  source?: string;
  /** Timed by speech heard in the audio, the last resort (see bySpeech): alternates timed by the
   * file's own subtitles are preferred over it. */
  bySpeech?: boolean;
  /** The file has no subtitle track, so speech was all there was: no alternate can do better. */
  speechOnly?: boolean;
  /** Timed line by line to the file's own lines (see byLines), not by a shift per stretch. */
  byLines?: boolean;
  /** A shift per stretch found by where lines start, not by how they overlap (see byStarts). */
  byStarts?: boolean;
  /** The captions were made for another frame rate: their times were multiplied by this (RATE_FACTORS). */
  factor?: number;
  /** Dub captions: ms the track's timing was moved by to meet the English voices (see refineBySpeech), the median over its stretches. */
  voiceShift?: number;
  /**
   * Dub captions timed by the track alone while the file's English audio is still to be heard (see
   * hearDubVoices): synced again once it has been, and not to be kept by a player meanwhile.
   */
  voicesPending?: boolean;
  /**
   * A file with no subtitle track whose speech didn't time these captions clearly, timed (or left)
   * by its first five windows while more of its audio is heard (see hearMoreSpeech): synced again
   * once it has been, and not to be kept by a player meanwhile.
   */
  speechPending?: boolean;
}

const syncJobs = new Map<string, Promise<SyncResult | undefined>>();
/** First-pass timing of syncs still reading more of the file (see syncCaptions). */
const firstPass = new Map<string, SyncResult>();

/** The timing from the first windows of a sync that is still refining, if it got that far. */
export function firstPassSync(key: string): SyncResult | undefined {
  return firstPass.get(key);
}

/** Bumped when the sync method changes: older results are ignored and download URLs change, so no cache keeps old timing. */
export const SYNC_VERSION = 16;

/**
 * Whether captions belong to the file at all: at least half of the measured
 * windows must have a best fit within AGREE_MS of another window's. A timing
 * step mid-episode still passes (windows on each side agree with each other).
 */
/** Whether at least half the measured windows' own best fits lie within AGREE_MS of the final timing there. */
export function landsOnTiming(windows: Array<{ from: number; measured: Measured }>, anchors: Anchor[]): boolean {
  if (windows.length < 3 || anchors.length === 0) return true;
  const timingAt = (from: number) => anchors.reduce((a, b) => (Math.abs(b.from - from) < Math.abs(a.from - from) ? b : a)).offset;
  const direct = windows.filter((w) => Math.abs(w.measured.offset - timingAt(w.from)) <= LAND_MS).length;
  return direct * 2 >= windows.length;
}

/**
 * How close a window's own best fit must be to the final timing to count as landing on it. Wider
 * than AGREE_MS, for timing that drifts a little (seen: 0.98 s read where the final timing is
 * 0.32 s); a coincidental fit sits seconds away (a misfiled subtitle: 2.6 to 18 s).
 */
const LAND_MS = 1000;

export function fitsFile(windows: Array<{ measured: Measured }>): boolean {
  if (windows.length < 3) return true;
  const supported = windows.filter((w, i) => windows.some((o, j) => j !== i && Math.abs(o.measured.offset - w.measured.offset) <= AGREE_MS)).length;
  if (supported * 2 >= windows.length) return true;
  // Timing that drifts a little across the file spreads past AGREE_MS (seen: -0.1, 0.2 and 1.0 s,
  // refined to 0.0-0.4 s). Three windows within BAND_MS of each other still fit:
  // another episode's captions scatter over the whole ±20 s. landsOnTiming checks again afterwards.
  const sorted = windows.map((w) => w.measured.offset).sort((a, b) => a - b);
  return sorted.some((offset, i) => i + 2 < sorted.length && sorted[i + 2] - offset <= BAND_MS);
}

/** How far apart three windows' readings may be and still count as one timing that drifts. */
const BAND_MS = 1500;

/**
 * How the captions, as timed by `shift`, sit on the file as a whole (see accountsForFile):
 * - inside: the share of their lines that start within the file, from 0 to its end;
 * - windows: the file's windows with dialogue (an index minute with INDEX_MIN_WINDOW_LINES lines or
 *   more, a window read or heard with 3 or more), and covered: how many of them hold a caption start;
 * - anchored, given the anchors: how many of those windows carry an anchor of the timing.
 */
export function wholeFile(found: FileAnchors, captions: Cue[], shift: (start: number) => number, anchors?: Anchor[]): { inside: number; windows: number; covered: number; anchored?: number } {
  const starts = captions.map((c) => c.start + shift(c.start)).sort((a, b) => a - b);
  const inside = starts.length && found.duration ? starts.filter((t) => t >= 0 && t <= found.duration).length / starts.length : 1;
  const fewest = found.source === "index" ? INDEX_MIN_WINDOW_LINES : 3;
  const windows = found.windows.filter((w) => !w.bridge && !w.heard && w.cues.length >= fewest);
  const holdsStart = (w: { from: number; to: number }) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < w.from) lo = mid + 1;
      else hi = mid;
    }
    return lo < starts.length && starts[lo] < w.to;
  };
  const anchoredAt = new Set(anchors?.map((a) => a.from));
  return {
    inside: Math.round(inside * 100) / 100,
    windows: windows.length,
    covered: windows.filter(holdsStart).length,
    ...(anchors ? { anchored: windows.filter((w) => anchoredAt.has(w.from)).length } : {})
  };
}

/**
 * Why the captions, as timed, can't be this file's, or undefined when nothing says so. The trust
 * checks above (fitsFile, landsOnTiming, holdsTogether) judge the windows that were measured, and a
 * window is measured only where the captions have lines near the file's own; with fewer than 3 they
 * judge nothing at all. So a subtitle that meets only a stretch of the file passed them on the few
 * windows it met, at chance shifts. Over every played file with every cached subtitle the data shows
 * to be another's (a cross check over the stored plays), 63 of 11,767 were served as synced that way,
 * all by a shift per stretch: a film's subtitle on episodes (93 to 107 minutes of lines on 24 to 57;
 * one of 30 lines over 2.6 minutes on 25 episodes), episodes of 42 to 56 minutes on ones of 19 to 24,
 * and 12 to 22 minutes of lines on files of 24 to 155 minutes. A subtitle of the file is all of it:
 * - nearly all its lines start within the file (WHOLE_MIN_INSIDE). The file's own, on the stored
 *   plays: 0.99 at least; a film's on an episode: 0.17 to 0.69;
 * - it has lines in nearly every window of the file with dialogue (WHOLE_MIN_COVERED). Own: 0.96 at
 *   least (a minute the subtitle leaves out); the short ones: 0.02 to 0.67, one 0.95;
 * - given `anchors` (a timing by fits per window of the track: a shift per stretch, another frame
 *   rate), its timing rests on most of those windows, and on WHOLE_MIN_ANCHORS at least
 *   (WHOLE_MIN_ANCHORED). Own: 0.79 at least; the one that passed the two above: 0.38.
 * Timing by line starts and far off have landing tests of their own over every window (byStarts,
 * farTiming), and timing line by line and by speech rest on no window fits, so they get the first two.
 */
export function accountsForFile(found: FileAnchors, captions: Cue[], shift: (start: number) => number, anchors?: Anchor[]): string | undefined {
  const w = wholeFile(found, captions, shift, anchors);
  if (w.inside < WHOLE_MIN_INSIDE) return `only ${Math.round(w.inside * 100)}% of its lines start within the file`;
  if (w.windows > 0 && w.covered < WHOLE_MIN_COVERED * w.windows) return `it has lines in only ${w.covered} of the file's ${w.windows} windows with dialogue`;
  if (w.anchored !== undefined && w.windows > 0 && (w.anchored < WHOLE_MIN_ANCHORED * w.windows || w.anchored < WHOLE_MIN_ANCHORS)) return `its timing rests on only ${w.anchored} of the file's ${w.windows} windows with dialogue`;
  return undefined;
}

/** The share of a subtitle's lines that must start within the file... */
const WHOLE_MIN_INSIDE = 0.9;
/** ...the share of the file's windows with dialogue that must hold one of its lines... */
const WHOLE_MIN_COVERED = 0.75;
/** ...and, for a timing by fits per window, the share of those windows that must carry it, and how many. */
const WHOLE_MIN_ANCHORED = 0.6;
const WHOLE_MIN_ANCHORS = 3;

export function syncKey(ref: string | number, season: number | undefined, episode: number | undefined, filename: string, pick?: number): string {
  // The ref as every caller passes it ("ss123", "osar-456"): the key must not change, or every synced
  // result is made again. A pack's file found by the subtitle's own count (pick, see downloads.ts) can
  // be another file than the one found by the episode, so it has a key of its own.
  return cacheKey({ kind: "synced", subtitleId: ref, season, episode, filename, version: SYNC_VERSION, ...(pick !== undefined ? { pick } : {}) });
}

/**
 * What's already known about syncing this subtitle to this file, read from
 * earlier results only (nothing is fetched): "unsynced" when the file has no
 * embedded subtitles to sync to, or this subtitle matched none of them.
 */
export async function knownSync(key: string, filename: string): Promise<"synced" | "speech" | "unsynced" | "wrong" | "unknown"> {
  try {
    const done = JSON.parse(await readFile(path.join(cachePath("synced"), `${key}.json`), "utf8")) as SyncResult;
    // Timed (or left) by a file's first five windows of speech while more was heard: once it has
    // been, this is to be synced again, so it isn't known yet. Asked before noFit: five windows can
    // find a subtitle not to be the file's (accountsForFile), and ten are judged again.
    if (done.speechPending) {
      const now = await storedAnchors(filename);
      if (now && !moreSpeechToHear(now) && (now.rounds ?? 0) > 0) return "unknown";
    }
    if (done.noFit) return "wrong";
    if (done.bySpeech && done.anchors.length > 0) return "speech";
    return done.anchors.length > 0 ? "synced" : "unsynced";
  } catch {}
  try {
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (found.windows.length === 0 && stillValid(found)) return "unsynced";
  } catch {}
  return "unknown";
}

/**
 * Captions retimed to the playing file, or undefined when it can't be done
 * (no embedded text subtitles, no anchor agreed). Started when the list is
 * asked for; the download waits on the same job.
 */
export function syncCaptions(
  key: string,
  caption: () => Promise<{ file: string }>,
  /** The AIOStreams of whoever is playing: their search, their debrid, never someone else's. */
  aiostreamsUrl: string,
  videoId: string,
  type: string,
  filename: string,
  lang?: string
): Promise<SyncResult | undefined> {
  const running = syncJobs.get(key);
  if (running) {
    // A finished sync whose file was deleted since (the daily clean-up, see cleanup.ts) is made again.
    return running.then((done) => {
      if (!done || existsSync(done.file)) return done;
      if (syncJobs.get(key) === running) syncJobs.delete(key);
      return syncCaptions(key, caption, aiostreamsUrl, videoId, type, filename, lang);
    });
  }
  const job = (async () => {
    const meta = path.join(cachePath("synced"), `${key}.json`);
    try {
      const done = JSON.parse(await readFile(meta, "utf8")) as SyncResult;
      if (existsSync(done.file)) {
        if (!done.voicesPending && !done.speechPending) return done;
        const now = await storedAnchors(filename);
        // Timed by the track while the English audio was still to be heard: synced again once it has
        // been, else served as it is (and the audio asked for again, if no read is under way).
        if (done.voicesPending && (!now || voicesToHear(now))) {
          if (now) hearDubVoices(now, aiostreamsUrl, videoId, type, filename);
          return done;
        }
        // Timed (or left) by the first five windows of a file with no subtitle track while more of its
        // audio is heard: the same.
        if (done.speechPending && (!now || moreSpeechToHear(now))) {
          if (now) hearMoreSpeech(now, aiostreamsUrl, videoId, type, filename);
          return done;
        }
      }
    } catch {}

    const source = await caption();
    const ext = path.extname(source.file).toLowerCase();
    const text = decodeSubtitle(await readFile(source.file), lang);
    let captions = parseCues(text, ext);
    // stored: the file's readings as kept on disk; found: the track these captions are timed by.
    let stored = await fileAnchors(aiostreamsUrl, videoId, type, filename);
    if (!stored) return undefined; // lookup failed: try again next time
    const pick: TrackPick = stored.speechOnly ? { track: "first" } : await finishBetweenRequests(trackChoiceSteps(stored, captions));
    const track = pick.track;
    const viewOf = (s: FileAnchors) => (track === undefined ? noLines(s) : track === "first" ? s : trackView(s, track));
    let found = viewOf(stored);
    if (track === undefined) console.log(`sync: ${filename}: every subtitle track has under half as many lines as the captions, timing by speech only`);
    else if (track !== "first") {
      count("sync.otherTrack");
      console.log(`sync: ${filename}: the first subtitle track doesn't fit, timing by track ${track}`);
    }

    let { measuredWindows, anchors } = found.speechOnly ? { measuredWindows: [] as ReturnType<typeof measureAll>["measuredWindows"], anchors: [] as Anchor[] } : (pick.asWritten ?? measureAll(found, captions));
    // Made for another frame rate: from here on the captions are rescaled to the file's.
    let factor = 1;
    const rated = found.speechOnly ? undefined : "rated" in pick ? pick.rated : await finishBetweenRequests(rescaledSteps(found, captions, { measuredWindows, anchors }));
    if (rated) {
      ({ factor, captions, measuredWindows, anchors } = rated);
      count("sync.rescaled");
      console.log(`sync: ${filename}: made for another frame rate, times x${factor.toFixed(4)}`);
    }
    if (found.speechOnly) found = { ...found, rounds: MAX_ROUNDS };
    // Dub captions (no language) timed by the track: moved onto the dub's voices where the English
    // audio has been heard and says so clearly (see refineBySpeech). Translations are left as timed,
    // and so are dub captions that are the file's own track (fitsOwnTrack): its timing is the file's.
    const ownTrack = () => !lang && fitsOwnTrack(measuredWindows);
    const byVoices = (plan: (start: number) => number): { shift: (start: number) => number; by?: ReturnType<typeof refineBySpeech> } => {
      const by = lang || ownTrack() ? undefined : refineBySpeech(found, captions, plan, voiceLeadFor(source.file));
      return by ? { shift: by.shift, by } : { shift: plan };
    };
    // Captions for this file fit at the same shift in window after window. When most windows' best
    // fits agree with no other window (seen: another episode's captions), they don't belong to this
    // file: they are left as they are, and no more of the file is read for them.
    let noFit = false;
    if (!found.speechOnly && !fitsFile(measuredWindows)) {
      console.log(`sync: ${filename}: best fits scattered (${measuredWindows.map((w) => w.measured.offset).join(", ")} ms), the captions don't match this file`);
      count("sync.noFit");
      noFit = true;
      measuredWindows = [];
      anchors = [];
      found = { ...found, rounds: MAX_ROUNDS };
    }
    // The timing from the first windows, ready for a download that can't wait for the extra
    // rounds below (they can take another 10 to 20 s). Kept in memory only. Only a timing those
    // windows already vouch for as the final one must (trusted, accountsForFile): a download takes
    // it in place of the finished sync, which may yet refuse the subtitle.
    const firstLines = found.windows.flatMap((w) => w.cues);
    if (anchors.length > 0 && (found.rounds ?? 0) < MAX_ROUNDS && trusted({ measuredWindows, anchors }) && !accountsForFile(found, captions, planShifts(anchors, captions, firstLines), anchors)) {
      const first = path.join(cachePath("synced"), `${key}.first${ext}`);
      await mkdir(cachePath("synced"), { recursive: true });
      // Translations by the file's line starts (see followShifts), dub captions by the track and then
      // their voices where the English audio has been heard (see refineBySpeech).
      const lines = firstLines;
      const followed = lang && !found.speechOnly ? timingByStarts(anchors, captions, lines, false, found) : undefined;
      await writeFile(first, retime(text, ext, followed ? followed.shift : byVoices(planShifts(anchors, captions, lines)).shift, factor));
      firstPass.set(key, { file: first, anchors });
    }
    // Gaps or disagreement: read more of the file there, then measure again. Rounds are
    // kept with the file, so later captions for it start from what's already read.
    while ((found.rounds ?? 0) < MAX_ROUNDS) {
      const spans =
        (found.rounds ?? 0) === 0
          ? refinementStarts(found, anchors).map((from) => ({ from, length: EXTRA_WINDOW_MS }))
          : bridgeSpans(found, anchors).map((span) => ({ ...span, bridge: true }));
      if (spans.length === 0) break;
      // More of the file is read for every track and kept as stored; these captions go on with theirs.
      const extended = await extendAnchors(stored, spans, aiostreamsUrl, videoId, type, filename);
      if (!extended || extended === stored) break;
      stored = extended;
      found = viewOf(stored);
      ({ measuredWindows, anchors } = measureAll(found, captions));
    }
    const notes = measuredWindows.flatMap((w) => {
      const kept = anchors.find((a) => a.from === w.from);
      const at = `${Math.round(w.from / 1000)}s`;
      if (!kept) return [`${at} ${w.measured.offset}ms set aside`];
      return kept.offset !== w.measured.offset ? [`${at} ${w.measured.offset}ms read as ${kept.offset}ms`] : [];
    });
    const unmatched = found.windows.filter((w) => !measuredWindows.some((m) => m.from === w.from)).map((w) => `${Math.round(w.from / 1000)}s (${w.cues.length} lines)`);
    if (unmatched.length) notes.push(`no match at ${unmatched.join(", ")}`);
    if (notes.length) console.log(`sync: ${filename}: ${notes.join("; ")}`);
    await mkdir(cachePath("synced"), { recursive: true });
    // A real sync lands most windows on the final timing with their own best fit. One built mostly
    // from second-best fits (seen: a misfiled Arabic, 1 of 8 windows) is a coincidence:
    // left unsynced, so a fallback gets its turn. Every real sync so far had 5/5 to 9/10.
    if (anchors.length > 0 && !landsOnTiming(measuredWindows, anchors)) {
      console.log(`sync: ${filename}: timing rests on second-best fits, not counted as synced`);
      count("sync.noFit");
      noFit = true;
      anchors = [];
    }
    // A shift that jumps about from window to window is chance fits, not cuts (see holdsTogether):
    // the captions are for another version of the file. Left unsynced, so a fallback gets its turn.
    if (anchors.length > 0 && !holdsTogether(anchors)) {
      console.log(`sync: ${filename}: the shift jumps ${shiftChanges(anchors)} times over ${anchors.length} windows, more than cuts explain: not counted as synced`);
      count("sync.noFit");
      noFit = true;
      anchors = [];
    }
    // Every timing found below must also account for the file as a whole (see accountsForFile): a
    // subtitle that meets only a stretch of it can pass every test of the windows it met. Refused,
    // the next way of timing gets its turn, under the same test.
    const notTheFile = (view: FileAnchors, shift: (start: number) => number, how: string, perWindow?: Anchor[]): boolean => {
      const why = accountsForFile(view, captions, shift, perWindow);
      if (!why) return false;
      console.log(`sync: ${filename}: ${how}, but ${why}: not counted as synced`);
      count("sync.noFit");
      noFit = true;
      return true;
    };
    if (anchors.length > 0 && notTheFile(found, planShifts(anchors, captions, found.windows.flatMap((w) => w.cues)), `a shift per stretch fits ${anchors.length} windows`, anchors)) anchors = [];
    // No shift fits, yet it may be the file's own dialogue timed line by line to another recording:
    // then each line takes its own line's start (see byLines). Other languages only, as with
    // snapping: dub captions follow the dub, whose lines aren't the file's.
    let lineTimed: Map<number, number> | undefined;
    if (anchors.length === 0 && lang) {
      const lined = byLines(stored, captions);
      if (lined && !notTheFile(lined.track === "first" ? stored : trackView(stored, lined.track), shiftLookup(lined.shifts), "its lines pair with the file's")) {
        lineTimed = lined.shifts;
        anchors = lined.anchors;
        noFit = false;
        count("sync.byLines");
        console.log(`sync: ${filename}: no shift fits, but it is the file's dialogue line for line: ${lined.paired} of ${captions.length} lines timed by the file's own${lined.track === "first" ? "" : ` (track ${lined.track})`}`);
      }
    }
    // Nothing fits within ±20 s, yet the line starts meet the file's at one shift far beyond it (a
    // recap in one release only): every window measured again around that shift (see farTiming).
    if (anchors.length === 0 && !lineTimed && !found.speechOnly) {
      const far = farTiming(found, captions);
      if (far && !notTheFile(found, planShifts(far.anchors, captions), `the line starts meet the file's ${Math.round(far.centre / 100) / 10} s off`)) {
        anchors = far.anchors;
        noFit = false;
        count("sync.far");
        console.log(`sync: ${filename}: nothing fits within 20 s, but the line starts meet the file's ${Math.round(far.centre / 100) / 10} s off: measured again around that shift, ${far.landed} of ${far.windows} windows on it`);
      }
    }
    // No shift fits by how the lines overlap, yet they start where the file's lines start, with a
    // shift per stretch (see byStarts). Translations only, as with snapping.
    let startTimed = false;
    if (anchors.length === 0 && lang) {
      const started = byStarts(found, captions);
      if (started && !notTheFile(found, planShifts(started.anchors, captions, [], true), "the line starts fit a shift per stretch")) {
        anchors = started.anchors;
        startTimed = true;
        noFit = false;
        count("sync.byStarts");
        console.log(`sync: ${filename}: no shift fits by overlap, but the line starts do: ${started.landed} of ${started.windows} windows on the timing`);
      }
    }
    // Nothing fits the subtitle track: speech in the audio, as a last resort.
    let reference = found.windows.flatMap((w) => w.cues);
    let heard = false;
    /** Windows whose speech could be measured, when timed by speech: each should land on the timing. */
    let speechWindows = 0;
    // A file timed from its index has no audio read yet: it's heard now, the last resort's turn.
    if (anchors.length === 0 && stored.source === "index" && stored.audio !== undefined && stored.speechBy !== "silero") {
      const withSpeech = await addSpeech(stored, aiostreamsUrl, videoId, type, filename);
      if (withSpeech) {
        stored = withSpeech;
        found = viewOf(stored);
      }
    }
    if (anchors.length === 0) {
      // Dub captions lead their voices by less than translations do, and by how much depends on who
      // timed them (voiceLeadFor), as when they are moved onto the voices.
      const speech = bySpeech(found, captions, lang ? SPEECH_LEAD_MS : voiceLeadFor(source.file));
      // Speech must account for the whole file too (accountsForFile), one shift or a shift per
      // stretch alike, by the stepped plan when it steps. On a file with no subtitle track this
      // judges whatever has been heard: the five windows of the first pass or, once more of the
      // audio is heard (hearMoreSpeech), all ten. Refused on five, it is heard at the five more
      // spots like any subtitle speech didn't time (speechPending below), and judged again on ten.
      // Speech gets the first two tests only, as timing line by line does. A timing that steps is
      // placed by each side's own windows, as a shift per stretch is, but bySpeech already holds it
      // to at least SPEECH_STRETCH_WINDOWS a side: six of at most ten windows heard, the share a
      // shift per stretch must rest on (test/speech.test.ts checks this).
      const whole = speech && !notTheFile(found, planShifts(speech.anchors, captions, speech.reference), "speech in the audio times it");
      if (speech && whole) {
        ({ anchors, reference } = speech);
        speechWindows = speech.windows;
        heard = true;
        noFit = false;
        count("sync.bySpeech");
        console.log(`sync: ${filename}: ${found.speechOnly ? "no subtitle track" : "no fit to the subtitle track"}; timed by speech in the audio (score ${speech.score}, margin ${speech.margin})`);
      } else if (found.speechOnly && !speech) console.log(`sync: ${filename}: speech in the audio doesn't time these captions clearly enough, left as they are`);
    }
    // A file with no subtitle track whose speech didn't time these clearly (no fit, one resting on few
    // windows, or a window heard well that lands elsewhere: the timing may step there): more of its
    // audio is heard in the background, and they are synced again by it on the next request (see
    // hearMoreSpeech).
    const speechPending = Boolean(found.speechOnly) && (anchors.length < SPEECH_SURE_WINDOWS || anchors.length < speechWindows) && moreSpeechToHear(stored);
    if (speechPending) console.log(`sync: ${filename}: ${anchors.length ? `timed by ${anchors.length} of ${found.windows.length} windows of speech` : "not timed by speech yet"}; hearing ${MORE_SPOTS.length} more spots of the audio`);
    count(anchors.length ? "sync.synced" : "sync.unsynced");
    if (anchors.length === 0) {
      if (!noFit) console.log(`sync: ${filename}: no anchor matched, captions left as they are`);
      const result: SyncResult = { file: source.file, anchors, ...(noFit ? { noFit } : {}), filename, source: path.basename(source.file), ...(speechPending ? { speechPending } : {}) };
      await writeWhole(meta, JSON.stringify(result));
      if (speechPending) hearMoreSpeech(stored, aiostreamsUrl, videoId, type, filename);
      return result;
    }
    // A translation takes its timing from where the file's own lines start, where they were read
    // (see followShifts); timing heard in speech does too, once enough of those lines meet it. Dub
    // captions and English CC (lang unset) follow the dub, not the file's lines: planShifts.
    // Timing by line starts (byStarts) keeps a plan of its own: its anchors are fits by line starts
    // already, and within a stretch its shift follows them from minute to minute (planShifts with
    // follow, see followRun), held in order as followShifts holds its own (inOrder). Fitting those
    // anchors again with followShifts did no better: over the stored plays, 59.8% of those lines
    // within 0.3 s against 60.2%. Every test above judged the plan; the timing followShifts makes of
    // it must account for the whole file as well, or the plan is served (see timingByStarts).
    const fileLines = found.windows.flatMap((w) => w.cues);
    const followed = lang && !lineTimed && !startTimed && !found.speechOnly ? timingByStarts(anchors, captions, fileLines, heard, found) : undefined;
    if (followed) {
      if (heard) console.log(`sync: ${filename}: the timing heard in speech is met by the file's own lines: timed by them`);
      anchors = followed.anchors;
    }
    let planned = lineTimed
      ? shiftLookup(lineTimed)
      : followed
        ? followed.shift
        : startTimed
          ? inOrder(captions, planShifts(anchors, captions, reference, true))
          : planShifts(anchors, captions, reference);
    // Dub captions (no language) timed by the track then move onto the English voices, where the
    // audio has been heard and says so clearly (see refineBySpeech). Translations never do: byVoices
    // leaves them as they are, and nothing below moves dub captions.
    let voiceShift: number | undefined;
    const ownTimed = !heard && !found.speechOnly && !lineTimed && ownTrack();
    if (ownTimed) {
      count("sync.ownTrack");
      console.log(`sync: ${filename}: dub captions fit the file's own subtitle track at one shift in ${measuredWindows.length} windows: its timing stands, not moved onto the voices`);
    } else if (!heard && !found.speechOnly && !lineTimed) {
      const voiced = byVoices(planned);
      if (voiced.by) {
        const plan = planned;
        planned = voiced.shift;
        // Each anchor as served: its window's lines (in caption time) moved with their stretch.
        anchors = anchors.map((a) => ({ ...a, offset: a.offset + (voiced.shift(a.from - a.offset) - plan(a.from - a.offset)) }));
        const moves = voiced.by.moves.map((m) => m.by).sort((a, b) => a - b);
        voiceShift = moves[moves.length >> 1];
        count("sync.byVoices");
        const ms = (by: number) => `${by >= 0 ? "+" : ""}${by} ms`;
        console.log(`sync: ${filename}: dub captions moved onto the English voices, ${voiced.by.moves.map((m) => `${ms(m.by)}${m.own ? "" : " (as the file)"}`).join(", ")} (${voiced.by.windows} windows agree, score ${voiced.by.score}, margin ${voiced.by.margin})`);
      }
    }
    // Lines in the windows read then move onto the file's own line starts (snapping): translations
    // only, and timing heard in speech only once the file's lines confirm it (followed).
    const snapping = Boolean(lang) && !found.speechOnly && !lineTimed && (!heard || Boolean(followed));
    const snapped = (shift: (start: number) => number) => {
      const nudges = snapping ? lineNudges(captions, shift, fileLines) : new Map<number, number>();
      return { nudges, shift: nudges.size ? (start: number) => shift(start) + (nudges.get(start) ?? 0) : shift };
    };
    const asShifted = snapped(planned);
    // The per-line steps for a translation, in order, each from where the one before left the lines,
    // so no line is moved twice in conflicting directions:
    // 1. the shift per stretch (followShifts, or byStarts' own plan), held in order by inOrder;
    // 2. on a file timed from its index, a line whose pairing by rhythm agrees with the pairs around
    //    it moves onto its own line (linesOverShift). Its residuals are measured from the shift of
    //    step 1, the closest there is, so fewer lines need moving and a pairing a line off stands
    //    out. Never timing heard in speech, which no shift on the track vouches for;
    // 3. snapping, on top of 1 and 2: a line moved onto its own line already starts there, so it
    //    isn't snapped again, and it keeps the others from snapping onto its line;
    // 4. keptInOrder, against the timing of 1 and 3: moved lines stay, the others give way.
    const moved =
      snapping && !heard && !found.image && found.source === "index"
        ? linesOverShift(captions, found.windows.filter((w) => !w.heard && !w.bridge).flatMap((w) => w.cues), planned)?.moves
        : undefined;
    const timed = moved?.size ? snapped((start) => moved.get(start) ?? planned(start)) : asShifted;
    // Many lines a pairing confirms were already there by snapping: only the others count as moved.
    const movedLines = moved ? [...moved].filter(([start, shift]) => shift !== asShifted.shift(start)).length : 0;
    if (movedLines) count("sync.linesMoved", movedLines);
    if (timed.nudges.size) count("sync.snapped", timed.nudges.size);
    // Timing that moves line by line keeps the lines in order and apart (see keptInOrder): byLines
    // against the lines as written (each of its lines sits where the pairing puts it, in order), the
    // moves above against the shift with snapping they started from.
    const perLine = lineTimed
      ? keptInOrder(captions, planned, new Set(lineTimed.keys()), () => 0)
      : moved?.size
        ? keptInOrder(captions, timed.shift, new Set(moved.keys()), asShifted.shift)
        : undefined;
    const out = path.join(cachePath("synced"), `${key}${ext}`);
    // Whole or not at all: a result synced again (voicesPending) replaces one a download may be reading.
    await writeWhole(out, perLine ? retime(text, ext, perLine.shift, factor, perLine.end) : retime(text, ext, timed.shift, factor));
    const done = [...(movedLines ? [`${movedLines} lines moved onto their own line`] : []), ...(timed.nudges.size ? [`${timed.nudges.size} lines snapped to the file`] : [])];
    console.log(`sync: ${filename}: ${anchors.map((a) => `${Math.round(a.from / 1000)}s ${a.offset >= 0 ? "+" : ""}${a.offset}ms (${a.score})`).join(", ")}${done.length ? `; ${done.join(", ")}` : ""}`);
    const result: SyncResult = { file: out, anchors, filename, source: path.basename(source.file), ...(heard ? { bySpeech: true } : {}), ...(found.speechOnly ? { speechOnly: true } : {}), ...(lineTimed ? { byLines: true } : {}), ...(startTimed ? { byStarts: true } : {}), ...(factor !== 1 ? { factor } : {}), ...(voiceShift !== undefined ? { voiceShift } : {}) };
    // Dub captions the track timed on a file whose English audio is still to be heard: it is read in
    // the background, and these are synced again by it on the next request (see hearDubVoices).
    // Not for the file's own track (ownTimed): the voices wouldn't move it.
    if (!lang && !heard && !lineTimed && !ownTimed && voiceShift === undefined && voicesToHear(stored)) result.voicesPending = true;
    if (speechPending) result.speechPending = true;
    await writeWhole(meta, JSON.stringify(result));
    if (result.voicesPending) hearDubVoices(stored, aiostreamsUrl, videoId, type, filename);
    if (speechPending) hearMoreSpeech(stored, aiostreamsUrl, videoId, type, filename);
    return result;
  })().catch((error) => {
    readFailed(filename, error);
    return undefined;
  });
  syncJobs.set(key, job);
  // Only while it runs, so the list and the download share one sync. A finished one is on disk and
  // read from there next time; a failed one is tried again.
  void job.then(() => {
    firstPass.delete(key);
    if (syncJobs.get(key) === job) syncJobs.delete(key);
  });
  return job;
}
