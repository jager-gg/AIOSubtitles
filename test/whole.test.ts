/**
 * The whole-file test every timing must pass (accountsForFile in src/sync.ts): a subtitle of the file
 * starts within it, has lines in nearly every window of it with dialogue, and a timing by fits per
 * window rests on most of those windows. The made-up plays are test/synthetic.ts's.
 */
import { describe, expect, it } from "vitest";
import { accountsForFile, judge, wholeFile, type Anchor, type Cue, type FileAnchors } from "../src/sync.js";
import { dialogue, episode, faithful, indexFile, shifted, unrelated, without, windowFile, type SubLine } from "./synthetic.js";

const cues = (sub: SubLine[]): Cue[] => [...sub].sort((a, b) => a.start - b.start).map((l) => ({ start: l.start, end: l.end }));
const at = (shift: number) => () => shift;
/** An anchor on every window of the file, at one shift. */
const everyWindow = (found: FileAnchors, offset: number): Anchor[] => found.windows.filter((w) => !w.heard).map((w) => ({ from: w.from, to: w.to, offset, score: 0.8 }));

/** A 24-minute episode, timed from its index. */
const ep = episode(101);
const file = indexFile(ep.duration, [ep.lines]);

describe("how a timing sits on the whole file", () => {
  it("counts the lines inside the file, the windows with dialogue that hold one, and those the timing rests on", () => {
    const sub = cues(faithful(ep.lines));
    const talking = (windows: FileAnchors["windows"]) => windows.filter((x) => x.cues.length >= 6).length;
    expect(wholeFile(file, sub, at(0), everyWindow(file, 0).slice(0, 5))).toEqual({ inside: 1, windows: talking(file.windows), covered: talking(file.windows), anchored: talking(file.windows.slice(0, 5)) });
    // Moved three minutes late, the last lines fall past the end and the first minutes hold none.
    const late = wholeFile(file, sub, at(180000));
    expect(late.inside).toBeLessThan(1);
    expect(late.covered).toBeLessThan(late.windows);
  });

  it("passes the file's own subtitle, shifted, with a stray line far past the end", () => {
    const sub = [...cues(shifted(faithful(ep.lines), 2300)), { start: 2 * 3600000, end: 2 * 3600000 + 2000 }];
    expect(accountsForFile(file, sub, at(-2300), everyWindow(file, -2300))).toBeUndefined();
  });

  it("refuses a subtitle most of whose lines start past the file's end", () => {
    const film = episode(404, { minutes: 95, opening: false, breaks: 0 });
    expect(accountsForFile(file, cues(unrelated(film.lines)), at(0))).toMatch(/of its lines start within the file/);
  });

  it("refuses one that has lines in only a stretch of the file", () => {
    const trailer = dialogue(156, 2000, 150000);
    expect(accountsForFile(file, trailer, at(0))).toMatch(/has lines in only \d+ of the file's \d+ windows/);
  });

  it("refuses a timing by window fits that rests on too few of the file's windows, or on fewer than three", () => {
    const sub = cues(faithful(ep.lines));
    const all = everyWindow(file, 0);
    expect(accountsForFile(file, sub, at(0), all)).toBeUndefined();
    expect(accountsForFile(file, sub, at(0), all.slice(0, Math.floor(all.length / 2)))).toMatch(/rests on only/);
    const three = windowFile(ep.duration, ep.lines);
    const anchors = everyWindow(three, 0);
    expect(accountsForFile(three, sub, at(0), anchors)).toBeUndefined();
    expect(accountsForFile({ ...three, windows: three.windows.slice(0, 2) }, sub, at(0), anchors.slice(0, 2))).toMatch(/rests on only 2/);
  });

  it("counts only windows with dialogue: an index minute of a few lines, a bridge and heard speech don't count", () => {
    const sparse: FileAnchors = {
      ...file,
      windows: [
        ...file.windows.map((w) => (w.from < 600000 ? w : { ...w, cues: w.cues.slice(0, 3) })),
        { from: 0, to: 60000, cues: ep.lines.slice(0, 40), bridge: true },
        { from: 0, to: 40000, cues: [], speech: ep.lines.slice(0, 20), heard: true }
      ]
    };
    const early = cues(faithful(ep.lines.filter((c) => c.start < 600000)));
    const w = wholeFile(sparse, early, at(0));
    expect(w.windows).toBe(file.windows.filter((x) => x.from < 600000 && x.cues.length >= 6).length);
    expect(w.covered).toBe(w.windows);
  });
});

describe("the verdict, with the whole-file test", () => {
  it("still syncs this file's own subtitle, from another release", () => {
    expect(judge(file, cues(shifted(faithful(ep.lines), 2300))).verdict).toBe("synced");
  });

  it("refuses what the windows measured alone let through: too few of them to judge", () => {
    // A trailer's 30 lines meet one or two of the file's windows: the tests of measured windows
    // judge nothing below three, so before this they were served as synced.
    expect(judge(file, dialogue(156, 2000, 150000)).verdict).not.toBe("synced");
    // A sparse film's subtitle: few windows overlap it well enough to be measured.
    const film = without(unrelated(episode(2031, { minutes: 95, opening: false, breaks: 0 }).lines), 2031, 0.5);
    expect(judge(file, cues(film)).verdict).not.toBe("synced");
  });
});
