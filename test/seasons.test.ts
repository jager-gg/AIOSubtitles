/**
 * Anime seasons named by their own titles: the season map built from the Anime Kitsu addon (its
 * catalog searched by the show's name, each entry's titles and episodes), names read through it
 * ("Show: Second Arc - 03" is season 2's third, "Show: Third Arc Part 2 - 01" is season 3's twelfth),
 * every SubSource record of the show searched, the file of a part's pack found by its own number, and
 * everything as before without a map.
 */
import AdmZip from "adm-zip";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SeasonMap, StremioSubtitleRequest, SubSourceSubtitle } from "../src/types.js";

const CACHE = ".cache-seasons-test";
let ids: typeof import("../src/ids.js");
let matching: typeof import("../src/matching.js");
let downloads: typeof import("../src/downloads.js");
let subsource: typeof import("../src/subsource.js");

beforeAll(async () => {
  process.env.CACHE_DIR = CACHE;
  ids = await import("../src/ids.js");
  matching = await import("../src/matching.js");
  downloads = await import("../src/downloads.js");
  subsource = await import("../src/subsource.js");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Episodes own number -> IMDb place: from..to of this entry, starting at IMDb's season and episode. */
const run = (count: number, season: number, first = 1) => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), [season, first + i] as [number, number]]));

/** A show with a base season, a second arc, a third arc in two parts and a special, as Anime Kitsu lists such a show. */
const MAP: SeasonMap = {
  show: "Show",
  entries: [
    { titles: ["Show", "SHOW"], episodes: run(12, 1) },
    { titles: ["Show: Second Arc", "Show 2nd Season", "Show Second Season"], episodes: run(11, 2) },
    { titles: ["Show: Third Arc", "Show Season 3"], episodes: run(11, 3) },
    { titles: ["Show: Third Arc Part 2", "Show Season 3 Part 2", "ショー 第3期"], episodes: run(11, 3, 12) },
    { titles: ["Show: Second Arc Special", "Show (2016)"], episodes: { "1": [0, 1] } }
  ]
};

const sub = (subtitleId: number, names: string[], extra: Partial<SubSourceSubtitle> = {}): SubSourceSubtitle => ({
  subtitleId,
  movieId: 1,
  language: "arabic",
  releaseInfo: names,
  commentary: null,
  files: null,
  downloads: 0,
  rating: null,
  ...extra
});
const episode = (season: number, ep: number, absoluteEpisode?: number): StremioSubtitleRequest => ({ type: "series", id: `tt0000981:${season}:${ep}`, imdbId: "tt0000981", season, episode: ep, absoluteEpisode });
/** Which of these subtitles fit the request, read with the map (or without one: null). */
const fitting = (subs: SubSourceSubtitle[], request: StremioSubtitleRequest, map: SeasonMap | null = MAP) =>
  matching.filterAndRankDubtitles(subs, request, { requireDub: false, seasonMap: map ?? undefined }).map((s) => s.subtitleId);
const read = (name: string, request: StremioSubtitleRequest, extra: Partial<SubSourceSubtitle> = {}) => matching.readByTitle(sub(1, [name], extra), request, MAP);

