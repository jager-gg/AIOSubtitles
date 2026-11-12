/**
 * Anime ids other than IMDb, and anime seasons by their own titles. AIOStreams' own Jellyfin server
 * asks subtitle addons with the title's own id, which for anime is often Kitsu ("kitsu:1000:13");
 * AIOMetadata converts to IMDb first, AIOStreams doesn't. SubSource is searched by IMDb id, so Kitsu
 * ids are mapped here with the Anime Kitsu addon's metadata, which gives each episode's IMDb season
 * and episode. Cached for a day.
 *
 * The same metadata gives a show's season map (seasonMap): Kitsu lists each season, part of a season
 * and special of a show as an entry of its own, with its own titles, and maps each of its episodes to
 * IMDb's season and episode. Uploaders name anime by those titles ("Show: Second Arc - 03"), so the
 * map is how such a name is read (matching.ts).
 */
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import type { SeasonMap } from "./types.js";

const KITSU = "https://anime-kitsu.strem.fun";
const DAY = 24 * 60 * 60;

interface KitsuMap {
  imdbId?: string;
  /** Kitsu episode -> [IMDb season, IMDb episode]. */
  episodes: Record<string, [number, number]>;
  /** Its name and aliases. Entries cached before these were kept lack them, and are fetched again for a season map. */
  titles?: string[];
}

export interface Mapped {
  imdbId: string;
  season?: number;
  episode?: number;
}

export function parseKitsuId(id: string): { kitsuId: string; episode?: number } | undefined {
  const match = id.match(/^kitsu:(\d+)(?::(\d+))?$/i);
  return match ? { kitsuId: match[1], episode: match[2] ? Number(match[2]) : undefined } : undefined;
}

interface KitsuMeta {
  imdb_id?: string;
  name?: string;
  aliases?: string[];
  videos?: Array<{ id?: string; episode?: number; imdbSeason?: number; imdbEpisode?: number }>;
}

