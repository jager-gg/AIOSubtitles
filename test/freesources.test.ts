/**
 * The free sources that need no key: TheSubtitleDB (by IMDb id), Gestdown (Addic7ed's TV subtitles,
 * by TVDB id), Anime Tosho (dub captions from anime releases' own tracks) and Cinemeta, which the
 * others ask about a title. Every site is a stand-in.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = ".cache-freesources-test";
process.env.CACHE_DIR = CACHE;
let tsdb: typeof import("../src/thesubtitledb.js");
let gestdown: typeof import("../src/gestdown.js");
let tosho: typeof import("../src/animetosho.js");
let profile: typeof import("../src/profile.js");
let cinemeta: typeof import("../src/cinemeta.js");
let downloads: typeof import("../src/downloads.js");
let matching: typeof import("../src/matching.js");
beforeAll(async () => {
  process.env.CONFIG_SECRET = "freesources-test-secret-freesources-1";
  tsdb = await import("../src/thesubtitledb.js");
  gestdown = await import("../src/gestdown.js");
  tosho = await import("../src/animetosho.js");
  profile = await import("../src/profile.js");
  cinemeta = await import("../src/cinemeta.js");
  downloads = await import("../src/downloads.js");
  matching = await import("../src/matching.js");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => rm(path.join(process.cwd(), CACHE), { recursive: true, force: true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Handler = (url: URL) => Response | undefined | Promise<Response | undefined>;
function sites(handle: Handler, hits: string[] = []) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    hits.push(url.href);
    return (await handle(url)) ?? new Response("not here", { status: 404 });
  });
  return hits;
}

describe("TheSubtitleDB", () => {
  const rows = (code: string) => [
    { id: 101, language: code, format: "srt", release_name: "Show.S01E02.1080p.WEB", hearing_impaired: false, uploader: "someone", added_at: "2026-01-02T00:00:00Z" },
    { id: 102, language: code, format: "ass", season: 1, episode: 2, release_name: "[Group] Show - 02 [1080p]", hearing_impaired: true },
    { id: 103, language: code, format: "sub", release_name: "a picture subtitle" },
    { id: 104, language: code, format: "srt", season: 1, episode: 3, release_name: "another episode's row" }
  ];

  it("asks once per language for the episode, and keeps its text subtitles for it", async () => {
    const hits = sites((url) => {
      const m = /^\/v1\/by-imdb\/tt0000801\/season\/1\/episode\/2$/.exec(url.pathname);
      if (url.hostname !== "api.thesubtitledb.org" || !m) return undefined;
      return json({ title: { imdb: "tt0000801", name: "Show" }, subtitles: { total: 4, items: rows(url.searchParams.get("lang") ?? "") }, seasons: null });
    });
    const found = await tsdb.theSubtitleDbSubtitles({ type: "series", id: "tt0000801:1:2", imdbId: "tt0000801", season: 1, episode: 2 }, ["english", "portuguese (br)"]);
    expect(hits.map((h) => new URL(h).searchParams.get("lang")).sort()).toEqual(["en", "pb"]);
    expect(found.map((s) => [s.ref, s.language, s.releaseInfo?.[0], s.hearingImpaired, s.episodeTrusted])).toEqual([
      ["tb101", "english", "Show.S01E02.1080p.WEB", false, true],
      ["tb102", "english", "[Group] Show - 02 [1080p]", true, true],
      ["tb101", "portuguese (br)", "Show.S01E02.1080p.WEB", false, true],
      ["tb102", "portuguese (br)", "[Group] Show - 02 [1080p]", true, true]
    ]);
    expect(tsdb.theSubtitleDbDownloadUrl("tb102")).toBe("https://api.thesubtitledb.org/get/102");
    expect(tsdb.theSubtitleDbDownloadUrl("tbx")).toBeUndefined();
  });

  it("takes a title it doesn't have as none, and a failure as none for this list only", async () => {
    sites(() => new Response("{}", { status: 404 }));
    expect(await tsdb.theSubtitleDbSubtitles({ type: "movie", id: "tt0000802", imdbId: "tt0000802" }, ["english"])).toEqual([]);
    sites(() => new Response("busy", { status: 503 }));
    expect(await tsdb.theSubtitleDbSubtitles({ type: "movie", id: "tt0000803", imdbId: "tt0000803" }, ["english"])).toEqual([]);
    sites((url) => (url.pathname === "/v1/by-imdb/tt0000803" ? json({ subtitles: { items: [{ id: 7, language: "en", format: "srt", release_name: "Film.2020.1080p" }] } }) : undefined));
    expect((await tsdb.theSubtitleDbSubtitles({ type: "movie", id: "tt0000803", imdbId: "tt0000803" }, ["english"])).map((s) => s.ref)).toEqual(["tb7"]);
  });

  it("counts the rows it marks as made by AI as machine translations, left out unless the link allows them", async () => {
    sites((url) =>
      url.pathname === "/v1/by-imdb/tt0000904"
        ? json({
            subtitles: {
              items: [
                { id: 201, language: "en", format: "srt", release_name: "Film.2020.1080p.WEB", ai_transcribed: true, ai: null },
                { id: 202, language: "en", format: "srt", release_name: "Film.2020.1080p.WEB", ai_transcribed: false, ai: { from: "fr" } },
                { id: 203, language: "en", format: "srt", release_name: "Film.2020.1080p.WEB", ai_transcribed: false, ai: null }
              ]
            }
          })
        : undefined
    );
    const request = { type: "movie", id: "tt0000904", imdbId: "tt0000904" };
    const found = await tsdb.theSubtitleDbSubtitles(request, ["english"]);
    expect(found.map((s) => [s.ref, s.productionType])).toEqual([
      ["tb201", "machine translated"],
      ["tb202", "machine translated"],
      ["tb203", null]
    ]);
    expect(matching.filterAndRankDubtitles(found, request, { requireDub: false }).map((s) => s.ref)).toEqual(["tb203"]);
    // Allowed, they rank below a person's.
    expect(matching.filterAndRankDubtitles(found, request, { requireDub: false, allowMachine: true }).map((s) => s.ref)[0]).toBe("tb203");
  });
});

describe("Gestdown", () => {
  const cinemeta = (url: URL) => (url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { name: "Show", tvdb_id: 4242, genres: ["Drama"], country: "United States" } }) : undefined);

  it("finds the show by its TVDB id and lists the episode's subtitles per language, by Addic7ed's names", async () => {
    const asked: string[] = [];
    sites((url) => {
      if (url.hostname !== "api.gestdown.info") return cinemeta(url);
      if (url.pathname === "/shows/external/tvdb/4242") return json({ shows: [{ id: "showAbc123", name: "Show", tvDbId: 4242 }] });
      const m = /^\/subtitles\/get\/showAbc123\/1\/2\/(.+)$/.exec(url.pathname);
      if (!m) return undefined;
      const language = decodeURIComponent(m[1]);
      asked.push(language);
      return json({
        matchingSubtitles: [
          { subtitleId: "subAAA111", version: "CREW", qualities: ["720p", "1080p"], completed: true, hearingImpaired: false, language, downloadCount: 12 },
          { subtitleId: "subBBB222", version: "TEAM", completed: false, language }
        ]
      });
    });
    const found = await gestdown.gestdownSubtitles({ type: "series", id: "tt0000811:1:2", imdbId: "tt0000811", season: 1, episode: 2 }, ["dutch", "portuguese (br)"]);
    expect(asked.sort()).toEqual(["Dutch", "Portuguese (Brazilian)"]);
    // An unfinished translation isn't listed.
    expect(found.map((s) => [s.ref, s.language, s.releaseInfo?.[0]])).toEqual([
      ["gdsubAAA111", "dutch", "CREW 720p 1080p"],
      ["gdsubAAA111", "portuguese (br)", "CREW 720p 1080p"]
    ]);
    expect(gestdown.gestdownDownloadUrl("gdsubAAA111")).toBe("https://api.gestdown.info/subtitles/download/subAAA111");
  });

  it("isn't asked for films, nor for a show it doesn't have", async () => {
    const hits = sites((url) => (url.hostname === "api.gestdown.info" ? new Response("", { status: 404 }) : cinemeta(url)));
    expect(await gestdown.gestdownSubtitles({ type: "movie", id: "tt0000812", imdbId: "tt0000812" }, ["english"])).toEqual([]);
    expect(hits).toEqual([]);
    expect(await gestdown.gestdownSubtitles({ type: "series", id: "tt0000813:1:1", imdbId: "tt0000813", season: 1, episode: 1 }, ["english"])).toEqual([]);
  });

  it("keeps the other languages when one is refused, and asks for that one again next time", async () => {
    const asked: string[] = [];
    let busy = true;
    sites((url) => {
      if (url.hostname === "v3-cinemeta.strem.io") return json({ meta: { name: "Show", tvdb_id: 4243, genres: ["Drama"], country: "United States" } });
      if (url.pathname === "/shows/external/tvdb/4243") return json({ shows: [{ id: "showDef456", tvDbId: 4243 }] });
      const m = /^\/subtitles\/get\/showDef456\/1\/3\/(.+)$/.exec(url.pathname);
      if (!m) return undefined;
      const language = decodeURIComponent(m[1]);
      asked.push(language);
      if (language === "English" && busy) return new Response("slow down", { status: 429 });
      return json({ matchingSubtitles: [{ subtitleId: `sub${language.slice(0, 3)}333`, version: "CREW", completed: true, language }] });
    });
    const request = { type: "series", id: "tt0000914:1:3", imdbId: "tt0000914", season: 1, episode: 3 };
    expect((await gestdown.gestdownSubtitles(request, ["english", "dutch"])).map((s) => s.ref)).toEqual(["gdsubDut333"]);
    busy = false;
    expect((await gestdown.gestdownSubtitles(request, ["english", "dutch"])).map((s) => s.ref).sort()).toEqual(["gdsubDut333", "gdsubEng333"]);
    // Dutch was kept; English, refused, was asked again.
    expect(asked.sort()).toEqual(["Dutch", "English", "English"]);
  });

  it("names languages as Addic7ed does", () => {
    expect(["english", "dutch", "portuguese (br)", "spanish (la)", "chinese (simplified)"].map(gestdown.gestdownLanguage)).toEqual([
      "English",
      "Dutch",
      "Portuguese (Brazilian)",
      "Spanish (Latin America)",
      "Chinese (Simplified)"
    ]);
  });
});

describe("Anime Tosho", () => {
  // An ASS file of one line, XZ-packed as Anime Tosho stores tracks.
  const XZ = Buffer.from(
    "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4AC+AJddAC2UyMtHifLr5yTJxebCHTfb/GkkOgEs1COSDHvfUSrdi+HDOaw/neUZiBNOgWB9UgTMNuUJeKKiTKdCELzwQPFCCw/dHoafq6DXwausOU+06ZjbiHLOkGHvkmKnZkaS9EjOIJ8XOP7kZC//bi5gpZkG/ourY8BarwDJnUBqAA4FJHysRYvM8YaD5DaJzSG6SObJvZ302qAAAPoAVGdZzPlBAAGzAb8BAABNqLgmscRn+wIAAAAABFla",
    "base64"
  );
  const englishOnly = "General\nComplete name : x.mkv\n\nVideo\nID : 1\n\nAudio\nID : 2\nLanguage : English\n\nText\nID : 3\nLanguage : English";
  const dualAudio = "General\n\nAudio #1\nLanguage : Japanese\n\nAudio #2\nLanguage : English\n\nText\nLanguage : English";
  const track = (place: string, name: string, extra = {}) => ({ type: "subtitle", url: `https://storage.animetosho.net/attachments/${place.slice(0, 5)}/${place.slice(5)}.xz?filename=x.ass.xz`, info: { name, language_code: "eng", format: "ASS", ...extra } });
  const releases: Record<string, unknown> = {
    // A web dub's batch: each file's own "English [CC]".
    "501": { id: 501, title: "Show - S02E03-05 - ENG UNCUT 720p WEB -TEAM", files: [3, 4, 5].map((e) => ({ filename: `Show - S02E0${e} - ENG UNCUT 720p WEB -TEAM.mkv`, info: { mediainfo: englishOnly }, attachments: [track(`000a0${e}00`, "English [CC]")] })) },
    // A dual-audio release: its plain English is the translation, its "Dub" track the captions.
    "502": { id: 502, title: "[Group] Show S2 - 04 [Dual Audio] [WEB 1080p]", files: [{ filename: "[Group] Show S2 - 04 [WEB 1080p].mkv", info: { mediainfo: dualAudio }, attachments: [track("000b0001", "English"), track("000b0002", "English (Dub)"), track("000b0003", "Signs [CC]")] }] },
    // An English dub's own release whose one English track has no name: every voice is English.
    "503": { id: 503, title: "[Group] Show S2 - 05 [English Dub] [WEB 1080p]", files: [{ filename: "[Group] Show S2 - 05 [WEB 1080p].mkv", info: { mediainfo: englishOnly }, attachments: [track("000c0001", "English")] }] },
    // A dual-audio release with only the translation: nothing for the dub.
    "504": { id: 504, title: "[Group] Show S2 - 03 [Dual Audio] [BD 1080p]", files: [{ filename: "[Group] Show S2 - 03 [BD 1080p].mkv", info: { mediainfo: dualAudio }, attachments: [track("000d0001", "English")] }] }
  };
  const listed = Object.values(releases).map((r) => ({ id: (r as { id: number }).id, title: (r as { title: string }).title, num_files: (r as { files: unknown[] }).files.length, status: "unknown" }));
  const feed = (url: URL) => {
    if (url.hostname === "storage.animetosho.net") return url.pathname === "/attachments/000a0/300.xz" ? new Response(XZ) : undefined;
    if (url.hostname !== "feed.animetosho.net") return undefined;
    if (url.searchParams.get("show") === "torrent") return json(releases[url.searchParams.get("id") ?? ""] ?? {}, releases[url.searchParams.get("id") ?? ""] ? 200 : 404);
    // Every search lists the same releases, one page.
    return json(Number(url.searchParams.get("page") ?? 1) > 1 ? [] : listed);
  };
  const ask = (episode: number) => ({ type: "series", id: `tt0000821:2:${episode}`, imdbId: "tt0000821", season: 2, episode });

  it("gives each episode the dub's captions out of the release that holds it", async () => {
    sites(feed);
    const e3 = await tosho.animeToshoSubtitles(ask(3), "Show", undefined);
    // The batch's E03 file's "English [CC]"; the dual-audio release's plain English (a translation) isn't one.
    expect(e3.map((s) => [s.ref, s.releaseInfo?.[0], s.hearingImpaired])).toEqual([["at000a0300", "Show - S02E03 - ENG UNCUT 720p WEB -TEAM", true]]);
    expect(e3[0]).toMatchObject({ source: "animetosho", language: "english", productionType: "official", files: 1 });
    expect(e3[0].commentary).toContain("English Dub captions");
    const e4 = await tosho.animeToshoSubtitles(ask(4), "Show", undefined);
    expect(e4.map((s) => s.ref).sort()).toEqual(["at000a0400", "at000b0002"]);
    const e5 = await tosho.animeToshoSubtitles(ask(5), "Show", undefined);
    expect(e5.map((s) => s.ref).sort()).toEqual(["at000a0500", "at000c0001"]);
  });

  it("downloads a track and unpacks it", async () => {
    sites(feed);
    const text = (await tosho.downloadAnimeTosho("at000a0300")).toString("utf8");
    expect(text).toContain("Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,We leave at dawn.");
    await expect(tosho.downloadAnimeTosho("at../x")).rejects.toThrow(/unknown subtitle/);
  });

  it("reads release names for a dub, never a TV capture", () => {
    expect(tosho.dubRelease("Show - S01E03 - ENG UNCUT 720p WEB H.264 -TEAM")).toBe(3);
    expect(tosho.dubRelease("[Group] Show S2 - 04 [English Dub] [FuniDub 1080p x264 AAC]")).toBe(3);
    expect(tosho.dubRelease("[Group] Show - 03 (Dubbed) [1080p].mkv")).toBe(2);
    expect(tosho.dubRelease("[Group] Show - S01E03 (BD 1080p HEVC) [Dual-Audio]")).toBe(1);
    expect(tosho.dubRelease("Show.S01E04.DUBBED.720p.HDTV.x264-CREW")).toBe(0);
    expect(tosho.dubRelease("[Group] Show - 03 (1080p) [ABCD1234].mkv")).toBe(0);
  });

  it("tells a file whose every voice is English from a dual-audio one", () => {
    expect(tosho.englishVoicesOnly(englishOnly)).toBe(true);
    expect(tosho.englishVoicesOnly(dualAudio)).toBe(false);
    expect(tosho.englishVoicesOnly("General\n\nVideo\nID : 1")).toBe(false);
  });

  it("searches the show's dub releases whole, and a season by its own title", () => {
    const map = { show: "Show", entries: [{ titles: ["Show", "Show Season 1"], episodes: { "1": [1, 1] as [number, number] } }, { titles: ["Show: Second Arc", "Show 2nd Season"], episodes: { "1": [2, 1] as [number, number] } }] };
    const searches = tosho.searchesFor(ask(3), "Show", tosho.seasonTitles(ask(3), map));
    expect(searches).toEqual([
      { q: 'Show "English Dub"', pages: 10 },
      { q: "Show UNCUT", pages: 2 },
      { q: "Show Dubbed", pages: 2 },
      { q: 'Show "Dual Audio" S02E03', pages: 1 },
      { q: 'Show Second Arc "English Dub"', pages: 2 }
    ]);
  });

  /** A stand-in feed: searches answered by `search` (by query and page), releases from `bodies`. */
  const standIn = (search: (q: string, page: number) => unknown[], bodies: Record<number, unknown>) => (url: URL) => {
    if (url.hostname !== "feed.animetosho.net") return undefined;
    if (url.searchParams.get("show") === "torrent") {
      const body = bodies[Number(url.searchParams.get("id"))];
      return body ? json(body) : undefined;
    }
    return json(search(url.searchParams.get("q") ?? "", Number(url.searchParams.get("page") ?? 1)));
  };
  const one = (id: number, title: string, place: string, extra = {}) => ({ id, title, files: [{ filename: `${title}.mkv`, info: { mediainfo: englishOnly }, attachments: [track(place, "English [CC]")] }], ...extra });
  const row = (body: { id: number; title: string; files: unknown[] }, status = "complete", timestamp = 100) => ({ id: body.id, title: body.title, num_files: body.files.length, status, timestamp });
  const opened = (hits: string[]) => hits.filter((h) => h.includes("show=torrent")).map((h) => Number(new URL(h).searchParams.get("id")));
  const series = (imdb: string, season: number, episode: number) => ({ type: "series", id: `${imdb}:${season}:${episode}`, imdbId: imdb, season, episode });

  it("leaves out a release still being mirrored, and looks again within the hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const late = one(601, "[Group] Show Late - 01 [English Dub] [1080p]", "000f0101");
    let status = "processing";
    const hits = sites(standIn((q) => (q.includes("English Dub") ? [row(late, status)] : []), { 601: late }));
    expect(await tosho.animeToshoSubtitles(series("tt0000941", 1, 1), "Show Late", undefined)).toEqual([]);
    expect(opened(hits)).toEqual([]);
    status = "complete";
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    expect((await tosho.animeToshoSubtitles(series("tt0000941", 1, 1), "Show Late", undefined)).map((s) => s.ref)).toEqual(["at000f0101"]);
  });

  it("keeps a release without subtitle tracks an hour, not a month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const full = one(602, "[Group] Show Bare - 01 [English Dub] [1080p]", "000f0201");
    const bodies: Record<number, unknown> = { 602: { ...full, files: [{ ...full.files[0], attachments: [] }] } };
    const hits = sites(standIn((q) => (q.includes("English Dub") ? [row(full)] : []), bodies));
    expect(await tosho.animeToshoSubtitles(series("tt0000942", 1, 1), "Show Bare", undefined)).toEqual([]);
    bodies[602] = full;
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    expect((await tosho.animeToshoSubtitles(series("tt0000942", 1, 1), "Show Bare", undefined)).map((s) => s.ref)).toEqual(["at000f0201"]);
    expect(opened(hits)).toEqual([602, 602]);
  });

  it("opens the complete one of a release's two resolutions", async () => {
    const newer = one(611, "[Group] Show Pair - 01 [English Dub] [1080p]", "000f1101");
    const older = one(612, "[Group] Show Pair - 01 [English Dub] [720p]", "000f1201");
    const hits = sites(standIn((q) => (q.includes("English Dub") ? [row(newer, "unknown", 200), row(older, "complete", 100)] : []), { 611: newer, 612: older }));
    expect((await tosho.animeToshoSubtitles(series("tt0000943", 1, 1), "Show Pair", undefined)).map((s) => s.ref)).toEqual(["at000f1201"]);
    expect(opened(hits)).toEqual([612]);
  });

  it("takes a release only when its own name is the show's, not a longer title that starts with it", async () => {
    const other = one(621, "[Group] Show N Next Generation - 01 [English Dub] [1080p]", "000f2101");
    const own = one(622, "[Group] Show N - 01 [English Dub] [1080p]", "000f2201");
    const hits = sites(standIn((q) => (q.includes("English Dub") ? [row(other), row(own)] : []), { 621: other, 622: own }));
    expect((await tosho.animeToshoSubtitles(series("tt0000944", 1, 1), "Show N", undefined)).map((s) => s.ref)).toEqual(["at000f2201"]);
    expect(opened(hits)).toEqual([622]);
  });

  it("reads a release's own name for the show's", () => {
    for (const title of [
      "[Group] Show - 03 [English Dub] [1080p]",
      "Show.S01E04.DUBBED.720p.WEB-CREW",
      "Show - S02E03 - ENG UNCUT 720p WEB -TEAM",
      "[Group] Show S2 - 04 [Dual Audio]",
      "Show 2nd Season - 01 (Dub)",
      "Show Second Season - 01",
      "Show (2020) - 01",
      "Show 03 [1080p]",
      "[Group] Show [English Dub] [Batch]",
      "Show"
    ]) {
      expect(tosho.namesTitle(title, "Show"), title).toBe(true);
    }
    for (const title of ["Show Next Generation - 01 [English Dub]", "[Group] Show Next Generation S2 - 01", "Showcase - 01", "Other Show - 01", "Show Second Arc - 01", "Shows - 01"]) {
      expect(tosho.namesTitle(title, "Show"), title).toBe(false);
    }
    expect(tosho.namesTitle("Show: Second Arc - 01 [English Dub]", "Show: Second Arc")).toBe(true);
    expect(tosho.namesTitle("[Group] The SHOW! - 01", "The Show")).toBe(true);
  });

  it("reads a batch's file by the season of its folder, or of the release's name", async () => {
    expect(tosho.seasonAround({ name: "Show - 03.mkv", folder: "Show [Batch]/Season 2" }, "[Group] Show [Batch]")).toBe(2);
    expect(tosho.seasonAround({ name: "Show - 03.mkv" }, "[Group] Show S2 [English Dub] [Batch]")).toBe(2);
    expect(tosho.seasonAround({ name: "Show S1 - 03.mkv", folder: "Season 2" }, "x")).toBeUndefined();
    expect(tosho.seasonAround({ name: "Show - 03.mkv", folder: "Show S1-S2" }, "[Group] Show S2")).toBeUndefined();
    const batch = {
      id: 631,
      title: "[Group] Show Q [English Dub] [Batch]",
      files: [1, 2].map((season) => ({
        filename: `Show Q [Batch]/Season ${season}/Show Q - 03.mkv`,
        info: { mediainfo: englishOnly },
        attachments: [track(`000e0${season}03`, "English [CC]")]
      }))
    };
    sites(standIn((q) => (q.includes("English Dub") ? [row(batch)] : []), { 631: batch }));
    expect((await tosho.animeToshoSubtitles(series("tt0000951", 2, 3), "Show Q", undefined)).map((s) => s.ref)).toEqual(["at000e0203"]);
    expect((await tosho.animeToshoSubtitles(series("tt0000951", 1, 3), "Show Q", undefined)).map((s) => s.ref)).toEqual(["at000e0103"]);
  });

  it("asks one page first, at most 3 requests at once, and once for what two lists ask at the same time", async () => {
    const wanted = one(641, "[Group] Show Busy - 01 [English Dub] [1080p]", "000f4101");
    const full = Array.from({ length: 75 }, (_, i) => ({ id: 7000 + i, title: `[Group] Film ${i} [1080p]`, num_files: 1, status: "complete" }));
    let now = 0;
    let most = 0;
    const answer = standIn((q, page) => (q.includes("English Dub") ? (page === 1 ? full : page === 2 ? [row(wanted)] : []) : []), { 641: wanted });
    const hits = sites(async (url) => {
      now++;
      most = Math.max(most, now);
      await new Promise((resolve) => setTimeout(resolve, 15));
      now--;
      return answer(url);
    });
    const [a, b] = await Promise.all([1, 1].map(() => tosho.animeToshoSubtitles(series("tt0000961", 1, 1), "Show Busy", undefined)));
    expect(a.map((s) => s.ref)).toEqual(["at000f4101"]);
    expect(b).toEqual(a);
    expect(most).toBeLessThanOrEqual(3);
    // Each page and release once. A search whose first page is short stops there; the "English Dub"
    // search's first page was full, so the next few were asked (together), and its short second ended it.
    expect(hits.length).toBe(new Set(hits).size);
    const pages = (q: string) => hits.filter((h) => new URL(h).searchParams.get("q") === q).map((h) => Number(new URL(h).searchParams.get("page") ?? 1)).sort();
    expect(pages("Show Busy UNCUT")).toEqual([1]);
    expect(pages('Show Busy "English Dub"')).toEqual([1, 2, 3, 4]);
    expect(opened(hits)).toEqual([641]);
  });
});

