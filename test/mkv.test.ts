import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dialogueLines, readMkvTiming } from "../src/mkv.js";
import { judge, type FileAnchors } from "../src/sync.js";

// ---------- a tiny Matroska file, written by the spec ----------
const bytes = (...parts: Array<Uint8Array | number[]>) => Uint8Array.from(parts.flatMap((p) => [...p]));
const idBytes = (id: number) => { const out: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return out; };
const size = (n: number) => [0x01, ...Array.from({ length: 7 }, (_, i) => Math.floor(n / 256 ** (6 - i)) % 256)]; // 8-byte size
const el = (id: number, ...body: Array<Uint8Array | number[]>) => { const data = bytes(...body); return bytes(idBytes(id), size(data.length), data); };
const uint = (id: number, v: number) => el(id, Array.from({ length: 4 }, (_, i) => Math.floor(v / 256 ** (3 - i)) % 256));
const str = (id: number, s: string) => el(id, [...Buffer.from(s)]);
const f64 = (id: number, v: number) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return el(id, [...b]); };

function mkv(lines: Array<{ track: number; start: number; duration?: number }>, withCues = true): Buffer {
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), f64(0x4489, 1_440_000));
  const track = (n: number, type: number, codec: string, name: string, lang = "eng") => el(0xae, uint(0xd7, n), uint(0x83, type), str(0x86, codec), str(0x22b59c, lang), str(0x536e, name));
  const tracks = el(0x1654ae6b, track(1, 1, "V_MPEG4/ISO/AVC", "video"), track(2, 2, "A_OPUS", "audio", "jpn"), track(3, 17, "S_TEXT/ASS", "Full Subtitles"), track(4, 17, "S_TEXT/ASS", "Signs and Songs"));
  const cues = el(0x1c53bb6b, ...lines.map((l) => el(0xbb, uint(0xb3, l.start), el(0xb7, uint(0xf7, l.track), uint(0xf1, 0), ...(l.duration ? [uint(0xb2, l.duration)] : [])))));
  const cluster = el(0x1f43b675, new Uint8Array(1_500_000));
  // SeekHead first, pointing at the Cues after the cluster (where mkvmerge puts them).
  const seekHeadFor = (cuesAt: number) => el(0x114d9b74, el(0x4dbb, el(0x53ab, idBytes(0x1c53bb6b)), uint(0x53ac, cuesAt)));
  const before = (cuesAt: number) => bytes(seekHeadFor(cuesAt), info, tracks, cluster);
  const cuesAt = before(0).length;
  const body = bytes(before(cuesAt), withCues ? cues : []);
  const ebml = el(0x1a45dfa3, str(0x4282, "matroska"));
  return Buffer.from(bytes(ebml, idBytes(0x18538067), size(body.length), body));
}

