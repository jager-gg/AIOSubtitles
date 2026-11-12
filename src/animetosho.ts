/**
 * Anime Tosho (animetosho.net): a free mirror of anime releases that extracts every subtitle track of
 * every file it mirrors, with an open JSON API and no key. A dub's own release (an English dub's web
 * release, a dual-audio one) carries the streaming service's English captions of the dub as a track,
 * often the only place they exist: those tracks are this source's subtitles, as dub captions.
 *
 * Releases are found by the show's name or its season's own title with a dub mark, then their files:
 * the episode's file by its name (the same matching as every subtitle name), and in it the English
 * track named as captions ("English [CC]", "SDH", "Dub"), or the one English track of a file whose
 * every voice is English (from the file's mediainfo). Searches are kept 12 hours, releases 30 days;
 * a release still being mirrored, or mirrored without subtitle tracks, only an hour (its tracks may
 * come yet). Its AniDB tags aren't used: later seasons' releases are often tagged as the first season's.
 */
import xz from "xz-decompress";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { extractEpisodeMarkers, extractSeasonMarkers, filterAndRankDubtitles, namesOnlyAnotherSeason } from "./matching.js";
import { count, noteError } from "./stats.js";
import type { SeasonMap, StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

const { XzReadableStream } = xz;

export const ANIMETOSHO_FEED = "https://feed.animetosho.net/json";
export const ANIMETOSHO_STORAGE = "https://storage.animetosho.net/attachments";
const HEADERS = { accept: "application/json", "user-agent": "AIOSubtitles" };
const SEARCH_TTL_S = 12 * 60 * 60;
const RELEASE_TTL_S = 30 * 24 * 60 * 60;
/** A release not yet mirrored whole, and a search listing one: asked again within the hour, once its tracks are there. */
const UNSETTLED_TTL_S = 60 * 60;
/** Requests to its feed in flight at most: it slows down for everyone when many are asked at once. */
const MAX_IN_FLIGHT = 3;
/** Releases opened per episode at most (each a request for its files), best first. */
const MAX_RELEASES = 6;
/** A subtitle track runs to a few hundred KB unpacked; anything far bigger isn't one. */
const MAX_TRACK_BYTES = 10_000_000;

/** One release in a search's answer. */
interface Listed {
  id: number;
  title: string;
  num_files?: number;
  status?: string;
  timestamp?: number;
}

/** A release's files, with their subtitle tracks, as kept. */
interface Release {
  id: number;
  title: string;
  timestamp?: number;
  /** `name` is the file's own name; `folder` the folders it is in within the release ("Season 2"), when any. */
  files: Array<{ name: string; folder?: string; englishVoicesOnly: boolean; tracks: Track[] }>;
}

/**
 * A release whose tracks are all there: "complete", or "unknown" on older rows (mirrored before the
 * feed kept a status). One still "processing" has no tracks yet, and a failed one never will.
 */
const settled = (status: string | undefined) => status === undefined || /^(?:complete|unknown)$/i.test(status);
/** Not settled yet, but may be soon: neither failed nor skipped. */
const coming = (status: string | undefined) => !settled(status) && !/fail|skip|broken|error/i.test(status ?? "");

interface Track {
  /** The track's storage place, 8 hex characters: "00157ad3" for attachments/00157/ad3.xz. */
  place: string;
  name: string;
  language: string;
  format: string;
  forced: boolean;
}

/**
 * How likely a release is to carry the dub's captions, by its name: an English dub's own release
 * ("English Dub", "ENG UNCUT", "Dubbed") 2, dual audio 1, one more for a streaming service's release
 * (web, or a service named), whose files keep the service's own tracks. A TV capture has none.
 */
export function dubRelease(name: string): number {
  if (/(?:^|[^a-z])hdtv(?:$|[^a-z])/i.test(name)) return 0;
  const dub = /(?:^|[^a-z])(?:eng(?:lish)?[ ._-]*(?:dub(?:bed)?|uncut)|dub(?:bed)?)(?:$|[^a-z])/i.test(name)
    ? 2
    : /(?:^|[^a-z])dual[ ._-]*(?:audio)?(?:$|[^a-z])/i.test(name)
      ? 1
      : 0;
  if (!dub) return 0;
  const web = /(?:^|[^a-z])(?:web(?:[ ._-]?(?:dl|rip))?|funi(?:dub|mation)?|crunchyroll|cr|amzn|nf|hidive|dsnp|hulu)(?:$|[^a-z])/i.test(name);
  return dub + (web ? 1 : 0);
}

const ENGLISH = /^(en|eng|english)$/i;
const NOT_DIALOGUE = /sign|song|forced|karaoke|lyric/i;
const CAPTIONS = /(?:^|[^a-z])(?:cc|sdh|closed[ ._-]?captions?|captions|dub(?:bed)?|dubtitles?|hearing[ ._-]?impaired)(?:$|[^a-z])/i;
const TEXT_FORMAT = /^(ass|ssa|srt|subrip|utf-?8|webvtt|vtt|text)$/i;

/**
 * A file's track of English captions of English voices: an English text track named as captions or
 * dub captions, or the one English text track of a file whose every voice is English. Signs, songs
 * and forced tracks never. (A dual-audio file's plain "English" track is the translation.)
 */
export function captionsTrack(file: { englishVoicesOnly: boolean; tracks: Track[] }): Track | undefined {
  const text = file.tracks.filter((t) => ENGLISH.test(t.language) && TEXT_FORMAT.test(t.format) && !t.forced && !NOT_DIALOGUE.test(t.name));
  return text.find((t) => CAPTIONS.test(t.name)) ?? (file.englishVoicesOnly && text.length === 1 ? text[0] : undefined);
}

/** Whether a file's mediainfo lists audio tracks, every one of them in English. */
export function englishVoicesOnly(mediainfo: string): boolean {
  const audio = mediainfo.split(/\n\s*\n/).filter((section) => /^Audio\b/.test(section.trim()));
  if (audio.length === 0) return false;
  return audio.every((section) => /^Language\s*:\s*English\b/im.test(section));
}

/** A name with only its letters and digits, lower case: "The SHOW" and "The Show" alike. */
const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Tags in front of a release's name: "[Group] ", "(Batch) ". */
const LEADING_TAGS = /^\s*(?:[[({【][^\])}】]*[\])}】]\s*)+/u;
/** Where a name's own words end: " - ", a bracket, a pipe. */
const SEPARATOR = /^[\s._]*[-–—|~/[({【]/u;
/**
 * A word that may follow the show's name in a release's own name without making it another title:
 * an episode or season marker, a number or year, a season word, a release tag.
 */
const AFTER_NAME =
  /^(?:\d{1,4}(?:v\d)?|s\d{1,2}(?:e\d{1,4})?(?:v\d)?|ep?\d{1,4}(?:v\d)?|\d{1,2}x\d{1,4}|eps?|episodes?|seasons?|part|cour|pt\d*|\d{1,2}(?:st|nd|rd|th)|ii|iii|iv|vi{0,3}|ix|final|tv|dub|dubbed|eng|english|uncut|dual|multi|web|webrip|webdl|bd|bdrip|bluray|batch|complete|\d{3,4}p|hevc|avc|[xh]26[45]|uncensored)$/i;
const ORDINAL = /^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i;
const LETTER = /[\p{L}\p{N}]/u;

/**
 * Whether a release's own name is this name: after its leading tags, the release's name starts with
 * it (letters and digits compared, so "The SHOW!" and "the show" alike), followed by nothing, a
 * separator, an episode or season marker, or a release tag; not by more words of a title. Its search
 * matches words anywhere, so a search for "Show" also finds "Show Next Generation", another show.
 */
export function namesTitle(title: string, name: string): boolean {
  const own = squash(name);
  if (!own) return false;
  const text = title.replace(LEADING_TAGS, "");
  // Walk the release's letters and digits until the name's are used up: there the name ends in it.
  let matched = 0;
  let cut = -1;
  for (let i = 0; i < text.length && cut < 0; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    i += ch.length;
    if (!LETTER.test(ch)) continue;
    const lower = ch.toLowerCase();
    if (!own.startsWith(lower, matched)) return false;
    matched += lower.length;
    if (matched >= own.length) cut = i;
  }
  if (cut < 0) return false;
  const rest = text.slice(cut);
  if (!LETTER.test(rest) || SEPARATOR.test(rest)) return true;
  const [next = "", after = ""] = rest.match(/[\p{L}\p{N}]+/gu) ?? [];
  // "Show Second Season" is the show's; "Show Second Arc" is a title of its own (a season map's, when it is one).
  if (ORDINAL.test(next)) return /^(?:season|part|cour)$/i.test(after);
  return AFTER_NAME.test(next);
}

/** The words of a title to search by: what its search matches on (punctuation dropped). */
function words(title: string): string {
  return title.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A search and how many of its pages (75 releases each, newest first) to go through. */
export interface Search {
  q: string;
  pages: number;
}

/**
 * What to search for an episode. Its search matches words, not episode markers ("S02E04" doesn't find
 * "S2 - 04"), and gives the newest releases first, so the show's dub releases are listed whole, a few
 * pages deep (shared by every episode of the show), and the episode is picked out of them by name:
 * the show's name with each dub mark ("English Dub", the web dubs' "UNCUT", "Dubbed"), its dual-audio
 * releases naming this episode, and each title the season goes by (later seasons are often released
 * under their own title, "Show: Second Arc - 03"). Phrases in quotes match as written.
 */
export function searchesFor(request: StremioSubtitleRequest, show: string, seasonTitles: string[]): Search[] {
  const out: Search[] = [];
  const name = words(show);
  if (name) {
    out.push({ q: `${name} "English Dub"`, pages: DUB_PAGES }, { q: `${name} UNCUT`, pages: 2 }, { q: `${name} Dubbed`, pages: 2 });
    if (request.type === "series" && request.season && request.episode) {
      out.push({ q: `${name} "Dual Audio" S${String(request.season).padStart(2, "0")}E${String(request.episode).padStart(2, "0")}`, pages: 1 });
    }
  }
  for (const title of seasonTitles) {
    const t = words(title);
    if (t && t.toLowerCase() !== name.toLowerCase()) out.push({ q: `${t} "English Dub"`, pages: 2 });
  }
  return out.filter((a, i) => out.findIndex((b) => b.q === a.q) === i);
}

/** Pages of a show's "English Dub" releases gone through at most: a long show's run in two resolutions fills several. */
const DUB_PAGES = 10;
/** Releases a page holds; a shorter page is the last. */
const PAGE_SIZE = 75;

/** The titles a show's season map gives the requested season, its own name first (at most two). */
export function seasonTitles(request: StremioSubtitleRequest, map: SeasonMap | undefined): string[] {
  if (!map || request.season === undefined) return [];
  const titles: string[] = [];
  for (const entry of map.entries) {
    if (!Object.values(entry.episodes).some(([season]) => season === request.season)) continue;
    const own = entry.titles.find((t) => /[a-z]/i.test(t) && t.toLowerCase() !== map.show.toLowerCase());
    if (own) titles.push(own);
  }
  return [...new Set(titles)].slice(0, 2);
}

/** Requests to the feed now, and those waiting for one of them to end. */
let inFlight = 0;
const waiting: Array<() => void> = [];

/** Runs work once fewer than MAX_IN_FLIGHT feed requests are in flight (shared by every list being made). */
async function politely<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    // The slot goes straight to the next one waiting, if any.
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

/** Look-ups under way, by what they ask: two lists asking for the same page or release at once share one request. */
const pending = new Map<string, Promise<unknown>>();
function shared<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = pending.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = work().finally(() => pending.delete(key));
  pending.set(key, started);
  return started;
}

/** Its answers slow down when many are asked at once (a show's first look): a release's files can take 10 s. */
function getJson<T>(url: string): Promise<T> {
  return politely(async () => {
    count("api.animetosho");
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  });
}

/**
 * One page of a search, kept 12 hours (a show's episodes share them); an hour when it lists a
 * release still being mirrored, which is left out until it is complete.
 */
function searchPage(q: string, page: number): Promise<Listed[]> {
  const key = cacheKey({ kind: "animetosho-search", q, page });
  return shared(key, async () => {
    const cached = await readJsonCache<Listed[]>("results", key);
    if (cached) return cached;
    const rows = await getJson<Listed[]>(`${ANIMETOSHO_FEED}?${new URLSearchParams({ q, ...(page > 1 ? { page: String(page) } : {}) })}`);
    const kept = (Array.isArray(rows) ? rows : []).map((r) => ({ id: r.id, title: r.title, num_files: r.num_files, status: r.status, timestamp: r.timestamp }));
    await writeJsonCache("results", key, kept, kept.some((r) => coming(r.status)) ? UNSETTLED_TTL_S : SEARCH_TTL_S);
    return kept;
  });
}

/**
 * A search's pages, up to `pages`, until one comes back short: the first alone (most shows' dub
 * releases fit in it), then the rest a few at a time.
 */
async function search({ q, pages }: Search): Promise<Listed[]> {
  const out: Listed[] = [];
  for (let first = 1; first <= pages; ) {
    const batch = Array.from({ length: Math.min(first === 1 ? 1 : MAX_IN_FLIGHT, pages - first + 1) }, (_, i) => first + i);
    const got = await Promise.all(batch.map((page) => searchPage(q, page)));
    for (const rows of got) out.push(...rows);
    if (got.some((rows) => rows.length < PAGE_SIZE)) break;
    first += batch.length;
  }
  return out;
}

interface ApiRelease {
  id: number;
  title: string;
  status?: string;
  timestamp?: number;
  files?: Array<{
    filename?: string;
    info?: { mediainfo?: string };
    attachments?: Array<{ type?: string; url?: string; info?: { name?: string; language_code?: string; format?: string; forced?: boolean } }>;
  }>;
}

/**
 * A release's files and their subtitle tracks, kept 30 days (a mirrored release doesn't change).
 * One not yet complete, or with no subtitle track at all, is kept an hour: its tracks may come yet.
 */
function release(id: number): Promise<Release> {
  const key = cacheKey({ kind: "animetosho-release", id });
  return shared(key, async () => {
    const cached = await readJsonCache<Release>("results", key);
    if (cached) return cached;
    const body = await getJson<ApiRelease>(`${ANIMETOSHO_FEED}?${new URLSearchParams({ show: "torrent", id: String(id) })}`);
    const kept: Release = {
      id: body.id,
      title: body.title,
      ...(body.timestamp ? { timestamp: body.timestamp } : {}),
      files: (body.files ?? []).map((f) => {
        const folders = (f.filename ?? "").split("/");
        const name = folders.pop() ?? "";
        return {
          name,
          ...(folders.length ? { folder: folders.join("/") } : {}),
          englishVoicesOnly: englishVoicesOnly(f.info?.mediainfo ?? ""),
          tracks: (f.attachments ?? []).flatMap((a): Track[] => {
            const place = /\/attachments\/([0-9a-f]{5})\/([0-9a-f]{3})\.xz/.exec(a.url ?? "");
            if (a.type !== "subtitle" || !place) return [];
            return [{ place: place[1] + place[2], name: a.info?.name ?? "", language: a.info?.language_code ?? "", format: a.info?.format ?? "", forced: a.info?.forced === true }];
          })
        };
      })
    };
    // An older release's "unknown" is as final as "complete": it was mirrored long ago.
    const final = settled(body.status) && kept.files.some((f) => f.tracks.length > 0);
    await writeJsonCache("results", key, kept, final ? RELEASE_TTL_S : UNSETTLED_TTL_S);
    return kept;
  });
}

/** Whether names may hold the episode, by the same matching every subtitle name goes through. */
function holds(names: string[], files: number, request: StremioSubtitleRequest, map: SeasonMap | undefined): boolean {
  const probe: SubSourceSubtitle = { subtitleId: 0, movieId: 0, language: "english", releaseInfo: names, files };
  return filterAndRankDubtitles([probe], request, { requireDub: false, allowMachine: true, seasonMap: map }).length > 0;
}

/** Seasons a name gives, alone ("Season 2", "S2") or with an episode ("S02E01-12"). */
const seasonsIn = (name: string) => new Set([...extractSeasonMarkers(name), ...extractEpisodeMarkers(name).map((m) => m.season)]);

/**
 * The season a batch's file is in when its own name gives none ("Season 2/Show - 03.mkv"): the one
 * season its nearest folder that names any gives, else the release's name. A folder or name giving
 * several ("S1-S2") gives none.
 */
export function seasonAround(file: { name: string; folder?: string }, title: string): number | undefined {
  if (seasonsIn(file.name).size > 0) return undefined;
  for (const around of [...(file.folder ?? "").split("/").reverse(), title]) {
    const seasons = seasonsIn(around);
    if (seasons.size === 1) return [...seasons][0];
    if (seasons.size > 1) return undefined;
  }
  return undefined;
}

/**
 * Dub captions for the episode from Anime Tosho: each a release's own English captions track, for
 * the file of the release that holds this episode. `show` is the show's name; `map` its seasons.
 */
export async function animeToshoSubtitles(request: StremioSubtitleRequest, show: string | undefined, map: SeasonMap | undefined): Promise<SubSourceSubtitle[]> {
  if (!show) return [];
  try {
    const titles = seasonTitles(request, map);
    const queries = searchesFor(request, show, titles);
    // Its search matches words anywhere (a batch's file names, another show's longer title): a release's own name must be the show's or a season's.
    const names = [...new Set([show, ...titles, ...(map?.entries.flatMap((e) => e.titles) ?? [])])].filter((n) => squash(n).length >= 2);
    const namesShow = (title: string) => names.some((n) => namesTitle(title, n));
    const found = new Map<number, Listed>();
    for (const rows of await Promise.all(queries.map((query) => search(query).catch(() => [] as Listed[])))) {
      // Only releases mirrored whole: one still processing has no tracks yet (it is found again once complete).
      for (const row of rows) if (settled(row.status) && !found.has(row.id)) found.set(row.id, row);
    }
    const batch = (row: Listed) => (row.num_files ?? 1) > 1;
    // One of a group's releases of an episode: its 1080p and 720p carry the same track.
    const sameRelease = (title: string) => title.toLowerCase().replace(/\b\d{3,4}p\b|\[[0-9a-f]{8}\]|x26[45]|hevc|avc/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const candidates = [...found.values()]
      .map((row) => ({ row, rank: dubRelease(row.title), named: holds([row.title], row.num_files ?? 1, request, map) }))
      // A batch's name may give a range the matching doesn't read ("S02E03-11"): its files are matched one by one below,
      // so a batch is opened unless its name gives only other seasons.
      .filter(({ row, rank, named }) => rank > 0 && row.num_files !== 0 && namesShow(row.title) && (named || (batch(row) && !namesOnlyAnotherSeason(row.title, request))))
      // The likelier release first, then one whose name holds the episode, then a single episode's, then the newest.
      .sort((a, b) => b.rank - a.rank || Number(b.named) - Number(a.named) || Number(batch(a.row)) - Number(batch(b.row)) || (b.row.timestamp ?? 0) - (a.row.timestamp ?? 0));
    // Of one release's resolutions, the first in that order, unless a later one is known complete and it isn't.
    const byRelease = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const key = sameRelease(candidate.row.title);
      const had = byRelease.get(key);
      if (!had || (had.row.status !== "complete" && candidate.row.status === "complete")) byRelease.set(key, candidate);
    }
    const releases = [...byRelease.values()].slice(0, MAX_RELEASES);
    const opened = await Promise.all(releases.map(({ row }) => release(row.id).catch(() => undefined)));
    const out: SubSourceSubtitle[] = [];
    const seen = new Set<string>();
    for (const rel of opened) {
      if (!rel) continue;
      // The release's name goes beside a file's only when it doesn't place the episode elsewhere (a batch's "S02E01-12" would).
      const titleFits = holds([rel.title], rel.files.length, request, map);
      for (const file of rel.files) {
        // A batch's file named only by its number goes by the season its folder or the release gives.
        const season = seasonAround(file, rel.title);
        const names = [file.name.replace(/\.(mkv|mp4)$/i, ""), ...(season !== undefined ? [`Season ${season}`] : [])];
        if (!holds(names, 1, request, map)) continue;
        const track = captionsTrack(file);
        if (!track || seen.has(track.place)) continue;
        seen.add(track.place);
        out.push({
          subtitleId: 0,
          ref: `at${track.place}`,
          source: "animetosho",
          movieId: 0,
          language: "english",
          releaseInfo: [...names, ...(titleFits ? [rel.title] : [])],
          // What it is, in the words the ranking reads: the dub's captions, made by the service.
          commentary: `English Dub captions: the release's own "${track.name || "English"}" track`,
          productionType: "official",
          files: 1,
          hearingImpaired: /cc|sdh|closed|hearing/i.test(track.name),
          downloads: 0,
          rating: null,
          ...(rel.timestamp ? { createdAt: new Date(rel.timestamp * 1000).toISOString() } : {})
        });
      }
    }
    return out;
  } catch (error) {
    noteError("animetosho", error);
    console.error(`animetosho: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/** The words of an "at" subtitle: its track from Anime Tosho's storage, unpacked. */
export async function downloadAnimeTosho(ref: string): Promise<Buffer> {
  const place = /^at([0-9a-f]{8})$/.exec(ref)?.[1];
  if (!place) throw new Error(`unknown subtitle ${ref}`);
  count("api.animetosho");
  const response = await fetch(`${ANIMETOSHO_STORAGE}/${place.slice(0, 5)}/${place.slice(5)}.xz`, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
  const reader = new XzReadableStream(response.body).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_TRACK_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`subtitle ${ref} unpacks to more than a subtitle ever is`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
