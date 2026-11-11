/**
 * Subtitle Cat (subtitlecat.com) as a source: subtitles people uploaded under their own file
 * names, each with machine translations made from it. It has titles the indexed sites lack
 * (fan translations of donghua, for one), and nothing to look them up by but the name: no ids, no
 * API, a search page and a page per upload. So the show's title and the episode number are
 * searched for, and a result is kept only when its name is that title followed by that episode.
 *
 * Names this loose can still be another show's. A Subtitle Cat subtitle is therefore listed only
 * once it has synced to the playing file (app.ts): what doesn't fit the file is never shown.
 *
 * On a page, "-orig.srt" is the upload itself, in the language the search row names ("translated
 * from English"); the other files are machine translations of it and are marked as such, so they
 * only reach people who allow machine translations.
 */
import { createHash } from "node:crypto";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { languageCode, languageName } from "./langcodes.js";
import { subtitleMatchesRequestedEpisode } from "./matching.js";
import { count, noteError } from "./stats.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

const SITE = "https://www.subtitlecat.com";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; AIOSubtitles)", Accept: "text/html,*/*" };
/** Pages opened per request: each is one more fetch. */
const MAX_PAGES = 4;
const DAY = 24 * 60 * 60;

/** A row of the search page. */
export interface CatRow {
  /** "subs/853/Show_S2_17%2833%29.html" */
  page: string;
  name: string;
  /** The upload's language, lower case, when the row says "(translated from English)". */
  from?: string;
}

const decode = (text: string) =>
  text.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** The uploads a search page lists. */
export function parseSearch(html: string): CatRow[] {
  const rows: CatRow[] = [];
  for (const m of html.matchAll(/<td>\s*<a href="(subs\/[^"]+\.html)">([\s\S]*?)<\/a>\s*(?:\(translated from ([^)]+)\))?/g)) {
    rows.push({ page: m[1], name: decode(m[2].replace(/<[^>]+>/g, "")).trim(), ...(m[3] ? { from: m[3].trim().toLowerCase() } : {}) });
  }
  return rows;
}

/** An upload's page: the upload itself and the translations already made, by the site's language code. */
export function parsePage(html: string): { original?: string; files: Array<{ code: string; path: string }> } {
  const orig = /translate_from_server_folder\('[^']*',\s*'([^']+-orig\.srt)',\s*'(\/subs\/[^']+\/)'\)/.exec(html);
  const files = [...html.matchAll(/<a id="download_([A-Za-z-]+)"[^>]*href="(\/subs\/[^"]+\.srt)"/g)].map((m) => ({ code: m[1], path: decode(m[2]) }));
  return { ...(orig ? { original: decode(orig[2] + orig[1]) } : {}), files };
}

/** Words that sit between a title and its episode number without making it another title. */
const BETWEEN = new Set(["season", "s", "series", "part", "the", "movie", "episode", "ep", "e", "tv"]);
/** What may follow a film's title in a file name. */
const FILM_TAG = /^(?:\d{3,4}p|4k|uhd|hd|sd|bluray|blu|ray|bdrip|brrip|web|webrip|webdl|dl|hdrip|dvdrip|hdtv|x26[45]|h26[45]|hevc|avc|aac|ac3|dts|remux|proper|repack|extended|unrated|imax|multi|dual|eng|english|sub|subs|srt)$/;

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

/**
 * An upload's name as release names are usually written, so the episode rules (matching.ts) read
 * it: bracketed tags and site names off, "_" and "." as spaces, and the season-then-number forms
 * these names use spelled as SxxEyy ("S2_17(33)", "S01 EP02", "S02 E002").
 */
