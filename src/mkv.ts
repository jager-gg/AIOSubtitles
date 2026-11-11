/**
 * The timing of a Matroska file's subtitle tracks, from the file's seek index (Cues) alone.
 *
 * A .mkv holds its tracks interleaved in clusters, and near the end an index of where each moment
 * starts. mkvmerge, which makes most releases, gives every subtitle block its own index entry, with
 * its time and (since 2013) its duration. So every line's start and length, for every subtitle track,
 * is in the header and the index: a few hundred KB, where reading the lines themselves means reading
 * stretches of the video. The text isn't there, only the timing, which is all syncing needs.
 *
 * Only the format is used here (the Matroska and EBML specifications). Files without that index, or
 * whose index has no subtitle entries (other muxers, MP4), return undefined and are read the usual way.
 */
import { noteRead, noteReadOk, noteRefusal } from "./reads.js";

/** A subtitle track as the Tracks element describes it. */
export interface MkvTrack {
  /** Its TrackNumber, as index entries name it. */
  number: number;
  /** Its position among the file's tracks: ffmpeg's stream index. */
  index: number;
  type: "video" | "audio" | "subtitle" | "other";
  codec: string;
  language: string;
  name: string;
  forced: boolean;
  default: boolean;
}

export interface MkvTiming {
  /** Milliseconds. */
  duration: number;
  tracks: MkvTrack[];
  /** Each subtitle track's lines from the index, by TrackNumber: start and end in ms, sorted. */
  lines: Map<number, Array<{ start: number; end: number }>>;
  /** How many bytes were read for this. */
  bytesRead: number;
}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  FlagForced: 0x55aa,
  FlagDefault: 0x88,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueDuration: 0xb2,
  Cluster: 0x1f43b675
} as const;

/** The first part of a file, enough for its header (EBML, SeekHead, Info, Tracks). */
const HEAD_BYTES = 512 * 1024;
/** An index bigger than this isn't read (a long film's runs to a few MB). */
const MAX_CUES_BYTES = 24 * 1024 * 1024;
/** An index entry without a duration: lines run this long, or to the next line, whichever is sooner. */
const DEFAULT_LINE_MS = 2500;

