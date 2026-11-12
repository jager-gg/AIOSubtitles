import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compilationRange, selectArchiveEntry } from "../src/downloads.js";

const zip = (files: Record<string, number>) => {
  const z = new AdmZip();
  for (const [name, size] of Object.entries(files)) z.addFile(name, Buffer.alloc(size, 65));
  return new AdmZip(z.toBuffer());
};

describe("the subtitle inside a downloaded zip", () => {
  it("takes the fullest file for a film, when the zip names it for several releases", () => {
    const z = zip({ "Film.2014.UHD.BluRay.2160p.REMUX-TEAM.ar.srt": 88254, "Film.2014.Bluray.1080p.REMUX-CREW.ar.srt": 88000 });
    expect(selectArchiveEntry(z)?.entryName).toBe("Film.2014.UHD.BluRay.2160p.REMUX-TEAM.ar.srt");
  });

  it("never takes a film's forced-lines file over the full one", () => {
    const z = zip({ "Film.2020.forced.srt": 120000, "Film.2020.srt": 90000 });
    expect(selectArchiveEntry(z)?.entryName).toBe("Film.2020.srt");
  });

  it("never takes a file that covers a run of episodes for one of them", () => {
    // Show on SubSource: subtitles of compilation videos, nine episodes a file.
    const spelled = zip({ "Show EP1-EP9 en.srt": 46000, "Show EP10-EP18 en.srt": 46000, "Show EP19-EP26 en.srt": 46000 });
    for (const episode of [1, 6, 9, 10, 26]) expect(selectArchiveEntry(spelled, 1, episode), `episode ${episode}`).toBeUndefined();
    const bare = zip({ "1-9en.srt": 46000, "10-18en.srt": 46000, "19-26en.srt": 46000, "27-35en.srt": 46000 });
    for (const episode of [1, 9, 18, 27]) expect(selectArchiveEntry(bare, 1, episode), `episode ${episode}`).toBeUndefined();
    expect(compilationRange("Show EP1-EP9 en.srt")).toEqual({ from: 1, to: 9 });
    expect(compilationRange("folder/10-18en.srt")).toEqual({ from: 10, to: 18 });
    // A double episode, an episode with a title after a dash, and a plain episode are not runs.
    expect(compilationRange("Show.S01E01-E02.srt")).toBeUndefined();
    expect(compilationRange("Show - 05 - The Return.srt")).toBeUndefined();
    expect(compilationRange("Show - 013 [720p].ass")).toBeUndefined();
    // An episode file beside the runs is still found.
    const mixed = zip({ "Show EP1-EP12.srt": 90000, "Show EP05.srt": 20000 });
    expect(selectArchiveEntry(mixed, 1, 5)?.entryName).toBe("Show EP05.srt");
  });

  it("still finds an episode by name in a season pack, and refuses one without it", () => {
    const pack = zip({ "Show.S01E01.srt": 40000, "Show.S01E02.srt": 41000 });
    expect(selectArchiveEntry(pack, 1, 2)?.entryName).toBe("Show.S01E02.srt");
    expect(selectArchiveEntry(pack, 1, 3)).toBeUndefined();
  });

  it("treats a special (season 0) as an episode, not a film", () => {
    // The fuller file would be a film's pick: a special's is the one named for it.
    const specials = zip({ "Show.S00E01.srt": 40000, "Show.S00E02.srt": 52000 });
    expect(selectArchiveEntry(specials, 0, 1)?.entryName).toBe("Show.S00E01.srt");
    expect(selectArchiveEntry(specials, 0, 2)?.entryName).toBe("Show.S00E02.srt");
    expect(selectArchiveEntry(specials, 0, 3)).toBeUndefined();
    // A lone file named for another special isn't this one.
    expect(selectArchiveEntry(zip({ "Show.S00E02.srt": 40000 }), 0, 1)).toBeUndefined();
    expect(selectArchiveEntry(zip({ "Show OVA.srt": 40000 }), 0, 1)?.entryName).toBe("Show OVA.srt");
    // By the subtitle's own count too.
    expect(selectArchiveEntry(specials, 0, 2, 1)?.entryName).toBe("Show.S00E02.srt");
  });
});

describe("an episode's file in a pack, by its number", () => {
  it("isn't another episode whose number starts the same", () => {
    const later = zip({ "Show.S01E30.srt": 40000, "Show.S01E31.srt": 40000, "Show.S01E32.srt": 40000 });
    expect(selectArchiveEntry(later, 1, 3)).toBeUndefined();
    const listedOutOfOrder = zip({ "Show.S01E10.srt": 40000, "Show.S01E01.srt": 40000 });
    expect(selectArchiveEntry(listedOutOfOrder, 1, 1)?.entryName).toBe("Show.S01E01.srt");
    expect(selectArchiveEntry(listedOutOfOrder, 1, 10)?.entryName).toBe("Show.S01E10.srt");
  });
});

describe("a season's number in a pack's file name", () => {
  it("isn't read as the episode", async () => {
    const { withoutSeasons } = await import("../src/downloads.js");
    // A "season pack" holding only episode 1 of season 2: not episode 2's file.
    const onlyFirst = zip({ "Show - S02E01.English[SDH].ass": 40000 });
    expect(selectArchiveEntry(onlyFirst, 2, 2)).toBeUndefined();
    expect(selectArchiveEntry(onlyFirst, 2, 1)?.entryName).toBe("Show - S02E01.English[SDH].ass");
    expect(selectArchiveEntry(zip({ "Show 3x01.srt": 40000 }), 3, 3)).toBeUndefined();
    expect(selectArchiveEntry(zip({ "Show E01 S04.srt": 40000 }), 4, 4)).toBeUndefined();
    expect(withoutSeasons("Show - S02E01")).toBe("Show - E01");
  });

  it("still finds a double episode's second half and a bare number", () => {
    expect(selectArchiveEntry(zip({ "Show.S01E05-E06.srt": 40000, "Show.S01E07.srt": 40000 }), 1, 6)?.entryName).toBe("Show.S01E05-E06.srt");
    expect(selectArchiveEntry(zip({ "Show - 01.ass": 40000, "Show - 02.ass": 40000 }), 2, 2)?.entryName).toBe("Show - 02.ass");
  });
});