export function releaseForm(name: string): string {
  return name
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b[\w-]+\.(?:com|net|org|io|tv|to|cc|me|info)\b\.?/gi, " ")
    .replace(/@\w+/g, " ")
    .replace(/[_.()]+/g, " ")
    .replace(/\bS(\d{1,2})\s*EP?\s*0*(\d{1,3})\b/gi, "S$1E$2")
    .replace(/\bS(\d{1,2})\s+0*(\d{1,3})\b/gi, "S$1E$2")
    .replace(/\bEP?(\d{1,4})\b/gi, "EP $1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether an upload's name is this title and this episode (or this film). The title's words must
 * stand together, with nothing before them but an episode marker, and nothing between them and the
 * episode number but words like "season": "Show Girl S02E17" isn't "Show", and "Show the Women"
 * isn't "The Show". The episode itself is judged as for any release name.
 */
export function nameFits(name: string, title: string, request: StremioSubtitleRequest, year?: number): boolean {
  const form = releaseForm(name);
  const tokens = words(form);
  const wanted = words(title).filter((w, i) => !(i === 0 && w === "the"));
  if (wanted.length === 0) return false;
  let at = -1;
  for (let i = 0; i + wanted.length <= tokens.length && at < 0; i++) if (wanted.every((w, k) => tokens[i + k] === w)) at = i;
  if (at < 0) return false;
  const marker = (t: string) => /^(?:s\d{1,2}e\d{1,3}|\d{1,4})$/.test(t);
  if (!tokens.slice(0, at).every((t) => marker(t) || t === "the")) return false;
  const after = tokens.slice(at + wanted.length);
  if (request.type !== "series" || !request.season || !request.episode) {
    // A film: its year when the name gives one, and otherwise nothing but tags.
    const years = after.filter((t) => /^(?:19|20)\d{2}$/.test(t)).map(Number);
    if (years.length && year && !years.some((y) => Math.abs(y - year) <= 1)) return false;
    const next = after.find((t) => !/^(?:19|20)\d{2}$/.test(t));
    return next === undefined || FILM_TAG.test(next);
  }
  // A name that says "Episode 9" is that episode, whatever other numbers it carries ("... Episode 9
  // No Sub 2"), and a number between the title and that word belongs to the title ("Show 2 - The
  // Next Chapter Episode 100" is another show), unless it follows "season" or "part".
  const said = after.findIndex((t, i) => /^(?:episode|ep|e)$/.test(t) && /^\d{1,4}$/.test(after[i + 1] ?? ""));
  if (said >= 0) {
    for (let i = 0; i < said; i++) {
      const t = after[i];
      const counted = /^\d{1,4}$/.test(t) && /^(?:season|s|part)$/.test(after[i - 1] ?? "");
      if (!BETWEEN.has(t) && !counted && !/^(?:19|20)\d{2}$/.test(t) && !/^s\d{1,2}$/.test(t)) return false;
    }
    const n = Number(after[said + 1]);
    if (n !== request.episode && n !== request.absoluteEpisode) return false;
    const season = after.slice(0, said).flatMap((t, i) => (/^\d{1,2}$/.test(t) && /^(?:season|s)$/.test(after[i - 1] ?? "") ? [Number(t)] : /^s(\d{1,2})$/.test(t) ? [Number(t.slice(1))] : []));
    // A season named before it has to be this one, unless the number counts across the show.
    return season.length === 0 || season.includes(request.season) || (n === request.absoluteEpisode && n !== request.episode);
  }
  for (const t of after) {
    if (marker(t)) break;
    if (!BETWEEN.has(t) && !/^(?:19|20)\d{2}$/.test(t)) return false;
  }
  return subtitleMatchesRequestedEpisode({ subtitleId: 0, movieId: 0, language: "", releaseInfo: [form], files: 1 }, request);
}

/** The title and year a catalog id stands for, from Cinemeta. Cached a day. */
export async function titleOf(type: string, imdbId: string): Promise<{ name: string; year?: number } | undefined> {
  const key = cacheKey({ kind: "title", imdbId });
  const cached = await readJsonCache<{ name: string; year?: number }>("results", key);
  if (cached) return cached.name ? cached : undefined;
  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type === "movie" ? "movie" : "series"}/${imdbId}.json`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const meta = ((await response.json()) as { meta?: { name?: string; year?: string; releaseInfo?: string } }).meta;
    const year = Number(/\d{4}/.exec(String(meta?.year ?? meta?.releaseInfo ?? ""))?.[0]);
    const found = { name: String(meta?.name ?? "").trim(), ...(year ? { year } : {}) };
    await writeJsonCache("results", key, found, DAY);
    return found.name ? found : undefined;
  } catch {
    return undefined;
  }
}

async function page(pathname: string): Promise<string> {
  count("api.subtitlecat");
  const response = await fetch(new URL(pathname, `${SITE}/`), { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** What to type into the site's search for this title and episode: it matches every word given. */
export function searches(title: string, request: StremioSubtitleRequest, year?: number): string[] {
  const name = words(title).filter((w, i) => !(i === 0 && w === "the")).join(" ");
  if (!name) return [];
  if (request.type !== "series" || !request.season || !request.episode) return [...new Set([year ? `${name} ${year}` : name, name])];
  const two = (n: number) => String(n).padStart(2, "0");
  const numbers = [request.episode, ...(request.absoluteEpisode && request.absoluteEpisode !== request.episode ? [request.absoluteEpisode] : [])];
  return [...new Set([...numbers.map((n) => `${name} ${n}`), `${name} S${two(request.season)}E${two(request.episode)}`])];
}

// ---------- is the file in the language it is listed under ----------

/** Writing systems, by the languages that use them; a language not named here is written in Latin letters. */
const SCRIPTS: Array<[RegExp, RegExp]> = [
  [/^(arabic|persian|farsi|urdu|pashto|kurdish)/, /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g],
  [/^(chinese|japanese|korean|cantonese)/, /[぀-ヿ㐀-鿿가-힯]/g],
  [/^(russian|ukrainian|bulgarian|serbian|macedonian|belarusian|kazakh|mongolian)/, /[Ѐ-ӿ]/g],
  [/^greek/, /[Ͱ-Ͽ]/g],
  [/^hebrew/, /[֐-׿]/g],
  [/^thai/, /[฀-๿]/g],
  [/^(hindi|marathi|nepali)/, /[ऀ-ॿ]/g]
];
const LATIN = /[A-Za-zÀ-ɏ]/g;
/** The commonest words of a language: real dialogue is full of them, another language has few. */
const COMMON: Record<string, string[]> = {
  english: ["the", "you", "i", "to", "a", "it", "is", "and", "that", "of", "what", "in", "me", "this", "not", "we", "he", "my", "are", "have", "for", "no", "do", "your", "be", "was", "on", "so", "but", "with"],
  dutch: ["de", "het", "een", "ik", "je", "dat", "niet", "is", "en", "van", "wat", "in", "we", "hij", "op", "te", "zijn", "er", "maar", "voor", "met", "die", "dit", "aan", "heb", "ze", "me", "wel", "nog", "zo"]
};

/**
 * Whether a subtitle's text is written in the language it is listed under. The site names an
 * upload's language itself and gets it wrong: an upload listed as English held Chinese text, and
 * timing alone can't tell, so it could have synced and been served as
 * English. Checked by writing system, and for English and Dutch by how many of the words are the
 * language's commonest ones (about a third in real dialogue, a few in a hundred in another language).
 */
export function writtenIn(text: string, language: string): boolean {
  const body = text.replace(/^\d+\s*$/gm, " ").replace(/^.*-->.*$/gm, " ").replace(/<[^>]+>|\{[^}]*\}/g, " ");
  const letters = body.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 200) return false;
  const name = language.toLowerCase();
  const own = SCRIPTS.find(([languages]) => languages.test(name));
  const inScript = body.match(own ? own[1] : LATIN)?.length ?? 0;
  if (inScript / letters < (own ? 0.5 : 0.85)) return false;
  const common = COMMON[name];
  if (!common) return true;
  const tokens = body.toLowerCase().match(/[a-zÀ-ɏ']+/g) ?? [];
  const hits = tokens.filter((t) => common.includes(t)).length;
  return tokens.length > 0 && hits / tokens.length >= 0.15;
}

const refOfPath = (pathname: string) => `sc${createHash("sha256").update(pathname).digest("hex").slice(0, 20)}`;
const fileKey = (ref: string) => cacheKey({ kind: "subtitlecat-upload", ref });

/** Subtitle Cat's subtitles for the episode (or film) in the given languages (SubSource-style names). */
export async function subtitleCatSubtitles(request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (!request.imdbId || languages.length === 0) return [];
  const key = cacheKey({ kind: "subtitlecat-search", id: request.id, languages: [...languages].sort() });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;
  const out: SubSourceSubtitle[] = [];
  try {
    const title = await titleOf(request.type, request.imdbId);
    if (!title) return [];
    const lists = await Promise.all(searches(title.name, request, title.year).map((q) => page(`index.php?search=${encodeURIComponent(q)}`).then(parseSearch, () => [] as CatRow[])));
    const seen = new Set<string>();
    const rows = lists.flat().filter((row) => !seen.has(row.page) && seen.add(row.page) && nameFits(row.name, title.name, request, title.year));
    await Promise.all(
      rows.slice(0, MAX_PAGES).map(async (row) => {
        const found = parsePage(await page(row.page));
        const entry = (pathname: string, language: string, machine: boolean): SubSourceSubtitle => ({
          subtitleId: 0,
          ref: refOfPath(pathname),
          source: "subtitlecat",
          movieId: 0,
          language,
          // The name as the episode rules read it, so ranking judges the same thing as the search did.
          releaseInfo: [releaseForm(row.name)],
          commentary: null,
          files: 1,
          hearingImpaired: false,
          productionType: machine ? "machine translated" : null,
          link: pathname,
          downloads: 0,
          rating: null
        });
        for (const language of languages) {
          if (row.from === language && found.original) out.push(entry(found.original, language, false));
          else {
            const file = found.files.find((f) => languageName(f.code.toLowerCase()) === language || f.code.toLowerCase() === languageCode(language));
            // The file in the upload's own language is the upload again.
            if (file && row.from !== language) out.push(entry(file.path, language, true));
          }
        }
      })
    );
    // A download is asked for by its ref alone: where each one lives is kept beside the results.
    await Promise.all(out.map((s) => writeJsonCache("results", fileKey(s.ref as string), { path: s.link, language: s.language }, 30 * DAY)));
  } catch (error) {
    noteError("subtitlecat", error);
    console.error(`subtitlecat: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
  await writeJsonCache("results", key, out);
  return out;
}

/** The file a Subtitle Cat ref stands for. */
export async function downloadSubtitleCat(ref: string): Promise<Buffer> {
  const known = await readJsonCache<{ path: string; language?: string }>("results", fileKey(ref));
  if (!known?.path) throw new Error(`no address for subtitle ${ref}`);
  count("api.subtitlecat");
  const response = await fetch(new URL(known.path, `${SITE}/`), { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 5_000_000) throw new Error(`download of ${ref} failed: too large`);
  if (known.language && !writtenIn(body.toString("utf8"), known.language)) throw new Error(`subtitle ${ref} isn't written in ${known.language}, though listed as it`);
  return body;
}
