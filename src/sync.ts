/**
 * Syncing a subtitle to the file being played. A subtitle is usually timed to some other release;
 * this lines it up with the playing one. The file is found through the viewer's AIOStreams, and the
 * timing of its own subtitle lines is read (never their words): for a Matroska file from its index
 * (mkv.ts), about 1 MB for the whole file; otherwise ffmpeg reads a few short windows, seeking with
 * the file's index so only those are downloaded. The subtitle's shift is measured window by window,
 * so timing that steps mid-episode is followed. When the subtitle fits none of the file's tracks, or
 * the file has none, it is timed by where speech starts in the audio of a few windows (vad.ts).
 * Reads of the file are held back when its host refuses them or the day's limit is spent (reads.ts).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheKey, cachePath } from "./cache.js";
import { decodeSubtitle } from "./text.js";
import { count, noteError, scrub } from "./stats.js";
import { heardSpeech } from "./vad.js";
import { dialogueLines, pictureLines, readMkvTiming } from "./mkv.js";
import { checkReads, noteRead, noteReadOk, noteRefusal, ReadsPaused, refusalStatus } from "./reads.js";

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
 * RATE_FACTORS), then moved by delta(scaled start).
 */
export function retime(text: string, ext: string, delta: (start: number) => number, factor = 1): string {
  const scale = (ms: number) => Math.round(ms * factor);
  if (isAss(ext)) {
    return text.replace(/^(Dialogue:[^,]*,)(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2})/gm, (_all, head, a, b) => {
      const start = scale(assTime(a));
      const d = delta(start);
      return `${head}${formatAss(start + d)},${formatAss(scale(assTime(b)) + d)}`;
    });
  }
  return text.replace(/^.*-->.*$/gm, (line) => {
    const [a] = line.split("-->");
    const d = delta(scale(srtTime(a)));
    return line.replace(/(?:\d{1,2}:)?\d{2}:\d{2}([,.])\d{3}/g, (stamp, sep) => formatSrt(scale(srtTime(stamp)) + d, sep));
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
 * Node runs it on the one thread that also answers lists and downloads (Pit Lane 2025: 12 s
 * during which a download couldn't even be told to stop waiting).
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
  return fitsFile(m.measuredWindows) && m.anchors.length > 0 && landsOnTiming(m.measuredWindows, m.anchors);
}

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
  const starts = captions.map((c) => c.start).sort((a, b) => a - b);
  const steps = Math.round((2 * range) / LINE_STEP_MS) + 1;
  const matched = new Array<number>(steps).fill(0);
  let total = 0;
  for (const w of found.windows) {
    if (w.bridge || w.cues.length < 3) continue;
    for (const line of w.cues) {
      total++;
      // Every shift where a caption start lands within LINE_TOLERANCE_MS of this line's start.
      const lo = line.start - range - LINE_TOLERANCE_MS;
      const hi = line.start + range + LINE_TOLERANCE_MS;
      let k = 0;
      let a = 0;
      let b = starts.length;
      while (a < b) {
        const mid = (a + b) >> 1;
        if (starts[mid] < lo) a = mid + 1;
        else b = mid;
      }
      const hits = new Set<number>();
      for (k = a; k < starts.length && starts[k] <= hi; k++) {
        const shift = line.start - starts[k];
        const first = Math.max(0, Math.ceil((shift - LINE_TOLERANCE_MS + range) / LINE_STEP_MS));
        const last = Math.min(steps - 1, Math.floor((shift + LINE_TOLERANCE_MS + range) / LINE_STEP_MS));
        for (let i = first; i <= last; i++) hits.add(i);
      }
      for (const i of hits) matched[i]++;
    }
  }
  if (total === 0) return { score: 0, margin: 0 };
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
 * when one is shifted by seconds; where speech starts doesn't (The Analyst: speech started within
 * 0.1 s of 10 of 16 lines).
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
export function measureSpeechFile(windows: Array<{ from: number; to: number; speech: Cue[] }>, captions: Cue[], range = 20000):
  | { offset: number; score: number; margin: number; anchors: Anchor[] }
  | undefined {
  const curves = windows.flatMap((w) => {
    const curve = speechCurve(w.speech, captions, range);
    return curve ? [{ w, curve }] : [];
  });
  if (curves.length < SPEECH_MIN_ANCHORS) return undefined;
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
  return { offset: best.offset, score: Math.round(best.score * 100) / 100, margin: Math.round((best.score - rival) * 100) / 100, anchors };
}

const SPEECH_DRIFT_MS = 600;

export function measureWindow(embedded: Cue[], captions: Cue[], range = 20000): Measured | undefined {
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
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] <= 0 || scores[i] < (scores[i - 1] ?? 0) || scores[i] < (scores[i + 1] ?? 0)) continue;
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
 * on an episode whose shift changes four times (Night Patrol S01E06, Dutch:
 * -2.2, -4.5, -7.0, -9.6 and -12.1 s) that read minutes 13 to 25 at the first shift, 2.3 to 4.8 s
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
 * -1.16 s within one Iron Lantern episode). Differences under this are noise.
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

