/**
 * Which subtitles fit the episode being played, and in what order. Everything
 * here reads the uploader's own words: release names, notes and file names.
 */
import type { RankedSubtitle, SeasonMap, StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";
import { qualityTier } from "./quality.js";

// ---------- dub captions ----------

/** Lower case letters and digits only, so "Eng-Dubbed_Version" reads as "engdubbedversion". */
const squash = (value: string) => value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The one tag that names English dub captions outright. */
const DUB_EXACT = "engdubbedversion";
/** Other ways uploaders say a subtitle follows the dub. */
const DUB_LOOSE = ["dubbedversion", "dubversion", "engdub", "englishdub"];

/** 2 for "Eng Dubbed Version", 1 for another dub tag, 0 for none. */
export function dubtitlePhraseScore(value: string): 0 | 1 | 2 {
  const text = squash(value);
  if (text.includes(DUB_EXACT)) return 2;
  return DUB_LOOSE.some((tag) => text.includes(tag)) ? 1 : 0;
}

/** Everything the uploader wrote about a subtitle, as one string to search. */
function searchableText(subtitle: SubSourceSubtitle): string {
  const said = [
    ...(subtitle.releaseInfo ?? []),
    subtitle.commentary,
    subtitle.productionType,
    subtitle.releaseType,
    subtitle.language,
    subtitle.link,
    ...(subtitle.contributors ?? []).map((person) => person.displayname)
  ];
  return said.filter(Boolean).join(" ");
}

// ---------- episode and season names ----------

/** A subtitle file a player can show, by its extension. */
export function fileLooksLikeSubtitle(filename: string): boolean {
  return /\.(srt|ass|ssa|vtt|sub)$/i.test(filename);
}

/**
 * Season and episode written together: "S01E05", "s1 e5", "E05 S01", "1x05", "S01E005". A number
 * ends where its digits do, so episode 3 isn't "S01E30" and season 1 isn't "S10".
 */
export function episodeMarkerMatches(value: string, season?: number, episode?: number): boolean {
  // Season 0 is IMDb's specials: "S00E01" is a marker like any other.
  if (season === undefined || !episode) return false;
  const s = `0*${season}(?!\\d)`;
  const e = `0*${episode}(?!\\d)`;
  const forms = [`s\\s*${s}\\D{0,4}e\\s*${e}`, `e\\s*${e}\\D{0,4}s\\s*${s}`, `\\b${season}x0*${episode}\\b`];
  return forms.some((form) => new RegExp(form, "i").test(value));
}

/** Each (season, episode) a name spells out, with which group holds which. */
const SEASON_EPISODE: Array<{ pattern: RegExp; episodeFirst: boolean }> = [
  { pattern: /s\s*0?(\d{1,2})\D{0,4}e\s*0?(\d{1,3})/gi, episodeFirst: false },
  { pattern: /e\s*0?(\d{1,3})\D{0,4}s\s*0?(\d{1,2})/gi, episodeFirst: true },
  { pattern: /\b(\d{1,2})x0?(\d{1,3})\b/gi, episodeFirst: false }
];

/** Every season and episode a name spells out together ("S02E05", "E05S02", "2x05"). */
export function extractEpisodeMarkers(value: string): Array<{ season: number; episode: number }> {
  const found: Array<{ season: number; episode: number }> = [];
  for (const { pattern, episodeFirst } of SEASON_EPISODE) {
    for (const [, first, second] of value.matchAll(pattern)) {
      const [season, episode] = episodeFirst ? [second, first] : [first, second];
      found.push({ season: Number(season), episode: Number(episode) });
    }
  }
  return found;
}

/** The episode as a number of its own in a file name: "Show - 01v2.ass" is episode 1. */
export function bareEpisodeMarkerMatches(value: string, episode?: number): boolean {
  if (!episode) return false;
  return new RegExp(`(?:^|\\D)0?${episode}(?:v\\d+)?(?:\\D|$)`, "i").test(value);
}

/** Seasons in words, by number: index 1 is "one" or "first". */
const NUMBER_WORDS = ["zero", "one|first", "two|second", "three|third", "four|fourth", "five|fifth", "six|sixth", "seven|seventh", "eight|eighth", "nine|ninth", "ten|tenth"];
const WORD_NUMBER = new Map(NUMBER_WORDS.flatMap((words, n) => words.split("|").map((word) => [word, n] as const)));
const ANY_WORD = NUMBER_WORDS.join("|");
/** "S2", "Season 2", "2nd Season", "Season Two", "Second Season". */
const SEASON_FORMS = [
  /\bs\s*0?(\d{1,2})\b/gi,
  /\bseason\D{0,4}0?(\d{1,2})\b/gi,
  /\b0?(\d{1,2})(?:st|nd|rd|th)?\D{0,4}season\b/gi,
  new RegExp(`\\bseason\\D{0,4}(${ANY_WORD})\\b`, "gi"),
  new RegExp(`\\b(${ANY_WORD})\\D{0,4}season\\b`, "gi")
];

/** The seasons a name mentions, in digits or words. */
export function extractSeasonMarkers(value: string): number[] {
  const seasons = new Set<number>();
  for (const form of SEASON_FORMS) {
    for (const [, said] of value.matchAll(form)) {
      const n = /^\d+$/.test(said) ? Number(said) : WORD_NUMBER.get(said.toLowerCase());
      if (n !== undefined) seasons.add(n);
    }
  }
  return [...seasons];
}

/** "Ep101-170", "Episodes 1-100", "E01~E25": a pack covering a span of episodes. */
export function extractEpisodeRange(value: string): { from: number; to: number } | undefined {
  const match = value.match(/\be(?:p(?:isodes?|s)?)?\.?\s*0*(\d{1,4})\s*(?:-|~|to)\s*(?:e(?:p(?:isodes?|s)?)?\.?\s*)?0*(\d{1,4})\b/i);
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = Number(match[2]);
  return to > from ? { from, to } : undefined;
}

/**
 * Episode-like numbers standing alone in release names ("- 013", "Ep 13",
 * "#13"), leaving out resolutions, years, codecs, CRCs and bit depths.
 */
export function bareNumbers(value: string): number[] {
  const cleaned = value
    .replace(/\[[0-9a-f]{8}\]/gi, " ")
    .replace(/\b(?:season|part|vol(?:ume)?|cour)\.?\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+(?:season|part|cour)\b|\bs\d{1,2}\b/gi, " ")
    .replace(/\b\d{3,4}p\b|\b(?:19|20)\d{2}\b|\b[xh]\.?26[45]\b|\b10-?bit\b|\b\d\.\d\b|\b(?:aac|ac3|opus|flac|dts)\d?\b/gi, " ");
  const found = new Set<number>();
  for (const match of cleaned.matchAll(/(?:^|[\s\-_\[(#]|\bep?\.?\s*)0*(\d{1,4})(?:v\d)?(?=[\s\])._\-]|$)/gi)) {
    const n = Number(match[1]);
    if (n > 0 && n < 2000) found.add(n);
  }
  return [...found];
}

// ---------- seasons named by their own titles ----------

/** Lower case, accents off ("Ō" is "o"): what titles and names are compared in. */
const plain = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** "first" to "tenth", by number. */
const ORDINAL_WORDS = new Map(NUMBER_WORDS.flatMap((words, n) => words.split("|").slice(1).map((word) => [word, n] as const)));
const countOf = (token?: string) => (token === undefined ? undefined : /^\d{1,2}$/.test(token) ? Number(token) : WORD_NUMBER.get(token));
const ordinalOf = (token?: string) => {
  const digits = token === undefined ? null : /^0?(\d{1,2})(?:st|nd|rd|th)$/.exec(token);
  return digits ? Number(digits[1]) : token === undefined ? undefined : ORDINAL_WORDS.get(token);
};

/** Release tags: words that stand beside a title without being part of it. */
const RELEASE_TAGS = new Set(
  [
    "web webrip webdl dl bd bdrip bluray blu ray hdtv tv dvd dvdrip hevc avc aac flac opus ac3 eac3 dts ddp dual audio multi sub subs softsub softsubs",
    "dub dubbed raw uncensored uncut complete batch end arabic english eng en ara ar jap jpn ja mkv mp4 avi ass srt ssa vtt zip rar torrent hd fhd uhd remux proper repack",
    "nf netflix amzn amazon cr crunchyroll funi funimation hidive dsnp disney hulu bili bilibili iqiyi viki"
  ]
    .join(" ")
    .split(" ")
);

/** A word of a title or a name, and where it stands in plain(name). */
interface Word {
  text: string;
  start: number;
  end: number;
}

/**
 * A title or a name as words, with seasons and parts in one form each: "2nd Season", "Second Season",
 * "Season Two" and "S2" are "season 2"; "Part 2", "Cour 2", "2nd Cour", "Cour Part 2" and "Pt2" are
 * "part 2". Numbers lose their leading zeros, and "the" is left out.
 */
function titleWords(text: string): Word[] {
  const raw = [...plain(text).matchAll(/[a-z0-9]+/g)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  const out: Word[] = [];
  for (let i = 0; i < raw.length; i++) {
    const [t, next, after] = [raw[i].text, raw[i + 1]?.text, raw[i + 2]?.text];
    const two = (kind: string, n: number, last: number) => {
      out.push({ text: kind, start: raw[i].start, end: raw[last].end }, { text: String(n), start: raw[i].start, end: raw[last].end });
      i = last;
    };
    const glued = /^(s|pt|part|cour)0?(\d{1,2})$/.exec(t);
    if (t === "season" && countOf(next) !== undefined) two("season", countOf(next) as number, i + 1);
    else if (next === "season" && ordinalOf(t) !== undefined) two("season", ordinalOf(t) as number, i + 1);
    else if (t === "cour" && next === "part" && countOf(after) !== undefined) two("part", countOf(after) as number, i + 2);
    else if ((t === "part" || t === "cour" || t === "pt") && countOf(next) !== undefined) two("part", countOf(next) as number, i + 1);
    else if ((next === "part" || next === "cour") && ordinalOf(t) !== undefined) two("part", ordinalOf(t) as number, i + 1);
    else if (glued) two(glued[1] === "s" ? "season" : "part", Number(glued[2]), i);
    else if (t !== "the") out.push({ ...raw[i], text: /^\d+$/.test(t) ? String(Number(t)) : t });
  }
  return out;
}

/** Where a phrase stands, word for word, in a list of words. */
function occurrences(words: Word[], phrase: string[]): number[] {
  const found: number[] = [];
  for (let i = 0; i + phrase.length <= words.length; i++) if (phrase.every((w, k) => words[i + k].text === w)) found.push(i);
  return found;
}

/** A season map ready to read names with (see compileSeasonMap). */
interface ReadableMap {
  /** The show's own titles, as words. */
  base: string[][];
  /** The entry the show's own titles stand for: the one holding IMDb's first episode. */
  baseEntry?: number;
  entries: Array<{
    /** The words that tell this entry apart: its titles past the show's own ("second arc", "season 2"). */
    phrases: string[][];
    episodes: Map<number, [number, number]>;
    seasons: Set<number>;
  }>;
  /** Every IMDb episode the map places, as "season:episode". */
  placed: Set<string>;
}

const compiled = new WeakMap<SeasonMap, ReadableMap>();

/**
 * The words that tell each entry apart. Titles in another script are left out (only Latin letters are
 * compared), and so are phrases that can't tell an entry apart: one shared by two entries, one that is
 * only numbers or release tags ("2016", "TV"), and one that is the show's own title.
 */
function compileSeasonMap(map: SeasonMap): ReadableMap {
  const kept = compiled.get(map);
  if (kept) return kept;
  const asWords = (title: string) => titleWords(title).map((w) => w.text);
  const unique = (lists: string[][]) => [...new Map(lists.filter((l) => l.length > 0).map((l) => [l.join(" "), l])).values()];
  const latin = (title: string) => !/\p{L}/u.test(plain(title).replace(/[a-z]/g, ""));
  const variants = map.entries.map((entry) => unique(entry.titles.filter(latin).map(asWords)));
  const episodes = map.entries.map((entry) => new Map(Object.entries(entry.episodes).map(([own, at]) => [Number(own), at] as [number, [number, number]])));

  // The show itself: the entry with IMDb's first episode (the one with the most of season 1, if two have it).
  let baseEntry: number | undefined;
  let most = 0;
  episodes.forEach((places, index) => {
    const seasonOne = [...places.values()].filter(([s]) => s === 1);
    if (seasonOne.some(([, e]) => e === 1) && seasonOne.length > most) [baseEntry, most] = [index, seasonOne.length];
  });
  // The show's name as Cinemeta gives it, unless it is a later entry's title too (then it can't say
  // which), and the first entry's titles.
  const laterTitles = new Set(variants.flatMap((list, index) => (index === baseEntry ? [] : list.map((v) => v.join(" ")))));
  const showName = asWords(map.show);
  const base = unique([...(laterTitles.has(showName.join(" ")) ? [] : [showName]), ...(baseEntry !== undefined ? variants[baseEntry] : [])]);
  const past = (title: string[]) => {
    const prefix = base.filter((b) => b.length < title.length && b.every((w, k) => title[k] === w)).sort((a, b) => b.length - a.length)[0];
    return prefix ? title.slice(prefix.length) : title;
  };
  const tells = (phrase: string[]) => phrase.some((w) => /[a-z]/.test(w) && !RELEASE_TAGS.has(w));
  const phrases = variants.map((list, index) => (index === baseEntry ? [] : unique(list.map(past).filter(tells))));
  const owners = new Map<string, number>();
  for (const list of phrases) for (const p of list) owners.set(p.join(" "), (owners.get(p.join(" ")) ?? 0) + 1);
  const own = new Set(base.map((b) => b.join(" ")));

  const readable: ReadableMap = {
    base,
    baseEntry,
    entries: phrases.map((list, index) => ({
      phrases: list.filter((p) => owners.get(p.join(" ")) === 1 && !own.has(p.join(" "))),
      episodes: episodes[index],
      seasons: new Set([...episodes[index].values()].map(([s]) => s))
    })),
    placed: new Set(episodes.flatMap((places) => [...places.values()].map(([s, e]) => `${s}:${e}`)))
  };
  compiled.set(map, readable);
  return readable;
}

/** Resolutions, years, codecs, CRCs and bit depths, blanked: never an episode number. */
const blankTags = (text: string) =>
  text.replace(/\[[0-9a-f]{8}\]|\b\d{3,4}p\b|\b(?:19|20)\d{2}\b|\b[xh]\.?26[45]\b|\b10-?bit\b|\b\d\.\d\b|\b(?:aac|ac3|opus|flac|dts)\d?\b/gi, (m) => " ".repeat(m.length));

/** A season by number, in any of its forms ("Season.01", "S2", "2nd Season", "Second Season"). */
const SEASON_WORD = new RegExp(
  `^(?:season[\\s._-]*0*\\d{1,2}|s0*\\d{1,2}|0*\\d{1,2}(?:st|nd|rd|th)[\\s._-]*season|(?:${[...ORDINAL_WORDS.keys()].join("|")})[\\s._-]*season|season[\\s._-]*(?:${ANY_WORD}))(?![a-z0-9])`
);

/**
 * The episode number, or the range of a pack, that follows a title: "- 03", "Ep 03", "[1 ~ 11]",
 * "01-11", "(01-24END)". Before it may stand only tags, words in brackets and a season number.
 * Anything else stops the reading ("stop"): more of a title ("Show: Third Arc" when the map doesn't
 * know it), or a part the map doesn't know ("Part 2"), so a number after it can't be placed. Two numbers
 * in a row ("Show 2 - 03") can't be told apart either, nor a number in brackets after a word of its
 * own ("[Group 2]", "[P2 - 10]"). undefined: no number at all (a title alone).
 * firstPart: the title names no part, so "Part 1" after it is the title's own first part.
 */
function numberAfter(after: string, firstPart: boolean): { from: number; to: number } | "stop" | undefined {
  let rest = blankTags(after);
  let depth = 0;
  let worded = false;
  const following = () => {
    const next = /^[^a-z0-9]*([a-z0-9]+)/.exec(rest);
    return next && /^\d+$/.test(next[1]) ? "stop" : undefined;
  };
  while (rest.length > 0) {
    const gap = /^[^a-z0-9]+/.exec(rest);
    if (gap) {
      for (const c of gap[0]) {
        if ("[({".includes(c)) [depth, worded] = [depth + 1, false];
        else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
      }
      rest = rest.slice(gap[0].length);
      continue;
    }
    if (depth > 0 && worded && /^\d/.test(rest)) return "stop";
    const season = SEASON_WORD.exec(rest);
    if (season) {
      rest = rest.slice(season[0].length);
      continue;
    }
    const first = /^(?:(?:part|cour|pt)[\s._-]*0*1|1st[\s._-]*(?:part|cour)|first[\s._-]*(?:part|cour))(?![a-z0-9])/.exec(rest);
    if (first && firstPart) {
      rest = rest.slice(first[0].length);
      continue;
    }
    // A range: "1 ~ 11", "01-11", "1 to 11"; spaced like "01 - 12" only from the first episode, since
    // "Show 2 - 03" is a title's number and an episode.
    const range = /^(?:ep?s?\.?\s*|episodes?\s*)?0*(\d{1,4})(?:v\d+)?(\s*(?:~|to)\s*|-|\s+-\s+)(?:ep?\.?\s*)?0*(\d{1,4})(?:v\d+)?(?:\s*end)?(?![a-z0-9])/.exec(rest);
    if (range && (!/\s-\s/.test(range[2]) || Number(range[1]) <= 1)) {
      const [a, b] = [Number(range[1]), Number(range[3])];
      rest = rest.slice(range[0].length);
      return a === b ? "stop" : following() ?? { from: Math.min(a, b), to: Math.max(a, b) };
    }
    const single = /^(?:ep?\.?\s*|episode\s*)?0*(\d{1,4})(?:v\d+)?(?:\s*end)?(?![a-z0-9])/.exec(rest);
    if (single) {
      rest = rest.slice(single[0].length);
      return following() ?? { from: Number(single[1]), to: Number(single[1]) };
    }
    const word = (/^[a-z0-9]+/.exec(rest) as RegExpExecArray)[0];
    if (/^(?:part|cour|pt)\d*$/.test(word)) return "stop";
    if (depth === 0 && !RELEASE_TAGS.has(word) && !/^v\d+$/.test(word)) return "stop";
    if (depth > 0) worded = true;
    rest = rest.slice(word.length);
  }
  return undefined;
}

/** What one release name says through the map. */
type NameReading =
  | { kind: "none" }
  | { kind: "unknown" }
  | {
      kind: "read";
      /** The IMDb episodes it is for, each with its number within the entry. */
      places: Array<{ at: [number, number]; own: number }>;
      /** Its numbers that have no IMDb place (in a range: "01-25" when the season has 24). */
      unplaced: number[];
      /** It gave a number or a range (not just a title). */
      numbered: boolean;
      single: boolean;
      /** How many words of the entry's own title it carries: more is more specific. */
      specific: number;
    };

/**
 * One release name read through the map. The entry is the one whose own words it carries (the most
 * of them, so "Third Arc Part 2" over "Third Arc"), or, with withBase, the show's first entry when it
 * carries only the show's title. Its number counts within that entry and is placed by the entry's table;
 * a number past the entry's own episodes counts on within its IMDb season ("Third Arc - 21" when the
 * arc's first part has 11), if the map has that episode.
 */
function readName(name: string, map: ReadableMap, withBase: boolean): NameReading {
  const text = plain(name);
  const words = titleWords(name);
  type Found = { entry: number; start: number; end: number; length: number; phrase: string[] };
  let best: Found | undefined;
  let tie = false;
  map.entries.forEach((entry, index) => {
    for (const phrase of entry.phrases) {
      for (const at of occurrences(words, phrase)) {
        const found = { entry: index, start: words[at].start, end: words[at + phrase.length - 1].end, length: phrase.length, phrase };
        if (!best || found.length > best.length) [best, tie] = [found, false];
        else if (found.length === best.length && found.entry !== best.entry) tie = true;
      }
    }
  });
  if (best && tie) return { kind: "unknown" };
  const shows = map.base.flatMap((b) => occurrences(words, b).map((at) => ({ start: words[at].start, end: words[at + b.length - 1].end, length: b.length })));
  if (!best) {
    if (!withBase || map.baseEntry === undefined || shows.length === 0) return { kind: "none" };
    const first = shows.sort((a, b) => b.length - a.length || a.start - b.start)[0];
    best = { entry: map.baseEntry, start: first.start, end: first.end, length: 0, phrase: [] };
  }
  const chosen: Found = best;
  const entry = map.entries[chosen.entry];
  if (entry.episodes.size === 0) return { kind: "unknown" };

  // A season the name gives by number, past its titles, has to be this entry's ("Show Season 5 Ep 17"
  // is for season 5): otherwise the name is left to the rules for seasons.
  const titled = [chosen, ...shows, ...entry.phrases.flatMap((p) => occurrences(words, p).map((at) => ({ start: words[at].start, end: words[at + p.length - 1].end })))];
  const rest = titled.reduce((s, span) => s.slice(0, span.start) + " ".repeat(span.end - span.start) + s.slice(span.end), text);
  const named = extractSeasonMarkers(rest);
  if (named.some((s) => !entry.seasons.has(s))) return { kind: "unknown" };

  const number = numberAfter(text.slice(chosen.end), !chosen.phrase.includes("part"));
  if (number === "stop") return { kind: "unknown" };
  if (number === undefined) {
    // A title alone is the whole entry, as a season's name alone is the whole season. The show's own
    // title alone says nothing, unless the name gives its season too ("Show (Season 1)").
    if (chosen.entry === map.baseEntry && named.length === 0) return { kind: "unknown" };
    // Nor is it the whole entry when a number stands before the title ("03 - Show: Second Arc").
    if (bareNumbers(blankTags(text.slice(0, Math.min(chosen.start, ...shows.map((s) => s.start))))).length > 0) return { kind: "unknown" };
    const places = [...entry.episodes].map(([own, at]) => ({ at, own }));
    // "Show S3" alone, where the entry it names is IMDb's season 3 (its first part), is all of that
    // season, as uploaders mean it; the parts after count on within it.
    const bySeason = chosen.phrase.length === 2 && chosen.phrase[0] === "season" ? Number(chosen.phrase[1]) : undefined;
    if (bySeason !== undefined && entry.seasons.size === 1 && entry.seasons.has(bySeason)) {
      const mine = new Set(places.map((p) => `${p.at[0]}:${p.at[1]}`));
      for (const key of map.placed) {
        const [s, e] = key.split(":").map(Number);
        if (s === bySeason && !mine.has(key)) places.push({ at: [s, e], own: e });
      }
    }
    return { kind: "read", places, unplaced: [], numbered: false, single: places.length === 1, specific: chosen.length };
  }
  if (number.to - number.from > 500) return { kind: "unknown" };
  const only = entry.seasons.size === 1 ? [...entry.seasons][0] : undefined;
  const places: Array<{ at: [number, number]; own: number }> = [];
  const unplaced: number[] = [];
  for (let n = number.from; n <= number.to; n++) {
    const at = entry.episodes.get(n) ?? (only && n >= 1 && map.placed.has(`${only}:${n}`) ? ([only, n] as [number, number]) : undefined);
    if (at) places.push({ at, own: n });
    else unplaced.push(n);
  }
  if (places.length === 0) return { kind: "unknown" };
  return { kind: "read", places, unplaced, numbered: true, single: number.from === number.to, specific: chosen.length };
}

/** What a subtitle's names say about the episode, read through the show's season map. */
export interface TitleReading {
  /** For the episode asked for. */
  fits: boolean;
  /** A name gives this exact episode. */
  exact?: boolean;
  /** Its number within the entry, when that isn't the IMDb episode: how its file is found in a pack. */
  pick?: number;
}

/**
 * A subtitle's names read through the show's season map (a series whose Anime Kitsu entries are two or
 * more). Names that spell out a season and episode ("S02E03") aren't read this way: those markers
 * decide, as before. Otherwise each name is read (readName); the subtitle fits when one of them places
 * the episode asked for, and doesn't when they place it elsewhere. undefined when no name could be
 * read: then everything goes as without a map. From a source that searched for the episode itself,
 * only a later season's own title can overrule it, not the show's title alone.
 *
 * Listed under the requested season's own SubSource record, the show's title alone ("[Group] Show -
 * 03") is how uploaders name that season's episodes too, so it doesn't make the subtitle another
 * season's: the rules without a map judge it. Not when that record mixes seasons (mixedRecord, see
 * mixedRecords): there, as for a show whose every season sits under one record, the show's title
 * alone is the first season's.
 */
export function readByTitle(subtitle: SubSourceSubtitle, request: StremioSubtitleRequest, seasonMap?: SeasonMap, mixedRecord = false): TitleReading | undefined {
  if (!seasonMap || seasonMap.entries.length < 2 || request.type !== "series" || request.season === undefined || !request.episode) return undefined;
  if (extractEpisodeMarkers(searchableText(subtitle)).length > 0) return undefined;
  const map = compileSeasonMap(seasonMap);
  const ownRecord = !mixedRecord && request.season > 0 && subtitle.recordSeason === request.season;
  let placedElsewhere = false;
  let pack = false;
  const covering: Array<{ reading: Extract<NameReading, { kind: "read" }>; own: number }> = [];
  for (const name of subtitle.releaseInfo ?? []) {
    const reading = readName(name, map, !subtitle.episodeTrusted);
    if (reading.kind !== "read") continue;
    // A lone file holds one episode: a range or a whole season can't be read from its name.
    if (subtitle.files === 1 && !reading.single) continue;
    const hit = reading.places.find((p) => p.at[0] === request.season && p.at[1] === request.episode);
    // The show's title alone, in this season's own record, doesn't place it elsewhere (see above).
    if (!hit && ownRecord && reading.specific === 0) continue;
    if (!reading.single) pack = true;
    if (hit) covering.push({ reading, own: hit.own });
    // A number the map can't place may still be this episode counted another way (across the show):
    // then the rules without a map judge it.
    else if (!reading.unplaced.some((n) => n === request.episode || n === request.absoluteEpisode)) placedElsewhere = true;
  }
  if (covering.length > 0) {
    // The file in a pack goes by the name that numbers it, the most specific one.
    const [best] = covering.sort((a, b) => Number(b.reading.numbered) - Number(a.reading.numbered) || b.reading.specific - a.reading.specific);
    // Exact: a name gives this one episode, and no other name makes it a pack.
    return { fits: true, exact: best.reading.single && !pack, ...(best.own !== request.episode ? { pick: best.own } : {}) };
  }
  return placedElsewhere ? { fits: false } : undefined;
}

/**
 * The SubSource records (by movieId) whose lists mix seasons: one of their names carries another
 * season's own title ("Show: Third Arc - 03" under season 2's record). Such a record is filed by
 * whoever uploaded first, not by season (seen: every season of a show under its season 3 record, each
 * named by its season's title), so there the show's title alone is the first season's. A special's
 * title doesn't count: specials are often filed under their season's record.
 */
export function mixedRecords(subtitles: SubSourceSubtitle[], seasonMap: SeasonMap): Set<number> {
  const mixed = new Set<number>();
  if (seasonMap.entries.length < 2) return mixed;
  const map = compileSeasonMap(seasonMap);
  for (const subtitle of subtitles) {
    const season = subtitle.recordSeason;
    if (season === undefined || season < 1 || mixed.has(subtitle.movieId)) continue;
    const another = (subtitle.releaseInfo ?? []).some((name) => {
      const reading = readName(name, map, false);
      return reading.kind === "read" && reading.places.some((p) => p.at[0] > 0) && !reading.places.some((p) => p.at[0] === season);
    });
    if (another) mixed.add(subtitle.movieId);
  }
  return mixed;
}

/**
 * Whether a name can be IMDb's special (season 0) of this number. Specials are named every which way
 * and are taken loosely, but a name that gives only other seasons ("Show.S03.1080p.WEB", a season's
 * pack, or "Show.S03E05") isn't one, nor one whose "S00E02" gives another special. A name that says
 * it is a special ("Show 2nd Season OVA") may still give its season.
 */
function mayBeSpecial(name: string, episode: number): boolean {
  const markers = extractEpisodeMarkers(name);
  if (markers.some((m) => m.season === 0)) return markers.some((m) => m.season === 0 && m.episode === episode);
  if (/\b(?:ova|oad|specials?|sp\d{0,2})\b/i.test(name)) return true;
  const seasons = [...markers.map((m) => m.season), ...extractSeasonMarkers(name)];
  return seasons.length === 0 || seasons.includes(0);
}

/**
 * Whether a subtitle can be for the requested episode. Movies always fit; for
 * a series, the most specific thing its names say decides: an exact episode,
 * the season its title names (byTitle, see readByTitle), a range, an episode
 * count, a bare number, then a season.
 */
export function subtitleMatchesRequestedEpisode(subtitle: SubSourceSubtitle, request: StremioSubtitleRequest, byTitle?: TitleReading): boolean {
  if (request.type !== "series" || !request.episode) return true;
  if (byTitle) return byTitle.fits;
  if (request.season === 0) return mayBeSpecial((subtitle.releaseInfo ?? []).join(" "), request.episode);
  if (!request.season) return true;
  if (subtitle.episodeTrusted) {
    // The source searched for this episode, but its match can be loose ("Show - 113" for E13):
    // trust it unless the release name itself names a different episode.
    const name = (subtitle.releaseInfo ?? []).join(" ");
    const wanted = [request.episode, request.absoluteEpisode].filter((n): n is number => n !== undefined);
    const markers = extractEpisodeMarkers(name);
    if (markers.length > 0) return markers.some((m) => (m.season === request.season && m.episode === request.episode) || (m.season <= 1 && wanted.includes(m.episode)));
    const bare = bareNumbers(name);
    return bare.length === 0 || bare.some((n) => wanted.includes(n));
  }
  const text = searchableText(subtitle);
  const markers = extractEpisodeMarkers(text);
  if (markers.length > 0) {
    return markers.some(
      (marker) =>
        (marker.season === request.season && marker.episode === request.episode) ||
        (request.absoluteEpisode !== undefined && marker.season <= 1 && marker.episode === request.absoluteEpisode)
    );
  }
  // Listed under another season's record (SubSource had none for this season, the whole series or
  // season 1, so that one was searched): only a name that spells out this season and episode, which
  // the markers above would have shown, can be for it. Its episode numbers count from its own season.
  if (subtitle.recordSeason !== undefined && subtitle.recordSeason > 1 && subtitle.recordSeason !== request.season) return false;

  const range = extractEpisodeRange(text);
  if (range) {
    const wanted = request.absoluteEpisode ?? request.episode;
    return wanted >= range.from && wanted <= range.to;
  }

  // A season pack that gives no file count but says how many episodes it has ("Rip from NETFLIX. (26 episodes").
  const count = (subtitle.commentary ?? "").match(/\b(\d{1,4})\s*episodes?\b/i);
  if (count && !subtitle.files) {
    return request.episode <= Number(count[1]);
  }

  // "Show - 013 [720p]": a bare number counts when nothing else marks the episode.
  if (subtitle.files === 1 || !subtitle.files) {
    const name = (subtitle.releaseInfo ?? []).join(" ");
    const bare = bareNumbers(name);
    if (bare.length > 0) {
      // "Show Season 5 Ep 17" is the 17th episode of season 5: for season 2 it's another
      // episode (it was served for S2E17). A name that says season 1 may still be
      // counting across the whole show ("Season 1 - 113").
      const named = extractSeasonMarkers(name);
      const acrossShow = named.includes(1) && request.absoluteEpisode !== undefined && bare.includes(request.absoluteEpisode);
      if (named.length > 0 && !named.includes(request.season) && !acrossShow) return false;
      return bare.includes(request.absoluteEpisode ?? request.episode) || bare.includes(request.episode);
    }
  }

  // Only a season is named: it has to be this one.
  const seasons = extractSeasonMarkers(text);
  if (seasons.length > 0) return seasons.includes(request.season);
  // Nothing names an episode or a season: a pack of several files may hold it; a lone file can't be told apart.
  return (subtitle.files ?? 0) > 1;
}

// ---------- how well a subtitle's release matches the playing file ----------

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|webm|ts|srt|ass|ssa|vtt|sub|zip)$/i;
/** Words that end scene names after a hyphen but are tags, not groups ("WEB-DL", "x264-…"). */
const NOT_GROUP = /^(dl|rip|web|webdl|x26[45]|h26[45]|hevc|avc|aac|ddp?|dts|\d+p|\d+|v\d)$/i;

/** The release group: "[SubsPlease] Show - 13 (1080p)" or "Show.S01E13.1080p.CR.WEB-DL-TEAM.mkv". */
export function releaseGroup(name: string): string | undefined {
  const stem = name.trim().replace(VIDEO_EXT, "");
  const lead = stem.match(/^\[([^\]]{2,30})\]/);
  if (lead) return lead[1].trim().toLowerCase();
  const tail = stem.replace(/(?:\s*\[[^\]]*\]|\s*\([^)]*\))+$/, "").match(/-([A-Za-z0-9]{2,20})$/);
  return tail && !NOT_GROUP.test(tail[1]) ? tail[1].toLowerCase() : undefined;
}

/** A tag standing as a word of its own; "_" and "." separate words in release names too. */
const word = (pattern: string) => new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, "i");

const SERVICES: Array<[string, RegExp]> = [
  ["crunchyroll", word("cr|crunchy ?roll")],
  ["netflix", word("nf|netflix")],
  ["amazon", word("amzn|amazon")],
  ["disney", word("dsnp|disney")],
  ["hidive", word("hidive")],
  ["funimation", word("funi|funimation")],
  ["hulu", word("hulu")],
  ["apple", word("atvp|aptv")],
  ["max", word("hmax")]
];
/** Anime groups that rip one service without saying so in the name. */
const GROUP_SERVICE: Record<string, string> = { subsplease: "crunchyroll", "erai-raws": "crunchyroll", horriblesubs: "crunchyroll" };
const SOURCES: Array<[string, RegExp]> = [
  ["web", word("web(?:[-. ]?(?:dl|rip))?")],
  ["bluray", word("blu[-. ]?ray|bd(?:rip|remux|mv)?|remux")],
  ["tv", word("hdtv|tvrip")],
  ["dvd", word("dvd(?:rip)?")]
];

function tagsIn(text: string, table: Array<[string, RegExp]>): Set<string> {
  return new Set(table.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return [...a].some((tag) => b.has(tag)) ? 1 : -1;
}

/**
 * How well a subtitle's release names (and notes) fit the playing filename:
 * same group +3, same streaming service +2 (another one -1), same source
 * (WEB, Blu-ray, TV, DVD) +1 (another one -1). 0 without a filename. A
 * subtitle made for the same release needs the least retiming.
 */
export function releaseMatch(subtitle: SubSourceSubtitle, filename?: string): number {
  if (!filename) return 0;
  const names = (subtitle.releaseInfo ?? []).join(" | ");
  const text = `${names} ${subtitle.commentary ?? ""}`;
  let score = 0;
  const group = releaseGroup(filename);
  if (group && group.length >= 3 && word(group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(names)) score += 3;
  const fileServices = tagsIn(filename, SERVICES);
  if (group && GROUP_SERVICE[group]) fileServices.add(GROUP_SERVICE[group]);
  const service = overlap(fileServices, tagsIn(text, SERVICES));
  score += service > 0 ? 2 : service;
  score += overlap(tagsIn(filename, SOURCES), tagsIn(text, SOURCES));
  return score;
}

/**
 * Subtitles that fit the request, best first. requireDub: false ranks every
 * subtitle for the episode (used for other languages, such as Arabic), not
 * just the dub-tagged ones. seasonMap: the show's seasons by their titles
 * (ids.ts), when it has them.
 */
export function filterAndRankDubtitles(
  subtitles: SubSourceSubtitle[],
  request: StremioSubtitleRequest,
  options: { requireDub?: boolean; allowMachine?: boolean; hearingImpaired?: "include" | "exclude" | "only"; seasonMap?: SeasonMap } = {}
): RankedSubtitle[] {
  const requireDub = options.requireDub ?? true;
  const hearingImpaired = options.hearingImpaired ?? "include";
  // Which records mix seasons is told from each record's whole list, before anything is left out.
  const mixed = options.seasonMap && request.type === "series" && (request.season ?? 0) > 0 && request.episode ? mixedRecords(subtitles, options.seasonMap) : undefined;
  const fitting = subtitles.flatMap((subtitle): RankedSubtitle[] => {
    const text = searchableText(subtitle);
    const phrase = dubtitlePhraseScore(text);
    if (requireDub && phrase === 0) return [];
    const byTitle = readByTitle(subtitle, request, options.seasonMap, mixed?.has(subtitle.movieId) ?? false);
    if (!subtitleMatchesRequestedEpisode(subtitle, request, byTitle)) return [];

    // Read by its title, its numbers count within its own season or part: never across the show.
    const range = request.type === "series" && !byTitle ? extractEpisodeRange(text) : undefined;
    const absoluteMarker =
      !byTitle &&
      request.absoluteEpisode !== undefined &&
      request.absoluteEpisode !== request.episode &&
      (extractEpisodeMarkers(text).some((marker) => marker.season <= 1 && marker.episode === request.absoluteEpisode) ||
        (bareNumbers((subtitle.releaseInfo ?? []).join(" ")).includes(request.absoluteEpisode) &&
          !bareNumbers((subtitle.releaseInfo ?? []).join(" ")).includes(request.episode ?? -1)));

    // From a source that searched for this episode, a name giving season 1 (or 0) and this episode's
    // number is taken: an anime sequel is often released as its own "S01". But it may also be the
    // first season's episode filed under this one, so a name that spells out this season wins over it.
    const otherSeason = subtitle.episodeTrusted === true && request.type === "series" && (request.season ?? 0) > 1 && namesOnlyAnotherSeason((subtitle.releaseInfo ?? []).join(" "), request);

    if (hearingImpaired === "exclude" && subtitle.hearingImpaired === true) return [];
    if (hearingImpaired === "only" && subtitle.hearingImpaired !== true) return [];
    const tier = qualityTier(subtitle);
    if (tier === -1 && !options.allowMachine) return []; // machine or AI translation
    const quality: 1 | 2 | 3 = tier === -1 ? 1 : tier;

    return [
      {
        ...subtitle,
        quality,
        ...(tier === -1 ? { machine: true } : {}),
        ...(otherSeason ? { otherSeason: true } : {}),
        dubtitleScore: phrase === 2 ? 2 : 1,
        releaseMatch: releaseMatch(subtitle, request.filename),
        episodeExact: byTitle
          ? byTitle.exact === true
          : subtitle.episodeTrusted === true ||
            episodeMarkerMatches(text, request.season, request.episode) ||
            (absoluteMarker && episodeMarkerMatches(text, 1, request.absoluteEpisode)),
        absoluteNumbered: Boolean(range) || absoluteMarker,
        ...(byTitle?.pick !== undefined ? { pick: byTitle.pick } : {})
      }
    ];
  });
  return fitting.sort(compareRanked);
}

/**
 * Whether a name's season and episode markers all give another season than the one asked for, and
 * none of them is the episode counted across the show ("S01E113" for season 3's 13th is that count).
 */
export function namesOnlyAnotherSeason(name: string, request: StremioSubtitleRequest): boolean {
  const markers = extractEpisodeMarkers(name);
  const counted = request.absoluteEpisode !== undefined && request.absoluteEpisode !== request.episode ? request.absoluteEpisode : undefined;
  return markers.length > 0 && !markers.some((m) => m.season === request.season || (counted !== undefined && m.episode === counted));
}

/** What decides between two fitting subtitles, most important first. Higher is better for each. */
const RANKING: Array<(subtitle: RankedSubtitle) => number> = [
  (s) => s.dubtitleScore, // the dub tag
  (s) => Number(!s.machine), // a person's (or unknown) before a machine's, when machine translations are allowed
  (s) => Number(!s.otherSeason), // a name with this season before one that only gives another (see filterAndRankDubtitles)
  (s) => s.quality ?? 1, // translation quality
  (s) => s.releaseMatch ?? 0, // fit to the playing release
  (s) => Number(s.episodeExact), // names this exact episode
  (s) => (s.rating?.good ?? 0) - (s.rating?.bad ?? 0), // net rating
  (s) => s.rating?.total ?? 0, // how many rated it
  (s) => s.downloads ?? 0,
  (s) => Date.parse(s.createdAt ?? "0") // newest
];

/** Best first, by RANKING. Shared by every source. */
export function compareRanked(a: RankedSubtitle, b: RankedSubtitle): number {
  for (const measure of RANKING) {
    const difference = measure(b) - measure(a);
    if (difference) return difference;
  }
  return 0;
}
