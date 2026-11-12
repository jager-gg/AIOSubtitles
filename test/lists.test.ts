/**
 * The subtitle list and the download, end to end against stand-ins for every site: a source that
 * fails or is slow never costs the others, a list waits for syncs it can finish and lists a fallback
 * in place of a subtitle that doesn't fit, the dub and CC tracks, SubDL's daily downloads, and the
 * download's one time budget.
 */
import AdmZip from "adm-zip";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/profile.js";
import type { Cue } from "../src/sync.js";

const CACHE = ".cache-lists-test";
const AIO = "https://aiostreams.example.com/stremio/list-test-uuid/pass/manifest.json";
let base = "";
let close = () => {};
let seal: (s: Settings) => string;
let stats: typeof import("../src/stats.js");
let cacheKey: (what: unknown) => string;
const realFetch = globalThis.fetch;
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

beforeAll(async () => {
  process.env.CONFIG_SECRET = "lists-test-secret-lists-test-secret-123";
  process.env.ALLOWED_AIOSTREAMS = "https://aiostreams.example.com";
  process.env.PUBLIC_BASE_URL = "https://sync.example";
  process.env.CACHE_DIR = CACHE;
  process.on("unhandledRejection", onRejection);
  seal = (await import("../src/profile.js")).sealSettings;
  stats = await import("../src/stats.js");
  cacheKey = (await import("../src/cache.js")).cacheKey;
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  close();
  process.off("unhandledRejection", onRejection);
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = <T,>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Every site this test talks to, answered by `handle`; this server itself is reached for real. */
function sites(handle: Handler, hits: string[] = []) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input instanceof Request ? input.url : input);
    if (raw.startsWith(base)) return realFetch(input, init);
    hits.push(raw);
    return (await handle(new URL(raw), init)) ?? new Response("not here", { status: 404 });
  });
  return hits;
}

const sub = (id: number, release: string, extra: Record<string, unknown> = {}) => ({
  subtitleId: id, movieId: 1, language: "english", releaseInfo: [release], commentary: null, files: 1, hearingImpaired: false, downloads: 0, rating: null, ...extra
});

/** SubSource with one season-1 record (its id unique per test: SubSource's lists are cached by it) and these subtitles per language. */
function subsource(url: URL, lists: Record<string, unknown[]>, files: Record<string, string> = {}, movieId = 1): Response | undefined {
  if (url.hostname !== "api.subsource.net") return undefined;
  if (url.pathname.endsWith("/movies/search")) return json({ data: [{ movieId, title: "Show", type: "tvseries", season: 1, subtitleCount: 9 }] });
  if (url.pathname.endsWith("/subtitles")) return json({ data: lists[url.searchParams.get("language") ?? ""] ?? [], pagination: { pages: 1 } });
  const download = url.pathname.match(/\/subtitles\/(\d+)\/download$/);
  if (download && files[download[1]]) return new Response(files[download[1]]);
  return undefined;
}

/** Cinemeta for an anime (animation from Japan): the season map is looked up only for one. */
const cinemeta = (url: URL) => (url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { country: "Japan", genres: ["Animation"], name: "Show" } }) : undefined);
const openSubtitlesArabic = (url: URL, id: number) =>
  url.hostname === "opensubtitles.stremio.homes" ? json({ subtitles: [{ sub_id: id, lang_code: "ar", title: "Show.S01E05.1080p.WEB" }] }) : undefined;

type Track = { lang: string; label: string; url: string };
async function list(settings: Settings, id: string, extra = "") {
  const started = Date.now();
  const res = await realFetch(`${base}/${seal(settings)}/subtitles/series/${encodeURIComponent(id)}${extra}.json`);
  const body = (await res.json()) as { subtitles: Track[]; cacheMaxAge: number };
  return { status: res.status, ms: Date.now() - started, cache: res.headers.get("cache-control") ?? "", ...body };
}
const refOfTrack = (t: Track) => new URL(t.url).pathname.split("/").at(-2);
const altsOf = (t: Track) => (new URL(t.url).searchParams.get("alt") ?? "").split(",").filter(Boolean).map((a) => a.split("@")[0]);

