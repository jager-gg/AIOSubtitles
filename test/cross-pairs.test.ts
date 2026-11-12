/**
 * The cross check's pairs (scripts/cross-pairs.ts): which cached subtitles the data shows to belong
 * to another file than a played one. Every name here is a made-up stand-in.
 */
import { describe, expect, it } from "vitest";
import { belonging, cachedPlace, crossFacts, crossPairs, namedPlace, sameDialogueGroups, sampleOrder, showWords, type CrossData } from "../scripts/cross-pairs.js";

describe("places from names", () => {
  it("reads a cached subtitle's ref and the place it was downloaded for", () => {
    expect(cachedPlace("123-1-13.srt")).toEqual({ ref: "123", place: "1-13" });
    expect(cachedPlace("sd5-6-2-01.ass")).toEqual({ ref: "sd5-6", place: "2-1" });
    expect(cachedPlace("osxx-77-movie-full.vtt")).toEqual({ ref: "osxx-77", place: "film" });
    expect(cachedPlace("123-1-full.srt")).toBeUndefined();
    expect(cachedPlace("notes.txt")).toBeUndefined();
  });

  it("reads the season and episode a file's name spells out, and nothing from a bare number", () => {
    expect(namedPlace("Show.Name.S01E02.1080p.WEB.mkv/123")).toBe("1-2");
    expect(namedPlace("Show S02EP07 (1080p).mkv/9")).toBe("2-7");
    expect(namedPlace("Show S2 - 05.mkv/9")).toBe("2-5");
    expect(namedPlace("Show.S2-05.[WEB].mkv")).toBe("2-5");
    expect(namedPlace("Show.S01E141.2160p")).toBe("1-141");
    expect(namedPlace("A.Film.2024.2160p.x265.mkv/1")).toBeUndefined();
    expect(namedPlace("Show - 013 [720p].mkv")).toBeUndefined();
  });

  it("takes a show's title words, a group's tag in front left out", () => {
    expect(showWords("Show.Name.S01E02.1080p.mkv/1")).toBe("show name");
    expect(showWords("[Group] Show Name S2 - 02 [WEB 1080p].mkv/2")).toBe("show name");
    expect(showWords("Show Name (2023) S01E06 Title (1080p).mkv/3")).toBe("show name");
    expect(showWords("A.Film.2024.2160p.mkv/4")).toBe("a film");
  });
});

/** Two shows and a film, as the data would hold them. */
function data(): CrossData {
  return {
    files: ["Show.A.S01E01.1080p.mkv/1", "Show.A.S01E02.1080p.mkv/2", "Other.Group.Show.A.S01E03.mkv/3", "Show.B.S01E01.720p.mkv/4", "A.Film.2024.2160p.mkv/5", "Show.C.S03E08.WEB.mkv/6"],
    subtitles: ["10-1-1.srt", "10-1-2.srt", "11-1-3.srt", "12-1-1.srt", "20-1-1.srt", "30-movie-full.srt", "31-movie-full.srt", "40-1-9.srt", "41-2-2.srt", "41-2-1.srt", "50-1-1.srt"],
    served: [
      { file: "Show.A.S01E01.1080p.mkv/1", subtitle: "10-1-1.srt" },
      { file: "Show.A.S01E02.1080p.mkv/2", subtitle: "10-1-2.srt" },
      // A release whose name starts otherwise is joined by the upload it shares with the others.
      { file: "Other.Group.Show.A.S01E03.mkv/3", subtitle: "11-1-3.srt" },
      { file: "Show.A.S01E01.1080p.mkv/1", subtitle: "12-1-1.srt" },
      { file: "Show.B.S01E01.720p.mkv/4", subtitle: "20-1-1.srt" },
      { file: "A.Film.2024.2160p.mkv/5", subtitle: "30-movie-full.srt" }
    ],
    // 41 was found not to hold 2-2: what's kept under that name is its 2-1, byte for byte.
    missing: ["41-2-2"],
    sameBytes: [["41-2-2.srt", "41-2-1.srt"]]
  };
}

