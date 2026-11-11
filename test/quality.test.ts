import { describe, expect, it } from "vitest";
import { filterAndRankDubtitles } from "../src/matching.js";
import { qualityTier } from "../src/quality.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "../src/types.js";

function sub(partial: Partial<SubSourceSubtitle>): SubSourceSubtitle {
  return { subtitleId: 1, movieId: 1, language: "arabic", releaseInfo: [], commentary: null, files: 1, downloads: 0, rating: { good: 0, bad: 0, total: 0 }, ...partial };
}

describe("translation quality", () => {
  it("drops machine and AI translations", () => {
    expect(qualityTier(sub({ commentary: "ترجمة آلية" }))).toBe(-1);
    expect(qualityTier(sub({ commentary: "Translated with ChatGPT" }))).toBe(-1);
    expect(qualityTier(sub({ commentary: "AI translated from English" }))).toBe(-1);
    expect(qualityTier(sub({ commentary: "ترجمة جوجل" }))).toBe(-1);
    expect(qualityTier(sub({ productionType: "machine translated" }))).toBe(-1);
  });

  it("treats Crunchyroll, Netflix and retail as official", () => {
    expect(qualityTier(sub({ commentary: "ترجمة كرانشي رول" }))).toBe(3);
    expect(qualityTier(sub({ commentary: "ترجمة كرنشي رول https://animesubarb.blogspot.com/" }))).toBe(3);
    expect(qualityTier(sub({ releaseInfo: ["Show.S01E01.1080p.NF.WEB-DL"], commentary: "Netflix" }))).toBe(3);
    expect(qualityTier(sub({ productionType: "retail" }))).toBe(3);
  });

  it("treats credited teams and sites as human, and the rest as unknown", () => {
    expect(qualityTier(sub({ commentary: "http://home.alphantom.com/index.php/ar/ horriblesubs متوافق" }))).toBe(2);
    expect(qualityTier(sub({ productionType: "improved" }))).toBe(2);
    expect(qualityTier(sub({ releaseInfo: ["Show 2017 - Ep001 To Ep170"] }))).toBe(1);
  });

  it("ranks an episode's Arabic: official, then human, then unknown", () => {
    const request: StremioSubtitleRequest = { type: "series", id: "tt0000004:1:13", imdbId: "tt0000004", season: 1, episode: 13, absoluteEpisode: 13 };
    const ranked = filterAndRankDubtitles(
      [
        sub({ subtitleId: 3187471, files: 170, downloads: 17, releaseInfo: ["Show 2017 - Ep001 To Ep170"] }),
        sub({ subtitleId: 1690964, downloads: 3, releaseInfo: ["[Phantom] Show - 13"], commentary: "http://home.alphantom.com/index.php/ar/ horriblesubs متوافق" }),
        sub({ subtitleId: 1696339, downloads: 2, releaseInfo: ["[HorribleSubs] Show - 13 [1080p]"], commentary: "ترجمة كرانشي رول" }),
        sub({ subtitleId: 9, downloads: 50, releaseInfo: ["Show - 13"], commentary: "ترجمة آلية" })
      ],
      request,
      { requireDub: false }
    );
    expect(ranked.map((s) => s.subtitleId)).toEqual([1696339, 1690964, 3187471]);
  });
});

describe("English CC fallback inputs (Netflix packs)", () => {
  it("places an episode in a pack that only says how many episodes it has, and keeps official HI tracks", () => {
    const request: StremioSubtitleRequest = { type: "series", id: "kitsu:1001:7", imdbId: "tt0000007", season: 1, episode: 7, absoluteEpisode: 7 };
    const ranked = filterAndRankDubtitles(
      [
        sub({ subtitleId: 2592520, language: "english", files: null, releaseInfo: ["Show"], commentary: "Rip from NETFLIX. (26 episodes - Phantom Blood", hearingImpaired: false }),
        sub({ subtitleId: 2592513, language: "english", files: null, releaseInfo: ["Show"], commentary: "Rip from NETFLIX. (26 episodes - Phantom Blood", hearingImpaired: true }),
        sub({ subtitleId: 1387723, language: "english", files: null, releaseInfo: ["gg Show 1-26 complete"], commentary: "http://www.ggkthx.org/", hearingImpaired: true })
      ],
      request,
      { requireDub: false, hearingImpaired: "only" }
    );
    expect(ranked.filter((s) => s.quality === 3).map((s) => s.subtitleId)).toEqual([2592513]);
    expect(filterAndRankDubtitles(ranked, { ...request, episode: 27, absoluteEpisode: 27 }, { requireDub: false })).toHaveLength(0);
  });
});
