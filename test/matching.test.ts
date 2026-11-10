import { describe, expect, it } from "vitest";
import { bareEpisodeMarkerMatches, bareNumbers, dubtitlePhraseScore, filterAndRankDubtitles } from "../src/matching.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "../src/types.js";

/** A SubSource-style record with just what a test sets. */
const sub = (fields: Partial<SubSourceSubtitle>): SubSourceSubtitle => ({
  subtitleId: 1,
  movieId: 1,
  language: "english",
  releaseInfo: [],
  commentary: null,
  files: 1,
  downloads: 0,
  rating: { total: 0 },
  ...fields
});

/** A series request: season, episode and (optionally) the absolute episode. */
const episodeOf = (season: number, episode: number, absoluteEpisode?: number): StremioSubtitleRequest => ({
  type: "series",
  id: `tt0000001:${season}:${episode}`,
  imdbId: "tt0000001",
  season,
  episode,
  absoluteEpisode
});

describe("a subtitle that names another season", () => {
  const starfall = (subtitleId: number, episode: string, extra: Partial<SubSourceSubtitle> = {}) =>
    sub({ subtitleId, releaseInfo: [`The Starfall Season 5 (Original Name, Other Name) Ep ${episode}`], commentary: "FanSubs", ...extra });

  it("isn't taken for the same episode number of the season asked for", () => {
    // SubSource has this show's season 5 only; season 2's episode 17 is the 33rd of the show.
    const listed = [starfall(3206201, "17", { recordSeason: 5 }), starfall(3288550, "33", { recordSeason: 5 })];
    expect(filterAndRankDubtitles(listed, episodeOf(2, 17, 33), { requireDub: false })).toEqual([]);
    // The name alone is enough, whichever record it was listed under.
    expect(filterAndRankDubtitles([starfall(3206201, "17")], episodeOf(2, 17, 33), { requireDub: false })).toEqual([]);
  });

  it("is still taken for its own season, and a name spelling out the episode is taken from any record", () => {
    expect(filterAndRankDubtitles([starfall(3206201, "17", { recordSeason: 5 })], episodeOf(5, 17, 87), { requireDub: false }).map((s) => s.subtitleId)).toEqual([3206201]);
    const spelled = sub({ subtitleId: 7, releaseInfo: ["The.Starfall.S02E17.1080p.WEB-DL"], recordSeason: 5 });
    expect(filterAndRankDubtitles([spelled], episodeOf(2, 17, 33), { requireDub: false }).map((s) => s.subtitleId)).toEqual([7]);
  });

  it("leaves bare numbers alone when no season is named or the record is the whole show's", () => {
    const bare = sub({ subtitleId: 8, releaseInfo: ["Iron Lantern - 013 [720p]"], recordSeason: 0 });
    expect(filterAndRankDubtitles([bare], episodeOf(1, 13), { requireDub: false }).map((s) => s.subtitleId)).toEqual([8]);
    // Counting across the whole show under a "Season 1" name.
    const across = sub({ subtitleId: 9, releaseInfo: ["Iron Lantern Season 1 - 113"], recordSeason: 1 });
    expect(filterAndRankDubtitles([across], episodeOf(3, 11, 113), { requireDub: false }).map((s) => s.subtitleId)).toEqual([9]);
    // A numbered file with no season in its name, listed under another season's record.
    const stray = sub({ subtitleId: 10, releaseInfo: ["The Starfall Ep 17"], recordSeason: 5 });
    expect(filterAndRankDubtitles([stray], episodeOf(2, 17, 33), { requireDub: false })).toEqual([]);
  });
});

/** The ids of what ranks, best first. */
const rankedIds = (subs: SubSourceSubtitle[], request: StremioSubtitleRequest, options?: Parameters<typeof filterAndRankDubtitles>[2]) =>
  filterAndRankDubtitles(subs, request, options).map((s) => s.subtitleId);

