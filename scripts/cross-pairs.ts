/**
 * Which cached subtitles surely belong to another file than a played one: the pairs the cross check
 * (`npm run negatives`, see docs/scoring.md) syncs to make sure none of them is served as synced.
 *
 * Everything here is told from the data, never from a title written in code:
 *
 * - **Where a subtitle was downloaded for**: its cache name, `<ref>-<season|movie>-<episode|full>`,
 *   is the request's season and episode (or a film). A `.missing` marker beside a name says that
 *   upload was found not to hold that episode, so a file kept under that name is another episode's;
 *   the name then says nothing. Copies with the same bytes are one subtitle, with every place their
 *   names give. Subtitles that are the same dialogue, word for word (one upload retimed or re-uploaded
 *   elsewhere, or kept under another episode's name), share their places too.
 * - **Where a played file was played as**: the places of the subtitles its stored results served it,
 *   which are the request it was played for. A file with no stored result is placed by the season
 *   and episode its own name spells out (`S01E02`, `S1 - 02`), or not at all.
 * - **Which show**: a file and a subtitle are joined when a stored result served the one for the
 *   other (lists are found by the title's id), two subtitles when they are one upload (the same ref,
 *   or the same bytes), and two files when their names start with the same title words.
 *
 * Pure: scripts/score.ts reads the data and syncs the pairs; test/score.test.ts checks this on
 * made-up names.
 */
import { titleOf } from "./score-metrics.js";

/** Where something was downloaded or played for: "film", or "<season>-<episode>". */
export type Place = string;

/** A cached subtitle's ref and place, from its name; undefined when the name isn't a cache name. */
export function cachedPlace(name: string): { ref: string; place: Place } | undefined {
  const m = name.match(/^(.+)-(movie|\d+)-(full|\d+)\.[a-z0-9]+$/i);
  if (!m) return undefined;
  if ((m[2] === "movie") !== (m[3] === "full")) return undefined;
  return { ref: m[1], place: m[2] === "movie" ? "film" : `${Number(m[2])}-${Number(m[3])}` };
}

/** A played file's name without the size the server keeps after it ("name.mkv/12345"). */
function bare(file: string): string {
  return file.replace(/\/\d+$/, "");
}

/**
 * The season and episode a file's own name spells out: `S01E02`, `S01EP02`, `S1 - 02`, `S1-02`.
 * Undefined for anything else, a film included: a bare number may be an absolute episode, a year or
 * a resolution.
 */
export function namedPlace(file: string): Place | undefined {
  const name = bare(file);
  const m = name.match(/(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?ep?(\d{1,4})(?![0-9])/i) ?? name.match(/(?:^|[^a-z0-9])s(\d{1,2}) ?- ?(\d{1,4})(?![0-9])/i);
  return m ? `${Number(m[1])}-${Number(m[2])}` : undefined;
}

/**
 * The title words a file's name starts with (titleOf), a release group's tag in brackets in front
 * left out: two releases of one show are joined by them.
 */
export function showWords(file: string): string {
  return titleOf(bare(file).replace(/^\s*\[[^\]]*\]\s*/, ""));
}

/** What the cross check knows of one played file and the cached subtitles. */
export interface CrossData {
  /** Played files (file refs, "name/size"). */
  files: string[];
  /** Cached subtitle names. */
  subtitles: string[];
  /** Stored sync results: which subtitle was served for which file. */
  served: Array<{ file: string; subtitle: string }>;
  /** Cache stems ("<ref>-<season>-<episode>") with a `.missing` marker. */
  missing: string[];
  /** Subtitle names whose bytes are the same, in groups of two or more. */
  sameBytes: string[][];
  /** Subtitle names that are the same dialogue (see sameDialogueGroups), in groups of two or more. */
  sameDialogue?: string[][];
}

