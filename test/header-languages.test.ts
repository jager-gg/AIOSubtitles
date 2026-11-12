/**
 * A first play's list leaves out the languages the playing file has: for a Matroska file they come
 * from one read of its first part (mkv.ts readMkvTracks), sooner than the full header check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMkvTracks, type MkvTrack } from "../src/mkv.js";
import { mkvTextLanguages } from "../src/sync.js";
import { ASS_HEADER, ASS_LINES, release } from "./mkvfile.js";

afterEach(() => vi.unstubAllGlobals());

describe("the playing file's languages from its first part (a first play's list)", () => {
  it("are its full text tracks' languages, read in one go: not signs, songs, forced or picture tracks", async () => {
    const file = release({ codecPrivate: ASS_HEADER, lines: ASS_LINES, name: "English" });
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      hits.push(String(input));
      const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("range") ?? "");
      const from = Number(m?.[1] ?? 0);
      const to = Math.min(Number(m?.[2] ?? file.length - 1), file.length - 1);
      return new Response(new Uint8Array(file.subarray(from, to + 1)), { status: 206 });
    });
    const head = await readMkvTracks("https://files.example/l.mkv");
    expect(hits).toHaveLength(1);
    // Track 9 ("English") counts; track 10 is signs.
    expect(mkvTextLanguages(head!.tracks)).toEqual(["eng"]);
    const t = (over: Partial<MkvTrack>): MkvTrack => ({ number: 1, index: 0, type: "subtitle", codec: "S_TEXT/UTF8", language: "por", name: "", forced: false, default: false, ...over });
    expect(mkvTextLanguages([t({}), t({ language: "spa", forced: true }), t({ language: "ara", codec: "S_HDMV/PGS" }), t({ language: "eng", name: "Songs" }), t({ language: "und" })])).toEqual(["por"]);
  });
});