/** A variable-length integer at pos: its value and length. IDs keep their marker bit; sizes don't. */
function vint(buf: Uint8Array, pos: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | undefined {
  const first = buf[pos];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > buf.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface Element {
  id: number;
  /** Where its data starts and ends, in buf. */
  start: number;
  end: number;
  /** The data runs past what was read (or its size is unknown). */
  cut: boolean;
}

/** The elements directly inside buf[from..to). */
function children(buf: Uint8Array, from: number, to: number): Element[] {
  const out: Element[] = [];
  let pos = from;
  while (pos < to) {
    const id = vint(buf, pos, true);
    if (!id) break;
    const size = vint(buf, pos + id.length, false);
    if (!size) break;
    const start = pos + id.length + size.length;
    const end = size.unknown ? to : start + size.value;
    out.push({ id: id.value, start, end: Math.min(end, to), cut: size.unknown || end > to });
    if (size.unknown) break;
    pos = end;
  }
  return out;
}

const uint = (buf: Uint8Array, e: Element) => {
  let v = 0;
  for (let i = e.start; i < e.end; i++) v = v * 256 + buf[i];
  return v;
};
const float = (buf: Uint8Array, e: Element) => {
  const view = new DataView(buf.buffer, buf.byteOffset + e.start, e.end - e.start);
  return e.end - e.start === 4 ? view.getFloat32(0) : e.end - e.start === 8 ? view.getFloat64(0) : NaN;
};
const text = (buf: Uint8Array, e: Element) => Buffer.from(buf.subarray(e.start, e.end)).toString("utf8").replace(/\0+$/, "");

const TRACK_TYPES: Record<number, MkvTrack["type"]> = { 1: "video", 2: "audio", 17: "subtitle" };

function parseTracks(buf: Uint8Array, tracks: Element): MkvTrack[] {
  return children(buf, tracks.start, tracks.end)
    .filter((e) => e.id === ID.TrackEntry)
    .map((entry, index) => {
      const track: MkvTrack = { number: 0, index, type: "other", codec: "", language: "eng", name: "", forced: false, default: true };
      let bcp47 = "";
      for (const f of children(buf, entry.start, entry.end)) {
        if (f.id === ID.TrackNumber) track.number = uint(buf, f);
        else if (f.id === ID.TrackType) track.type = TRACK_TYPES[uint(buf, f)] ?? "other";
        else if (f.id === ID.CodecID) track.codec = text(buf, f);
        else if (f.id === ID.Language) track.language = text(buf, f);
        else if (f.id === ID.LanguageBCP47) bcp47 = text(buf, f);
        else if (f.id === ID.Name) track.name = text(buf, f);
        else if (f.id === ID.FlagForced) track.forced = uint(buf, f) === 1;
        else if (f.id === ID.FlagDefault) track.default = uint(buf, f) === 1;
      }
      if (bcp47 && (track.language === "und" || track.language === "eng")) track.language = bcp47.split("-")[0];
      return track;
    });
}

/** Each subtitle track's lines from the Cues: CueTime is the line's start, CueDuration its length. */
export function parseIndex(buf: Uint8Array, scaleNs: number, subtitleTracks: Set<number>): Map<number, Array<{ start: number; end: number }>> {
  const toMs = (ticks: number) => (ticks * scaleNs) / 1e6;
  const raw = new Map<number, Array<{ start: number; duration?: number }>>();
  for (const point of children(buf, 0, buf.length)) {
    if (point.id !== ID.CuePoint) continue;
    let time: number | undefined;
    const positions: Array<{ track?: number; duration?: number }> = [];
    for (const f of children(buf, point.start, point.end)) {
      if (f.id === ID.CueTime) time = uint(buf, f);
      else if (f.id === ID.CueTrackPositions) {
        const pos: { track?: number; duration?: number } = {};
        for (const g of children(buf, f.start, f.end)) {
          if (g.id === ID.CueTrack) pos.track = uint(buf, g);
          else if (g.id === ID.CueDuration) pos.duration = uint(buf, g);
        }
        positions.push(pos);
      }
    }
    if (time === undefined) continue;
    for (const pos of positions) {
      if (pos.track === undefined || !subtitleTracks.has(pos.track)) continue;
      const list = raw.get(pos.track) ?? [];
      list.push({ start: toMs(time), ...(pos.duration !== undefined ? { duration: toMs(pos.duration) } : {}) });
      raw.set(pos.track, list);
    }
  }
  const lines = new Map<number, Array<{ start: number; end: number }>>();
  for (const [track, list] of raw) {
    list.sort((a, b) => a.start - b.start);
    lines.set(
      track,
      list.map((l, i) => {
        const next = list[i + 1]?.start ?? Infinity;
        const end = l.duration !== undefined ? l.start + l.duration : Math.min(l.start + DEFAULT_LINE_MS, next);
        return { start: Math.round(l.start), end: Math.round(end) };
      })
    );
  }
  return lines;
}

/**
 * The dialogue among a track's index lines. The index has timing but no text, so signs and karaoke
 * can't be told apart by style the way a read window's lines are. They give themselves away by shape:
 * karaoke and animated signs are runs of very short events stacked on each other (on one Blu-ray
 * episode, 2,478 of 2,841 entries, all in the opening and ending), dialogue lines are longer and stand
 * alone or beside one other line. Every dialogue line the window method read on that file passed this.
 */
export function dialogueLines(lines: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  return sorted.filter((line, i) => {
    if (line.end - line.start < MIN_DIALOGUE_MS) return false;
    let overlapping = 0;
    for (let j = i - 1; j >= 0 && j >= i - 50; j--) if (sorted[j].end > line.start) overlapping++;
    for (let j = i + 1; j < sorted.length && sorted[j].start < line.end; j++) overlapping++;
    return overlapping <= 1;
  });
}

const MIN_DIALOGUE_MS = 300;

/**
 * Lines of a picture track (PGS) from its index entries. Each line is two entries, one that shows it
 * and one that clears it, and the index gives neither a length nor which is which. A line that follows
 * another starts a moment (about 0.2 s) after the previous one was cleared: an entry within
 * CLEAR_GAP_MS of the one before is surely a show, and that one a clear. Between two sure labels,
 * shows and clears alternate; a stretch whose count doesn't fit (a line replaced without a clear) is
 * left out rather than guessed. Each show lasts until its clear. On an episode and a film
 * checked, this found every line the window method read (57 and 28), with their lengths
 * to the millisecond, and both synced within 0.08 s of the window method.
 */
export function pictureLines(entries: Array<{ start: number }>): Array<{ start: number; end: number }> {
  const t = entries.map((e) => e.start).sort((a, b) => a - b);
  const label: Array<"show" | "clear" | undefined> = new Array(t.length).fill(undefined);
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > CLEAR_GAP_MS) continue;
    label[i] = "show";
    label[i - 1] = "clear";
  }
  const sure = label.flatMap((l, i) => (l ? [i] : []));
  const other = (l: "show" | "clear") => (l === "show" ? "clear" : "show");
  for (let k = 0; k + 1 < sure.length; k++) {
    const a = sure[k];
    const b = sure[k + 1];
    if (b - a < 2) continue;
    const at = (i: number) => ((i - a) % 2 ? other(label[a]!) : label[a]!);
    if (at(b) !== label[b]) continue;
    for (let i = a + 1; i < b; i++) label[i] = at(i);
  }
  // Before the first sure label and after the last, they alternate outwards.
  if (sure.length) {
    const first = sure[0];
    const last = sure[sure.length - 1];
    for (let i = first - 1; i >= 0; i--) label[i] = (first - i) % 2 ? other(label[first]!) : label[first];
    for (let i = last + 1; i < t.length; i++) label[i] = (i - last) % 2 ? other(label[last]!) : label[last];
  }
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < t.length; i++) {
    if (label[i] !== "show" || label[i + 1] !== "clear") continue;
    const length = t[i + 1] - t[i];
    if (length >= MIN_DIALOGUE_MS && length <= MAX_PICTURE_MS) out.push({ start: t[i], end: t[i + 1] });
  }
  return out;
}

