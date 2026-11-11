import { afterEach, describe, expect, it, vi } from "vitest";
import { fileName, fileRef, lookUpStream, lookUpStreamAgain } from "../src/sync.js";

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
const PLAYED = "Harbor.S01E07.2160p.ATVP.WEB-DL.DDPA5.1.HDR.HEVC-NTb";
const stream = (filename: string) => ({ url: `https://debrid.example/${encodeURIComponent(filename)}`, behaviorHints: { filename } });
const list = (...names: string[]) => new Response(JSON.stringify({ streams: names.map(stream) }), { headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("finding the playing file in AIOStreams", () => {
  it("finds it by name, extension or not, with one search", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(list("Harbor.S01E07.720p.WEB.h264-ETHEL", `${PLAYED}.mkv`));
    expect(await lookUpStream(AIO, "tt0000005:1:7", "series", PLAYED)).toBe(stream(`${PLAYED}.mkv`).url);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe("http://aiostreams:3000/stremio/uuid/pass/stream/series/tt0000005%3A1%3A7.json");
  });

  it("finds nothing when failover played another file (the named one is dropped from the list)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(list("Harbor (2023) S01E07 (2160p ATVP WEB-DL Hybrid H265 DV HDR10+ DDP Atmos 5.1 English - HONE)", "Harbor.S01E07.XviD-AFG"));
    expect(await lookUpStream(AIO, "tt0000005:1:7", "series", PLAYED)).toBeUndefined();
  });

  it("asks again when the file isn't in the first list, and stops once it is found", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => list("Harbor.S01E07.720p.WEB.h264-ETHEL"))
      .mockImplementationOnce(async () => list("Harbor.S01E07.720p.WEB.h264-ETHEL", `${PLAYED}.mkv`))
      .mockImplementation(async () => list());
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [1, 1])).toBe(stream(`${PLAYED}.mkv`).url);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last wait when the file is in none of the lists", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => list("Harbor.S01E07.XviD-AFG"));
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [1, 1])).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    // Found at once: no second look.
    fetch.mockClear();
    fetch.mockImplementation(async () => list(`${PLAYED}.mkv`));
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [1, 1])).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("picks the same-sized file when two listed files share a name, and keeps working without a size", async () => {
    const sized = (filename: string, videoSize: number, at: string) => ({ url: `https://debrid.example/${at}`, behaviorHints: { filename, videoSize } });
    const body = { streams: [sized("S01E06.mkv", 1000, "other-show"), sized("S01E06.mkv", 2000, "this-show")] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body)));
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("S01E06.mkv", "2000"))).toBe("https://debrid.example/this-show");
    expect(await lookUpStream(AIO, "tt1:1:6", "series", "S01E06.mkv")).toBe("https://debrid.example/other-show");
    // A size listed a little off (rounded) still picks the nearer of the two named alike.
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("S01E06.mkv", "2003"))).toBe("https://debrid.example/this-show");
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("S01E06.mkv", "1100"))).toBe("https://debrid.example/other-show");
    // A renamed file is still found by its exact size.
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("Show.S01E06.mkv", "2000"))).toBe("https://debrid.example/this-show");
  });

  it("keys a file by name and size, and reads the name back", () => {
    expect(fileRef("A.mkv", "123")).toBe("A.mkv/123");
    expect(fileRef("A.mkv", undefined)).toBe("A.mkv");
    expect(fileRef("A.mkv", "12x")).toBe("A.mkv");
    expect(fileName(fileRef("A.mkv", "123"))).toBe("A.mkv");
    expect(fileName("A.mkv")).toBe("A.mkv");
  });
});