describe("Cinemeta", () => {
  it("reads a title's name, year, TVDB id, genres and country, and keeps them", async () => {
    const hits = sites((url) =>
      url.pathname === "/meta/series/tt0000931.json"
        ? json({ meta: { name: " Show ", releaseInfo: "2019–2021", tvdb_id: "4244", genres: ["Animation", "Action"], country: "Japan" } })
        : undefined
    );
    const meta = await cinemeta.metaOf("series", "tt0000931");
    expect(meta).toEqual({ name: "Show", year: 2019, tvdbId: 4244, genres: ["Animation", "Action"], country: "Japan" });
    expect(await cinemeta.metaOf("series", "tt0000931")).toEqual(meta);
    expect(hits).toEqual(["https://v3-cinemeta.strem.io/meta/series/tt0000931.json"]);
  });

  it("asks a film as a film, and leaves out a year or TVDB id it doesn't give", async () => {
    sites((url) => (url.pathname === "/meta/movie/tt0000932.json" ? json({ meta: { name: "Film", year: "n/a", tvdb_id: "none" } }) : undefined));
    expect(await cinemeta.metaOf("movie", "tt0000932")).toEqual({ name: "Film", genres: [], country: "" });
  });

  it("keeps a title it doesn't know as none, but asks again after a failure", async () => {
    const hits = sites((url) => (url.pathname === "/meta/series/tt0000933.json" ? json({ meta: {} }) : undefined));
    expect(await cinemeta.metaOf("series", "tt0000933")).toBeUndefined();
    expect(await cinemeta.metaOf("series", "tt0000933")).toBeUndefined();
    expect(hits.length).toBe(1);
    let down = true;
    const again = sites((url) => (down ? new Response("busy", { status: 503 }) : json({ meta: { name: "Show" } })));
    expect(await cinemeta.metaOf("series", "tt0000934")).toBeUndefined();
    down = false;
    expect((await cinemeta.metaOf("series", "tt0000934"))?.name).toBe("Show");
    expect(again.length).toBe(2);
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await cinemeta.metaOf("series", "tt0000935")).toBeUndefined();
  });

  it("calls a title anime when it is animation from a country anime comes from", () => {
    const meta = (genres: string[], country: string) => ({ name: "Show", genres, country });
    expect(cinemeta.isAnime(undefined)).toBe(false);
    expect(cinemeta.isAnime(meta(["Animation", "Action"], "Japan"))).toBe(true);
    expect(cinemeta.isAnime(meta(["anime"], "South Korea, Japan"))).toBe(true);
    expect(cinemeta.isAnime(meta(["Animation"], "United States, Japan"))).toBe(false);
    expect(cinemeta.isAnime(meta(["Drama"], "Japan"))).toBe(false);
    expect(cinemeta.isAnime(meta(["Animation"], ""))).toBe(false);
  });
});

