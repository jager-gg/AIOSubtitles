import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = ".cache-resync-test";
let sync: typeof import("../src/sync.js");

beforeAll(async () => {
  process.env.CACHE_DIR = CACHE;
  sync = await import("../src/sync.js");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

describe("a synced subtitle whose file was cleaned up", () => {
  it("is made again instead of handing out a file that's gone", async () => {
    // AIOStreams can't be reached here, so a sync made again ends without a result: what matters is
    // that it starts again (the caption is fetched) rather than returning the stale record.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const key = sync.syncKey("ss1", 1, 13, "Some.File.mkv");
    const dir = path.join(process.cwd(), CACHE, "synced");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify({ file: path.join(dir, `${key}.srt`), anchors: [{ from: 0, to: 40000, offset: 500, score: 1 }] }));
    const caption = vi.fn(async () => ({ file: path.join(dir, "missing-source.srt") }));
    const first = await sync.syncCaptions(key, caption, "http://aiostreams.invalid/stremio/u/p/manifest.json", "tt1:1:13", "series", "Some.File.mkv");
    expect(caption).toHaveBeenCalled();
    expect(first).toBeUndefined();
  });

  it("is made again when the file goes after the sync was remembered", async () => {
    const key = sync.syncKey("ss2", 1, 13, "Other.File.mkv");
    const dir = path.join(process.cwd(), CACHE, "synced");
    const file = path.join(dir, `${key}.srt`);
    await writeFile(file, "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify({ file, anchors: [{ from: 0, to: 40000, offset: 500, score: 1 }] }));
    const caption = vi.fn(async () => ({ file: path.join(dir, "missing-source.srt") }));
    const args = [caption, "http://aiostreams.invalid/stremio/u/p/manifest.json", "tt1:1:13", "series", "Other.File.mkv"] as const;
    expect((await sync.syncCaptions(key, ...args))?.file).toBe(file);
    expect(caption).not.toHaveBeenCalled();
    await rm(file);
    await rm(path.join(dir, `${key}.json`));
    // Remembered in memory, but its file is gone: started again.
    await sync.syncCaptions(key, ...args);
    expect(caption).toHaveBeenCalled();
  });
});

describe("the key a synced result is kept under", () => {
  it("is what it always was, so nothing synced before is made again", async () => {
    const { cacheKey } = await import("../src/cache.js");
    const expected = (subtitleId: string | number) => cacheKey({ kind: "synced", subtitleId, season: 1, episode: 13, filename: "Some.File.mkv", version: sync.SYNC_VERSION });
    expect(sync.syncKey("ss123", 1, 13, "Some.File.mkv")).toBe(expected("ss123"));
    expect(sync.syncKey("osar-456", 1, 13, "Some.File.mkv")).toBe(expected("osar-456"));
    expect(sync.syncKey(123, 1, 13, "Some.File.mkv")).toBe(expected(123));
  });
});
