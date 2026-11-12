/**
 * TheSubtitleDB (thesubtitledb.org): a free subtitle database with an open API, looked up by IMDb id,
 * per episode. No key or account. Its answer for an episode is already narrowed to it, with each
 * subtitle's release name, language and hearing-impaired flag, so its rows rank like any other's.
 * Rows it marks as made by AI (transcribed from the audio, or translated) count as machine-made.
 */
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { languageCode, languageName } from "./langcodes.js";
import { count, noteError } from "./stats.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

export const THESUBTITLEDB_API = "https://api.thesubtitledb.org";
const HEADERS = { accept: "application/json", "user-agent": "AIOSubtitles" };
/** Rows asked for per language: the API's limit is shared by every language in one ask, so each language asks alone. */
const PER_LANGUAGE = 30;
/** Formats served as text: SubRip, ASS/SSA and WebVTT. */
const TEXT_FORMATS = new Set(["srt", "ass", "ssa", "vtt"]);

interface Row {
  id?: number;
  language?: string;
  format?: string;
  season?: number | null;
  episode?: number | null;
  release_name?: string;
  uploader?: string;
  hearing_impaired?: boolean;
  added_at?: string;
  /** Transcribed from the audio by speech recognition. */
  ai_transcribed?: boolean;
  /** What an AI made of it, when one did (null for a person's upload). */
  ai?: unknown;
}

/** Whether a row was made by AI, which the ranking treats as a machine translation (left out unless allowed). */
function aiMade(row: Row): boolean {
  return row.ai_transcribed === true || (row.ai !== undefined && row.ai !== null && row.ai !== false && row.ai !== "");
}

/** Its language codes where they differ from this addon's (OpenSubtitles' older two-letter ones). */
const TO_API: Record<string, string> = { "pt-br": "pb", "pt-pt": "pt", "zh-cn": "zh", "zh-tw": "zt" };
const FROM_API: Record<string, string> = Object.fromEntries(Object.entries(TO_API).map(([ours, theirs]) => [theirs, ours]));

/** The API's code for a language name ("english" -> "en", "portuguese (br)" -> "pb"). */
export function apiLanguage(name: string): string | undefined {
  const code = languageCode(name);
  return code ? (TO_API[code] ?? code) : undefined;
}

/** This addon's name for an API code ("pb" -> "portuguese (br)"). */
export function fromApiLanguage(code: string): string | undefined {
  return languageName(FROM_API[code] ?? code);
}

/** TheSubtitleDB's subtitles for the episode (or film) in these languages (SubSource-style names). */
export async function theSubtitleDbSubtitles(request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (!request.imdbId) return [];
  const series = request.type === "series";
  if (series && (request.season === undefined || request.episode === undefined)) return [];
  const codes = [...new Set(languages.map(apiLanguage).filter((c): c is string => Boolean(c)))];
  const lists = await Promise.all(codes.map((code) => rowsIn(request, code)));
  return lists.flat();
}

async function rowsIn(request: StremioSubtitleRequest, code: string): Promise<SubSourceSubtitle[]> {
  const series = request.type === "series";
  const key = cacheKey({ kind: "thesubtitledb", imdb: request.imdbId, season: series ? request.season : undefined, episode: series ? request.episode : undefined, code });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;
  const url = new URL(`/v1/by-imdb/${request.imdbId}${series ? `/season/${request.season}/episode/${request.episode}` : ""}`, THESUBTITLEDB_API);
  url.searchParams.set("limit", String(PER_LANGUAGE));
  url.searchParams.set("lang", code);
  url.searchParams.set("client", "aiosubtitles");
  let rows: Row[] = [];
  count("api.thesubtitledb");
  try {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    // 404: it has nothing for this title. Kept like an empty list.
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      rows = ((await response.json()) as { subtitles?: { items?: Row[] } }).subtitles?.items ?? [];
    }
  } catch (error) {
    noteError("thesubtitledb", error);
    console.error(`thesubtitledb: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
  const out = rows.flatMap((row): SubSourceSubtitle[] => {
    const language = row.language ? fromApiLanguage(row.language) : undefined;
    if (!row.id || !language || row.language !== code || !TEXT_FORMATS.has(String(row.format ?? "").toLowerCase())) return [];
    // A row the API placed in another episode (it narrows by episode, but says so per row too).
    if (series && ((row.season != null && row.season !== request.season) || (row.episode != null && row.episode !== request.episode))) return [];
    return [
      {
        subtitleId: 0,
        ref: `tb${row.id}`,
        source: "thesubtitledb",
        movieId: 0,
        language,
        releaseInfo: row.release_name ? [row.release_name] : [],
        commentary: null,
        productionType: aiMade(row) ? "machine translated" : null,
        files: 1,
        hearingImpaired: row.hearing_impaired ?? null,
        downloads: 0,
        rating: null,
        contributors: row.uploader ? [{ displayname: row.uploader }] : null,
        createdAt: row.added_at ?? null,
        // Asked for this episode: its rows are for it.
        episodeTrusted: true
      }
    ];
  });
  await writeJsonCache("results", key, out);
  return out;
}

/** Where a "tb" subtitle downloads from: the API's counted link, which leads on to the file. */
export function theSubtitleDbDownloadUrl(ref: string): string | undefined {
  const id = /^tb(\d{1,12})$/.exec(ref)?.[1];
  return id ? `${THESUBTITLEDB_API}/get/${id}` : undefined;
}
