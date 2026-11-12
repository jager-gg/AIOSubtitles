/**
 * A Matroska file with clusters, blocks and an index, written by the spec, for tests that read a
 * track's words out of a file (releases.test.ts, lists.test.ts).
 */
const bytes = (...parts: Array<Uint8Array | number[]>) => Uint8Array.from(parts.flatMap((p) => [...p]));
const idBytes = (id: number) => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
};
/** A size as an EBML number of `length` bytes. */
const sized = (n: number, length = 8) => {
  const out = Array.from({ length }, (_, i) => Math.floor(n / 256 ** (length - 1 - i)) % 256);
  out[0] |= 0x80 >> (length - 1);
  return out;
};
const el = (id: number, ...body: Array<Uint8Array | number[]>) => {
  const data = bytes(...body);
  return bytes(idBytes(id), sized(data.length), data);
};
const elSized = (id: number, length: number, ...body: Array<Uint8Array | number[]>) => {
  const data = bytes(...body);
  return bytes(idBytes(id), sized(data.length, length), data);
};
const uint = (id: number, v: number) => el(id, Array.from({ length: 4 }, (_, i) => Math.floor(v / 256 ** (3 - i)) % 256));
const str = (id: number, s: string) => el(id, [...Buffer.from(s)]);
const f64 = (id: number, v: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, [...b]);
};

export const ASS_HEADER = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 1920",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV",
  "Style: Default,Arial,60,&H00FFFFFF,0,0,2,10,10,40",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
].join("\r\n");

export interface Release {
  codec?: string;
  codecPrivate?: string;
  name?: string;
  /** The captions track's language ("eng" when not given). */
  language?: string;
  audio?: string[];
  lines: Array<{ start: number; duration: number; text: string }>;
  /** How the subtitle track's blocks are packed: ContentEncodings, and what packs one. */
  encoding?: { algo: number; settings?: Uint8Array; pack: (data: Buffer) => Uint8Array };
  /** Bytes the cluster's size takes (mkvmerge writes 8; others fewer). */
  clusterSizeBytes?: number;
  /** Leave CueRelativePosition out of the index, as old muxers did. */
  noRelative?: boolean;
}

/** A file whose captions track (number 9) has one line per cluster, each after 200 KB of video. */
export function release(o: Release): Buffer {
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), f64(0x4489, 1_440_000));
  const track = (n: number, type: number, codec: string, name: string, lang: string, ...extra: Uint8Array[]) =>
    el(0xae, uint(0xd7, n), uint(0x83, type), str(0x86, codec), str(0x22b59c, lang), str(0x536e, name), ...extra);
  const subExtra: Uint8Array[] = [];
  if (o.codecPrivate !== undefined) subExtra.push(el(0x63a2, [...Buffer.from(o.codecPrivate)]));
  if (o.encoding)
    subExtra.push(el(0x6d80, el(0x6240, el(0x5034, uint(0x4254, o.encoding.algo), ...(o.encoding.settings ? [el(0x4255, [...o.encoding.settings])] : [])))));
  const tracks = el(
    0x1654ae6b,
    track(1, 1, "V_MPEG4/ISO/AVC", "", "und"),
    ...(o.audio ?? ["eng"]).map((lang, i) => track(2 + i, 2, "A_AAC", "", lang)),
    track(9, 17, o.codec ?? "S_TEXT/ASS", o.name ?? "CC", o.language ?? "eng", ...subExtra),
    track(10, 17, "S_TEXT/ASS", "Signs", "eng")
  );
  const seekHead = (cuesAt: number) => el(0x114d9b74, el(0x4dbb, el(0x53ab, idBytes(0x1c53bb6b)), uint(0x53ac, cuesAt)));
  const front = (cuesAt: number) => bytes(seekHead(cuesAt), info, tracks);
  const video = el(0xa3, [0x81, 0, 0, 0x80], new Uint8Array(200_000));
  let offset = front(0).length;
  const clusters: Uint8Array[] = [];
  const points: Uint8Array[] = [];
  for (const line of o.lines) {
    const data = Buffer.from(line.text);
    const group = el(0xa0, el(0xa1, [0x89, 0, 0, 0x00], o.encoding ? o.encoding.pack(data) : data), uint(0x9b, line.duration));
    const stamp = uint(0xe7, line.start);
    const cluster = elSized(0x1f43b675, o.clusterSizeBytes ?? 8, stamp, video, group);
    const relative = stamp.length + video.length;
    points.push(el(0xbb, uint(0xb3, line.start), el(0xb7, uint(0xf7, 9), uint(0xf1, offset), ...(o.noRelative ? [] : [uint(0xf0, relative)]), uint(0xb2, line.duration))));
    clusters.push(cluster);
    offset += cluster.length;
  }
  const body = bytes(front(offset), ...clusters, el(0x1c53bb6b, ...points));
  return Buffer.from(bytes(el(0x1a45dfa3, str(0x4282, "matroska")), idBytes(0x18538067), sized(body.length), body));
}

export const ASS_LINES = [
  { start: 1000, duration: 2500, text: "0,0,Default,,0,0,0,,Hello, there. How are you?" },
  { start: 64000, duration: 1800, text: "1,0,Default,Lead,0,0,0,,{\\i1}Fine{\\i0}, thanks." },
  { start: 125500, duration: 3000, text: "2,0,Default,,0,0,0,,We leave at dawn,\\Nall of us." }
];