describe("the season map", () => {
  const search = (metas: unknown[]) => json({ metas });
  const meta = (name: string, aliases: string[], videos: Array<[number, number, number]>) =>
    json({ meta: { name, aliases, imdb_id: "tt0000982", videos: videos.map(([episode, imdbSeason, imdbEpisode]) => ({ id: `kitsu:0:${episode}`, episode, imdbSeason, imdbEpisode })) } });

  it("is built from the catalog search, keeping only this show's entries, and cached", async () => {
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.push(url);
      if (url.includes("/catalog/anime/kitsu-anime-list/search=Show%20Two.json")) {
        return search([
          { id: "kitsu:9001", type: "series", imdb_id: "tt0000982" },
          { id: "kitsu:9002", type: "series", imdb_id: "tt0000982" },
          { id: "kitsu:9003", type: "series", imdb_id: "tt0000999" },
          { id: "kitsu:9004", type: "series" }
        ]);
      }
      if (url.endsWith("/meta/series/kitsu:9001.json")) return meta("Show Two", ["SHOW TWO"], [[1, 1, 1], [2, 1, 2]]);
      if (url.endsWith("/meta/series/kitsu:9002.json")) return meta("Show Two: Second Arc", ["Show Two 2nd Season"], [[1, 2, 1], [2, 2, 2]]);
      return new Response("not here", { status: 404 });
    });
    const map = await ids.seasonMap("tt0000982", async () => "Show Two");
    expect(map).toEqual({
      show: "Show Two",
      entries: [
        { titles: ["Show Two", "SHOW TWO"], episodes: { "1": [1, 1], "2": [1, 2] } },
        { titles: ["Show Two: Second Arc", "Show Two 2nd Season"], episodes: { "1": [2, 1], "2": [2, 2] } }
      ]
    });
    // Another show's entry and one without an IMDb id aren't fetched.
    expect(hits.filter((h) => h.includes("/meta/"))).toHaveLength(2);
    // Kept: asked again, nothing is fetched, not even the show's name.
    const asked = hits.length;
    const name = vi.fn(async () => "Show Two");
    expect(await ids.seasonMap("tt0000982", name)).toEqual(map);
    expect(hits).toHaveLength(asked);
    expect(name).not.toHaveBeenCalled();
  });

  it("is none for a show with one entry, and none when any entry can't be read", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search=Show%20One.json")) return search([{ id: "kitsu:9011", type: "series", imdb_id: "tt0000983" }]);
      if (url.includes("search=Show%20Three.json")) return search([{ id: "kitsu:9021", type: "series", imdb_id: "tt0000984" }, { id: "kitsu:9022", type: "series", imdb_id: "tt0000984" }]);
      if (url.endsWith("/meta/series/kitsu:9021.json")) return meta("Show Three", [], [[1, 1, 1]]);
      if (url.endsWith("/meta/series/kitsu:9022.json")) return new Response("busy", { status: 503 });
      return new Response("not here", { status: 404 });
    });
    expect(await ids.seasonMap("tt0000983", async () => "Show One")).toBeUndefined();
    // A map missing an entry would read that entry's names as another's.
    expect(await ids.seasonMap("tt0000984", async () => "Show Three")).toBeUndefined();
  });

  it("is none, not a part of one, when the show has more entries than are read or the search page is full", async () => {
    const metas: string[] = [];
    const entries = (imdbId: string, count: number, first: number) => Array.from({ length: count }, (_, i) => ({ id: `kitsu:${first + i}`, type: "series", imdb_id: imdbId }));
    const others = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `kitsu:${9900 + i}`, type: "series", imdb_id: "tt0000999" }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search=Show%20Many.json")) return search(entries("tt0000986", 13, 9031));
      // Twenty results: two of this show's, eighteen of others. The rest may be on the next page.
      if (url.includes("search=Show%20Full.json")) return search([...entries("tt0000987", 2, 9051), ...others(18)]);
      if (url.includes("search=Show%20Room.json")) return search([...entries("tt0000988", 2, 9061), ...others(17)]);
      const id = /kitsu:(\d+)\.json$/.exec(url)?.[1];
      if (id) {
        metas.push(id);
        return meta(`Show ${id}`, [], [[1, Number(id) - 9000, 1]]);
      }
      return new Response("not here", { status: 404 });
    });
    expect(await ids.seasonMap("tt0000986", async () => "Show Many")).toBeUndefined();
    expect(await ids.seasonMap("tt0000987", async () => "Show Full")).toBeUndefined();
    // Nothing was fetched for either.
    expect(metas).toEqual([]);
    // One result fewer: the page held them all.
    expect((await ids.seasonMap("tt0000988", async () => "Show Room"))?.entries).toHaveLength(2);
  });

  it("is none when the addon can't be reached, and that is kept briefly, not asked again at once", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new TypeError("fetch failed");
    });
    expect(await ids.seasonMap("tt0000985", async () => "Show Four")).toBeUndefined();
    expect(await ids.seasonMap("tt0000985", async () => "Show Four")).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("a name read through the season map", () => {
  it("with the show's title alone is the first season's", () => {
    const base = [sub(1, ["[Group] Show - 03 [1080p]"])];
    expect(fitting(base, episode(1, 3))).toEqual([1]);
    expect(fitting(base, episode(2, 3, 15))).toEqual([]);
    expect(fitting(base, episode(3, 3, 26))).toEqual([]);
  });

  it("with a later season's title is that season's, from whichever season's record it is listed under", () => {
    const names = [sub(1, ["Show - 03"], { recordSeason: 4 }), sub(2, ["Show: Second Arc - 03"], { recordSeason: 4 }), sub(3, ["Show: Third Arc - 03"], { recordSeason: 4 })];
    expect(fitting(names, episode(2, 3, 15))).toEqual([2]);
    expect(fitting(names, episode(3, 3, 26))).toEqual([3]);
    expect(fitting(names, episode(1, 3))).toEqual([1]);
    // Its number names this exact episode.
    expect(read("Show: Second Arc - 03", episode(2, 3, 15))).toEqual({ fits: true, exact: true });
  });

  it("counts a part's episodes from 1, as the part's own title does", () => {
    expect(read("Show: Third Arc Part 2 - 01", episode(3, 12, 35))).toEqual({ fits: true, exact: true, pick: 1 });
    expect(read("Show: Third Arc Part 2 - 01", episode(3, 1, 24))).toEqual({ fits: false });
    // "Cour 2" and "Cour Part 2" are the same part.
    expect(read("[Group] Show - Third Arc Cour Part 2 - 01 [1080p]", episode(3, 12, 35))?.pick).toBe(1);
    expect(read("[Group] Show - Third Arc Cour 2 - 011 [1080p]", episode(3, 22, 45))?.pick).toBe(11);
    // A number past the first part's own episodes counts on within its season.
    expect(read("Show: Third Arc - 21", episode(3, 21, 44))).toEqual({ fits: true, exact: true });
    // The same file named both ways: the number right after the title counts, the part's in brackets doesn't.
    expect(read("Show: Third Arc - 21 [P2 - 10]", episode(3, 10, 33))).toEqual({ fits: false });
    expect(read("Show: Third Arc - 21 [P2 - 10]", episode(3, 21, 44))).toEqual({ fits: true, exact: true });
    expect(fitting([sub(4, ["Show: Third Arc Part 2 - 10", "Show: Third Arc - 21 [P2 - 10]"])], episode(3, 10, 33))).toEqual([]);
    expect(fitting([sub(4, ["Show: Third Arc Part 2 - 10", "Show: Third Arc - 21 [P2 - 10]"])], episode(3, 21, 44))).toEqual([4]);
  });

  it("knows a season by its aliases, in any of their forms", () => {
    for (const name of ["Show 2nd Season - 05", "Show Second Season - 05", "Show S2 - 05", "Show Season 2 - 05", "Show.Season.Two.05"]) {
      expect(read(name, episode(2, 5, 17)), name).toEqual({ fits: true, exact: true });
    }
    expect(read("Show Season 3 Part 2 - 02", episode(3, 13, 36))?.pick).toBe(2);
    // An alias in another script is left out; one that is a year tells nothing.
    expect(read("Show (2016) - 01", episode(0, 1))?.fits).not.toBe(true);
  });

  it("takes a pack's range in the part's own count", () => {
    const pack = sub(1, ["Show: Third Arc Part 2 [1 ~ 11]"]);
    expect(matching.readByTitle(pack, episode(3, 15, 38), MAP)).toEqual({ fits: true, exact: false, pick: 4 });
    expect(matching.readByTitle(pack, episode(3, 4, 27), MAP)).toEqual({ fits: false });
    expect(fitting([sub(2, ["[Group] Show: Second Arc 01-11 Complete"], { files: 11 })], episode(2, 7, 19))).toEqual([2]);
    // Reversed, and counted on within the season.
    expect(fitting([sub(3, ["Show: Third Arc [22 ~ 12]"])], episode(3, 12, 35))).toEqual([3]);
    // A title alone is its whole season or part, unless a number stands before it.
    expect(fitting([sub(4, ["Show: Second Arc"])], episode(2, 9, 21))).toEqual([4]);
    expect(matching.readByTitle(sub(6, ["[Group] 03 - Show: Second Arc"]), episode(2, 9, 21), MAP)).toBeUndefined();
    // A lone file can't hold a range: its name isn't read so, and the rules without a map decide.
    expect(matching.readByTitle(sub(5, ["Show: Third Arc Part 2 [1 ~ 11]"], { files: 1 }), episode(3, 15, 38), MAP)).toBeUndefined();
  });

  it("keeps the season rule for a name that gives another season by number", () => {
    // The show's title with "Season 5": not a season the map has, so it's for season 5 as before.
    const fifth = sub(1, ["Show Season 5 Ep 17"], { recordSeason: 5 });
    expect(matching.readByTitle(fifth, episode(2, 17, 29), MAP)).toBeUndefined();
    expect(fitting([fifth], episode(2, 17, 29))).toEqual([]);
    expect(fitting([fifth], episode(5, 17, 70))).toEqual([1]);
    // A season's title with another season's number can't be read either.
    expect(read("Show: Second Arc S3 - 03", episode(2, 3, 15))).toBeUndefined();
  });

  it("leaves names that spell out the season and episode to their markers", () => {
    const spelled = sub(1, ["Show: Third Arc Part 2 S03E12 1080p"], { recordSeason: 4 });
    expect(matching.readByTitle(spelled, episode(3, 12, 35), MAP)).toBeUndefined();
    expect(fitting([spelled], episode(3, 12, 35))).toEqual([1]);
    expect(fitting([sub(2, ["Show.S02E03.1080p"], { recordSeason: 4 })], episode(2, 3, 15))).toEqual([2]);
  });

  it("isn't read when the map can't tell: an unknown title, two numbers, the show's title alone", () => {
    // A season the map doesn't list yet isn't taken for the first season's.
    expect(read("Show: Fourth Arc - 03", episode(1, 3))).toBeUndefined();
    expect(read("Show 2 - 03", episode(2, 3, 15))).toBeUndefined();
    // A number in brackets after a word of its own is a tag's, not the episode's.
    expect(read("Show: Second Arc [Group 2]", episode(2, 2, 14))).toBeUndefined();
    expect(read("Show: Third Arc [P2 - 10]", episode(3, 10, 33))).toBeUndefined();
    // A tag in brackets before the number is passed over.
    expect(read("Show: Second Arc (TV) - 03", episode(2, 3, 15))).toEqual({ fits: true, exact: true });
    expect(read("Show [Arabic]", episode(1, 3))).toBeUndefined();
    // Unless it gives its season: then it is that season's.
    expect(read("Show (Season 1) [1080p x265]", episode(1, 3))).toEqual({ fits: true, exact: false });
    // A part the map doesn't know after a title it does.
    expect(read("Show: Second Arc Part 2 - 01", episode(2, 1, 13))).toBeUndefined();
    // Nothing of the show's titles at all.
    expect(read("[Group] 03 [1080p]", episode(1, 3))).toBeUndefined();
  });

  it("from a source that searched for the episode, lets only a later season's own title overrule it", () => {
    const trusted = (id: number, name: string) => sub(id, [name], { episodeTrusted: true });
    // "Show - 03" returned for season 2's third: the show's title alone doesn't say otherwise.
    expect(fitting([trusted(1, "Show - 03")], episode(2, 3, 15))).toEqual([1]);
    // A part's own title does: it's season 3's twelfth, not its first.
    expect(fitting([trusted(2, "Show: Third Arc Part 2 - 01")], episode(3, 1, 24))).toEqual([]);
    expect(fitting([trusted(2, "Show: Third Arc Part 2 - 01")], episode(3, 12, 35))).toEqual([2]);
  });

  it("without a map, or with one entry, reads everything as before", () => {
    const names = [sub(1, ["Show - 03"], { recordSeason: 4 }), sub(2, ["Show: Second Arc - 03"], { recordSeason: 4 })];
    expect(fitting(names, episode(2, 3, 15), null)).toEqual([]);
    const single: SeasonMap = { show: "Show", entries: [MAP.entries[0]] };
    expect(fitting(names, episode(2, 3, 15), single)).toEqual([]);
    expect(matching.readByTitle(names[1], episode(2, 3, 15), single)).toBeUndefined();
    // Season 1's record, no map: the bare number fits any season, as it always has.
    expect(fitting([sub(3, ["Show - 03"], { recordSeason: 1 })], episode(2, 3, 15), null)).toEqual([3]);
    expect(fitting([sub(3, ["Show - 03"], { recordSeason: 1 })], episode(2, 3, 15))).toEqual([]);
  });

  it("with the show's title alone, under the requested season's own record, is judged as without a map", () => {
    // SubSource's season 2 record holds season 2's subtitles, named with the show's title alone.
    const own = sub(1, ["[Group] Show - 03 [1080p]"], { recordSeason: 2, movieId: 2 });
    expect(fitting([own], episode(2, 3, 15))).toEqual([1]);
    expect(fitting([own], episode(2, 3, 15), null)).toEqual([1]);
    expect(fitting([own], episode(2, 4, 16))).toEqual([]);
    // Its own season's title and a special's beside it don't make the record a mixed one.
    const beside = [own, sub(2, ["Show: Second Arc - 05"], { recordSeason: 2, movieId: 2 }), sub(3, ["Show: Second Arc Special"], { recordSeason: 2, movieId: 2 })];
    expect(fitting(beside, episode(2, 3, 15))).toEqual([1]);
    // Nor does another record's list, ranked with it.
    expect(fitting([own, sub(4, ["Show: Third Arc - 03"], { recordSeason: 3, movieId: 3 })], episode(2, 3, 15))).toEqual([1]);
  });

  it("with the show's title alone, under a record that mixes seasons, is the first season's", () => {
    // The season 2 record also holds a third season's names: it is filed by uploader, not by season.
    const mixed = [
      sub(1, ["[Group] Show - 03 [1080p]"], { recordSeason: 2, movieId: 2 }),
      sub(2, ["[Group] Show: Second Arc - 03 [1080p]"], { recordSeason: 2, movieId: 2 }),
      sub(3, ["[Group] Show: Third Arc - 03 [1080p]"], { recordSeason: 2, movieId: 2 })
    ];
    expect(fitting(mixed, episode(2, 3, 15))).toEqual([2]);
    expect(fitting(mixed, episode(1, 3))).toEqual([1]);
    expect(matching.mixedRecords(mixed, MAP)).toEqual(new Set([2]));
    // The same for a show's every season under its third season's record.
    const one = [sub(4, ["Show - 03"], { recordSeason: 3, movieId: 3 }), sub(5, ["Show: Second Arc - 03"], { recordSeason: 3, movieId: 3 })];
    expect(fitting(one, episode(3, 3, 26))).toEqual([]);
  });

  it("for a special (season 0), refuses a name that gives only another season", () => {
    const special = episode(0, 1);
    for (const map of [MAP, null]) {
      expect(fitting([sub(1, ["Show.S03.1080p.WEB"], { files: 11 })], special, map), "a season's pack").toEqual([]);
      expect(fitting([sub(2, ["Show.S03E05.1080p.WEB"])], special, map)).toEqual([]);
      expect(fitting([sub(3, ["Show.S00E02.1080p.WEB"])], special, map), "another special").toEqual([]);
      expect(fitting([sub(4, ["Show.S00E01.1080p.WEB"])], special, map)).toEqual([4]);
      expect(fitting([sub(5, ["Show Season 0"], { files: 3 })], special, map)).toEqual([5]);
      // A name that says it is a special may give its season; one that names none is taken as before.
      expect(fitting([sub(6, ["Show 2nd Season OVA"])], special, map)).toEqual([6]);
    }
    expect(fitting([sub(7, ["Show Specials"])], special, null)).toEqual([7]);
    // With the map, a special's own title places it.
    expect(fitting([sub(8, ["Show: Second Arc Special"])], special)).toEqual([8]);
    expect(fitting([sub(9, ["[Group] Show - 03 [1080p]"])], special)).toEqual([]);
  });

  it("ranks a single episode's subtitle above a pack holding it", () => {
    const pack = sub(1, ["Show: Second Arc [1 ~ 11]"], { downloads: 900 });
    const single = sub(2, ["Show: Second Arc - 03"], { downloads: 1 });
    expect(fitting([pack, single], episode(2, 3, 15))).toEqual([2, 1]);
  });
});

