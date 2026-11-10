/**
 * Which subtitles fit the episode being played, and in what order. Everything
 * here reads the uploader's own words: release names, notes and file names.
 */
import type { RankedSubtitle, StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";
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

/** Season and episode written together: "S01E05", "s1 e5", "E05 S01", "1x05". */
export function episodeMarkerMatches(value: string, season?: number, episode?: number): boolean {
  if (!season || !episode) return false;
  const s = `0?${season}`;
  const e = `0?${episode}`;
  const forms = [`s\\s*${s}\\D{0,4}e\\s*${e}`, `e\\s*${e}\\D{0,4}s\\s*${s}`, `\\b${season}x0?${episode}\\b`];
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

/**
 * Whether a subtitle can be for the requested episode. Movies always fit; for
 * a series, the most specific thing its names say decides: an exact episode,
 * a range, an episode count, a bare number, then a season.
 */
export function subtitleMatchesRequestedEpisode(subtitle: SubSourceSubtitle, request: StremioSubtitleRequest): boolean {
  if (request.type !== "series" || !request.season || !request.episode) return true;
  if (subtitle.episodeTrusted) {
    // The source searched for this episode, but its match can be loose ("Iron Lantern - 113" for E13):
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

  // "Iron Lantern - 013 [720p]": a bare number counts when nothing else marks the episode.
  if (subtitle.files === 1 || !subtitle.files) {
    const name = (subtitle.releaseInfo ?? []).join(" ");
    const bare = bareNumbers(name);
    if (bare.length > 0) {
      // "The Starfall Season 5 Ep 17" is the 17th episode of season 5: for season 2 it's another
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

/** The release group: "[SubsPlease] Show - 13 (1080p)" or "Show.S01E13.1080p.CR.WEB-DL-VARYG.mkv". */
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
 * just the dub-tagged ones.
 */
export function filterAndRankDubtitles(
  subtitles: SubSourceSubtitle[],
  request: StremioSubtitleRequest,
  options: { requireDub?: boolean; allowMachine?: boolean; hearingImpaired?: "include" | "exclude" | "only" } = {}
): RankedSubtitle[] {
  const requireDub = options.requireDub ?? true;
  const hearingImpaired = options.hearingImpaired ?? "include";
  const fitting = subtitles.flatMap((subtitle): RankedSubtitle[] => {
    const text = searchableText(subtitle);
    const phrase = dubtitlePhraseScore(text);
    if (requireDub && phrase === 0) return [];
    if (!subtitleMatchesRequestedEpisode(subtitle, request)) return [];

    const range = request.type === "series" ? extractEpisodeRange(text) : undefined;
    const absoluteMarker =
      request.absoluteEpisode !== undefined &&
      request.absoluteEpisode !== request.episode &&
      (extractEpisodeMarkers(text).some((marker) => marker.season <= 1 && marker.episode === request.absoluteEpisode) ||
        (bareNumbers((subtitle.releaseInfo ?? []).join(" ")).includes(request.absoluteEpisode) &&
          !bareNumbers((subtitle.releaseInfo ?? []).join(" ")).includes(request.episode ?? -1)));

    if (hearingImpaired === "exclude" && subtitle.hearingImpaired === true) return [];
    if (hearingImpaired === "only" && subtitle.hearingImpaired !== true) return [];
    const tier = qualityTier(subtitle);
    if (tier === -1 && !options.allowMachine) return []; // machine or AI translation
    const quality: 1 | 2 | 3 = tier === -1 ? 1 : tier;

    return [
      {
        ...subtitle,
        quality,
        dubtitleScore: phrase === 2 ? 2 : 1,
        releaseMatch: releaseMatch(subtitle, request.filename),
        episodeExact:
          subtitle.episodeTrusted === true ||
          episodeMarkerMatches(text, request.season, request.episode) ||
          (absoluteMarker && episodeMarkerMatches(text, 1, request.absoluteEpisode)),
        absoluteNumbered: Boolean(range) || absoluteMarker
      }
    ];
  });
  return fitting.sort(compareRanked);
}

/** What decides between two fitting subtitles, most important first. Higher is better for each. */
const RANKING: Array<(subtitle: RankedSubtitle) => number> = [
  (s) => s.dubtitleScore, // the dub tag
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
