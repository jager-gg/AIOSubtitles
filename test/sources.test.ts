import { describe, expect, it } from "vitest";
import { filterAndRankDubtitles } from "../src/matching.js";
import { openSubtitlesDownloadUrl, refOf } from "../src/sources.js";
import { languageCode, languageName } from "../src/langcodes.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "../src/types.js";

const request: StremioSubtitleRequest = { type: "series", id: "tt0000007:1:7", imdbId: "tt0000007", season: 1, episode: 7, absoluteEpisode: 7 };
const sub = (p: Partial<SubSourceSubtitle>): SubSourceSubtitle => ({ subtitleId: 0, movieId: 0, language: "english", releaseInfo: [], files: 1, downloads: 0, rating: null, ...p });

describe("other sources", () => {
  it("gives every source its own id", () => {
    expect(refOf(sub({ subtitleId: 2592513 }))).toBe("ss2592513");
    expect(refOf(sub({ ref: "sd3734901-8656630" }))).toBe("sd3734901-8656630");
    expect(openSubtitlesDownloadUrl("osen-11848200")).toBe("https://opensubtitles.stremio.homes/sub.vtt/?lang_code=en&sub_id=11848200");
    expect(openSubtitlesDownloadUrl("os../x")).toBeUndefined();
  });

  it("maps language names to the codes sources use", () => {
    expect(languageCode("Arabic")).toBe("ar");
    expect(languageCode("english")).toBe("en");
    expect(languageName("ar")).toBe("arabic");
  });

  it("finds SubDL's Disney+ English Dub pack as dub captions (Odd Journey S1)", () => {
    const ranked = filterAndRankDubtitles(
      [sub({ ref: "sdx", source: "subdl", files: 2, hearingImpaired: true, releaseInfo: ["Odd.Journey.S01.DSNP.English.Dub.SDH.CC.-Uploader"] })],
      request
    );
    expect(ranked.map(refOf)).toEqual(["sdx"]);
  });

  it("trusts a source that already searched for the episode, and leaves out AI translations", () => {
    const ranked = filterAndRankDubtitles(
      [
        sub({ ref: "osar-1", source: "opensubtitles", language: "arabic", episodeTrusted: true, releaseInfo: ["Odd Journey [Bluray] [Sh-Arab Team]"] }),
        sub({ ref: "osar-2", source: "opensubtitles", language: "arabic", episodeTrusted: true, productionType: "machine translated", releaseInfo: ["Odd Journey S01E07"] })
      ],
      request,
      { requireDub: false }
    );
    expect(ranked.map(refOf)).toEqual(["osar-1"]);
  });
});

describe("OpenSubtitles V3+ files and episodes", async () => {
  const { repairOpenSubtitlesVtt } = await import("../src/sources.js");
  const promo = "WEBVTT\n\nheader\n00:00:01.000 --> 00:00:06.000\n&gt;&gt;OpenSubtitles v3+ v0.0.4&lt;&lt;\n<u>=&gt;x.srt</u>\n\nWEBVTT\n\n";

  it("drops the promo cue and the second header", () => {
    expect(repairOpenSubtitlesVtt(promo + "0\n00:00:06.880 --> 00:00:12.550\nhello\n")).toBe("WEBVTT\n\n0\n00:00:06.880 --> 00:00:12.550\nhello\n");
  });

  it("un-comments lines its converter turned into NOTEs (BOM in the original)", () => {
    const broken = promo + "NOTE ﻿1\nNOTE 00:00:01.084 --> 00:00:03.420\nNOTE -[mechanical whirring]\n\nNOTE 2\nNOTE 00:00:03.500 --> 00:00:05.000\nNOTE Hi\n";
    expect(repairOpenSubtitlesVtt(broken)).toBe("WEBVTT\n\n1\n00:00:01.084 --> 00:00:03.420\n-[mechanical whirring]\n\n2\n00:00:03.500 --> 00:00:05.000\nHi\n");
  });

  it("doesn't trust a release that names another episode", () => {
    const req: StremioSubtitleRequest = { type: "series", id: "tt0000004:1:13", imdbId: "tt0000004", season: 1, episode: 13, absoluteEpisode: 13 };
    const ranked = filterAndRankDubtitles(
      [
        sub({ ref: "osar-9225974", language: "arabic", episodeTrusted: true, releaseInfo: ["Iron Lantern - 113 [WEB][Crunchyroll . Zero-Kon]"] }),
        sub({ ref: "osar-1", language: "arabic", episodeTrusted: true, releaseInfo: ["Iron Lantern - 13 [WEB]"] }),
        sub({ ref: "osar-2", language: "arabic", episodeTrusted: true, releaseInfo: ["Iron Lantern Arabic"] })
      ],
      req,
      { requireDub: false }
    );
    expect(ranked.map(refOf).sort()).toEqual(["osar-1", "osar-2"]);
  });
});