const CLEAR_GAP_MS = 300;
const MAX_PICTURE_MS = 10_000;

/** Reads bytes [from, from + length) of the file at url. */
async function range(url: string, from: number, length: number, timeoutMs: number): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=${from}-${from + length - 1}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 206 && !(response.status === 200 && from === 0)) {
    await response.body?.cancel();
    if (response.status === 403 || response.status === 429) noteRefusal(url, response.status);
    throw new Error(`range read refused (HTTP ${response.status})`);
  }
  noteReadOk(url);
  // A server that ignores Range sends the whole file: only the part asked for is kept.
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let got = 0;
  while (got < length) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
  }
  await reader.cancel().catch(() => {});
  noteRead(Math.min(got, length));
  const out = new Uint8Array(Math.min(got, length));
  let at = 0;
  for (const part of parts) {
    const take = Math.min(part.length, out.length - at);
    out.set(part.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return out;
}

/**
 * The subtitle tracks' timing of the Matroska file at url, from its header and index, or undefined
 * when the file isn't Matroska, has no index the header points to, or its index has no subtitle lines.
 */
export async function readMkvTiming(url: string, timeoutMs = 20000): Promise<MkvTiming | undefined> {
  const head = await range(url, 0, HEAD_BYTES, timeoutMs);
  let bytesRead = head.length;
  const top = children(head, 0, head.length);
  if (top[0]?.id !== ID.EBML) return undefined;
  const segment = top.find((e) => e.id === ID.Segment);
  if (!segment) return undefined;
  const level1 = children(head, segment.start, segment.end);
  let scaleNs = 1_000_000;
  let durationTicks = 0;
  let tracks: MkvTrack[] = [];
  let cuesAt: number | undefined;
  for (const e of level1) {
    if (e.id === ID.SeekHead && !e.cut) {
      for (const seek of children(head, e.start, e.end).filter((s) => s.id === ID.Seek)) {
        const f = children(head, seek.start, seek.end);
        const id = f.find((x) => x.id === ID.SeekID);
        const position = f.find((x) => x.id === ID.SeekPosition);
        if (id && position && uint(head, id) === ID.Cues && cuesAt === undefined) cuesAt = segment.start + uint(head, position);
      }
    } else if (e.id === ID.Info && !e.cut) {
      for (const f of children(head, e.start, e.end)) {
        if (f.id === ID.TimestampScale) scaleNs = uint(head, f);
        else if (f.id === ID.Duration) durationTicks = float(head, f);
      }
    } else if (e.id === ID.Tracks && !e.cut) tracks = parseTracks(head, e);
    else if (e.id === ID.Cluster) break;
  }
  const subtitles = new Set(tracks.filter((t) => t.type === "subtitle").map((t) => t.number));
  if (cuesAt === undefined || subtitles.size === 0) return undefined;

  // The index: its own header first (ID and size), then the whole of it.
  const peek = await range(url, cuesAt, 16, timeoutMs);
  bytesRead += peek.length;
  const id = vint(peek, 0, true);
  const size = id && vint(peek, id.length, false);
  if (!id || id.value !== ID.Cues || !size || size.unknown || size.value > MAX_CUES_BYTES) return undefined;
  const cues = await range(url, cuesAt + id.length + size.length, size.value, timeoutMs);
  bytesRead += cues.length;
  if (cues.length < size.value) return undefined;
  const lines = parseIndex(cues, scaleNs, subtitles);
  if (![...lines.values()].some((l) => l.length > 0)) return undefined;
  return { duration: Math.round((durationTicks * scaleNs) / 1e6), tracks, lines, bytesRead };
}