/** A line's words, to compare dialogue by: lower case, tags left out, letters and digits only. */
function wordsOf(line: string): string {
  return line
    .replace(/<[^>]*>|\{[^}]*\}/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A line needs this many words to tell one dialogue from another ("yes", "what?" are in every one). */
const SAME_LINE_WORDS = 3;
/** A line in more subtitles than this is a stock phrase, not this dialogue's. */
const COMMON_LINE = 12;
/** The share of the shorter subtitle's lines the other must have, word for word... */
const SAME_TEXT_SHARE = 0.5;
/** ...out of at least this many: an episode's songs alone give a sibling a few dozen lines in common. */
const SAME_TEXT_LINES = 30;

/**
 * Groups of subtitles that are the same dialogue: at least SAME_TEXT_SHARE of the distinct lines (of
 * SAME_LINE_WORDS words or more) of the one with fewer are lines of the other too. The bytes differ
 * when an upload is retimed, re-encoded or re-uploaded, or kept under another episode's name; its
 * words don't. Translations of the same episode by different people, and other episodes of the same
 * show (their songs and stock phrases aside), share far fewer lines. `lines`: each subtitle's text
 * lines, as written.
 */
export function sameDialogueGroups(lines: Map<string, string[]>): string[][] {
  const names = [...lines.keys()].sort();
  const distinct = names.map((n) => new Set(lines.get(n)!.map(wordsOf).filter((w) => w.split(" ").length >= SAME_LINE_WORDS)));
  const holders = new Map<string, number[]>();
  distinct.forEach((set, i) => set.forEach((w) => holders.set(w, [...(holders.get(w) ?? []), i])));
  const shared = new Map<string, number>();
  for (const held of holders.values()) {
    if (held.length < 2 || held.length > COMMON_LINE) continue;
    for (let a = 0; a < held.length; a++) for (let b = a + 1; b < held.length; b++) shared.set(`${held[a]} ${held[b]}`, (shared.get(`${held[a]} ${held[b]}`) ?? 0) + 1);
  }
  const { find, join } = joiner();
  for (const [key, count] of shared) {
    const [a, b] = key.split(" ").map(Number);
    const fewer = Math.min(distinct[a].size, distinct[b].size);
    if (fewer >= SAME_TEXT_LINES && count >= SAME_TEXT_SHARE * fewer) join(names[a], names[b]);
  }
  const groups = new Map<string, string[]>();
  for (const n of names) groups.set(find(n), [...(groups.get(find(n)) ?? []), n]);
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * How a subtitle stands to a file:
 * - `own`: downloaded for the place the file was played as, of its show (not a negative);
 * - `sibling`: joined to the file's show, downloaded for another of its episodes;
 * - `other`: another title. Either it is joined to other files' show and not to this one's, or one
 *   of the two is a film and the other an episode;
 * - `elsewhere`: downloaded for another episode, of a show joined to no file: another episode of
 *   this show or another show's, surely not this file's;
 * - `unknown`: nothing says (the same place, and a show joined to no file; or no place known).
 */
export type Belonging = "own" | "sibling" | "other" | "elsewhere" | "unknown";

export interface CrossPair {
  file: string;
  /** One name for the subtitle (the first of its copies with a place). */
  subtitle: string;
  /** "own" only when asked for (crossPairs with own): the pairs a fix must not lose. */
  belongs: Exclude<Belonging, "unknown">;
  /** The places on each side, for the report. */
  filePlaces: Place[];
  subtitlePlaces: Place[];
  /** The two are at the same place (another show's subtitle for the same episode, or two films). */
  samePlace: boolean;
}

/** A union-find over string keys. */
function joiner() {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    // Each key on the way points straight at the root, so later finds are short.
    let at = k;
    while (at !== root) {
      const next = parent.get(at) ?? root;
      parent.set(at, root);
      at = next;
    }
    if (!parent.has(root)) parent.set(root, root);
    return root;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, join };
}

/** What the data tells about each file and subtitle, before pairing them. */
export function crossFacts(data: CrossData) {
  const { find, join } = joiner();
  const missing = new Set(data.missing);
  // One subtitle per set of identical copies, named by its first name in order.
  const copyOf = new Map<string, string>();
  for (const group of data.sameBytes) {
    const names = [...group].sort();
    for (const n of names) copyOf.set(n, names[0]);
  }
  const subtitleOf = (name: string) => copyOf.get(name) ?? name;
  const subtitlePlaces = new Map<string, Set<Place>>();
  const subtitleNames = new Map<string, string[]>();
  for (const name of [...data.subtitles].sort()) {
    const cached = cachedPlace(name);
    if (!cached) continue;
    const id = subtitleOf(name);
    subtitleNames.set(id, [...(subtitleNames.get(id) ?? []), name]);
    const places = subtitlePlaces.get(id) ?? new Set<Place>();
    // A name the upload was found not to hold says nothing of what the file kept under it is.
    const stem = name.replace(/\.[a-z0-9]+$/i, "");
    if (!missing.has(stem)) places.add(cached.place);
    subtitlePlaces.set(id, places);
    join(`s:${id}`, `r:${cached.ref}`);
  }
  // The same dialogue is the same episode of the same show, whatever names it is kept under: each
  // keeps its own copy (their timing may differ), with every place the group's names give.
  for (const group of data.sameDialogue ?? []) {
    const ids = [...new Set(group.map(subtitleOf))].filter((id) => subtitlePlaces.has(id));
    const places = new Set(ids.flatMap((id) => [...subtitlePlaces.get(id)!]));
    for (const id of ids) {
      subtitlePlaces.set(id, new Set(places));
      join(`s:${id}`, `s:${ids[0]}`);
    }
  }
  const filePlaces = new Map<string, Set<Place>>();
  for (const { file, subtitle } of data.served) {
    const cached = cachedPlace(subtitle);
    if (!cached) continue;
    // The name is the request's place, whatever the file under it holds: what the file was played as.
    filePlaces.set(file, (filePlaces.get(file) ?? new Set<Place>()).add(cached.place));
    if (subtitlePlaces.has(subtitleOf(subtitle))) join(`f:${file}`, `s:${subtitleOf(subtitle)}`);
  }
  for (const file of data.files) {
    if (!filePlaces.has(file)) {
      const named = namedPlace(file);
      if (named) filePlaces.set(file, new Set([named]));
    }
    const words = showWords(file);
    if (words) join(`f:${file}`, `t:${words}`);
  }
  // Which shows have files: a subtitle joined to one of them is known to be that show's.
  const showsWithFiles = new Set(data.files.map((f) => find(`f:${f}`)));
  return { find, filePlaces, subtitlePlaces, subtitleNames, showsWithFiles };
}

/** How one subtitle (as crossFacts names it) stands to one file. */
export function belonging(facts: ReturnType<typeof crossFacts>, file: string, subtitle: string): Belonging {
  const fp = facts.filePlaces.get(file);
  const sp = facts.subtitlePlaces.get(subtitle);
  if (!fp?.size || !sp?.size) return "unknown";
  const samePlace = [...sp].some((p) => fp.has(p));
  const show = facts.find(`f:${file}`);
  const theirs = facts.find(`s:${subtitle}`);
  if (show === theirs) return samePlace ? "own" : "sibling";
  const film = (places: Set<Place>) => [...places].every((p) => p === "film");
  const episode = (places: Set<Place>) => [...places].every((p) => p !== "film");
  if ((film(fp) && episode(sp)) || (episode(fp) && film(sp))) return "other";
  if (facts.showsWithFiles.has(theirs)) return "other";
  return samePlace ? "unknown" : "elsewhere";
}

/**
 * Every pair of a played file and a cached subtitle known not to belong to it; with `own`, also
 * every one known to be its own (the same show and place), to see that a check refusing the others
 * keeps these.
 */
export function crossPairs(data: CrossData, { own = false } = {}): CrossPair[] {
  const facts = crossFacts(data);
  const out: CrossPair[] = [];
  for (const file of [...data.files].sort()) {
    for (const [subtitle, names] of facts.subtitleNames) {
      const belongs = belonging(facts, file, subtitle);
      if (belongs === "unknown" || (belongs === "own" && !own)) continue;
      const filePlaces = [...(facts.filePlaces.get(file) ?? [])].sort();
      const subtitlePlaces = [...(facts.subtitlePlaces.get(subtitle) ?? [])].sort();
      // Synced under a name whose place the subtitle has, so its sync key reads like a real one.
      const name = names.find((n) => subtitlePlaces.includes(cachedPlace(n)!.place)) ?? names[0];
      out.push({ file, subtitle: name, belongs, filePlaces, subtitlePlaces, samePlace: subtitlePlaces.some((p) => filePlaces.includes(p)) });
    }
  }
  return out;
}

/**
 * A stable order for picking a sample: the pairs sorted by a hash of their names, so a cap takes
 * the same pairs every run and on every machine, spread over every file and subtitle.
 */
export function sampleOrder(key: string): number {
  // FNV-1a, 32 bits: enough to shuffle, and the same everywhere.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