/** One entry's metadata: undefined when the addon doesn't have it under this type; throws when the addon can't be reached. */
async function fetchKitsuMeta(type: string, kitsuId: string, ms: number): Promise<KitsuMap | undefined> {
  const response = await fetch(`${KITSU}/meta/${type}/kitsu:${kitsuId}.json`, { signal: AbortSignal.timeout(ms) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Anime Kitsu ${response.status}`);
  const meta = ((await response.json()) as { meta?: KitsuMeta }).meta;
  if (!meta) return undefined;
  const map: KitsuMap = { imdbId: meta.imdb_id, episodes: {}, titles: [meta.name, ...(meta.aliases ?? [])].filter((t): t is string => typeof t === "string" && t.trim() !== "") };
  for (const video of meta.videos ?? []) {
    const episode = video.episode ?? Number(video.id?.split(":")[2]);
    // Season 0 is IMDb's specials: a place like any other.
    if (episode && video.imdbSeason !== undefined && video.imdbSeason >= 0 && video.imdbEpisode) map.episodes[episode] = [video.imdbSeason, video.imdbEpisode];
  }
  return map;
}

async function kitsuMap(kitsuId: string): Promise<KitsuMap | undefined> {
  const key = cacheKey({ kind: "kitsu-imdb", kitsuId });
  const cached = await readJsonCache<KitsuMap>("results", key);
  if (cached) return cached;

  for (const type of ["series", "movie"]) {
    try {
      const map = await fetchKitsuMeta(type, kitsuId, 8000);
      if (!map) continue;
      await writeJsonCache("results", key, map, DAY);
      return map;
    } catch {
      // try the next type
    }
  }
  return undefined;
}

/** "kitsu:1000:13" -> { imdbId: "tt0000004", season: 1, episode: 13 }, or undefined when it can't be mapped. */
export async function kitsuToImdb(id: string): Promise<Mapped | undefined> {
  const parsed = parseKitsuId(id);
  if (!parsed) return undefined;
  const map = await kitsuMap(parsed.kitsuId);
  if (!map?.imdbId || !/^tt\d+$/.test(map.imdbId)) return undefined;
  if (parsed.episode === undefined) return { imdbId: map.imdbId };
  // A special (IMDb season 0) is looked up as before: by its Kitsu number, as if in season 1.
  const known = map.episodes[parsed.episode]?.[0] ? map.episodes[parsed.episode] : undefined;
  // Without a listed mapping, treat the Kitsu number as an absolute episode of season 1.
  return known ? { imdbId: map.imdbId, season: known[0], episode: known[1] } : { imdbId: map.imdbId, season: 1, episode: parsed.episode };
}

// ---------- a show's seasons by their own titles ----------

/** Entries of one show read at most: a long franchise lists many, and each is a fetch. One with more has no map. */
const MAX_ENTRIES = 12;
/**
 * Results on one page of the addon's catalog search. A full page may have left some of the show's
 * entries for the next one, so it gives no map.
 */
const SEARCH_PAGE = 20;
/** How long each look-up may take. A list doesn't wait past its own deadline; a slow first one finishes behind it and is cached. */
const SEARCH_MS = 5000;
const META_MS = 5000;
/** A map changes when a new season starts, so it is kept a week; a show without one is asked about again soon. */
const MAP_TTL = 7 * DAY;
const NONE_TTL = 60 * 60;
const FAILED_TTL = 10 * 60;

/** One entry's metadata for a season map: the day's cached copy (kitsuToImdb's too) when it has the titles. */
async function kitsuEntry(type: string, kitsuId: string): Promise<KitsuMap | undefined> {
  const key = cacheKey({ kind: "kitsu-imdb", kitsuId });
  const cached = await readJsonCache<KitsuMap>("results", key);
  if (cached?.titles) return cached;
  const map = await fetchKitsuMeta(type, kitsuId, META_MS);
  if (map) await writeJsonCache("results", key, map, DAY);
  return map;
}

interface SearchResult {
  id?: string;
  type?: string;
  imdb_id?: string;
}

/**
 * The show's season map, from the Anime Kitsu addon: its catalog searched by the show's name, the
 * entries that have this IMDb id kept, and each one's titles and episodes read. Only a show with two
 * entries or more has one (one entry says nothing a bare number doesn't). Any failure, even one entry
 * that can't be read, means no map: a map missing an entry would read that entry's names as another's.
 * So does a search that may not hold them all (a full page), and a show with more than MAX_ENTRIES.
 * Kept a week; a show with none, an hour; a failure, ten minutes.
 */
export async function seasonMap(imdbId: string, showName: () => Promise<string | undefined>): Promise<SeasonMap | undefined> {
  const key = cacheKey({ kind: "season-map", imdbId });
  const cached = await readJsonCache<{ map?: SeasonMap }>("results", key);
  if (cached) return cached.map;
  const show = await showName();
  if (!show) return undefined;
  let map: SeasonMap | undefined;
  try {
    const response = await fetch(`${KITSU}/catalog/anime/kitsu-anime-list/search=${encodeURIComponent(show)}.json`, { signal: AbortSignal.timeout(SEARCH_MS) });
    if (!response.ok) throw new Error(`Anime Kitsu ${response.status}`);
    const found = ((await response.json()) as { metas?: SearchResult[] }).metas ?? [];
    const same = found.filter((m) => m.imdb_id === imdbId && /^kitsu:\d+$/.test(m.id ?? ""));
    if (same.length >= 2 && same.length <= MAX_ENTRIES && found.length < SEARCH_PAGE) {
      const entries = await Promise.all(
        same.map(async (m) => {
          const entry = await kitsuEntry(m.type === "movie" ? "movie" : "series", (m.id as string).slice("kitsu:".length));
          if (!entry) throw new Error(`Anime Kitsu has no metadata for ${m.id}`);
          return { titles: entry.titles ?? [], episodes: entry.episodes };
        })
      );
      map = { show, entries };
    }
  } catch {
    await writeJsonCache("results", key, {}, FAILED_TTL);
    return undefined;
  }
  await writeJsonCache("results", key, map ? { map } : {}, map ? MAP_TTL : NONE_TTL);
  return map;
}
