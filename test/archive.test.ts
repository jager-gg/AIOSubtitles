import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { selectArchiveEntry } from "../src/downloads.js";

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

  it("still finds an episode by name in a season pack, and refuses one without it", () => {
    const pack = zip({ "Show.S01E01.srt": 40000, "Show.S01E02.srt": 41000 });
    expect(selectArchiveEntry(pack, 1, 2)?.entryName).toBe("Show.S01E02.srt");
    expect(selectArchiveEntry(pack, 1, 3)).toBeUndefined();
  });
});