// ---------- a server that answers range requests, like a debrid host ----------
let server: Server;
let base = "";
const files = new Map<string, Buffer>();
beforeAll(async () => {
  server = createServer((req, res) => {
    const file = files.get(req.url ?? "");
    if (!file) return res.writeHead(404).end();
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    if (!m) return res.writeHead(200).end(file);
    const from = Number(m[1]);
    const to = Math.min(Number(m[2]), file.length - 1);
    res.writeHead(206, { "Content-Range": `bytes ${from}-${to}/${file.length}` }).end(file.subarray(from, to + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("subtitle timing from a Matroska index", () => {
  it("reads every line's start and length, per track, from the header and index alone", async () => {
    files.set("/a.mkv", mkv([{ track: 3, start: 1000, duration: 2000 }, { track: 1, start: 0 }, { track: 3, start: 5000, duration: 1500 }, { track: 4, start: 300000, duration: 4000 }]));
    const timing = await readMkvTiming(`${base}/a.mkv`);
    expect(timing?.duration).toBe(1_440_000);
    expect(timing?.tracks.filter((t) => t.type === "subtitle").map((t) => [t.number, t.index, t.name])).toEqual([[3, 2, "Full Subtitles"], [4, 3, "Signs and Songs"]]);
    expect(timing?.lines.get(3)).toEqual([{ start: 1000, end: 3000 }, { start: 5000, end: 6500 }]);
    expect(timing?.lines.get(4)).toEqual([{ start: 300000, end: 304000 }]);
    expect(timing?.lines.has(1)).toBe(false);
    // The 1.5 MB of video between the header and the index is never read.
    expect(timing!.bytesRead).toBeLessThan(files.get("/a.mkv")!.length - 900_000);
  });

  it("gives a line without a duration a short one, never running into the next", async () => {
    files.set("/b.mkv", mkv([{ track: 3, start: 1000 }, { track: 3, start: 2000 }, { track: 3, start: 9000 }]));
    expect((await readMkvTiming(`${base}/b.mkv`))?.lines.get(3)).toEqual([{ start: 1000, end: 2000 }, { start: 2000, end: 4500 }, { start: 9000, end: 11500 }]);
  });

  it("says nothing for files it can't use, so they're read the usual way", async () => {
    files.set("/c.mkv", mkv([], false));
    files.set("/d.mp4", Buffer.from("....ftypisom" + "x".repeat(2000)));
    expect(await readMkvTiming(`${base}/c.mkv`)).toBeUndefined();
    expect(await readMkvTiming(`${base}/d.mp4`)).toBeUndefined();
  });
});

describe("dialogue among the index lines", () => {
  it("drops karaoke and animated signs (short, stacked) and keeps lines, alone or beside one other", () => {
    const dialogue = [{ start: 60000, end: 62500 }, { start: 63000, end: 65000 }, { start: 64000, end: 66000 }];
    const karaoke = Array.from({ length: 40 }, (_, i) => ({ start: 1000 + i * 40, end: 1000 + i * 40 + 120 }));
    const stacked = Array.from({ length: 5 }, () => ({ start: 90000, end: 93000 }));
    expect(dialogueLines([...karaoke, ...dialogue, ...stacked])).toEqual(dialogue);
  });
});

describe("syncing on index windows", () => {
  /** Lines of uneven length and spacing, the way dialogue comes (deterministic). */
  const lines = (from: number, to: number, seed: number) => {
    const out: Array<{ start: number; end: number }> = [];
    let at = from;
    let n = seed;
    while (at < to) {
      n = (n * 1103515245 + 12345) % 2147483648;
      const length = 900 + (n % 2600);
      out.push({ start: at, end: at + length });
      at += length + 300 + ((n >> 8) % 2200);
    }
    return out;
  };
  const indexFile = (track: Array<{ start: number; end: number }>): FileAnchors => {
    const windows: FileAnchors["windows"] = [];
    for (let from = 0; from < 1_440_000; from += 60000) windows.push({ from, to: from + 60000, cues: track.filter((c) => c.start >= from && c.start < from + 60000) });
    return { duration: 1_440_000, windows, track: 2, source: "index", rounds: 2 };
  };
  const captions = lines(0, 1_400_000, 7);

  it("times captions over the whole file, steps included", () => {
    // +0.4 s, then +2.9 s from 11:14 (a break cut differently).
    const track = captions.map((c) => { const d = c.start < 674_000 ? 400 : 2900; return { start: c.start + d, end: c.end + d }; });
    const verdict = judge(indexFile(track), captions);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.anchors.length).toBeGreaterThan(15);
    expect(verdict.anchors.filter((a) => a.from < 600_000).every((a) => Math.abs(a.offset - 400) <= 60)).toBe(true);
    expect(verdict.anchors.filter((a) => a.from > 720_000).every((a) => Math.abs(a.offset - 2900) <= 60)).toBe(true);
  });

  it("still refuses another episode's captions", () => {
    expect(judge(indexFile(lines(0, 1_400_000, 4242)), captions).verdict).not.toBe("synced");
  });
});

describe("one-minute spikes on index windows", () => {
  it("drops a window far from both agreeing neighbours, keeps a real cut", async () => {
    const { dropSpikes } = await import("../src/sync.js");
    const a = (minute: number, offset: number) => ({ from: minute * 60000, to: minute * 60000 + 60000, offset, score: 1 });
    expect(dropSpikes([a(2, 1240), a(3, 5760), a(4, 1265), a(5, 1200)]).map((x) => x.offset)).toEqual([1240, 1265, 1200]);
    // A cut: everything after it moves, so no window is alone.
    expect(dropSpikes([a(10, 1160), a(11, 6395), a(12, 6520), a(13, 6525)])).toHaveLength(4);
  });
});

describe("index minutes with only a few lines", () => {
  it("aren't timed on their own: a 3-line cold open takes the episode's timing", () => {
    const at = (start: number) => ({ start, end: start + 2000 });
    const lines: Array<{ start: number; end: number }> = [];
    // Minute 0: 3 lines; minutes 2 to 20: 14 each.
    for (const s of [5000, 15000, 30000]) lines.push(at(s));
    for (let m = 2; m < 21; m++) for (let i = 0; i < 14; i++) lines.push(at(m * 60000 + i * 4100 + (i % 3) * 230));
    const track = lines.map((l, i) => (i < 3 ? { start: l.start - 700, end: l.end - 700 } : { start: l.start - 1000, end: l.end - 1000 }));
    const windows: FileAnchors["windows"] = [];
    for (let from = 0; from < 1_320_000; from += 60000) windows.push({ from, to: from + 60000, cues: track.filter((c) => c.start >= from && c.start < from + 60000) });
    const verdict = judge({ duration: 1_320_000, windows, track: 2, source: "index", rounds: 2 }, lines);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.anchors.some((a) => a.from === 0)).toBe(false);
    expect(verdict.anchors.every((a) => Math.abs(a.offset + 1000) <= 60)).toBe(true);
  });
});

describe("lines of a picture track from its index", () => {
  it("tells shows from clears and gives each line its length", async () => {
    const { pictureLines } = await import("../src/mkv.js");
    // Shown/cleared pairs: 10.0-12.0, (clear+0.2) 12.2-15.0, then a long silence, 30.0-31.5, 31.7-34.0.
    const entries = [10000, 12000, 12200, 15000, 30000, 31500, 31700, 34000].map((start) => ({ start }));
    expect(pictureLines(entries)).toEqual([
      { start: 10000, end: 12000 }, { start: 12200, end: 15000 }, { start: 30000, end: 31500 }, { start: 31700, end: 34000 }
    ]);
  });

  it("leaves out a stretch whose shows and clears don't alternate", async () => {
    const { pictureLines } = await import("../src/mkv.js");
    // 20.0 is replaced at 22.0 without a clear: between the sure labels the count is off by one.
    const entries = [10000, 12000, 12200, 15000, 20000, 22000, 25000, 25200, 27000].map((start) => ({ start }));
    const lines = pictureLines(entries);
    expect(lines).toContainEqual({ start: 10000, end: 12000 });
    expect(lines).toContainEqual({ start: 25200, end: 27000 });
    expect(lines.some((l) => l.start === 20000 || l.start === 22000)).toBe(false);
  });
});

describe("window length by bit rate", () => {
  it("keeps 40 s for ordinary files and shortens heavy remuxes, down to 20 s", async () => {
    const { windowMs } = await import("../src/sync.js");
    expect(windowMs(undefined)).toBe(40000);
    expect(windowMs(8_000_000)).toBe(40000); // a 1080p web release
    expect(windowMs(20_000_000)).toBe(25166); // about 60 MB a window
    expect(windowMs(70_000_000)).toBe(20000); // a 2160p remux
  });
});
