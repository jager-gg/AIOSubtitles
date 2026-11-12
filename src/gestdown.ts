/**
 * Gestdown (api.gestdown.info): a free API over Addic7ed's TV subtitles. No key or account. Series
 * only: the show is found by its TVDB id (from Cinemeta), then the episode's subtitles per language,
 * named as Addic7ed names them ("English", "Portuguese (Brazilian)").
 */
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { metaOf } from "./cinemeta.js";
import { count, noteError } from "./stats.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

export const GESTDOWN_API = "https://api.gestdown.info";
const HEADERS = { accept: "application/json", "user-agent": "AIOSubtitles" };
const WEEK = 7 * 24 * 60 * 60;

/** Addic7ed's names where they aren't the language's own name in title case. */
const NAMES: Record<string, string> = {
  "portuguese (br)": "Portuguese (Brazilian)",
  "spanish": "Spanish (Spain)",
  "spanish (eu)": "Spanish (Spain)",
  "spanish (la)": "Spanish (Latin America)",
  "chinese (simplified)": "Chinese (Simplified)",
  "chinese (traditional)": "Chinese (Traditional)",
  "farsi/persian": "Persian",
  "farsi": "Persian",
  "serbian": "Serbian (Latin)"
};

/** Addic7ed's name for a language (SubSource-style, "dutch" -> "Dutch"). */
export function gestdownLanguage(name: string): string {
  const lower = name.trim().toLowerCase();
  return NAMES[lower] ?? lower.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

interface GestdownSubtitle {
  subtitleId?: string;
  version?: string;
  completed?: boolean;
  hearingImpaired?: boolean;
  corrected?: boolean;
  qualities?: string[];
  language?: string;
  discovered?: string;
  downloadCount?: number;
  release?: string | null;
}

/** The show's id on Gestdown, by TVDB id; undefined when it doesn't have the show. Kept a week. */
async function showId(tvdbId: number): Promise<string | undefined> {
  const key = cacheKey({ kind: "gestdown-show", tvdbId });
  const cached = await readJsonCache<{ id?: string }>("results", key);
  if (cached) return cached.id;
  count("api.gestdown");
  const response = await fetch(`${GESTDOWN_API}/shows/external/tvdb/${tvdbId}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (response.status === 404) {
    await writeJsonCache("results", key, {}, WEEK);
    return undefined;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for the show`);
  const shows = ((await response.json()) as { shows?: Array<{ id?: string; tvDbId?: number }> }).shows ?? [];
  const id = shows.find((s) => s.tvDbId === tvdbId)?.id;
  await writeJsonCache("results", key, id ? { id } : {}, WEEK);
  return id;
}

/** Gestdown's subtitles for the episode in these languages (SubSource-style names). Series only. */
export async function gestdownSubtitles(request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (request.type !== "series" || !request.imdbId || !request.season || !request.episode) return [];
  try {
    const meta = await metaOf("series", request.imdbId);
    if (!meta?.tvdbId) return [];
    const show = await showId(meta.tvdbId);
    if (!show) return [];
    // Each language by itself: one refused (too many asks, a timeout) leaves the others listed, and isn't kept.
    const lists = await Promise.allSettled([...new Set(languages)].map((language) => episodeIn(show, request, language)));
    const failed = lists.find((list): list is PromiseRejectedResult => list.status === "rejected");
    if (failed) {
      noteError("gestdown", failed.reason);
      console.error(`gestdown: search failed: ${failed.reason instanceof Error ? failed.reason.message : failed.reason}`);
    }
    return lists.flatMap((list) => (list.status === "fulfilled" ? list.value : []));
  } catch (error) {
    noteError("gestdown", error);
    console.error(`gestdown: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

async function episodeIn(show: string, request: StremioSubtitleRequest, language: string): Promise<SubSourceSubtitle[]> {
  const name = gestdownLanguage(language);
  const key = cacheKey({ kind: "gestdown", show, season: request.season, episode: request.episode, name });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;
  count("api.gestdown");
  const response = await fetch(`${GESTDOWN_API}/subtitles/get/${show}/${request.season}/${request.episode}/${encodeURIComponent(name)}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8000)
  });
  // 404: no such episode or language. Anything else that isn't an answer is asked again next time.
  if (response.status === 404) {
    await writeJsonCache("results", key, []);
    return [];
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for S${request.season}E${request.episode} ${name}`);
  const rows = ((await response.json()) as { matchingSubtitles?: GestdownSubtitle[] }).matchingSubtitles ?? [];
  const out = rows.flatMap((row): SubSourceSubtitle[] => {
    if (!row.subtitleId || !/^[A-Za-z0-9]{6,40}$/.test(row.subtitleId) || row.completed === false) return [];
    if (row.language && row.language.toLowerCase() !== name.toLowerCase()) return [];
    return [
      {
        subtitleId: 0,
        ref: `gd${row.subtitleId}`,
        source: "gestdown",
        movieId: 0,
        language: language.toLowerCase(),
        // Addic7ed names the release it fits ("CREW", "720p.TEAM") and the qualities it works with.
        releaseInfo: [[row.version, ...(row.qualities ?? [])].filter(Boolean).join(" "), row.release ?? ""].filter(Boolean),
        commentary: null,
        files: 1,
        hearingImpaired: row.hearingImpaired ?? null,
        downloads: row.downloadCount ?? 0,
        rating: null,
        createdAt: row.discovered ?? null,
        episodeTrusted: true
      }
    ];
  });
  await writeJsonCache("results", key, out);
  return out;
}

/** Where a "gd" subtitle downloads from. */
export function gestdownDownloadUrl(ref: string): string | undefined {
  const id = /^gd([A-Za-z0-9]{6,40})$/.exec(ref)?.[1];
  return id ? `${GESTDOWN_API}/subtitles/download/${id}` : undefined;
}