describe("dub tags", () => {
  it.each(["Eng Dubbed Version", "eng dubbed version", "Eng-Dubbed-Version", "ENG_DUBBED_VERSION"])("%s is the exact tag", (tag) => {
    expect(dubtitlePhraseScore(tag)).toBe(2);
  });

  it.each([
    "Dubbed Version",
    "iron lantern Ep1-100 closed caption for dub version",
    "Wall Breakers Season 1 2013 English Dub Subtitles",
    "Storm Ninja Eng Dub Eng Sub Ep 141"
  ])("%s is a looser dub tag", (tag) => {
    expect(dubtitlePhraseScore(tag)).toBe(1);
  });

  it.each(["English subtitles WEB-DL retail", "Dubstep remix"])("%s is no dub tag", (text) => {
    expect(dubtitlePhraseScore(text)).toBe(0);
  });

  it("puts the exact tag ahead of a looser one, whatever the downloads", () => {
    const movie: StremioSubtitleRequest = { type: "movie", id: "tt0000002", imdbId: "tt0000002" };
    const subs = [sub({ subtitleId: 1, releaseInfo: ["Movie Dubbed Version"], downloads: 999 }), sub({ subtitleId: 2, releaseInfo: ["Movie Eng Dubbed Version"], downloads: 1 })];
    expect(rankedIds(subs, movie)).toEqual([2, 1]);
  });
});

describe("which subtitles fit the episode", () => {
  it("keeps this episode's file and a pack of the season, not another episode", () => {
    const subs = [
      sub({ subtitleId: 1, releaseInfo: ["Show S01E01 ENG Dubbed version"] }),
      sub({ subtitleId: 2, releaseInfo: ["Show S01E02 ENG Dubbed version"] }),
      sub({ subtitleId: 3, releaseInfo: ["Show S01 Complete DUBBED Version"], files: 12 })
    ];
    expect(rankedIds(subs, episodeOf(1, 1))).toEqual([1, 3]);
  });

  it("keeps a season pack named in words or digits only for that season", () => {
    const subs = [
      sub({ subtitleId: 1, releaseInfo: ["Show Season 2 English Dubbed Version"], files: null }),
      sub({ subtitleId: 2, releaseInfo: ["Show Second Season ENG Dubbed version"], files: null }),
      sub({ subtitleId: 3, releaseInfo: ["Show Season 1 English Dubbed Version"], files: null })
    ];
    expect(rankedIds(subs, episodeOf(2, 1))).toEqual([2, 1]);
  });

  it("finds an episode's file in a pack by its number alone", () => {
    expect(bareEpisodeMarkerMatches("Wall Breakers - 01v2 (BD 1080p English Dubbed).ass", 1)).toBe(true);
    expect(bareEpisodeMarkerMatches("Wall Breakers - 02 (BD 1080p English Dubbed).ass", 1)).toBe(false);
  });

  it("reads bare episode numbers but not resolutions, years, seasons or CRCs", () => {
    expect(bareNumbers("[HorribleSubs] Iron Lantern - 13 [720p]")).toEqual([13]);
    expect(bareNumbers("Iron Lantern 013 (BD 1080p HEVC Opus) [8046D0BE]")).toEqual([13]);
    expect(bareNumbers("Iron Lantern (2017) Season 2 Ep 5 x265 10bit")).toEqual([5]);
  });

  it("ranks every subtitle for the episode when no dub tag is required", () => {
    const subs = [
      sub({ subtitleId: 1, releaseInfo: ["[HorribleSubs] Iron Lantern - 12 [720p]"] }),
      sub({ subtitleId: 2, releaseInfo: ["[HorribleSubs] Iron Lantern - 13 [720p]"] }),
      sub({ subtitleId: 3, releaseInfo: ["Iron Lantern 13 [1080p]"], rating: { total: 5 } })
    ];
    expect(rankedIds(subs, episodeOf(1, 13, 13), { requireDub: false })).toEqual([3, 2]);
  });
});

describe("dub caption packs numbered across seasons", () => {
  const packs = (show: string, ranges: Array<[string, number]>) =>
    ranges.map(([range, files], i) => sub({ subtitleId: i + 1, files, releaseInfo: [`${show} ${range} closed caption for dub version`] }));

  it("keeps only the pack whose range holds the absolute episode, marked as numbered that way", () => {
    const ranked = filterAndRankDubtitles(packs("storm ninja", [["Ep1-100", 100], ["Ep101-221", 121]]), episodeOf(5, 3, 91));
    expect(ranked.map((s) => s.subtitleId)).toEqual([1]);
    expect(ranked[0].absoluteNumbered).toBe(true);
  });

  it("uses the episode itself when there is no absolute number", () => {
    expect(rankedIds(packs("iron lantern ", [["Ep1-100", 100], ["Ep101-170", 70]]), episodeOf(1, 120, 120))).toEqual([2]);
  });
});
