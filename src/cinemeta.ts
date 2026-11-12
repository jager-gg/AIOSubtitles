/**
 * What Cinemeta (Stremio's catalog) says about a title: its name, year, TVDB id, genres and country.
 * Fetched once a day per title and shared by the sources that need it.
 */
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";

export interface TitleMeta {
  name: string;
  year?: number;
  tvdbId?: number;
  genres: string[];
  /** "Japan", "United States, Canada": the first is where it comes from. */
  country: string;
}

const DAY = 24 * 60 * 60;

export async function metaOf(type: string, imdbId: string): Promise<TitleMeta | undefined> {
  const kind = type === "movie" ? "movie" : "series";
  const key = cacheKey({ kind: "cinemeta-meta", type: kind, imdbId });
  const cached = await readJsonCache<TitleMeta | { none: true }>("results", key);
  if (cached) return "none" in cached ? undefined : cached;
  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const meta = ((await response.json()) as { meta?: { name?: string; year?: string; releaseInfo?: string; tvdb_id?: number | string; genres?: string[]; country?: string } }).meta;
    if (!meta?.name) {
      await writeJsonCache("results", key, { none: true }, DAY);
      return undefined;
    }
    const year = Number(/\d{4}/.exec(String(meta.year ?? meta.releaseInfo ?? ""))?.[0]);
    const tvdbId = Number(meta.tvdb_id);
    const found: TitleMeta = {
      name: String(meta.name).trim(),
      ...(year ? { year } : {}),
      ...(Number.isInteger(tvdbId) && tvdbId > 0 ? { tvdbId } : {}),
      genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
      country: String(meta.country ?? "")
    };
    await writeJsonCache("results", key, found, DAY);
    return found;
  } catch {
    return undefined;
  }
}

/** Countries whose animation is anime or its neighbours (donghua, aeni), as Cinemeta names them. */
const ANIME_COUNTRIES = new Set(["japan", "china", "south korea", "korea", "taiwan", "hong kong"]);

/** Whether Cinemeta files the title as animation from the countries anime comes from. */
export function isAnime(meta: TitleMeta | undefined): boolean {
  if (!meta) return false;
  const from = meta.country.split(",")[0].trim().toLowerCase();
  return meta.genres.some((g) => /^animation$|^anime$/i.test(g)) && ANIME_COUNTRIES.has(from);
}
