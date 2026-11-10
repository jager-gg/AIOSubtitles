/**
 * Subtitle sources besides SubSource. Their results are converted to the
 * same shape as SubSource's, so dub/CC detection, quality ranking and sync
 * treat every source alike. Keys only ever go to their own API, from here,
 * never into URLs handed out or into logs.
 */
import { createHash } from "node:crypto";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { fetchPublic, publicHttpsUrl, readCapped } from "./net.js";
import { sealUrl, type Addon } from "./profile.js";
import { count, noteError, noteKeyCall } from "./stats.js";
import { languageCode, languageName } from "./langcodes.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

const SUBDL_API = "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DOWNLOAD = "https://dl.subdl.com/subtitle";
const OPENSUBTITLES_V3_PLUS = "https://opensubtitles.stremio.homes";

/** A short id per source, used in download URLs: "ss123", "sd3734901-8656630", "osar-11816405". */
export function refOf(subtitle: SubSourceSubtitle): string {
  return subtitle.ref ?? `ss${subtitle.subtitleId}`;
}

// ---------- SubDL ----------

interface SubdlItem {
  release_name?: string;
  name?: string;
  lang?: string;
  language?: string;
  author?: string;
  url?: string;
  season?: number | null;
  episode?: number | null;
  hi?: boolean;
  comment?: string | null;
  releases?: string[];
  episode_from?: number | null;
  episode_end?: number | null;
  full_season?: boolean;
}

