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
    const z = zip({ "Tempo.2014.UHD.BluRay.2160p.REMUX-FraMeSToR.ar.srt": 88254, "Tempo.2014.Bluray.1080p.REMUX-Machine.ar.srt": 88000 });
    expect(selectArchiveEntry(z)?.entryName).toBe("Tempo.2014.UHD.BluRay.2160p.REMUX-FraMeSToR.ar.srt");
  });

  it("never takes a film's forced-lines file over the full one", () => {
    const z = zip({ "Film.2020.forced.srt": 120000, "Film.2020.srt": 90000 });
    expect(selectArchiveEntry(z)?.entryName).toBe("Film.2020.srt");
  });

  it("never takes a file that covers a run of episodes for one of them", () => {
    // Crown of Frost on SubSource: subtitles of compilation videos, nine episodes a file.
    const spelled = zip({ "Crown of Frost EP1-EP9 en.srt": 46000, "Crown of Frost EP10-EP18 en.srt": 46000, "Crown of Frost EP19-EP26 en.srt": 46000 });
    for (const episode of [1, 6, 9, 10, 26]) expect(selectArchiveEntry(spelled, 1, episode), `episode ${episode}`).toBeUndefined();
    const bare = zip({ "1-9en.srt": 46000, "10-18en.srt": 46000, "19-26en.srt": 46000, "27-35en.srt": 46000 });
    for (const episode of [1, 9, 18, 27]) expect(selectArchiveEntry(bare, 1, episode), `episode ${episode}`).toBeUndefined();
    expect(compilationRange("Crown of Frost EP1-EP9 en.srt")).toEqual({ from: 1, to: 9 });
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
});