/** A dialogue's timing, made up but irregular like real speech (a seeded random walk). */
function dialogue(seed: number, until = 20 * 60000): Cue[] {
  let s = seed;
  const random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Cue[] = [];
  for (let t = 30000; t < until - 5000; ) {
    const length = 900 + Math.round(random() * 2600);
    out.push({ start: t, end: t + length });
    t += length + 150 + Math.round(random() * (random() < 0.15 ? 6000 : 1500));
  }
  return out;
}
const stamp = (ms: number) =>
  `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
const srt = (cues: Cue[]) => cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\nline ${i + 1}\n`).join("\n");

/** The playing file as if its Matroska index had been read: these lines on its subtitle track. */
async function fileWithTrack(filename: string, lines: Cue[]) {
  const duration = 20 * 60000;
  const windows = [];
  for (let from = 0; from < duration; from += 60000) windows.push({ from, to: from + 60000, cues: lines.filter((c) => c.start >= from && c.start < from + 60000) });
  await mkdir(path.join(process.cwd(), CACHE, "anchors"), { recursive: true });
  await writeFile(path.join(process.cwd(), CACHE, "anchors", `${cacheKey({ kind: "file-anchors", filename })}.json`), JSON.stringify({ filename, duration, windows, track: 2, source: "index", rounds: 2, subtitleLangs: [] }));
}

/** The playing file as one with no subtitle track and no audio to hear: nothing syncs to it. */
async function fileWithoutTrack(filename: string) {
  await mkdir(path.join(process.cwd(), CACHE, "anchors"), { recursive: true });
  await writeFile(path.join(process.cwd(), CACHE, "anchors", `${cacheKey({ kind: "file-anchors", filename })}.json`), JSON.stringify({ filename, duration: 1200000, windows: [], speechChecked: true, subtitleLangs: [] }));
}

const playing = (filename: string) => `/${new URLSearchParams({ filename })}`;