/** SubDL subtitles for the episode (or film) in the given languages (SubSource-style names). */
export async function subdlSubtitles(apiKey: string, request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  const codes = [...new Set(languages.map((l) => languageCode(l)?.toUpperCase()).filter((c): c is string => Boolean(c)))];
  if (!apiKey || !request.imdbId || codes.length === 0) return [];
  const key = cacheKey({ kind: "subdl", imdb: request.imdbId, season: request.season, episode: request.episode, codes });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;

  const query = new URLSearchParams({
    api_key: apiKey,
    imdb_id: request.imdbId,
    type: request.type === "series" ? "tv" : "movie",
    languages: codes.join(","),
    subs_per_page: "30",
    releases: "1",
    hi: "1",
    comment: "1"
  });
  if (request.type === "series" && request.season) query.set("season_number", String(request.season));
  if (request.type === "series" && request.episode) query.set("episode_number", String(request.episode));

  let items: SubdlItem[] = [];
  count("api.subdl");
  try {
    const response = await fetch(`${SUBDL_API}?${query}`, { signal: AbortSignal.timeout(10000) });
    noteKeyCall("subdl", apiKey, response);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { status?: boolean; subtitles?: SubdlItem[] };
    items = body.status ? body.subtitles ?? [] : [];
  } catch (error) {
    // Never log the request URL: it carries the key.
    noteError("subdl", error);
    console.error(`subdl: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }

  const out = items.flatMap((item): SubSourceSubtitle[] => {
    const id = item.url?.match(/\/subtitle\/([\w-]+)\.zip/)?.[1];
    const lang = languageName((item.language ?? item.lang ?? "").slice(0, 2));
    if (!id || !lang) return [];
    const span = item.episode_from && item.episode_end ? item.episode_end - item.episode_from + 1 : undefined;
    return [{
      subtitleId: 0,
      ref: `sd${id}`,
      source: "subdl",
      movieId: 0,
      language: lang,
      releaseInfo: [item.release_name ?? item.name ?? "", ...(item.releases ?? [])].filter(Boolean),
      commentary: item.comment ?? null,
      // A season pack has more than one file; the matching uses that to look inside it.
      files: item.full_season ? Math.max(2, span ?? 2) : 1,
      hearingImpaired: item.hi ?? null,
      downloads: 0,
      rating: null,
      contributors: item.author ? [{ displayname: item.author }] : null,
      // SubDL asked for this episode already: a single file it returns is for it.
      episodeTrusted: !item.full_season && (request.type !== "series" || item.episode === request.episode || item.episode == null)
    }];
  });
  await writeJsonCache("results", key, out);
  return out;
}

export function subdlDownloadUrl(ref: string, apiKey: string): string {
  return `${SUBDL_DOWNLOAD}/${ref.slice(2)}.zip?api_key=${encodeURIComponent(apiKey)}`;
}

// ---------- OpenSubtitles V3+ ----------

interface OpenSubtitlesItem {
  sub_id?: number;
  ai_translated?: boolean;
  from_trusted?: boolean;
  lang_code?: string;
  title?: string;
}

const HEARING_IMPAIRED = /\[cc\]|\bsdh\b|\bcc\b|\[hi\]|\bhi\b|closed.?caption/i;

/** OpenSubtitles V3+ (no key): already per episode, with release names and an AI-translated flag. */
export async function openSubtitles(request: StremioSubtitleRequest, languages: string[], allowMachine: boolean): Promise<SubSourceSubtitle[]> {
  const codes = [...new Set(languages.map((l) => languageCode(l)).filter((c): c is string => Boolean(c)))].slice(0, 10);
  if (!request.imdbId || codes.length === 0) return [];
  const id = request.type === "series" && request.season && request.episode ? `${request.imdbId}:${request.season}:${request.episode}` : request.imdbId;
  const key = cacheKey({ kind: "opensubtitles-v3plus", id, codes, allowMachine });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;

  const config = `${encodeURIComponent(codes.join("|"))}/${encodeURIComponent(`ai-translated=${allowMachine}|from=all|auto-adjustment=false`)}`;
  let items: OpenSubtitlesItem[] = [];
  count("api.opensubtitles");
  try {
    const response = await fetch(`${OPENSUBTITLES_V3_PLUS}/${config}/subtitles/${request.type === "series" ? "series" : "movie"}/${id}.json`, {
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    items = ((await response.json()) as { subtitles?: OpenSubtitlesItem[] }).subtitles ?? [];
  } catch (error) {
    noteError("opensubtitles", error);
    console.error(`opensubtitles: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }

  const out = items.flatMap((item): SubSourceSubtitle[] => {
    const lang = item.lang_code ? languageName(item.lang_code) : undefined;
    if (!item.sub_id || !item.lang_code || !lang) return [];
    const title = item.title ?? "";
    return [{
      subtitleId: 0,
      ref: `os${item.lang_code}-${item.sub_id}`,
      source: "opensubtitles",
      movieId: 0,
      language: lang,
      releaseInfo: [title],
      commentary: null,
      files: 1,
      hearingImpaired: HEARING_IMPAIRED.test(title),
      // Only the AI flag and the trusted-uploader flag say anything about the translation.
      productionType: item.ai_translated ? "machine translated" : item.from_trusted ? "translated" : null,
      downloads: 0,
      rating: null,
      episodeTrusted: true
    }];
  });
  await writeJsonCache("results", key, out);
  return out;
}

export function openSubtitlesDownloadUrl(ref: string): string | undefined {
  const match = ref.match(/^os([a-z-]+)-(\d+)$/);
  return match ? `${OPENSUBTITLES_V3_PLUS}/sub.vtt/?lang_code=${match[1]}&sub_id=${match[2]}` : undefined;
}

/**
 * OpenSubtitles V3+ serves every subtitle as VTT with a promo cue first and a
 * second "WEBVTT" line after it. When the original SRT starts with a byte
 * order mark, its converter also turns every line into a NOTE comment, which
 * players hide. This puts the file back the way it was uploaded.
 */
export function repairOpenSubtitlesVtt(text: string): string {
  let lines = text.replace(/\r\n?/g, "\n").replace(/﻿/g, "").split("\n");
  // Lines commented out by the broken conversion: the timings themselves are inside NOTE lines.
  if (lines.some((l) => /^NOTE .*-->/.test(l))) lines = lines.map((l) => l.replace(/^NOTE ?/, ""));
  const blocks = lines
    .join("\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b && !/^WEBVTT\b/.test(b) && !/OpenSubtitles v3\+/i.test(b));
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

// ---------- other Stremio subtitle addons ----------

interface AddonItem {
  id?: string | number;
  url?: string;
  lang?: string;
  label?: string;
  title?: string;
}

/** "ara", "ar", "Arabic", "pt-br" -> the language name used here ("arabic"), or undefined. */
export function addonLanguage(code: string): string | undefined {
  const c = code.trim().toLowerCase();
  if (!c) return undefined;
  const direct = languageName(c) ?? (languageCode(c) ? c : undefined);
  if (direct) return direct;
  try {
    // Three-letter codes ("ara", "eng") canonicalise to the two-letter ones the table uses.
    const short = Intl.getCanonicalLocales(c)[0]?.toLowerCase();
    return short ? languageName(short) ?? languageName(short.split("-")[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** Its base URL (no /manifest.json), for /subtitles requests. */
function addonBase(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json$/, "");
}

/**
 * Subtitles from an added addon, in the wanted languages. It's asked the way
 * a player would ask it, with the filename (and hash, when the player sent
 * one) so it can match the file. Its subtitle URLs are sealed before they're
 * kept anywhere: an addon's links can carry its keys.
 */
export async function addonSubtitles(addon: Addon, request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (!request.imdbId) return [];
  const wanted = new Set(languages.map((l) => l.toLowerCase()));
  const id = request.type === "series" && request.season && request.episode ? `${request.imdbId}:${request.season}:${request.episode}` : request.imdbId;
  const extra = new URLSearchParams();
  if (request.filename) extra.set("filename", request.filename);
  if (request.videoHash) extra.set("videoHash", request.videoHash);
  if (request.videoSize) extra.set("videoSize", request.videoSize);
  const key = cacheKey({ kind: "addon", url: addon.url, id, extra: extra.toString() });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached.filter((s) => wanted.has(s.language));

  const type = request.type === "series" ? "series" : "movie";
  const path = `/subtitles/${type}/${encodeURIComponent(id)}${extra.size ? `/${extra.toString()}` : ""}.json`;
  let items: AddonItem[] = [];
  count("api.addons");
  try {
    const response = await fetchPublic(`${addonBase(addon.url)}${path}`, 10000, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = JSON.parse((await readCapped(response, 2_000_000)).toString("utf8")) as { subtitles?: AddonItem[] };
    items = Array.isArray(body.subtitles) ? body.subtitles : [];
  } catch (error) {
    // Never log the URL: it can carry the addon's keys.
    noteError("addons", error);
    console.error(`addon ${addon.name}: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }

  const out = items.slice(0, 200).flatMap((item): SubSourceSubtitle[] => {
    const lang = item.lang ? addonLanguage(item.lang) : undefined;
    if (!item.url || !lang || !publicHttpsUrl(item.url)) return [];
    const title = [item.label, item.title].filter((t): t is string => typeof t === "string" && t.trim() !== "").join(" ");
    return [{
      subtitleId: 0,
      ref: `cx${createHash("sha256").update(item.url).digest("hex").slice(0, 20)}`,
      source: "addon",
      sealedUrl: sealUrl(item.url),
      movieId: 0,
      language: lang,
      releaseInfo: title ? [title] : [],
      commentary: null,
      files: 1,
      hearingImpaired: HEARING_IMPAIRED.test(title),
      downloads: 0,
      rating: null,
      // No addon name in here: the dub check reads every name, and an addon called "… Dub …" isn't a tag.
      // The addon was asked for this episode.
      episodeTrusted: true
    }];
  });
  await writeJsonCache("results", key, out);
  return out.filter((s) => wanted.has(s.language));
}
