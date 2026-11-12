/**
 * Made-up subtitle timing for the sync benchmark (test/benchmark.test.ts, npm run bench, see
 * docs/benchmark.md): an episode's dialogue as the file's own subtitle track times it, the ways a
 * subtitle for it can be off, and the file's readings as the sync finds them stored.
 *
 * Every subtitle line carries where it belongs in the file (`truth`), so a served file is scored
 * against the truth, not against the nearest line of the file's track: a line moved onto the wrong
 * line of the file counts as wrong. Everything is seeded, so a scenario is the same on every run.
 * Times are ms. Nothing here loads src/ (only its types), so the cache folder can be chosen first.
 */
import type { Cue, FileAnchors } from "../src/sync.js";

// ---------- chance, repeatable ----------

/** A seeded stand-in for Math.random (mulberry32): the same seed gives the same numbers. */
export function random(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (next: () => number, lo: number, hi: number) => lo + next() * (hi - lo);
/** Mostly near 0, now and then out to ±1 (three uniforms added: bell-shaped). */
const bell = (next: () => number) => (next() + next() + next() - 1.5) / 1.5;

// ---------- an episode ----------

export interface Episode {
  /** Runtime. */
  duration: number;
  /** Every spoken line, as the file's own subtitle track times it. */
  lines: Cue[];
  /** The stretches that hold dialogue, in order. */
  parts: Array<{ from: number; to: number }>;
  /** The opening song, when there is one: no dialogue on the track (a translation may subtitle its lyrics). */
  opening?: { from: number; to: number };
  /** The ending song over the credits, when there is an opening: no dialogue either. */
  ending?: { from: number; to: number };
  /**
   * The middle of each silent stretch between parts (before and after the opening, the ad breaks),
   * in order: where releases are cut differently.
   */
  cuts: number[];
}

export interface Shape {
  minutes: number;
  /** A cold open of a minute or two, then a 90 s opening song with no dialogue. */
  opening: boolean;
  /** Ad breaks: a few seconds of silence between parts. */
  breaks: number;
  /** Another episode of the same show: its runtime, opening and breaks are copied, the dialogue isn't. */
  like?: Episode;
}

/**
 * An episode's dialogue: lines of 0.8 to 4 s (mostly short), pauses of 0.15 to 6 s (mostly under a
 * second), now and then a scene change of 8 to 20 s with no dialogue. A cold open before the opening
 * song, parts between ad breaks, and credits over the ending song at the end.
 */
export function episode(seed: number, shape: Partial<Shape> = {}): Episode {
  const next = random(seed);
  const like = shape.like;
  const duration = like?.duration ?? (shape.minutes ?? 24) * 60000;
  const parts: Episode["parts"] = like ? like.parts : [];
  const cuts: number[] = like ? like.cuts : [];
  let opening = like?.opening;
  let ending = like?.ending;
  if (!like) {
    const credits = duration - Math.round(between(next, 80000, 100000));
    // Without an opening song (a film), dialogue starts after a minute of titles.
    let from = 60000;
    if (shape.opening ?? true) {
      const coldOpenEnd = Math.round(between(next, 55000, 110000));
      parts.push({ from: 4000, to: coldOpenEnd });
      opening = { from: coldOpenEnd + 3000, to: coldOpenEnd + 93000 };
      cuts.push(coldOpenEnd + 1500, opening.to + 1500);
      from = opening.to + 3000;
    }
    const breaks = shape.breaks ?? 2;
    const span = credits - from;
    let at = from;
    for (let k = 1; k <= breaks; k++) {
      const middle = Math.round(from + (span * k) / (breaks + 1) + between(next, -0.06, 0.06) * span);
      const half = Math.round(between(next, 2000, 4000));
      parts.push({ from: at, to: middle - half });
      cuts.push(middle);
      at = middle + half;
    }
    parts.push({ from: at, to: credits });
    if (opening) ending = { from: credits + 1500, to: duration - 3000 };
  }
  const lines = parts.flatMap((part) => talk(next, part.from, part.to));
  return { duration, lines, parts, ...(opening ? { opening } : {}), ...(ending ? { ending } : {}), cuts };
}

/** Dialogue in [from, to), as episode makes it. */
export function dialogue(seed: number, from: number, to: number): Cue[] {
  return talk(random(seed), from, to);
}

function talk(next: () => number, from: number, to: number): Cue[] {
  const lines: Cue[] = [];
  let t = from + Math.round(between(next, 500, 3000));
  for (;;) {
    const length = Math.round(800 + 3200 * next() ** 1.6);
    if (t + length > to) break;
    lines.push({ start: t, end: t + length });
    const r = next();
    const pause = r < 0.03 ? between(next, 8000, 20000) : r < 0.72 ? between(next, 150, 1000) : between(next, 1000, 6000);
    t += length + Math.round(pause);
  }
  return lines;
}

// ---------- subtitles for it ----------

/** A subtitle line: where it is written, and where it belongs in the file (NaN: nowhere, another episode's). */
export interface SubLine extends Cue {
  truth: number;
}

/** The file's own lines, as a subtitle timed to this very file has them. */
export function faithful(lines: Cue[]): SubLine[] {
  return lines.map((c) => ({ start: c.start, end: c.end, truth: c.start }));
}

/** Another episode's lines: nothing in this file is theirs. */
export function unrelated(lines: Cue[]): SubLine[] {
  return lines.map((c) => ({ start: c.start, end: c.end, truth: NaN }));
}

const moved = (l: SubLine, by: number): SubLine => ({ ...l, start: l.start + Math.round(by), end: l.end + Math.round(by) });

/** Every line `ms` late (negative: early), as a subtitle for another release of the same cut. */
export function shifted(sub: SubLine[], ms: number): SubLine[] {
  return sub.map((l) => moved(l, ms));
}

/** The stretch of the file a line belongs to, by its place in the file: 0 before cuts[0], k after cuts[k-1]. */
const stretchOf = (truth: number, cuts: number[]) => cuts.filter((c) => truth >= c).length;

/**
 * A subtitle for a release cut differently: each stretch between `cuts` (file times) has its own
 * shift, shifts[0] before the first cut. A recap, a bumper or a longer break in one release moves
 * everything after it.
 */
export function stepped(sub: SubLine[], cuts: number[], shifts: number[]): SubLine[] {
  return sub.map((l) => moved(l, shifts[Math.min(stretchOf(l.truth, cuts), shifts.length - 1)]));
}

/**
 * As stepped, and within each stretch the subtitle runs a touch slow: its shift grows by
 * `perMinute` ms a minute from the stretch's start, and is back to that stretch's shift at the next cut.
 */
export function creeping(sub: SubLine[], cuts: number[], shifts: number[], perMinute: number): SubLine[] {
  return sub.map((l) => {
    const k = Math.min(stretchOf(l.truth, cuts), shifts.length - 1);
    const from = k === 0 ? 0 : cuts[k - 1];
    return moved(l, shifts[k] + (perMinute * (l.truth - from)) / 60000);
  });
}

/**
 * The subtitle of a longer cut of the same episode: at each of `at` (file times, in silent stretches)
 * that cut has a scene the file doesn't, `scenes[k]` ms long, with dialogue of its own. Every line
 * after such a scene is written that much later, and the scene's own lines belong nowhere in the file.
 */
export function extendedCut(sub: SubLine[], at: number[], scenes: number[], seed: number): SubLine[] {
  const added = (t: number, strictly = false) => at.reduce((sum, a, k) => ((strictly ? t > a : t >= a) ? sum + scenes[k] : sum), 0);
  const own = sub.map((l) => moved(l, added(l.truth)));
  // A scene starts, in the subtitle's time, where its cut point lands after the scenes before it.
  const extra = at.flatMap((a, k) => {
    const from = a + added(a, true);
    return dialogue(seed + k, from + 500, from + scenes[k] - 500).map((c) => ({ ...c, truth: NaN }));
  });
  return [...own, ...extra].sort((x, y) => x.start - y.start);
}

/** 23.976 fps, the rate of web and Blu-ray releases. */
export const FILM = 24000 / 1001;

/**
 * A subtitle made for a release playing at another frame rate: its times multiplied by `factor` land
 * on the file `late` ms late. 25 / FILM is a European TV or DVD release on a web one (4.3% fast);
 * 24 / FILM a 24.000 fps one (1.4 s over 24 minutes).
 */
export function madeForRate(sub: SubLine[], factor: number, late = 0): SubLine[] {
  return sub.map((l) => ({ ...l, start: Math.round((l.start + late) / factor), end: Math.round((l.end + late) / factor) }));
}

/**
 * A translation timed by someone else: each line starts and ends a beat off the file's line (within
 * ±`jitter` ms, mostly well inside it, and one line in seven up to twice as far), a share of lines
 * merged with the next one and a share of long lines split in two. Applied to lines where written and
 * truth are still the same (before any shift), since merges and splits happen in the file's time.
 */
export function retimedByOthers(sub: SubLine[], seed: number, { jitter = 400, merge = 0.05, split = 0.05 } = {}): SubLine[] {
  const next = random(seed);
  const regrouped: SubLine[] = [];
  for (let i = 0; i < sub.length; i++) {
    const l = sub[i];
    const after = sub[i + 1];
    if (after && after.start - l.end < 800 && next() < merge) {
      regrouped.push({ start: l.start, end: after.end, truth: l.truth });
      i++;
    } else if (l.end - l.start >= 2500 && next() < split) {
      const at = Math.round(l.start + (l.end - l.start) * between(next, 0.45, 0.55));
      regrouped.push({ start: l.start, end: at - 40, truth: l.truth }, { start: at, end: l.end, truth: l.truth + (at - l.start) });
    } else regrouped.push({ ...l });
  }
  const off = () => Math.round((next() < 1 / 7 ? 2 : 1) * jitter * bell(next));
  return regrouped.map((l) => {
    const start = l.start + off();
    return { ...l, start, end: Math.max(start + 500, l.end + off()) };
  });
}

/**
 * A translation whose lines last otherwise than the file's, as some official ones do: a share of
 * lines is merged with the next one when the pause between them is short, and every line stays on
 * screen until just before the next one starts (at most `hold` ms past where it would end). Its lines
 * still start where the file's lines start. Applied before any shift, like retimedByOthers.
 */
export function runOn(sub: SubLine[], seed: number, { merge = 0.4, hold = 3000 } = {}): SubLine[] {
  const next = random(seed);
  const merged: SubLine[] = [];
  for (let i = 0; i < sub.length; i++) {
    const l = sub[i];
    const after = sub[i + 1];
    if (after && after.start - l.end < 1200 && next() < merge) {
      merged.push({ start: l.start, end: after.end, truth: l.truth });
      i++;
    } else merged.push({ ...l });
  }
  return merged.map((l, i) => {
    const following = merged[i + 1];
    const until = following ? following.start - 80 : l.end + hold;
    return { ...l, end: Math.max(l.end, Math.min(until, l.end + hold)) };
  });
}

/**
 * A subtitle timed by hand to another recording: the shift each line needs wanders smoothly
 * through the file between `low` and `high` ms (two slow waves, minutes long), each line also a
 * little off on its own and of its own length. No shift per stretch fits it; line by line does.
 */
export function handTimed(sub: SubLine[], seed: number, { low = -3000, high = 9000 } = {}): SubLine[] {
  const next = random(seed);
  const slow = between(next, 18, 30) * 60000;
  const fast = between(next, 5, 9) * 60000;
  const p1 = next() * 2 * Math.PI;
  const p2 = next() * 2 * Math.PI;
  const middle = (low + high) / 2;
  const reach = (high - low) / 2;
  const need = (t: number) => middle + reach * (0.65 * Math.sin((2 * Math.PI * t) / slow + p1) + 0.35 * Math.sin((2 * Math.PI * t) / fast + p2));
  return sub.map((l) => {
    const start = Math.round(l.start - need(l.truth) + 100 * bell(next));
    const length = Math.max(400, l.end - l.start + Math.round(250 * bell(next)));
    return { ...l, start, end: start + length };
  });
}

/**
 * English dub captions for the episode: the dub follows the same scenes, but its lines are its own.
 * Each stretch of talk (lines less than 1.5 s apart) starts a little off the original's
 * (-0.25 to +0.35 s) and ends up to 0.6 s either way, and is cut into lines of its own lengths that
 * run nearly into each other. The truth is the dub's own timing: overall it sits where the original does.
 */
export function dubCaptions(ep: Episode, seed: number): SubLine[] {
  const next = random(seed);
  const blocks: Cue[] = [];
  for (const line of ep.lines) {
    const last = blocks[blocks.length - 1];
    if (last && line.start - last.end < 1500) last.end = Math.max(last.end, line.end);
    else blocks.push({ ...line });
  }
  const out: SubLine[] = [];
  for (const block of blocks) {
    const from = block.start + Math.round(between(next, -250, 350));
    const to = Math.max(from + 900, block.end + Math.round(between(next, -600, 600)));
    let t = from;
    while (t < to) {
      let end = Math.min(to, t + Math.round(1000 + 3500 * next() ** 1.4));
      if (to - end < 800) end = to; // no scrap of a line at the end
      out.push({ start: t, end, truth: t });
      t = end + Math.round(between(next, 80, 500));
    }
  }
  return out;
}

/**
 * An English dub of the episode as it comes from a dub caption upload: where the dub's voices speak,
 * and its captions. The dub plays the same scenes: each stretch of the original's talk (its lines
 * less than 1.5 s apart) is spoken in English starting `lag` ms after the original line shows, give
 * or take 0.25 s, and ending as much later, give or take 0.6 s. 240 ms is where the original's own
 * voice starts (see heard): a dub spoken later or earlier than that is what a track timed to the
 * original audio gets wrong. Within a stretch the sentences are the dub's
 * own: 0.8 to 4.5 s, with pauses of 0.15 to 0.7 s. Each caption starts 0.02 to 0.26 s before its
 * sentence is spoken, runs nearly into the next one, and a long sentence is now and then split over
 * two captions (the second starting mid-sentence). The upload is right by the dub's voices: each
 * caption belongs where it is written (truth = start), and the voices are what a detector hears.
 */
export function dubbed(ep: Episode, seed: number, { lag = 240 } = {}): { voices: Cue[]; captions: SubLine[] } {
  const next = random(seed);
  const blocks: Cue[] = [];
  for (const line of ep.lines) {
    const last = blocks[blocks.length - 1];
    if (last && line.start - last.end < 1500) last.end = Math.max(last.end, line.end);
    else blocks.push({ ...line });
  }
  const voices: Cue[] = [];
  const starts: Array<{ start: number; voiceEnd: number }> = [];
  for (const block of blocks) {
    const from = block.start + lag + Math.round(250 * bell(next));
    const to = Math.max(from + 900, block.end - 250 + (lag - 240) + Math.round(600 * bell(next)));
    let t = Math.max(from, (voices[voices.length - 1]?.end ?? -Infinity) + 400);
    while (t < to) {
      let end = Math.min(to, t + Math.round(800 + 3700 * next() ** 1.4));
      if (to - end < 700) end = to;
      voices.push({ start: t, end });
      const lead = Math.round(between(next, 20, 260));
      if (end - t > 3500 && next() < 0.5) {
        const at = Math.round(t + (end - t) * between(next, 0.4, 0.6));
        starts.push({ start: t - lead, voiceEnd: at }, { start: at, voiceEnd: end });
      } else starts.push({ start: t - lead, voiceEnd: end });
      t = end + Math.round(between(next, 150, 700));
    }
  }
  const captions = starts.map((s, i) => {
    const after = starts[i + 1]?.start ?? Infinity;
    const end = Math.min(s.voiceEnd + Math.round(between(next, 100, 400)), after - Math.round(between(next, 80, 200)));
    return { start: s.start, end: Math.max(s.start + 400, end), truth: s.start };
  });
  return { voices, captions };
}

/**
 * Where a voice detector hears these voices: each a moment late (0 to 60 ms) and ending a little
 * off; one in twenty drowned by music, now and then a noise in a pause; spans closer than 0.3 s
 * join, and ones under 0.25 s or over 12 s are dropped, as Silero's are (SPEECH_SHAPE in src/vad.ts).
 * Unlike heard, the voices are given, not guessed from subtitle lines.
 */
export function heardVoices(voices: Cue[], seed: number): Cue[] {
  const next = random(seed);
  const spans: Cue[] = [];
  for (const voice of voices) {
    if (next() < 0.05) continue;
    const start = voice.start + Math.round(between(next, 0, 60));
    const end = Math.max(start + 250, voice.end + Math.round(between(next, -150, 100)));
    spans.push({ start, end });
    if (next() < 0.03) {
      const noise = end + Math.round(between(next, 400, 1200));
      spans.push({ start: noise, end: noise + Math.round(between(next, 300, 800)) });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const joined: Cue[] = [];
  for (const s of spans) {
    const last = joined[joined.length - 1];
    if (last && s.start - last.end <= 300) last.end = Math.max(last.end, s.end);
    else joined.push({ ...s });
  }
  return joined.filter((s) => s.end - s.start >= 250 && s.end - s.start <= 12000);
}

/**
 * The lyrics of the opening and ending songs: a line every 4 to 6 s through each. The same song
 * (the same seed) has the same lines in every episode, at the same place when the episode is `like` another.
 */
export function songLyrics(ep: Episode, seed: number): Cue[] {
  const next = random(seed);
  const out: Cue[] = [];
  for (const song of [ep.opening, ep.ending]) {
    if (!song) continue;
    for (let t = song.from + 2000; t < song.to - 4000; t += Math.round(between(next, 4000, 6000))) out.push({ start: t, end: t + Math.round(between(next, 2500, 3800)) });
  }
  return out;
}

/**
 * Lines the file's track lacks: the songs' lyrics (songLyrics) and `signs` short signs and captions
 * dropped in pauses through the episode. They belong where they are written; nothing in the file's
 * track marks them.
 */
export function withExtras(sub: SubLine[], ep: Episode, seed: number, signs = 12): SubLine[] {
  const next = random(seed);
  const extra: SubLine[] = faithful(songLyrics(ep, seed + 1));
  const gaps = ep.lines.slice(1).flatMap((l, i) => (l.start - ep.lines[i].end > 2500 ? [{ from: ep.lines[i].end, to: l.start }] : []));
  for (let k = 0; k < signs && gaps.length; k++) {
    const gap = gaps[Math.floor(next() * gaps.length)];
    const t = Math.round(gap.from + 300 + next() * (gap.to - gap.from - 2000));
    extra.push({ start: t, end: t + Math.round(between(next, 1200, 1800)), truth: t });
  }
  return [...sub, ...extra].sort((a, b) => a.truth - b.truth);
}

/** The subtitle without a share of its lines (left untranslated, or folded into others). */
export function without(sub: SubLine[], seed: number, share: number): SubLine[] {
  const next = random(seed);
  return sub.filter(() => next() >= share);
}

// ---------- the file, as the sync finds it stored ----------

/** Where a file without an index is read, and how long (WINDOW_SPOTS and WINDOW_MS in src/sync.ts). */
export const SPOTS = [0.15, 0.32, 0.5, 0.68, 0.85];
export const WINDOW_LENGTH = 40000;
/** Index lines come in windows of a minute (INDEX_WINDOW_MS in src/sync.ts). */
const INDEX_WINDOW = 60000;

/**
 * How long after a dub caption shows its voice is heard: dub caption uploads lead the English voices
 * by about 0.12 to 0.23 s, English subtitle tracks lead English voices by 0.04 to 0.12 s (measured on
 * the stored plays; VOICE_LEAD_MS in src/sync.ts). A translation's line leads its voice by more
 * (heard's default, 0.08 to 0.4 s).
 */
export const DUB_VOICE_AFTER_MS: readonly [number, number] = [0, 240];

/**
 * Where a voice detector hears speech while these lines are spoken: the voice starts 0.08 to 0.4 s
 * after its line shows (`after`, for a dub caption DUB_VOICE_AFTER_MS) and stops up to 0.5 s before
 * it goes; one line in twenty is drowned by music, and now and then a noise is heard in a pause.
 * Spans closer than 0.3 s join, as Silero's do (SPEECH_SHAPE in src/vad.ts), and ones under 0.25 s
 * or over 12 s are dropped.
 */
export function heard(lines: Cue[], seed: number, after: readonly [number, number] = [80, 400]): Cue[] {
  const next = random(seed);
  const spans: Cue[] = [];
  for (const line of lines) {
    if (next() < 0.05) continue;
    const start = line.start + Math.round(between(next, after[0], after[1]));
    const end = Math.max(start + 300, line.end - Math.round(between(next, 0, 500)));
    spans.push({ start, end });
    if (next() < 0.03) {
      const noise = end + Math.round(between(next, 400, 1200));
      spans.push({ start: noise, end: noise + Math.round(between(next, 300, 800)) });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const joined: Cue[] = [];
  for (const s of spans) {
    const last = joined[joined.length - 1];
    if (last && s.start - last.end <= 300) last.end = Math.max(last.end, s.end);
    else joined.push({ ...s });
  }
  return joined.filter((s) => s.end - s.start >= 250 && s.end - s.start <= 12000);
}

/** The heard windows a file timed by its index gets once its audio is read (addSpeech in src/sync.ts). */
function heardWindows(duration: number, speech: Cue[]): FileAnchors["windows"] {
  return SPOTS.map((spot) => {
    const from = Math.round(duration * spot);
    const to = from + WINDOW_LENGTH;
    return { from, to, cues: [], speech: speech.filter((c) => c.start >= from && c.end <= to), heard: true };
  });
}

/**
 * A Matroska file timed from its index: every line of each text track, in windows of a minute end
 * to end, nothing more to read. tracks[0] is the track ranked first; the rest are read beside it.
 * With `speech`, its audio has been heard too, as the sync does once the tracks fit nothing.
 */
export function indexFile(duration: number, tracks: Cue[][], speech?: Cue[]): FileAnchors {
  const [first, ...rest] = tracks;
  const others = rest.map((_, i) => 3 + i);
  const windows: FileAnchors["windows"] = [];
  for (let from = 0; from < duration; from += INDEX_WINDOW) {
    const to = Math.min(duration, from + INDEX_WINDOW);
    const inside = (cues: Cue[]) => cues.filter((c) => c.start >= from && c.start < to);
    windows.push({ from, to, cues: inside(first), ...(rest.length ? { others: Object.fromEntries(rest.map((t, i) => [String(others[i]), inside(t)])) } : {}) });
  }
  return {
    duration,
    windows: speech ? [...windows, ...heardWindows(duration, speech)].sort((a, b) => a.from - b.from) : windows,
    track: 2,
    source: "index",
    rounds: 2,
    ...(others.length ? { others } : {}),
    ...(speech ? { audio: 1, speechBy: "silero" as const } : {}),
    subtitleLangs: []
  };
}

/**
 * A file without an index, read the usual way: its track's lines in five 40 s windows (a line counts
 * when it lies wholly inside), with the speech heard in the same reads. Only this first pass: the
 * extra reads a live sync makes are refused offline, as when the file's host refuses them.
 */
export function windowFile(duration: number, lines: Cue[], speech?: Cue[]): FileAnchors {
  const windows = SPOTS.map((spot) => {
    const from = Math.round(duration * spot);
    const to = from + WINDOW_LENGTH;
    const inside = (cues: Cue[]) => cues.filter((c) => c.start >= from && c.end <= to);
    return { from, to, cues: inside(lines), ...(speech ? { speech: inside(speech) } : {}) };
  });
  return { duration, windows, track: 2, ...(speech ? { audio: 1, speechBy: "silero" as const } : {}), subtitleLangs: [] };
}

/** Where more of a file with no subtitle track is heard when its first five windows don't say (MORE_SPOTS in src/sync.ts). */
export const MORE_SPOTS = [0.1, 0.24, 0.41, 0.59, 0.76];

/**
 * A file with no subtitle track: five windows of speech heard in its audio. With `more`, as the
 * next request finds it once the audio at MORE_SPOTS has been heard too: ten windows.
 */
export function speechOnlyFile(duration: number, speech: Cue[], { more = false } = {}): FileAnchors {
  const windows = [...SPOTS, ...(more ? MORE_SPOTS : [])].sort((a, b) => a - b).map((spot) => {
    const from = Math.round(duration * spot);
    const to = from + WINDOW_LENGTH;
    return { from, to, cues: speech.filter((c) => c.start >= from && c.end <= to) };
  });
  return { duration, windows, audio: 1, speechOnly: true, speechBy: "silero", ...(more ? { rounds: 1 } : {}), subtitleLangs: [] };
}

/**
 * Speech heard under loud music, as in a show scored wall to wall: only `share` of the voices are
 * heard at all (the rest drowned, or joined with the music into stretches too long to keep).
 */
export function drowned(speech: Cue[], seed: number, share: number): Cue[] {
  const next = random(seed);
  return speech.filter(() => next() < share);
}

/**
 * Speech heard where a song or a fight scene fills the windows at `spots` (fractions of `duration`,
 * WINDOW_LENGTH long): no voice is heard there, only a few short bursts of the music the detector
 * takes for speech. Elsewhere the speech stays as heard.
 */
export function musicAt(speech: Cue[], duration: number, spots: number[], seed: number): Cue[] {
  const next = random(seed);
  const out = speech.filter((c) => !spots.some((spot) => c.end > duration * spot && c.start < duration * spot + WINDOW_LENGTH));
  for (const spot of spots) {
    const from = Math.round(duration * spot);
    for (let k = 0; k < 4; k++) {
      const start = from + Math.round(between(next, 1000, WINDOW_LENGTH - 3000));
      out.push({ start, end: start + Math.round(between(next, 300, 1500)) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * A short track of signs and songs only (a couple a minute, of their own timing), the kind a file
 * ranks first when its tracks are labelled badly.
 */
export function signsTrack(duration: number, seed: number): Cue[] {
  const next = random(seed);
  const out: Cue[] = [];
  for (let t = 20000; t < duration - 60000; t += Math.round(between(next, 20000, 45000))) out.push({ start: t, end: t + Math.round(between(next, 1500, 4000)) });
  return out;
}

// ---------- the subtitle file ----------

const stamp = (ms: number) => {
  if (!(ms >= 0)) throw new Error(`a subtitle line written at ${ms} ms: the scenario moves it before the start`);
  const t = Math.round(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(t / 3600000))}:${two(Math.floor(t / 60000) % 60)}:${two(Math.floor(t / 1000) % 60)},${String(t % 1000).padStart(3, "0")}`;
};

/** The subtitle as an SRT file, its lines in the order given; line k reads "line k". */
export function srt(sub: SubLine[]): string {
  return sub
    .map((l, i) => `${i + 1}\n${stamp(l.start)} --> ${stamp(l.end)}\nline ${i + 1}\n`)
    .join("\n");
}

/** Start times of an SRT file's lines, in the order they're written in it (retiming keeps that order). */
export function srtStarts(text: string): number[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes("-->"))
    .map((line) => {
      const m = line.split("-->")[0].match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/);
      return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : NaN;
    });
}