export function planShifts(anchors: Anchor[], captions: Cue[], reference: Cue[] = []): (start: number) => number {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  if (sorted.length === 0) return () => 0;
  const offsets = sorted.map((a) => a.offset);
  if (Math.max(...offsets) - Math.min(...offsets) <= AGREE_MS) {
    const median = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)];
    return () => median;
  }

  // Boundaries in caption time (the times as written in the caption file).
  const bounds: Array<{ at: number; offset: number }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (Math.abs(a.offset - b.offset) <= AGREE_MS) continue;
    bounds.push({ at: placeStep(a, b, captions, reference), offset: b.offset });
  }
  const first = sorted[0].offset;
  return (start) => {
    let offset = first;
    for (const bound of bounds) if (start >= bound.at) offset = bound.offset;
    return offset;
  };
}

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
  // Same name and same size first: two listed files can share a name.
  const pick = (same: (name: string) => boolean) => {
    const named = listed.filter((s) => same(s.behaviorHints!.filename!));
    return (named.find(sized) ?? named[0])?.url;
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
  return {
    duration: Number(json.format?.duration ?? 0) * 1000,
    ...(Number(json.format?.bit_rate) > 0 ? { bitrate: Number(json.format?.bit_rate) } : {}),
    track: track?.index,
    image,
    ...(others.length ? { others } : {}),
    audio: pickAudio(json.streams ?? []),
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
  /**
   * No subtitle track: the windows' cues are where people speak, heard in the audio. Otherwise the
   * windows also keep their speech beside the lines, to measure how well speech times a file.
   */
  speechOnly?: boolean;
  /** How many rounds of extra windows have been read (at most MAX_ROUNDS). */
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
function stillValid(found: FileAnchors): boolean {
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
 * (Room Twelve S1E2: a dead usenet REMUX; Harbor S1E7: three NTb NZBs missing on
 * the providers, then a TorBox file played while the player still named the first). AIOStreams drops
 * a failed NZB from later lists, and which file failover played is known only to it, so lists show
 * these tracks unsynced: timing from the named file would be wrong for the one playing. The list is
 * asked for a few times first (see lookUpStreamAgain); after that the lookup isn't repeated for
 * UNLISTED_MS.
 */
const unlisted = new Map<string, number>();
const UNLISTED_MS = 10 * 60 * 1000;
/** A search through every indexer can take a while the first time (Harbor S1E8 ran past 20 s); nothing waits on it but the sync. */
const STREAM_LOOKUP_TIMEOUT_MS = 45 * 1000;
/** One lookup per file at a time: the header read and the windows share it, so indexers are searched once. */
const lookups = new Map<string, Promise<string | undefined>>();

/** The playing file's stream URL from AIOStreams, by its name (see unlisted for when it isn't there). */
export function lookUpStream(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<string | undefined> {
  return streamUrl(aiostreamsUrl, videoId, type, filename);
}

/**
 * As lookUpStream, asking again when the file isn't listed. AIOStreams' list for one title differs
 * from one request to the next (a slow source misses one answer and is in the next): Pit Lane 2025,
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

async function resolvePlayback(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<string> {
  const known = playbackUrls.get(filename);
  if (known && Date.now() - known.at < PLAYBACK_KEPT_MS) {
    checkReads(known.url);
    return known.url;
  }
  checkReads();
  if (notListed(filename)) throw new Error(`no stream in AIOStreams named ${filename} (seen a moment ago)`);
  let lookup = lookups.get(filename);
  if (!lookup) {
    lookup = lookUpStreamAgain(aiostreamsUrl, videoId, type, filename).finally(() => lookups.delete(filename));
    lookups.set(filename, lookup);
  }
  const playback = await lookup;
  if (!playback) {
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
 * Languages the playing file already has full text subtitles in, from earlier reads of it or a header
 * read that has finished (fileHasSubtitles starts one on a first play). Undefined when not known yet.
 */
export async function embeddedLanguages(filename: string): Promise<string[] | undefined> {
  try {
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (Array.isArray(found.subtitleLangs)) return found.subtitleLangs;
  } catch {}
  const job = probeJobs.get(filename);
  if (!job) return undefined;
  // Only a header read that's already done: never wait here.
  const probed = await Promise.race([job, Promise.resolve(undefined)]);
  return probed?.languages;
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
async function indexAnchors(url: string, filename: string, duration: number, audio: number | undefined, languages: string[], bitrate?: number): Promise<FileAnchors | undefined> {
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
    filename, duration: length, windows, track: first, audio, source: "index", rounds: MAX_ROUNDS, ...(bitrate ? { bitrate } : {}), ...(firstIsPicture ? { image: true } : {}),
    ...(rest.length ? { others: rest } : {}), subtitleLangs: languages
  };
}

/**
 * Speech for a file timed from its index, read only when the captions fit none of its tracks: the
 * audio at the usual spots, kept beside the index windows (marked heard, so nothing measures them as
 * lines). Undefined when the file has no audio to hear or it can't be read.
 */
function addSpeech(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<FileAnchors | undefined> {
  const jobKey = `${filename}#speech`;
  let job = extendJobs.get(jobKey);
  if (job) return job;
  job = (async () => {
    if (stored.audio === undefined || stored.speechBy === "silero" || !SPEECH_SYNC) return undefined;
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
    count("sync.windows", WINDOW_SPOTS.length);
    const span = windowMs(stored.bitrate);
    count("sync.videoSeconds", (WINDOW_SPOTS.length * span) / 1000);
    noteRead(windowBytes(stored.bitrate, WINDOW_SPOTS.length * span));
    const heard = await Promise.all(
      WINDOW_SPOTS.map(async (spot) => {
        const from = Math.round(stored.duration * spot);
        const speech = await readSpeechWindow(url, stored.audio as number, from, span).catch(() => [] as Cue[]);
        return { from, to: from + span, cues: [] as Cue[], speech, heard: true };
      })
    );
    const result: FileAnchors = { ...stored, windows: [...stored.windows, ...heard].sort((a, b) => a.from - b.from), speechBy: "silero" };
    await writeFile(anchorsFile(filename), JSON.stringify(result));
    console.log(`sync: ${filename}: read the audio at ${WINDOW_SPOTS.length} spots for speech`);
    return result;
  })().catch((error) => {
    readFailed(filename, error, "speech: ");
    return undefined;
  });
  keepJob(jobKey, job);
  return job;
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
      const { duration, track, image, audio, languages, others, bitrate } = probed;
      const span = windowMs(bitrate);
      if ((track === undefined && (audio === undefined || !SPEECH_SYNC)) || !duration) return { filename, duration, windows: [], speechChecked: true, subtitleLangs: languages } satisfies FileAnchors;
      // No subtitle track: speech in the audio stands in for the lines.
      const speechOnly = track === undefined;
      const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
      // A Matroska file's index holds every subtitle line's timing: the whole file's lines from a few
      // hundred KB, instead of reading windows of the video (see mkv.ts).
      if (!speechOnly) {
        const fromIndex = await indexAnchors(url, filename, duration, audio, languages, bitrate).catch((error) => {
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
      const result: FileAnchors = { filename, duration, windows, track, image, audio, ...(others?.length && !speechOnly ? { others } : {}), ...(speechOnly ? { speechOnly } : {}), ...(audio !== undefined ? { speechBy: "silero" as const } : {}), subtitleLangs: languages };
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
const MAX_ROUNDS = 2;
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
      found = { ...found, track: probed.track, image: probed.image, audio: probed.audio, ...(probed.others ? { others: probed.others } : {}) };
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

function measureAll(found: FileAnchors, captions: Cue[]) {
  const measuredWindows = found.windows.flatMap((w) => {
    if (w.bridge) return [];
    // An index minute with only a few lines (a cold open before the opening song) is too few to time
    // by; it takes its neighbours' timing (Iron Lantern 013: 3 lines, 0.5 s off against the voices).
    if (found.source === "index" && w.cues.length < INDEX_MIN_WINDOW_LINES) return [];
    const measured = measureWindow(w.cues, captions);
    return measured ? [{ from: w.from, to: w.to, measured }] : [];
  });
  const anchors = agreeAnchors(measuredWindows);
  return { measuredWindows, anchors: found.source === "index" ? dropSpikes(anchors) : anchors };
}

/**
 * On index windows, which follow each other minute by minute: a window whose shift is far from both
 * neighbours while they agree is a chance fit, not a cut (a cut changes every window after it). Seen on
 * Iron Lantern 013, OpenSubtitles English: +1.24 s, +5.76 s, +1.27 s at 2, 3 and 4 minutes.
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
/** Index windows with fewer lines aren't measured (minutes of dialogue held 8 to 27 on Iron Lantern). */
const INDEX_MIN_WINDOW_LINES = 6;

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
export function judge(stored: FileAnchors, captions: Cue[]): { verdict: "synced" | "wrong" | "rejected" | "unsynced"; anchors: Anchor[]; offsets: number[]; bySpeech?: boolean; factor?: number; track?: "first" | number } {
  if (stored.speechOnly) {
    const speech = bySpeech(stored, captions);
    return speech ? { verdict: "synced", anchors: speech.anchors, offsets: [], bySpeech: true } : { verdict: "unsynced", anchors: [], offsets: [] };
  }
  const track = trackChoice(stored, captions);
  const found = track === undefined ? noLines(stored) : track === "first" ? stored : trackView(stored, track);
  const asWritten = measureAll(found, captions);
  const rated = rescaled(found, captions, asWritten);
  if (rated) return { verdict: "synced", anchors: rated.anchors, offsets: rated.measuredWindows.map((w) => w.measured.offset), factor: rated.factor, track };
  const { measuredWindows, anchors } = asWritten;
  const offsets = measuredWindows.map((w) => w.measured.offset);
  const heard = () => {
    const speech = bySpeech(found, captions);
    return speech ? { verdict: "synced" as const, anchors: speech.anchors, offsets, bySpeech: true } : undefined;
  };
  if (!fitsFile(measuredWindows)) return heard() ?? { verdict: "wrong", anchors: [], offsets };
  if (anchors.length === 0) return heard() ?? { verdict: "unsynced", anchors, offsets };
  if (!landsOnTiming(measuredWindows, anchors)) return heard() ?? { verdict: "rejected", anchors: [], offsets };
  return { verdict: "synced", anchors, offsets, track };
}

/**
 * Timing from speech heard in the audio (Silero, English audio first, see pickAudio): for a file with
 * no subtitle track, and as the last resort when captions fit the track nowhere (dub captions follow
 * the English audio, not the translated track). All windows are matched at once (measureSpeechFile).
 * Over 8 recorded files it landed within 0.36 s on each against the file's own lines, and refused
 * another file's lines on all 8 (best margin 0.13).
 */
export function bySpeech(found: FileAnchors, captions: Cue[]): { anchors: Anchor[]; reference: Cue[]; score: number; margin: number } | undefined {
  if (found.speechBy !== "silero") return undefined;
  const heard = found.windows
    .filter((w) => !w.bridge)
    .map((w) => ({ from: w.from, to: w.to, speech: (found.speechOnly ? w.cues : w.speech) ?? [] }))
    .filter((w) => w.speech.length >= 3);
  if (heard.length < SPEECH_MIN_ANCHORS) return undefined;
  const fit = measureSpeechFile(heard, captions);
  if (!fit || fit.anchors.length < SPEECH_MIN_ANCHORS || fit.score < SPEECH_MIN_SCORE || fit.margin < SPEECH_MIN_MARGIN) return undefined;
  // Lines show a little before the voice starts: a line start met at the voice is that much late.
  const anchors = fit.anchors.map((a) => ({ ...a, offset: a.offset - SPEECH_LEAD_MS }));
  return { anchors, reference: heard.flatMap((w) => w.speech), score: fit.score, margin: fit.margin };
}

const SPEECH_MIN_ANCHORS = 3;
/** Over the recorded files: own lines scored 0.38 to 0.69, margins 0.14 to 0.42; another file's lines at most 0.40 and 0.13. */
const SPEECH_MIN_SCORE = 0.35;
const SPEECH_MIN_MARGIN = 0.15;
/** Median of where the files' own lines landed against speech (20 to 360 ms). */
const SPEECH_LEAD_MS = 200;

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
  /** The captions were made for another frame rate: their times were multiplied by this (RATE_FACTORS). */
  factor?: number;
}

const syncJobs = new Map<string, Promise<SyncResult | undefined>>();
/** First-pass timing of syncs still reading more of the file (see syncCaptions). */
const firstPass = new Map<string, SyncResult>();

/** The timing from the first windows of a sync that is still refining, if it got that far. */
export function firstPassSync(key: string): SyncResult | undefined {
  return firstPass.get(key);
}

/** Bumped when the sync method changes: older results are ignored and download URLs change, so no cache keeps old timing. */
export const SYNC_VERSION = 9;

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
 * than AGREE_MS, for timing that drifts a little (The Analyst S3E8 English: 0.98 s read where the
 * final timing is 0.32 s); a coincidental fit sits seconds away (misfiled Dr. Ember: 2.6 to 18 s).
 */
const LAND_MS = 1000;

export function fitsFile(windows: Array<{ measured: Measured }>): boolean {
  if (windows.length < 3) return true;
  const supported = windows.filter((w, i) => windows.some((o, j) => j !== i && Math.abs(o.measured.offset - w.measured.offset) <= AGREE_MS)).length;
  if (supported * 2 >= windows.length) return true;
  // Timing that drifts a little across the file spreads past AGREE_MS (seen: -0.1, 0.2 and 1.0 s on
  // The Analyst, refined to 0.0-0.4 s). Three windows within BAND_MS of each other still fit:
  // another episode's captions scatter over the whole ±20 s. landsOnTiming checks again afterwards.
  const sorted = windows.map((w) => w.measured.offset).sort((a, b) => a - b);
  return sorted.some((offset, i) => i + 2 < sorted.length && sorted[i + 2] - offset <= BAND_MS);
}

/** How far apart three windows' readings may be and still count as one timing that drifts. */
const BAND_MS = 1500;

export function syncKey(ref: string | number, season: number | undefined, episode: number | undefined, filename: string): string {
  // SubSource ids keep their earlier keys, so their synced results stay valid.
  const subtitleId = typeof ref === "number" ? ref : /^ssd+$/.test(ref) ? Number(ref.slice(2)) : ref;
  return cacheKey({ kind: "synced", subtitleId, season, episode, filename, version: SYNC_VERSION });
}

/**
 * What's already known about syncing this subtitle to this file, read from
 * earlier results only (nothing is fetched): "unsynced" when the file has no
 * embedded subtitles to sync to, or this subtitle matched none of them.
 */
export async function knownSync(key: string, filename: string): Promise<"synced" | "speech" | "unsynced" | "wrong" | "unknown"> {
  try {
    const done = JSON.parse(await readFile(path.join(cachePath("synced"), `${key}.json`), "utf8")) as SyncResult;
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
      if (existsSync(done.file)) return done;
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
    // rounds below (they can take another 10 to 20 s). Kept in memory only.
    if (anchors.length > 0 && (found.rounds ?? 0) < MAX_ROUNDS) {
      const first = path.join(cachePath("synced"), `${key}.first${ext}`);
      await mkdir(cachePath("synced"), { recursive: true });
      await writeFile(first, retime(text, ext, planShifts(anchors, captions, found.windows.flatMap((w) => w.cues)), factor));
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
    // from second-best fits (seen: a misfiled Dr. Ember Arabic, 1 of 8 windows) is a coincidence:
    // left unsynced, so a fallback gets its turn. Every real sync so far had 5/5 to 9/10.
    if (anchors.length > 0 && !landsOnTiming(measuredWindows, anchors)) {
      console.log(`sync: ${filename}: timing rests on second-best fits, not counted as synced`);
      count("sync.noFit");
      noFit = true;
      anchors = [];
    }
    // Nothing fits the subtitle track: speech in the audio, as a last resort.
    let reference = found.windows.flatMap((w) => w.cues);
    let heard = false;
    // A file timed from its index has no audio read yet: it's heard now, the last resort's turn.
    if (anchors.length === 0 && stored.source === "index" && stored.audio !== undefined && stored.speechBy !== "silero") {
      const withSpeech = await addSpeech(stored, aiostreamsUrl, videoId, type, filename);
      if (withSpeech) {
        stored = withSpeech;
        found = viewOf(stored);
      }
    }
    if (anchors.length === 0) {
      const speech = bySpeech(found, captions);
      if (speech) {
        ({ anchors, reference } = speech);
        heard = true;
        noFit = false;
        count("sync.bySpeech");
        console.log(`sync: ${filename}: ${found.speechOnly ? "no subtitle track" : "no fit to the subtitle track"}; timed by speech in the audio (score ${speech.score}, margin ${speech.margin})`);
      } else if (found.speechOnly) console.log(`sync: ${filename}: speech in the audio doesn't time these captions clearly enough, left as they are`);
    }
    count(anchors.length ? "sync.synced" : "sync.unsynced");
    if (anchors.length === 0) {
      if (!noFit) console.log(`sync: ${filename}: no anchor matched, captions left as they are`);
      const result: SyncResult = { file: source.file, anchors, ...(noFit ? { noFit } : {}), filename, source: path.basename(source.file) };
      await writeFile(meta, JSON.stringify(result));
      return result;
    }
    const shiftFor = planShifts(anchors, captions, reference);
    // Lines in the windows read move onto the file's own line starts: other languages only (lang is
    // unset for dub captions and English CC, which follow the dub), and never timing heard in speech.
    const nudges = lang && !heard && !found.speechOnly ? lineNudges(captions, shiftFor, found.windows.flatMap((w) => w.cues)) : new Map<number, number>();
    if (nudges.size) count("sync.snapped", nudges.size);
    const out = path.join(cachePath("synced"), `${key}${ext}`);
    await writeFile(out, retime(text, ext, nudges.size ? (start) => shiftFor(start) + (nudges.get(start) ?? 0) : shiftFor, factor));
    console.log(`sync: ${filename}: ${anchors.map((a) => `${Math.round(a.from / 1000)}s ${a.offset >= 0 ? "+" : ""}${a.offset}ms (${a.score})`).join(", ")}${nudges.size ? `; ${nudges.size} lines snapped to the file` : ""}`);
    const result: SyncResult = { file: out, anchors, filename, source: path.basename(source.file), ...(heard ? { bySpeech: true } : {}), ...(found.speechOnly ? { speechOnly: true } : {}), ...(factor !== 1 ? { factor } : {}) };
    await writeFile(meta, JSON.stringify(result));
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