describe("SubSource's records of a show", () => {
  it("are all kept in order, the requested season, the whole series and season 1 first, the rest nearest first", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/movies/search")) {
        return json({
          data: [6, 1, 3, 0, 5, 2, 4, 7, 8, 9].map((season) => ({ movieId: 9900 + season, title: "Show", type: "tvseries", season, subtitleCount: season === 7 ? 0 : 5 }))
        });
      }
      return new Response("not here", { status: 404 });
    });
    const records = await subsource.findCandidateMovies(episode(4, 3, 40), "sk_records_test_0981");
    expect(records.map((r) => r.season)).toEqual([4, 0, 1, 3, 5, 2, 6, 8]);
    expect(records.slice(0, subsource.FIRST_RECORDS).map((r) => r.season)).toEqual([4, 0, 1]);
    expect(records.length).toBeLessThanOrEqual(subsource.MAX_RECORDS);
  });
});

describe("a part's pack", () => {
  const zip = (names: string[]) => {
    const z = new AdmZip();
    for (const name of names) z.addFile(name, Buffer.alloc(4000, 65));
    return new AdmZip(z.toBuffer());
  };
  const pad = (n: number) => String(n).padStart(2, "0");

  it("gives up its file by the part's own number", () => {
    const own = zip(Array.from({ length: 11 }, (_, i) => `Show - Third Arc Part 2 - ${pad(i + 1)}.ass`));
    expect(downloads.selectArchiveEntry(own, 3, 12, 1)?.entryName).toBe("Show - Third Arc Part 2 - 01.ass");
    // "Part 2" in every name isn't episode 2.
    expect(downloads.selectArchiveEntry(own, 3, 13, 2)?.entryName).toBe("Show - Third Arc Part 2 - 02.ass");
    // Named both ways: the one with both numbers.
    const both = zip(Array.from({ length: 11 }, (_, i) => `Show: Third Arc - ${pad(i + 12)} [P2 - ${pad(i + 1)}].ass`));
    expect(downloads.selectArchiveEntry(both, 3, 15, 4)?.entryName).toBe("Show: Third Arc - 15 [P2 - 04].ass");
    // Files counted on within the season: none has the part's number, so the season's.
    const counted = zip(Array.from({ length: 11 }, (_, i) => `Show - Third Arc - ${pad(i + 12)}.ass`));
    expect(downloads.selectArchiveEntry(counted, 3, 15, 4)?.entryName).toBe("Show - Third Arc - 15.ass");
    // Spelled out with the IMDb season and episode, that comes first.
    const spelled = zip(["Show.S03E12.ass", "Show.S03E13.ass"]);
    expect(downloads.selectArchiveEntry(spelled, 3, 13, 2)?.entryName).toBe("Show.S03E13.ass");
  });

  it("and a second arc's pack numbered like IMDb finds its file as before", () => {
    const arc = zip(Array.from({ length: 11 }, (_, i) => `Show: Second Arc - ${pad(i + 1)}.ass`));
    expect(downloads.selectArchiveEntry(arc, 2, 3)?.entryName).toBe("Show: Second Arc - 03.ass");
    // A part IMDb counts as a season of its own: "Part 2" in its names isn't episode 2 either.
    const part = zip(["Show Part 2 - 01.ass", "Show Part 2 - 02.ass"]);
    expect(downloads.selectArchiveEntry(part, 5, 2)?.entryName).toBe("Show Part 2 - 02.ass");
  });

  it("refuses a lone file that is another episode in both counts", () => {
    expect(downloads.selectArchiveEntry(zip(["Show - Third Arc Part 2 - 01.ass"]), 3, 13, 2)).toBeUndefined();
    expect(downloads.selectArchiveEntry(zip(["Show - Third Arc Part 2 - 01.ass"]), 3, 12, 1)?.entryName).toBe("Show - Third Arc Part 2 - 01.ass");
  });
});
