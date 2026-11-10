/**
 * SubSource's API (api.subsource.net/api/v1). Every call runs on the key of
 * the link that asked, and is counted against it (stats.ts). Results are public
 * data, so their cache is shared by everyone whatever key fetched them; the
 * cache keys below must not change, or every cached search is fetched again.
 */
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { count, noteKeyCall } from "./stats.js";
import type { StremioSubtitleRequest, SubSourceMovie, SubSourceSubtitle } from "./types.js";

const API = "https://api.subsource.net/api/v1";
/** Subtitles per page when listing a record (SubSource's maximum). */
const PAGE_SIZE = 50;

/** SubSource's reply: the data, plus page counts on lists. */
interface Reply<T> {
  data: T;
  pagination?: { pages: number };
}

/** Every call names the key it runs on: the owner's, or a friend's from their personal link. */
function requireKey(apiKey: string): string {
  if (!apiKey) throw new Error("No SubSource API key for this request");
  return apiKey;
}

/** A GET on the API, counted for its key. A refusal throws with SubSource's own message. */
async function apiGet<T>(apiKey: string, pathname: string, query: Record<string, string | number | undefined> = {}): Promise<Reply<T>> {
  const url = new URL(API + pathname);
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
  count("api.subsource");
  const response = await fetch(url, { headers: { "X-API-Key": requireKey(apiKey), Accept: "application/json" } });
  noteKeyCall("subsource", apiKey, response);
  if (!response.ok) {
    count("api.subsource.fail");
    throw new Error(`SubSource ${response.status} for ${pathname}: ${await response.text()}`);
  }
  return (await response.json()) as Reply<T>;
}

/** A cached result, or the fetched one (then cached). */
async function cachedResult<T>(key: string, fetchIt: () => Promise<T>): Promise<T> {
  const kept = await readJsonCache<T>("results", key);
  if (kept) return kept;
  const fresh = await fetchIt();
  await writeJsonCache("results", key, fresh);
  return fresh;
}

/** SubSource's records for an IMDb id: one per season for a series. */
export function searchMoviesByImdb(imdbId: string, apiKey: string): Promise<SubSourceMovie[]> {
  return cachedResult(cacheKey({ kind: "movie-search-imdb", imdbId }), async () =>
    (await apiGet<SubSourceMovie[]>(apiKey, "/movies/search", { searchType: "imdb", imdb: imdbId })).data
  );
}

/**
 * SubSource records to try, best first. Anime is often filed on a whole-series
 * record (season 0) or on season 1 with absolute numbering, while the season
 * record itself is empty. Records with no subtitles at all are skipped, which
 * costs no API calls.
 */
export async function findCandidateMovies(request: StremioSubtitleRequest, apiKey: string): Promise<SubSourceMovie[]> {
  if (!request.imdbId) return [];
  const records = await searchMoviesByImdb(request.imdbId, apiKey);
  if (request.type !== "series") {
    const film = records.find((record) => record.type === "movie") ?? records[0];
    return film ? [film] : [];
  }
  const seasons = records.filter((record) => record.type === "tvseries");
  const preferred = [request.season, 0, 1].map((season) => seasons.find((record) => record.season === season));
  const picked = new Map<number, SubSourceMovie>();
  for (const record of [...preferred, ...seasons]) {
    if (record && !picked.has(record.movieId)) picked.set(record.movieId, record);
  }
  return [...picked.values()].filter((record) => record.subtitleCount !== 0).slice(0, 3);
}

/** Episode number counted across seasons (specials excluded), from Cinemeta's episode list. */
export async function absoluteEpisode(imdbId: string, season: number, episode: number): Promise<number | undefined> {
  if (season === 1) return episode;
  const key = cacheKey({ kind: "season-sizes", imdbId });
  let sizes = await readJsonCache<Record<string, number>>("results", key);
  if (!sizes) {
    try {
      const response = await fetch(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { meta?: { videos?: Array<{ season?: number }> } };
      sizes = {};
      for (const video of body.meta?.videos ?? []) {
        if (video.season && video.season > 0) sizes[video.season] = (sizes[video.season] ?? 0) + 1;
      }
      await writeJsonCache("results", key, sizes, 24 * 60 * 60);
    } catch {
      return undefined;
    }
  }
  let before = 0;
  for (let s = 1; s < season; s++) {
    if (!sizes[s]) return undefined;
    before += sizes[s];
  }
  return before + episode;
}

/** Countries whose own shows and films are made in English: no English dub exists to caption. */
const ENGLISH_SPEAKING = new Set(["united states", "united kingdom", "canada", "australia", "ireland", "new zealand"]);

/**
 * Whether a title was made in English, from its country in Cinemeta's catalog: true for The
 * Analyst (United States), false for Dr. Ember (Japan), undefined when unknown. Cached a day.
 */
export async function madeInEnglish(type: string, imdbId: string): Promise<boolean | undefined> {
  const key = cacheKey({ kind: "made-in", imdbId });
  const cached = await readJsonCache<{ country: string }>("results", key);
  let country = cached?.country;
  if (country === undefined) {
    try {
      const kind = type === "movie" ? "movie" : "series";
      const response = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { meta?: { country?: string } };
      country = String(body.meta?.country ?? "");
      await writeJsonCache("results", key, { country }, 24 * 60 * 60);
    } catch {
      return undefined;
    }
  }
  // "United States, Canada": the first country listed is where it comes from.
  const first = country.split(",")[0].trim().toLowerCase();
  return first ? ENGLISH_SPEAKING.has(first) : undefined;
}

/** Every subtitle of one SubSource record in one language (SubSource's name, e.g. "arabic"), all pages. */
export function getSubtitlesIn(movieId: number, language: string, apiKey: string): Promise<SubSourceSubtitle[]> {
  return cachedResult(cacheKey({ kind: "subtitles", movieId, language }), async () => {
    const all: SubSourceSubtitle[] = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      const reply = await apiGet<SubSourceSubtitle[]>(apiKey, "/subtitles", { movieId, language, page, limit: PAGE_SIZE });
      all.push(...reply.data);
      pages = reply.pagination?.pages ?? page;
    }
    return all;
  });
}

/** The subtitle's download as SubSource sends it: usually a zip, sometimes a lone file. */
export async function downloadSubtitleArchive(subtitleId: number, apiKey: string): Promise<Buffer> {
  count("api.subsource");
  const response = await fetch(`${API}/subtitles/${subtitleId}/download`, { headers: { "X-API-Key": requireKey(apiKey) } });
  noteKeyCall("subsource", apiKey, response, true);
  if (!response.ok) throw new Error(`SubSource ${response.status} downloading subtitle ${subtitleId}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}