describe("how a subtitle stands to a file", () => {
  const facts = crossFacts({ ...data(), served: [...data().served, { file: "Other.Group.Show.A.S01E03.mkv/3", subtitle: "10-1-2.srt" }] });

  it("knows a file's own subtitles, and another episode's of the same show", () => {
    expect(belonging(facts, "Show.A.S01E01.1080p.mkv/1", "10-1-1.srt")).toBe("own");
    expect(belonging(facts, "Show.A.S01E01.1080p.mkv/1", "10-1-2.srt")).toBe("sibling");
    // Joined to the show by the upload it shares (10) with a subtitle served for this other release.
    expect(belonging(facts, "Other.Group.Show.A.S01E03.mkv/3", "10-1-1.srt")).toBe("sibling");
    expect(belonging(facts, "Other.Group.Show.A.S01E03.mkv/3", "11-1-3.srt")).toBe("own");
  });

  it("knows another show's, the same episode included, and a film's against an episode", () => {
    expect(belonging(facts, "Show.A.S01E01.1080p.mkv/1", "20-1-1.srt")).toBe("other");
    expect(belonging(facts, "Show.B.S01E01.720p.mkv/4", "10-1-1.srt")).toBe("other");
    expect(belonging(facts, "Show.A.S01E01.1080p.mkv/1", "31-movie-full.srt")).toBe("other");
    expect(belonging(facts, "A.Film.2024.2160p.mkv/5", "10-1-2.srt")).toBe("other");
    expect(belonging(facts, "A.Film.2024.2160p.mkv/5", "30-movie-full.srt")).toBe("own");
  });

  it("calls another place of an unknown show elsewhere, and the same place of one unknown", () => {
    expect(belonging(facts, "Show.A.S01E01.1080p.mkv/1", "40-1-9.srt")).toBe("elsewhere");
    expect(belonging(facts, "Show.A.S01E01.1080p.mkv/1", "50-1-1.srt")).toBe("unknown");
    // A film's subtitle no film file was served: which film is unknown.
    expect(belonging(facts, "A.Film.2024.2160p.mkv/5", "31-movie-full.srt")).toBe("unknown");
  });

  it("places a file with no stored result by its own name", () => {
    expect(belonging(facts, "Show.C.S03E08.WEB.mkv/6", "40-1-9.srt")).toBe("elsewhere");
    expect(belonging(facts, "Show.C.S03E08.WEB.mkv/6", "10-1-1.srt")).toBe("other");
  });

  it("doesn't trust a name the upload was found not to hold: its copies say what it is", () => {
    // 41-2-2.srt is 41-2-1.srt: on a file played as 2-1 nothing says it is another episode.
    const twoOne = crossFacts({ ...data(), files: ["Show.D.S02E01.mkv/7"], served: [{ file: "Show.D.S02E01.mkv/7", subtitle: "41-2-1.srt" }] });
    expect(belonging(twoOne, "Show.D.S02E01.mkv/7", "41-2-1.srt")).toBe("own");
    const alone = crossFacts({ ...data(), files: ["Show.D.S02E01.mkv/7"], sameBytes: [], served: [{ file: "Show.D.S02E01.mkv/7", subtitle: "41-2-1.srt" }] });
    expect(belonging(alone, "Show.D.S02E01.mkv/7", "41-2-2.srt")).toBe("unknown");
  });
});

/** Made-up dialogue: line k of a numbered script, four words each. */
const script = (from: number, to: number, tag = "word") => Array.from({ length: to - from }, (_, k) => `${tag} number ${from + k} here`);

describe("the same dialogue under other names", () => {
  it("groups subtitles whose lines are mostly the same words, whatever their tags, case and timing", () => {
    const lines = new Map([
      ["a-1-6.srt", script(0, 100)],
      // The same translation re-uploaded, styled and with a few lines of its own.
      ["b-1-7.srt", [...script(0, 80).map((l) => `<i>${l.toUpperCase()}!</i>`), ...script(500, 520)]],
      // Another episode: other lines, and the same 20 lines of song.
      ["c-1-8.srt", [...script(1000, 1100), ...script(0, 20)]]
    ]);
    expect(sameDialogueGroups(lines)).toEqual([["a-1-6.srt", "b-1-7.srt"]]);
  });

  it("leaves out short lines and stock phrases, and subtitles too short to tell", () => {
    const stock = ["yes", "what?", "come on now", "i know that"];
    const many = new Map(Array.from({ length: 14 }, (_, i) => [`s${i}-1-${i + 1}.srt`, [...Array(40).fill(0).flatMap(() => stock), ...script(i * 100, i * 100 + 40, `own${i}`)]]));
    expect(sameDialogueGroups(many)).toEqual([]);
    expect(sameDialogueGroups(new Map([["x-1-1.srt", script(0, 20)], ["y-1-2.srt", script(0, 20)]]))).toEqual([]);
  });

  it("shares the places of the same dialogue, so a subtitle kept under another episode's name isn't taken for that episode's", () => {
    const facts = crossFacts({ ...data(), sameDialogue: [["10-1-2.srt", "40-1-9.srt"]] });
    expect(belonging(facts, "Show.A.S01E02.1080p.mkv/2", "40-1-9.srt")).toBe("own");
    expect(belonging(facts, "Show.A.S01E01.1080p.mkv/1", "40-1-9.srt")).toBe("sibling");
  });
});

describe("the cross check's pairs", () => {
  it("lists only pairs known not to belong, one per subtitle and its copies", () => {
    const pairs = crossPairs(data());
    expect(pairs.every((p) => p.belongs !== ("own" as string))).toBe(true);
    expect(pairs.some((p) => p.subtitle === "41-2-2.srt")).toBe(false);
    const film = pairs.filter((p) => p.file === "A.Film.2024.2160p.mkv/5");
    expect(film.map((p) => p.subtitle)).not.toContain("30-movie-full.srt");
    expect(film.every((p) => p.belongs === "other")).toBe(true);
    const same = pairs.find((p) => p.file === "Show.B.S01E01.720p.mkv/4" && p.subtitle === "10-1-1.srt");
    expect(same).toMatchObject({ belongs: "other", samePlace: true });
  });

  it("lists the file's own pairs too when asked", () => {
    const own = crossPairs(data(), { own: true }).filter((p) => p.belongs === "own");
    expect(own.map((p) => `${p.file}|${p.subtitle}`)).toContain("Show.A.S01E01.1080p.mkv/1|10-1-1.srt");
    expect(own.every((p) => p.samePlace)).toBe(true);
  });

  it("orders a sample the same way every time", () => {
    expect(sampleOrder("a|b")).toBe(sampleOrder("a|b"));
    expect(sampleOrder("a|b")).not.toBe(sampleOrder("a|c"));
  });
});
