/**
 * Anime ids other than IMDb. AIOStreams' own Jellyfin server asks subtitle
 * addons with the title's own id, which for anime is often Kitsu
 * ("kitsu:1000:13"); AIOMetadata converts to IMDb first, AIOStreams doesn't.
 * SubSource is searched by IMDb id, so Kitsu ids are mapped here with the
 * Anime Kitsu addon's metadata, which gives each episode's IMDb season and
 * episode. Cached for a day.
 */
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";

const KITSU_META = "https://anime-kitsu.strem.fun/meta";

interface KitsuMap {
  imdbId?: string;
  /** Kitsu episode -> [IMDb season, IMDb episode]. */
  episodes: Record<string, [number, number]>;
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

async function kitsuMap(kitsuId: string): Promise<KitsuMap | undefined> {
  const key = cacheKey({ kind: "kitsu-imdb", kitsuId });
  const cached = await readJsonCache<KitsuMap>("results", key);
  if (cached) return cached;

  for (const type of ["series", "movie"]) {
    try {
      const response = await fetch(`${KITSU_META}/${type}/kitsu:${kitsuId}.json`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        meta?: { imdb_id?: string; videos?: Array<{ id?: string; episode?: number; imdbSeason?: number; imdbEpisode?: number }> };
      };
      if (!body.meta) continue;
      const map: KitsuMap = { imdbId: body.meta.imdb_id, episodes: {} };
      for (const video of body.meta.videos ?? []) {
        const episode = video.episode ?? Number(video.id?.split(":")[2]);
        if (episode && video.imdbSeason && video.imdbEpisode) map.episodes[episode] = [video.imdbSeason, video.imdbEpisode];
      }
      await writeJsonCache("results", key, map, 24 * 60 * 60);
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
  const known = map.episodes[parsed.episode];
  // Without a listed mapping, treat the Kitsu number as an absolute episode of season 1.
  return known ? { imdbId: map.imdbId, season: known[0], episode: known[1] } : { imdbId: map.imdbId, season: 1, episode: parsed.episode };
}