describe("downloads from the free sources", () => {
  it("follows TheSubtitleDB's counted link to its file, and refuses a hop off https or a body too big", async () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nA line.\n";
    sites((url) => {
      if (url.href === "https://api.thesubtitledb.org/get/901") return new Response(null, { status: 302, headers: { location: "https://files.thesubtitledb.org/get/abc" } });
      if (url.href === "https://files.thesubtitledb.org/get/abc") return new Response(srt);
      if (url.href === "https://api.thesubtitledb.org/get/902") return new Response(null, { status: 302, headers: { location: "http://files.thesubtitledb.org/get/def" } });
      if (url.pathname === "/subtitles/download/bigAAA111") return new Response("x", { headers: { "content-length": String(50_000_000) } });
      return undefined;
    });
    const got = await downloads.getCachedSubtitleFile("tb901", undefined, undefined, {});
    expect(await readFile(got.file, "utf8")).toBe(srt);
    await expect(downloads.getCachedSubtitleFile("tb902", undefined, undefined, {})).rejects.toThrow(/public https/);
    await expect(downloads.getCachedSubtitleFile("gdbigAAA111", undefined, undefined, {})).rejects.toThrow(/too large/);
  });
});

describe("the free sources in a link's settings", () => {
  const base = { languages: ["English"], allowMachine: false, hearingImpaired: "include" as const };
  it("are on unless a link turns them off, links made before them included", () => {
    const on = profile.profileFromSettings({ ...base, subsource: "sk_free_sources_key" }, "t");
    expect([on.thesubtitledb, on.gestdown, on.animetosho]).toEqual([true, true, true]);
    const off = profile.profileFromSettings({ ...base, subsource: "sk_free_sources_key", thesubtitledb: false, gestdown: false, animetosho: false }, "t");
    expect([off.thesubtitledb, off.gestdown, off.animetosho]).toEqual([false, false, false]);
  });

  it("make a link work without any key, but Anime Tosho alone isn't enough", () => {
    expect(profile.settingsProblem({ ...base })).toBeUndefined();
    expect(profile.settingsProblem({ ...base, thesubtitledb: false })).toBeUndefined();
    expect(profile.settingsProblem({ ...base, thesubtitledb: false, gestdown: false })).toMatch(/Anime Tosho need another source/);
  });
});