describe("a source that fails", () => {
  it("leaves SubSource out when it refuses, and still lists the others, with no crash", async () => {
    sites((url) => (url.hostname === "api.subsource.net" ? new Response("too many requests", { status: 429 }) : openSubtitlesArabic(url, 9101)));
    const answer = await list({ subsource: "sk_failing_key_0001", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000701:1:5");
    expect(answer.status).toBe(200);
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9101"]);
    await later(50, () => undefined);
    expect(rejections).toEqual([]);
    const noted = (await stats.statsView("test")).errors.filter((e) => e.where === "subsource");
    expect(noted.length).toBe(1);
    expect(noted[0].message).toMatch(/SubSource 429/);
  });

  it("does the same when SubSource can't be reached at all", async () => {
    sites((url) => {
      if (url.hostname === "api.subsource.net") throw new TypeError("fetch failed");
      return openSubtitlesArabic(url, 9102);
    });
    const answer = await list({ subsource: "sk_offline_key_00002", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000702:1:5");
    expect(answer.status).toBe(200);
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9102"]);
    await later(50, () => undefined);
    expect(rejections).toEqual([]);
  });

  it("loses only the language whose SubSource list failed", async () => {
    sites((url) => {
      if (url.hostname === "api.subsource.net" && url.pathname.endsWith("/subtitles") && url.searchParams.get("language") === "arabic") return new Response("oops", { status: 500 });
      return subsource(url, { dutch: [sub(9103, "Show S01E05", { language: "dutch" })] }, {}, 103);
    });
    const answer = await list({ subsource: "sk_half_broken_00003", languages: ["Arabic", "Dutch"], allowMachine: false, hearingImpaired: "include" }, "tt0000703:1:5");
    expect(answer.status).toBe(200);
    expect(answer.subtitles.map((t) => [t.lang, refOfTrack(t)])).toEqual([["Dutch", "ss9103"]]);
    await later(50, () => undefined);
    expect(rejections).toEqual([]);
  });
});

describe("a slow source", () => {
  it("doesn't take the fast ones' results with it, and the partial list is kept briefly", async () => {
    sites((url) => {
      if (url.hostname === "api.subdl.com") return json({ status: true, subtitles: [{ url: "/subtitle/9104-1.zip", language: "AR", release_name: "Show S01E05", season: 1, episode: 5 }] });
      if (url.hostname === "opensubtitles.stremio.homes") return later(6000, () => json({ subtitles: [] }));
      return undefined;
    });
    const answer = await list({ subdl: "subdl_fast_key_0004", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000704:1:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["sd9104-1"]);
    expect(answer.ms).toBeLessThan(5000);
    expect(answer.cache).toBe("max-age=30");
    expect(answer.cacheMaxAge).toBe(30);
  }, 15000);

  it("keeps a full list five minutes, as before", async () => {
    sites((url) => subsource(url, { arabic: [sub(9105, "Show S01E05", { language: "arabic" })] }, {}, 105) ?? openSubtitlesArabic(url, 9106));
    const answer = await list({ subsource: "sk_all_fast_key_0005", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000705:1:5");
    expect(answer.subtitles).toHaveLength(1);
    expect(answer.cache).toBe("max-age=300, stale-while-revalidate=900");
    expect(answer.cacheMaxAge).toBe(300);
  });

  it("answers a new anime's first list in time while its id is looked up, and lists it next time", async () => {
    sites((url) => {
      if (url.hostname === "anime-kitsu.strem.fun") return later(6000, () => json({ meta: { imdb_id: "tt0000706", videos: [{ episode: 5, imdbSeason: 1, imdbEpisode: 5 }] } }));
      return openSubtitlesArabic(url, 9107);
    });
    const settings: Settings = { opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" };
    const first = await list(settings, "kitsu:7006:5");
    expect(first.ms).toBeLessThan(5000);
    expect(first.subtitles).toEqual([]);
    expect(first.cacheMaxAge).toBe(30);
    await later(Math.max(0, 6500 - first.ms), () => undefined);
    const next = await list(settings, "kitsu:7006:5");
    expect(next.subtitles.map(refOfTrack)).toEqual(["osar-9107"]);
  }, 20000);
});

describe("dub caption and CC tracks", () => {
  const dubs = [9201, 9202, 9203, 9204, 9205].map((id) => sub(id, `Show S01E05 [Eng Dubbed Version] ${id}`, { downloads: 100 - id + 9200 }));

  it("lists three dub tracks at most; the others stand behind them as fallbacks", async () => {
    sites((url) => subsource(url, { english: dubs }, {}, 107) ?? cinemeta(url));
    const settings: Settings = { subsource: "sk_dub_cap_key_0006", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    const bare = await list(settings, "tt0000707:1:5");
    expect(bare.subtitles.map(refOfTrack)).toEqual(["ss9201", "ss9202", "ss9203"]);
    // With a file playing, each track's fallbacks are in its link, the unlisted ones too.
    await fileWithoutTrack("Show.S01E05.Cap.mkv");
    const played = await list(settings, "tt0000707:1:5", playing("Show.S01E05.Cap.mkv"));
    expect(played.subtitles.map(refOfTrack)).toEqual(["ss9201", "ss9202", "ss9203"]);
    expect(altsOf(played.subtitles[0])).toEqual(["ss9202", "ss9203", "ss9204", "ss9205"]);
    expect(altsOf(played.subtitles[2])).toEqual(["ss9204", "ss9205"]);
  });

  it("gives English CC the other official CC tracks as fallbacks", async () => {
    const cc = [9211, 9212].map((id) => sub(id, `Show S01E05 ${id}`, { hearingImpaired: true, commentary: "Netflix", downloads: 9300 - id }));
    sites((url) => subsource(url, { english: cc }, {}, 108) ?? cinemeta(url));
    await fileWithoutTrack("Show.S01E05.CC.mkv");
    const answer = await list({ subsource: "sk_cc_alts_key_0007", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "tt0000708:1:5", playing("Show.S01E05.CC.mkv"));
    expect(answer.subtitles).toHaveLength(1);
    expect(answer.subtitles[0].label).toMatch(/^CC · /);
    expect(refOfTrack(answer.subtitles[0])).toBe("ss9211");
    expect(altsOf(answer.subtitles[0])).toEqual(["ss9212"]);
  });
});

describe("dub captions in a pack that turned out not to hold the episode", () => {
  it("don't count, so the regular English fallback is listed instead of nothing", async () => {
    const pack = sub(9801, "Show S02 English Dub SDH", { files: 2, hearingImpaired: true });
    const regular = sub(9802, "Show S02E02 1080p WEB");
    sites((url) => subsource(url, { english: [pack, regular] }, {}, 116) ?? cinemeta(url));
    const settings: Settings = { subsource: "sk_missing_pack_k_16", languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    expect((await list(settings, "tt0000716:2:2")).subtitles.map((t) => [refOfTrack(t), t.label])).toEqual([["ss9801", "Dub · AIOSubtitles"]]);
    // Opened (by a play): it holds episode 1 only.
    await mkdir(path.join(process.cwd(), CACHE, "subtitles"), { recursive: true });
    await writeFile(path.join(process.cwd(), CACHE, "subtitles", "9801-2-2.missing"), "");
    expect((await list(settings, "tt0000716:2:2")).subtitles.map((t) => [t.lang, refOfTrack(t), t.label])).toEqual([["English", "ss9802", "AIOSubtitles"]]);
  });
});

describe("the first list on a file timed by its own track", () => {
  it("waits for the syncs and lists the fallback that fits in place of the top pick that doesn't", async () => {
    const lines = dialogue(11);
    const right = lines.map((c) => ({ start: c.start - 1500, end: c.end - 1500 }));
    const wrong = dialogue(97);
    sites((url) =>
      subsource(
        url,
        { arabic: [sub(9301, "Show S01E05", { language: "arabic", commentary: "Netflix" }), sub(9302, "Show S01E05", { language: "arabic" })] },
        { "9301": srt(wrong), "9302": srt(right) },
        109
      )
    );
    await fileWithTrack("Show.S01E05.Index.mkv", lines);
    const answer = await list({ subsource: "sk_first_list_key_08", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000709:1:5", playing("Show.S01E05.Index.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9302"]);
    expect(answer.subtitles[0].label).toBe("Synced · AIOSubtitles");
    expect(answer.ms).toBeLessThan(5600);
    // Settled: kept the usual five minutes.
    expect(answer.cacheMaxAge).toBe(300);
    // The download serves it synced, from what the list already did.
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(download.headers.get("cache-control")).toMatch(/immutable/);
    expect(await download.text()).toContain(`00:00:${String(Math.floor(lines[0].start / 1000) % 60).padStart(2, "0")}`);
  }, 20000);
});

describe("SubDL's daily downloads", () => {
  const subdlSearch = (id: string) => (url: URL) => {
    if (url.hostname === "api.subdl.com") return json({ status: true, subtitles: [{ url: `/subtitle/${id}.zip`, language: "AR", release_name: "Show S01E05", season: 1, episode: 5 }] });
    if (url.hostname === "dl.subdl.com") return new Response(srt(dialogue(11).map((c) => ({ start: c.start - 700, end: c.end - 700 }))));
    return undefined;
  };

  it("are used by a list's syncs while plenty are left", async () => {
    const hits = sites(subdlSearch("9401-1"));
    await fileWithTrack("Show.S01E05.Quota1.mkv", dialogue(11));
    await list({ subdl: "subdl_plenty_key_0009", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000710:1:5", playing("Show.S01E05.Quota1.mkv"));
    await later(300, () => undefined);
    expect(hits.filter((h) => h.includes("dl.subdl.com"))).toHaveLength(1);
  });

  it("aren't spent by a list once only the last ten are left", async () => {
    const key = "subdl_spent_key_0010";
    for (let i = 0; i < 40; i++) stats.noteKeyCall("subdl", key, undefined, true);
    const hits = sites(subdlSearch("9402-1"));
    await fileWithTrack("Show.S01E05.Quota2.mkv", dialogue(11));
    const answer = await list({ subdl: key, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000711:1:5", playing("Show.S01E05.Quota2.mkv"));
    await later(300, () => undefined);
    expect(answer.subtitles.map(refOfTrack)).toEqual(["sd9402-1"]);
    expect(hits.filter((h) => h.includes("dl.subdl.com"))).toHaveLength(0);
    // A player asking for it still gets it.
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(download.status).toBe(200);
    expect(hits.filter((h) => h.includes("dl.subdl.com"))).toHaveLength(1);
  });
});

describe("the playing file's header", () => {
  it("is read from the start of a list, beside the searches, not after them", async () => {
    const started = Date.now();
    let asked: number | undefined;
    sites((url) => {
      // AIOStreams asked for the file (the header read's first step); it never answers here.
      if (url.hostname === "aiostreams.example.com") {
        asked ??= Date.now() - started;
        return new Promise<Response>(() => undefined);
      }
      if (url.hostname === "opensubtitles.stremio.homes") return later(3000, () => json({ subtitles: [{ sub_id: 9701, lang_code: "ar", title: "Show.S01E05.1080p.WEB" }] }));
      return undefined;
    });
    const answer = await list({ opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000714:1:5", playing("Show.S01E05.Header.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9701"]);
    expect(asked).toBeDefined();
    expect(asked!).toBeLessThan(1000);
  }, 15000);
});

describe("a download", () => {
  it("stays inside its 8 s budget, the subtitle's own slow fetch included", async () => {
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9501\/download$/.test(url.pathname)) return later(6000, () => new Response(srt(dialogue(5))));
      // Finding the file in AIOStreams hangs, so the sync can't finish.
      if (url.hostname === "aiostreams.example.com") return later(30000, () => json({ streams: [] }));
      return undefined;
    });
    const token = seal({ subsource: "sk_slow_download_011", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000712:1:5", type: "series", file: "Show.S01E05.Slow.mkv" });
    const started = Date.now();
    const res = await realFetch(`${base}/${token}/download/ss9501/subtitle.srt?${query}`);
    const text = await res.text();
    const ms = Date.now() - started;
    expect(res.status).toBe(200);
    expect(text).toContain("line 1");
    expect(ms).toBeGreaterThan(5900);
    expect(ms).toBeLessThan(8800);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

  it("gives SubSource's search and download a time limit", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    sites((url, init) => {
      signals.push(init?.signal);
      return subsource(url, { arabic: [] }, { "9601": srt(dialogue(3)) }, 113);
    });
    const { downloadSubtitleArchive, searchMoviesByImdb } = await import("../src/subsource.js");
    await searchMoviesByImdb("tt0000713", "sk_time_limit_key_12");
    await downloadSubtitleArchive(9601, "sk_time_limit_key_12");
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("an anime season named by its own title", () => {
  const SHOW: Record<string, [string, number, number, number]> = {
    // Anime Kitsu's entries for one show: name, IMDb season, its first IMDb episode, episodes.
    base: ["Show", 1, 1, 12],
    second: ["Show: Second Arc", 2, 1, 11],
    third: ["Show: Third Arc", 3, 1, 11],
    part: ["Show: Third Arc Part 2", 3, 12, 11]
  };
  /** The Anime Kitsu addon for a show with these entries (kitsu ids from `first` on), or failing. */
  const kitsu = (imdbId: string, first: number, names: string[], fail = false) => (url: URL) => {
    if (url.hostname !== "anime-kitsu.strem.fun") return undefined;
    if (fail) return new Response("busy", { status: 503 });
    if (url.pathname.includes("/catalog/")) return json({ metas: names.map((_, i) => ({ id: `kitsu:${first + i}`, type: "series", imdb_id: imdbId })) });
    const index = Number(url.pathname.match(/kitsu:(\d+)\.json$/)?.[1]) - first;
    const entry = SHOW[names[index]];
    if (!entry) return undefined;
    const [name, season, from, count] = entry;
    return json({ meta: { name, aliases: [], imdb_id: imdbId, videos: Array.from({ length: count }, (_, i) => ({ episode: i + 1, imdbSeason: season, imdbEpisode: from + i })) } });
  };
  /** SubSource with one record per season (movieId base + season), these Arabic subtitles in each, and these downloads. */
  const records = (url: URL, base: number, arabic: Record<number, unknown[]>, files: Record<string, Buffer> = {}, hits: number[] = []) => {
    if (url.hostname !== "api.subsource.net") return undefined;
    if (url.pathname.endsWith("/movies/search")) {
      return json({ data: Object.keys(arabic).map((season) => ({ movieId: base + Number(season), title: "Show", type: "tvseries", season: Number(season), subtitleCount: 9 })) });
    }
    if (url.pathname.endsWith("/subtitles")) {
      const season = Number(url.searchParams.get("movieId")) - base;
      hits.push(season);
      return json({ data: url.searchParams.get("language") === "arabic" ? (arabic[season] ?? []) : [], pagination: { pages: 1 } });
    }
    const download = url.pathname.match(/\/subtitles\/(\d+)\/download$/);
    return download && files[download[1]] ? new Response(new Uint8Array(files[download[1]])) : undefined;
  };
  const arabic = (id: number, name: string, extra: Record<string, unknown> = {}) => sub(id, name, { language: "arabic", files: null, ...extra });
  const settings = (key: string): Settings => ({ subsource: key, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });

  it("gives a second season's episode its own subtitle from a third season's record, not the first season's '- 03'", async () => {
    sites((url) =>
      records(url, 98100, {
        1: [arabic(98111, "[Group] Show - 03 [1080p]")],
        2: [],
        3: [arabic(98131, "[Group] Show - 03"), arabic(98132, "[Group] Show: Second Arc - 03"), arabic(98133, "[Group] Show: Third Arc - 03")]
      }) ??
      kitsu("tt0000981", 9001, ["base", "second", "third"])(url) ??
      cinemeta(url)
    );
    const answer = await list(settings("sk_season_title_0981"), "tt0000981:2:3");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss98132"]);
    expect(answer.cacheMaxAge).toBe(300);
    // The same record gives the first and third seasons their own.
    expect((await list(settings("sk_season_title_0981"), "tt0000981:3:3")).subtitles.map(refOfTrack)).toEqual(["ss98133"]);
    expect((await list(settings("sk_season_title_0981"), "tt0000981:1:3")).subtitles.map(refOfTrack)).toEqual(["ss98111"]);
  });

  it("searches every record of the show with a map, and only the first three without one", async () => {
    const lists = { 1: [arabic(98211, "Show - 05")], 2: [], 3: [], 5: [arabic(98251, "Show: Second Arc - 05")] };
    const hits: number[] = [];
    sites((url) => records(url, 98200, lists, {}, hits) ?? kitsu("tt0000982", 9011, ["base", "second", "third"])(url) ?? cinemeta(url));
    const answer = await list(settings("sk_all_records_00982"), "tt0000982:2:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss98251"]);
    expect([...new Set(hits)].sort()).toEqual([1, 2, 3, 5]);

    // The addon failing: no map, so everything goes as before. The fifth record isn't searched, and
    // the first season's "- 05" is listed for any season, as it always was.
    const without: number[] = [];
    sites((url) => records(url, 98300, lists, {}, without) ?? kitsu("tt0000983", 9021, [], true)(url) ?? cinemeta(url));
    const before = await list(settings("sk_no_map_key_000983"), "tt0000983:2:5");
    expect(before.subtitles.map(refOfTrack)).toEqual(["ss98211"]);
    expect([...new Set(without)].sort()).toEqual([1, 2, 3]);
  });

  it("downloads a part's episode from its pack by the part's own number", async () => {
    const pack = new AdmZip();
    for (let n = 1; n <= 11; n++) pack.addFile(`Show - Third Arc Part 2 - ${String(n).padStart(2, "0")}.srt`, Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\npart two, episode ${n}\n`));
    sites((url) =>
      records(url, 98400, { 1: [], 3: [arabic(98431, "[Group] Show: Third Arc Part 2 [1 ~ 11]", { files: 11 })] }, { "98431": pack.toBuffer() }) ??
      kitsu("tt0000984", 9031, ["base", "second", "third", "part"])(url) ??
      cinemeta(url)
    );
    const answer = await list(settings("sk_part_pack_k_00984"), "tt0000984:3:13");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss98431"]);
    const link = new URL(answer.subtitles[0].url);
    expect(link.searchParams.get("pick")).toBe("2");
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(await download.text()).toContain("part two, episode 2");
  });
});

describe("a show that isn't anime", () => {
  it("isn't looked up in the Anime Kitsu addon, and its list doesn't wait for it", async () => {
    const hits = sites((url) => {
      if (url.hostname === "v3-cinemeta.strem.io") return json({ meta: { country: "United States", genres: ["Drama"], name: "Show" } });
      // Asked, it would answer too late for the list.
      if (url.hostname === "anime-kitsu.strem.fun") return later(6000, () => json({ metas: [] }));
      return subsource(url, { arabic: [sub(9901, "Show S01E05", { language: "arabic" })] }, {}, 118);
    });
    const answer = await list({ subsource: "sk_not_anime_key_018", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000718:1:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9901"]);
    expect(answer.cacheMaxAge).toBe(300);
    expect(hits.filter((h) => h.includes("anime-kitsu.strem.fun"))).toEqual([]);
  });
});
