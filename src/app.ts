import cors from "cors";
import express, { type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accessRoutes, checkLimit, requireRole, sessionRoles } from "./access.js";
import { config } from "./config.js";
import { getCachedSubtitleFile, isDownloaded, knownMissing } from "./downloads.js";
import { compareRanked, filterAndRankDubtitles } from "./matching.js";
import { addonSubtitles, openSubtitles, refOf, subdlSubtitles } from "./sources.js";
import type { SourceKeys } from "./downloads.js";
import { noteLinkToken, openUrl, routePath, storeSettings, type Profile, type Settings } from "./profile.js";
import { checkStep, configurePage, saveConfiguration } from "./configure.js";
import { kitsuToImdb } from "./ids.js";
import { absoluteEpisode, findCandidateMovies, getSubtitlesIn, madeInEnglish } from "./subsource.js";
import { subtitleCatSubtitles } from "./subtitlecat.js";
import { decodeSubtitle } from "./text.js";
import { toSrt } from "./srt.js";
import { tierName, type QualityTier } from "./quality.js";
import type { RankedSubtitle } from "./types.js";
import { embeddedLanguages, fileHasSubtitles, fileName, fileRef, firstPassSync, knownSync, SYNC_VERSION, syncCaptions, syncKey, type SyncResult } from "./sync.js";
import { activityPage, clearErrors, undoClearErrors, count, downloadsToday, linkNames, noteActivity, noteError, noteLinkKeys, noteLinkLabel, requestContext, scrub, statsView } from "./stats.js";
import { activityRows, pageRange, statsPage } from "./statsPage.js";
import { parseExtraArgs, parseStremioSubtitleRequest } from "./stremio.js";

/** Where links in answers point: PUBLIC_BASE_URL, or the address the request came in on. */
function publicBase(req: Request): string {
  return config.publicBaseUrl ?? `${req.protocol}://${req.get("host")}`;
}

function dubLabel(profile: Profile): string {
  return profile.langMode === "custom" ? "English Dub" : "English";
}

/**
 * The track's language as sent: "standard" sends the language alone ("Arabic"), so a player's
 * preferred subtitle language picks it, and the status goes in the label after it ("Arabic -
 * Synced · AIOSubtitles" in a Jellyfin client). "custom" keeps it in the name ("Arabic (Synced)").
 */
export function sentLanguage(profile: Profile, track: { lang: string; code?: string }): string {
  if (profile.langMode === "custom") return track.lang;
  return track.code ? languageTitle(track.code) : "English";
}

interface PlayingFile {
  videoId: string;
  type: string;
  filename: string;
}

function downloadUrl(
  baseUrl: string,
  profile: Profile,
  subtitle: RankedSubtitle,
  season?: number,
  episode?: number,
  playing?: PlayingFile,
  lang?: string,
  alts: Array<{ ref: string; at: Array<number | undefined> }> = []
): string {
  const url = new URL(`${profile.prefix}/download/${refOf(subtitle)}/subtitle.srt`, baseUrl);
  // An added addon's subtitle: its own URL, sealed, since it can carry that addon's keys.
  if (subtitle.sealedUrl) url.searchParams.set("src", subtitle.sealedUrl);
  if (lang) url.searchParams.set("lang", lang);
  if (season) url.searchParams.set("season", String(season));
  if (episode) url.searchParams.set("episode", String(episode));
  if (playing) {
    url.searchParams.set("sv", String(SYNC_VERSION));
    url.searchParams.set("vid", playing.videoId);
    url.searchParams.set("type", playing.type);
    url.searchParams.set("file", playing.filename);
    // "ref@season:episode,…": tried in order when this subtitle can't be synced to the file.
    if (alts.length) url.searchParams.set("alt", alts.map((a) => `${a.ref}@${a.at[0] ?? ""}:${a.at[1] ?? ""}`).join(","));
  }
  return url.toString();
}

/**
 * How long a download waits for its sync. Players give up on a subtitle that takes longer than about
 * 10 s and show nothing (a 2160p remux read the slow way: 12 s, and no text). The whole
 * download, fetching the subtitle and trying fallbacks included, stays inside DOWNLOAD_BUDGET_MS from
 * the moment it is asked for; past it, a stand-in is sent and the next request gets the finished sync.
 */
const SYNC_WAIT_MS = 5000;
const DOWNLOAD_BUDGET_MS = 8000;
/** Fallback candidates kept per other-language track, tried in order when its own subtitle can't be synced. */
const ALTERNATES = 4;
/**
 * Dub caption tracks listed at most. Uploads of one show's dub captions are often the same text, and
 * the ones not listed still stand behind the listed ones as fallbacks. English CC lists one.
 */
const DUB_TRACKS = 3;
/**
 * SubDL allows a key 50 downloads a UTC day. Work a list starts (pre-syncing, opening packs, trying
 * fallbacks) may be for an episode nobody plays (AIOMetadata asks ahead for the next one), so once a
 * key is down to its last SUBDL_SPARE downloads, a list fetches nothing new from SubDL: those are kept
 * for subtitles a player asks for. Already downloaded ones cost nothing and are used as before.
 */
const SUBDL_DAILY_DOWNLOADS = 50;
const SUBDL_SPARE = 10;
/** How long a subtitle list may take: AIOStreams waits 7 s for an addon and then drops all of it. */
const LIST_BUDGET_MS = 4000;
/** Extra time the first-play header check may take past that, still well inside 7 s. */
const HEADER_GRACE_MS = 1500;
/** Extra wait when even the first windows aren't read yet, before sending the file as it came. */
const SYNC_SLOW_MS = 2500;

/** A track's description: what it is, and whose addon it comes from. */
/**
 * audio: "synced" when the track was timed by speech in the audio; "trying" when the file has no
 * subtitle track and the audio sync hasn't finished yet, so it may still come as it is.
 */
export function trackLabel(code: string | undefined, synced: boolean, audio?: "synced" | "trying", cc = false): string {
  const how = !synced ? undefined : audio === "synced" ? "Synced by audio" : audio === "trying" ? "Trying audio sync" : "Synced";
  // The player shows the language beside the label, so the label doesn't repeat "English".
  return [code ? undefined : cc ? "CC" : "Dub", how, "AIOSubtitles"].filter(Boolean).join(" · ");
}

/** "ara" or "Arabic" -> "Arabic (Synced)". */
/** "ara" or "arabic" -> "Arabic". */
function languageTitle(code: string): string {
  if (code.length > 3) return `${code.charAt(0).toUpperCase()}${code.slice(1)}`;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(new Intl.Locale(code).language) ?? code;
  } catch {
    return code;
  }
}

export function syncedLabel(code: string): string {
  return `${languageTitle(code)} (Synced)`;
}

/**
 * "ara" -> "Arabic (Synced by audio)": timed by speech in the audio, the last resort, so it stands
 * out. "Arabic (Trying audio sync)" before that's known: a player keeps the first list it gets, so
 * a file with no subtitle track can't claim a sync that may still fail.
 */
export function audioLabel(code: string, audio: "synced" | "trying" = "synced"): string {
  return `${languageTitle(code)} (${audio === "synced" ? "Synced by audio" : "Trying audio sync"})`;
}

/**
 * "English Dub" -> "English Dub (Synced)", for links that put the status in the track's name: a
 * player that shows only the name (and not the label) would otherwise show no status for the dub
 * captions or English CC, while every other language says "(Synced)". Unsynced, the name stays.
 */
export function withStatus(name: string, synced: boolean, audio?: "synced" | "trying"): string {
  if (!synced) return name;
  return `${name} (${audio === "synced" ? "Synced by audio" : audio === "trying" ? "Trying audio sync" : "Synced"})`;
}

/**
 * "Arabic" -> "Arabic · AIOSubtitles": a track that isn't synced (sync off, or this file couldn't be
 * matched) still says whose it is, instead of a plain "Arabic" like any other addon's.
 */
export function unsyncedLabel(code: string): string {
  return `${languageTitle(code)} · AIOSubtitles`;
}

/**
 * Whether a sync result is good enough to serve or list as synced: anchors found, and not timed by
 * speech alone unless the file has no subtitle track (then speech is all there is, and no alternate
 * can do better). Every place that weighs a subtitle against its fallbacks asks this one question.
 */
export function syncedWell(result: SyncResult | undefined | "late" | "wait"): result is SyncResult {
  return typeof result === "object" && result.anchors.length > 0 && (!result.bySpeech || result.speechOnly === true);
}

/** A route parameter as one string (Express can hand over an array). */
function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function keysOf(profile: Profile): SourceKeys {
  return { subsource: profile.subsourceKey || undefined, subdl: profile.subdlKey };
}

function profileOf(res: Response): Profile | undefined {
  return res.locals.profile as Profile | undefined;
}

const MANIFEST = {
  id: "aio.subtitle",
  // One version for the package and the manifest: package.json sits next to src/ and dist/ alike.
  version: (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
  name: "AIOSubtitles",
  description:
    "English dub captions, and the best subtitle in your other languages, from SubSource, SubDL, OpenSubtitles and any subtitle addon you add. Each one synced to the file you're playing.",
  resources: [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }],
  types: ["movie", "series"],
  catalogs: []
};

/** A request's subject for the activity list: the file's name when known, short. */
export function describe(filename: string | undefined, fallback: string, season?: number, episode?: number): string {
  let text = filename ? fileName(filename).replace(/\.(mkv|mp4|avi|m4v|webm)$/i, "") : fallback;
  // A file named by a random id ("po0xCP6G") says nothing; the episode goes in front of it.
  const pad = (v: number) => String(v).padStart(2, "0");
  if (filename && season !== undefined && episode !== undefined && !/s\d{1,2}[ ._-]?e\d{1,4}|\d{1,2}x\d{1,3}|(?:^|\D)\d{2,4}(?:\D|$)/i.test(text)) {
    text = `S${pad(season)}E${pad(episode)} · ${text}`;
  }
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
}

/** The configure page's password (ADDON_PASSWORD) and the dashboard's (ADMIN_PASSWORD), when set: see access.ts. */
const configureGate = requireRole("addon");
const statsGate = requireRole("admin");

/** The addon's routes, the same for the owner (/) and for a personal link (/u/<token>/). */
function addonRoutes(): express.Router {
  const router = express.Router({ mergeParams: true });

  // configurable: AIOStreams then shows a Reconfigure button that opens <manifest base>/configure.
  router.get("/manifest.json", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const configured = Boolean(res.locals.profile);
    const logo = config.publicBaseUrl ? { logo: `${config.publicBaseUrl}/logo.png` } : {};
    res.json({ ...MANIFEST, ...logo, behaviorHints: { configurable: true, configurationRequired: !configured } });
  });

  router.get("/configure", configureGate, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.type("html").send(configurePage(res.locals.settings as Settings | undefined, sessionRoles(req).length > 0));
  });

  router.post("/configure", configureGate, checkLimit, express.json({ limit: "16kb" }), async (req, res, next) => {
    try {
      const result = await saveConfiguration(req.body ?? {}, res.locals.settings as Settings | undefined);
      res.set("Cache-Control", "no-store");
      if ("error" in result) {
        res.status(400).json(result);
        return;
      }
      count("saves");
      // Editing a link: its new settings are kept under it, and its URL stays the one AIOStreams has.
      const token = res.locals.token as string | undefined;
      if (token && config.publicBaseUrl) {
        storeSettings(token, result.settings);
        console.log(`configure: link edited in place (${result.settings.languages.length} languages)`);
        res.json({ manifestUrl: `${config.publicBaseUrl}/${token}/manifest.json`, inPlace: true });
        return;
      }
      console.log(`configure: link saved (${(req.body?.languages ?? []).length} languages)`);
      res.json({ manifestUrl: result.manifestUrl });
    } catch (error) {
      next(error);
    }
  });

  // One step of the flow, checked before the page moves on: { step, ...the form }.
  router.post("/configure/check", configureGate, checkLimit, express.json({ limit: "16kb" }), async (req, res, next) => {
    try {
      const { step, ...input } = (req.body ?? {}) as { step?: unknown };
      const result = await checkStep(String(step ?? ""), input, res.locals.settings as Settings | undefined);
      res.set("Cache-Control", "no-store");
      res.status("error" in result ? 400 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  async function subtitlesHandler(req: Request, res: Response): Promise<void> {
    const profile = profileOf(res);
    if (!profile) {
      res.status(404).json({ error: "Configure AIOSubtitles first" });
      return;
    }
    const who = `[${profile.name}]`;
    count("lists", 1, profile.name);
    const extra = parseExtraArgs(param(req.params.extra));
    const stremioRequest = parseStremioSubtitleRequest(param(req.params.type), param(req.params.id), extra);

    // Answer within LIST_BUDGET_MS: AIOStreams gives an addon 7 s and drops all of it after that,
    // and a site seeing an episode for the first time can take longer (OpenSubtitles V3+: 6 to 9 s).
    // Every lookup starts at once and is waited on by itself: whatever isn't back by the deadline is
    // left out of this answer but keeps going, so its results are cached for the next request, and
    // the sources that did answer are listed. A lookup that fails counts as one that found nothing.
    // A partial answer is cached briefly, so the next request gets the full list.
    const deadline = Date.now() + LIST_BUDGET_MS;
    let partial = false;
    const inTime = <T,>(work: Promise<T>, fallback: T): Promise<T> => {
      const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now())).unref());
      // A rejection never reaches the list. Sources log their own failures; anything else that throws
      // (a full disk under the cache, say) is logged here, so a source left out is never left out silently.
      const settled = work.then(
        (value) => ({ value }),
        (error: unknown) => {
          console.error(`${who} subtitles: a lookup failed, left out of the list: ${scrub(error instanceof Error ? error.message : String(error))}`);
          return { value: fallback };
        }
      );
      return Promise.race([settled, late]).then((r) => {
        if (r !== "late") return r.value;
        partial = true;
        return fallback;
      });
    };

    if (!stremioRequest.imdbId) {
      // Kitsu ids (AIOStreams' Jellyfin server sends them for anime) are mapped to IMDb season/episode.
      // The original id stays as stremioRequest.id, which AIOStreams understands for the sync lookup.
      // A first look-up can take up to 16 s; it goes on after the deadline and is cached for the next ask.
      const mapped = await inTime(kitsuToImdb(stremioRequest.id), undefined);
      if (mapped) {
        stremioRequest.imdbId = mapped.imdbId;
        stremioRequest.season = mapped.season;
        stremioRequest.episode = mapped.episode;
      }
    }
    if (!stremioRequest.imdbId) {
      // Without an IMDb id the episode can't be placed; a title search would return every pack.
      console.log(`${who} subtitles ${stremioRequest.id}: ${partial ? "its IMDb id isn't known yet (looking it up)" : "no IMDb id for it, skipped"}`);
      const age = partial ? 30 : 300;
      res.set("Cache-Control", `max-age=${age}`);
      res.json({ subtitles: [], cacheMaxAge: age });
      return;
    }
    // The playing file's header (whether it has a subtitle track, and which languages it already has
    // full subtitles in) is read from now on, beside the searches, not after them: on a file nobody
    // has played yet it can take 4 to 6 s, and the list can't wait for it past deadline + grace. A
    // first list answered before it knows lists the file's own languages too.
    if (profile.aiostreamsUrl && stremioRequest.filename) {
      void fileHasSubtitles(profile.aiostreamsUrl, stremioRequest.id, stremioRequest.type, fileRef(stremioRequest.filename, stremioRequest.videoSize), 0).catch(() => undefined);
    }
    const key = profile.subsourceKey;
    const keys = keysOf(profile);
    const what = describe(stremioRequest.filename, stremioRequest.id, stremioRequest.season, stremioRequest.episode);
    res.locals.activity = { kind: "list", what, result: "error" };

    const wanted = [...new Set([...(profile.dub ? ["english"] : []), ...profile.extraLanguages.map((l) => l.name)])];
    // Regular English (REGULAR_ENGLISH): translated from the original audio. Dub captions follow the dub.
    const regularEnglish = profile.extraLanguages.some((l) => l.name === "english");
    const absolute =
      stremioRequest.imdbId && stremioRequest.season && stremioRequest.episode
        ? inTime(absoluteEpisode(stremioRequest.imdbId, stremioRequest.season, stremioRequest.episode), undefined)
        : Promise.resolve(undefined);
    // SubSource refusing (a key it no longer accepts, too many calls, an outage) leaves SubSource out of
    // this list, noted once for the dashboard; the other sources are still listed.
    let subsourceNoted = false;
    const subsourceFailed = (error: unknown): never[] => {
      if (!subsourceNoted) {
        subsourceNoted = true;
        noteError("subsource", error);
        console.error(`subsource: search failed: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
      }
      return [];
    };
    const moviesJob = key ? findCandidateMovies(stremioRequest, key).catch(subsourceFailed) : Promise.resolve([]);
    // Made in English: there's no dub to caption, so the best English subtitle is the
    // one. Anime (Kitsu ids too) and other foreign titles, or unknown: dub captions come first.
    const englishJob = inTime<boolean | undefined>(
      profile.dub && stremioRequest.imdbId && !stremioRequest.id.startsWith("kitsu") ? madeInEnglish(stremioRequest.type, stremioRequest.imdbId) : Promise.resolve(false),
      undefined
    );
    // The other sources are asked once for every language this person wants, each waited on by itself.
    const othersJob = Promise.all([
      inTime(profile.subdlKey ? subdlSubtitles(profile.subdlKey, stremioRequest, wanted) : Promise.resolve([]), []),
      inTime(profile.opensubtitles ? openSubtitles(stremioRequest, wanted, profile.allowMachine) : Promise.resolve([]), []),
      inTime(profile.subtitlecat ? subtitleCatSubtitles(stremioRequest, wanted) : Promise.resolve([]), []),
      ...profile.addons.map((addon) => inTime(addonSubtitles(addon, stremioRequest, wanted), []))
    ]);
    /** SubSource's lists in one language, one per record in order (season, whole series, season 1), fetched side by side. */
    const subsourceIn = async (language: string) =>
      Promise.all(
        (await moviesJob).map(async (movie) =>
          (await getSubtitlesIn(movie.movieId, language, key).catch(subsourceFailed)).map((subtitle) => ({ ...subtitle, recordSeason: movie.season ?? undefined }))
        )
      );
    // Each language's SubSource lookup starts now too, so they run side by side.
    const subsourceJobs = new Map(wanted.map((language) => [language, subsourceIn(language)] as const));

    stremioRequest.absoluteEpisode = await absolute;
    const movies = await inTime(moviesJob, []);
    const [subdl, opensubs, fromCat, ...fromAddons] = await othersJob;
    const others = (language: string) => [...subdl, ...opensubs, ...fromCat, ...fromAddons.flat()].filter((sub) => sub.language === language);

    type RankOptions = Parameters<typeof filterAndRankDubtitles>[2];
    /** Every source's candidates in one language, ranked together. */
    const pool = async (language: string, options: RankOptions): Promise<RankedSubtitle[]> => {
      // SubSource: the first record (in order) that has any for this episode, as before.
      let fromSubSource: RankedSubtitle[] = [];
      for (const list of await inTime(subsourceJobs.get(language) ?? Promise.resolve([]), [])) {
        fromSubSource = filterAndRankDubtitles(list, stremioRequest, options);
        if (fromSubSource.length > 0) break;
      }
      return [...fromSubSource, ...filterAndRankDubtitles(others(language), stremioRequest, options)].sort(compareRanked);
    };

    // English Dub: subtitles tagged as dub captions, from any source. Other languages at the same time.
    const extraLists = Promise.all(
      profile.extraLanguages.map(async (language) => {
        const found = await pool(language.name, { requireDub: false, allowMachine: profile.allowMachine, hearingImpaired: profile.hearingImpaired });
        if (language.name !== "english") return found;
        // Regular English never serves dub captions: those follow the English voices, not the original audio.
        const dubTagged = new Set((await pool("english", { allowMachine: true })).map((s) => refOf(s)));
        return found.filter((s) => !dubTagged.has(refOf(s)));
      })
    );
    const place = (subtitle: RankedSubtitle) =>
      subtitle.absoluteNumbered && stremioRequest.absoluteEpisode
        ? [1, stremioRequest.absoluteEpisode]
        : [stremioRequest.season, stremioRequest.episode];
    /** Leaves out packs already opened and found not to hold this episode (a "season pack" holding only episode 1). */
    const notKnownMissing = async (subtitles: RankedSubtitle[]) => {
      const missing = await Promise.all(subtitles.map((s) => knownMissing(refOf(s), place(s)[0], place(s)[1])));
      return subtitles.filter((_, i) => !missing[i]);
    };
    const englishOriginal = (await englishJob) === true;
    // Dub captions known not to be in their pack don't count, so the English CC and regular English
    // fallbacks below get their turn instead of the episode listing nothing.
    let ranked: RankedSubtitle[] = profile.dub && !englishOriginal ? await notKnownMissing(await pool("english", { allowMachine: profile.allowMachine })) : [];

    // No dub captions tagged as such: fall back to an official English hearing-impaired track
    // (Netflix and the like), whose "English (CC)" usually transcribes the dub. Marked "English CC".
    // One is listed; the other official ones stand behind it as its fallbacks.
    let closedCaptions = false;
    if (profile.dub && !englishOriginal && ranked.length === 0) {
      const cc = (await notKnownMissing(await pool("english", { requireDub: false, allowMachine: false, hearingImpaired: "only" }))).filter((sub) => sub.quality === 3);
      if (cc.length > 0) {
        ranked = cc;
        closedCaptions = true;
      }
    }
    const dubListed = ranked.slice(0, closedCaptions ? 1 : DUB_TRACKS);

    // Other languages: the best subtitle for the episode in each, from any source.
    // Each also keeps its next two candidates: when the best one can't be synced to the file (seen:
    // a subtitle filed under the wrong season), the first fallback that syncs is used instead.
    const extras: Array<{ subtitle: RankedSubtitle; lang: string; alts: RankedSubtitle[] }> = [];
    (await extraLists).forEach((found, i) => {
      const per = profile.extraPerLanguage;
      // Fallbacks from added addons are left out: their download needs a sealed address of its own.
      const alts = found.slice(per).filter((s) => !s.sealedUrl).slice(0, ALTERNATES);
      extras.push(...found.slice(0, per).map((subtitle) => ({ subtitle, lang: profile.extraLanguages[i].code, alts })));
    });

    // The best regular English subtitle: the English track for titles made in English, and the last
    // fallback for the rest (no dub captions, no official CC). Shown as plain English, synced like the
    // other languages, never as dub captions.
    if (profile.dub && ranked.length === 0 && !regularEnglish) {
      const plain = await notKnownMissing(await pool("english", { requireDub: false, allowMachine: profile.allowMachine, hearingImpaired: profile.hearingImpaired }));
      if (plain[0]) extras.unshift({ subtitle: plain[0], lang: "English", alts: plain.slice(1).filter((s) => !s.sealedUrl).slice(0, ALTERNATES) });
    }

    if (ranked.length === 0 && extras.length === 0) {
      console.log(`${who} subtitles ${stremioRequest.id} file=${stremioRequest.filename ?? "-"} results=0 (records tried: ${movies.map((m) => `s${m.season}`).join(",") || "none"})`);
      const age = partial ? 30 : 300;
      res.set("Cache-Control", `max-age=${age}`);
      res.locals.activity = { kind: "list", what, result: partial ? "nothing yet (sites slow)" : "nothing found" };
      count("lists.empty");
      if (partial) count("lists.partial");
      res.json({ subtitles: [], cacheMaxAge: age });
      return;
    }

    count("tracks", dubListed.length + extras.length);
    const baseUrl = publicBase(req);
    const playing: PlayingFile | undefined =
      profile.aiostreamsUrl && stremioRequest.filename && stremioRequest.imdbId
        ? { videoId: stremioRequest.id, type: stremioRequest.type, filename: fileRef(stremioRequest.filename, stremioRequest.videoSize) }
        : undefined;
    /** Whether work this list starts may fetch this subtitle now (see SUBDL_SPARE). */
    const listMayFetch = async (subtitle: RankedSubtitle): Promise<boolean> => {
      if (!refOf(subtitle).startsWith("sd") || !profile.subdlKey) return true;
      if (downloadsToday("subdl", profile.subdlKey) < SUBDL_DAILY_DOWNLOADS - SUBDL_SPARE) return true;
      if (await isDownloaded(refOf(subtitle))) return true;
      count("tracks.subdlSpared");
      return false;
    };
    /** Starts the sync of one subtitle to the playing file, or joins the one running. */
    const syncOne = (subtitle: RankedSubtitle, season: number | undefined, episode: number | undefined, code: string | undefined): Promise<SyncResult | undefined> =>
      playing && profile.aiostreamsUrl
        ? syncCaptions(
            syncKey(refOf(subtitle), season, episode, playing.filename),
            () => getCachedSubtitleFile(refOf(subtitle), season, episode, { ...keys, addonUrl: subtitle.sealedUrl ? openUrl(subtitle.sealedUrl) : undefined }),
            profile.aiostreamsUrl,
            playing.videoId,
            playing.type,
            playing.filename,
            code
          ).catch(() => undefined)
        : Promise.resolve(undefined);
    const placed = [
      // Each dub track falls back on the ones after it, listed or not: two uploads often carry the same
      // dub captions, one of them off by a second or so and harder to fit.
      ...dubListed.map((subtitle, index) => ({
        subtitle,
        lang: closedCaptions ? "English CC" : dubLabel(profile),
        code: undefined as string | undefined,
        cc: closedCaptions,
        alts: ranked.slice(index + 1).filter((s) => !s.sealedUrl).slice(0, ALTERNATES)
      })),
      // Synced ones get a label of their own ("Arabic (Synced)") so they stand apart from other
      // addons' plain "Arabic"; a player's language preference won't pick them by itself then.
      ...extras.map(({ subtitle, lang, alts }) => ({
        subtitle,
        lang: playing ? syncedLabel(lang) : unsyncedLabel(lang),
        code: lang as string | undefined,
        cc: false,
        alts
      }))
    ].map((track) => {
      const [season, episode] = place(track.subtitle);
      return { ...track, season, episode };
    });
    // A pack found not to hold this episode (its only file is another one) gives its place to the
    // next subtitle in line that isn't known to lack it, and the track is left out when there is none.
    const tracks: typeof placed = [];
    for (const track of placed) {
      let current: (typeof placed)[number] | undefined = track;
      while (current && (await knownMissing(refOf(current.subtitle), current.season, current.episode))) {
        const next: RankedSubtitle | undefined = current.alts[0];
        if (!next) {
          current = undefined;
          break;
        }
        const [season, episode] = place(next);
        current = { ...current, subtitle: next, alts: current.alts.slice(1), season, episode };
      }
      if (current) tracks.push(current);
    }
    // A pack is only known to hold the episode once it is opened (seen: two packs whose files each
    // cover nine episodes were listed, and the player got an empty track). With a file
    // playing the sync opens it anyway, so each is opened from here on, beside the header read, and
    // asked about further down.
    const opening = new Map<string, Promise<boolean>>();
    const holds = (subtitle: RankedSubtitle): Promise<boolean> => {
      if (subtitle.files === 1) return Promise.resolve(true);
      const [s, e] = place(subtitle);
      const id = `${refOf(subtitle)}|${s}|${e}`;
      let job = opening.get(id);
      if (!job) {
        // A pack this list may not fetch now is listed as it is, as one not opened in time would be.
        job = listMayFetch(subtitle).then((may) =>
          !may
            ? true
            : getCachedSubtitleFile(refOf(subtitle), s, e, { ...keys, addonUrl: subtitle.sealedUrl ? openUrl(subtitle.sealedUrl) : undefined }).then(
                () => true,
                (error) => !(error instanceof Error && error.name === "EpisodeNotInPack")
              )
        );
        opening.set(id, job);
      }
      return job;
    };
    if (playing) for (const track of tracks) void holds(track.subtitle);

    // The file has no embedded subtitles (from its header, read now on a first play, waited on
    // for at most 4 s), or this subtitle matched none of them before: those tracks don't claim
    // "Synced" and skip the sync work.
    const fileHas = playing && profile.aiostreamsUrl && tracks.length > 0
      ? await fileHasSubtitles(profile.aiostreamsUrl, playing.videoId, playing.type, playing.filename, Math.min(4000, Math.max(0, deadline + HEADER_GRACE_MS - Date.now())))
      : undefined;
    // The file's own full subtitles are timed to it already: those languages are left out, unless the
    // link asks for ours too (keepEmbedded). Dub and CC tracks stay: a file's English is the
    // translation, not what the dub says.
    if (playing && profile.skipEmbedded) {
      const have = await embeddedLanguages(playing.filename);
      if (have?.length) {
        const names = new Set(have.map((code) => languageTitle(code).toLowerCase()));
        const before = tracks.length;
        for (let i = tracks.length - 1; i >= 0; i--) {
          const code = tracks[i].code;
          if (code && names.has(languageTitle(code).toLowerCase())) tracks.splice(i, 1);
        }
        if (tracks.length < before) {
          count("tracks.embedded", before - tracks.length);
          console.log(`${who} ${stremioRequest.id}: ${before - tracks.length} left out, the file has them (${have.join(", ")})`);
        }
      }
    }
    // A file timed by its own subtitle track syncs in a second or two once its header is read: the
    // list waits for that, up to its own deadline, so the first list already says which tracks
    // synced and can list a fallback in place of one that doesn't. Timing by speech takes 9 to 17 s
    // and isn't waited for (those tracks say "Trying audio sync").
    if (playing && fileHas === true && Date.now() < deadline) {
      const jobs = tracks.map((t) => listMayFetch(t.subtitle).then((may) => (may ? syncOne(t.subtitle, t.season, t.episode, t.code) : undefined)).catch(() => undefined));
      await Promise.race([Promise.all(jobs), new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())).unref())]);
    }
    if (playing) {
      for (const track of tracks) {
        if (!track.alts.length) continue;
        const own = await knownSync(syncKey(refOf(track.subtitle), track.season, track.episode, playing.filename), playing.filename);
        // Timed only by speech (the last resort) counts as not fitting here: an alternate that fits the
        // file's subtitles is better.
        if (own !== "wrong" && own !== "unsynced" && own !== "speech") continue;
        // A file with no subtitle track: speech is all there is. Timed by it, the top one stays; not
        // timed, an alternate that speech does time takes its place (seen: the top English couldn't be
        // timed, the third in line was, to +0.06 s, and was never sent).
        const speechOnly = fileHas === "speech";
        if (speechOnly && own === "speech") continue;
        // The top one is known not to sync: take a fallback that is known to, or try them now. The
        // file's windows are already read by then, so each try is a download and a measurement.
        for (const alt of track.alts) {
          const [s, e] = place(alt);
          const key = syncKey(refOf(alt), s, e, playing.filename);
          let state = await knownSync(key, playing.filename);
          if (state === "unknown" && profile.aiostreamsUrl && Date.now() < deadline + HEADER_GRACE_MS && (await listMayFetch(alt))) {
            const job = syncOne(alt, s, e, track.code);
            const result = await Promise.race([job, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, deadline + HEADER_GRACE_MS - Date.now())).unref())]);
            if (syncedWell(result)) state = "synced";
          }
          if (state !== "synced" && !(speechOnly && state === "speech")) continue;
          track.alts = track.alts.filter((a) => a !== alt);
          Object.assign(track, { subtitle: alt, season: s, episode: e });
          count("tracks.fallback");
          console.log(`${who} ${stremioRequest.id}: listing fallback ${refOf(alt)}, the top one doesn't sync to this file`);
          break;
        }
      }
      // A dub track that took the place of the one above it now lists the same subtitle as the
      // track it came from: list it once.
      const seen = new Set<string>();
      for (let i = 0; i < tracks.length; ) {
        const id = `${tracks[i].lang}|${refOf(tracks[i].subtitle)}|${tracks[i].season}|${tracks[i].episode}`;
        if (seen.has(id)) tracks.splice(i, 1);
        else (seen.add(id), i++);
      }
    }
    // The packs opened above: one without the episode gives its place to the next in line, or isn't
    // listed. One not opened in what is left of this list's time is listed as it was.
    if (playing) {
      const inTimeHolds = (subtitle: RankedSubtitle): Promise<boolean> =>
        Promise.race([holds(subtitle), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), Math.max(0, deadline - Date.now())).unref())]);
      const kept = await Promise.all(
        tracks.map(async (track) => {
          while (!(await inTimeHolds(track.subtitle))) {
            const next = track.alts.shift();
            if (!next) return false;
            const [s, e] = place(next);
            count("tracks.packWithoutEpisode");
            Object.assign(track, { subtitle: next, season: s, episode: e });
          }
          return true;
        })
      );
      for (let i = tracks.length - 1; i >= 0; i--) if (!kept[i]) tracks.splice(i, 1);
    }
    // Subtitle Cat is searched by name alone (subtitlecat.ts), so its subtitles are listed only once
    // they have synced to the playing file: tried now, within what is left of this list's time. One
    // that hasn't gives its place to the next subtitle from another source, or isn't listed.
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.subtitle.source !== "subtitlecat") continue;
      let fits = false;
      if (playing && profile.aiostreamsUrl) {
        const key = syncKey(refOf(track.subtitle), track.season, track.episode, playing.filename);
        let state = await knownSync(key, playing.filename);
        if (state === "unknown") {
          const job = syncOne(track.subtitle, track.season, track.episode, track.code);
          const result = await Promise.race([job, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, deadline + HEADER_GRACE_MS - Date.now())).unref())]);
          // Timed by speech counts only on a file with no subtitle track, where speech is all there is.
          if (syncedWell(result)) state = "synced";
        }
        fits = state === "synced" || (state === "speech" && fileHas === "speech");
      }
      if (fits) continue;
      count("tracks.subtitlecatHeld");
      const next = track.alts.find((alt) => alt.source !== "subtitlecat");
      if (next) {
        const [s, e] = place(next);
        track.alts = track.alts.filter((alt) => alt !== next && alt.source !== "subtitlecat");
        Object.assign(track, { subtitle: next, season: s, episode: e });
      } else tracks.splice(i, 1);
    }
    // A track that took another's place above (a pack without the episode, a Subtitle Cat subtitle
    // that didn't sync) can now list the same subtitle as the track beside it: listed once.
    {
      const seen = new Set<string>();
      for (let i = 0; i < tracks.length; ) {
        const id = `${tracks[i].lang}|${refOf(tracks[i].subtitle)}|${tracks[i].season}|${tracks[i].episode}`;
        if (seen.has(id)) tracks.splice(i, 1);
        else (seen.add(id), i++);
      }
    }
    const known = await Promise.all(
      tracks.map((t) =>
        playing
          ? fileHas === false
            ? "unsynced"
            : knownSync(syncKey(refOf(t.subtitle), t.season, t.episode, playing.filename), playing.filename)
          : "unknown"
      )
    );
    const unsynced = new Set(tracks.filter((_, i) => known[i] === "unsynced").map((t) => t.subtitle));
    // Captions that couldn't be fitted to this file stay listed, unsynced: timing alone can't tell
    // another episode from the same one cut differently (seen: one service's Arabic sits about 20 s
    // off its English, both for the same episode). Only the pack check, which reads episode names, removes.
    for (let i = 0; i < tracks.length; i++) if (known[i] === "wrong") unsynced.add(tracks[i].subtitle);
    const synced = (t: (typeof tracks)[number]) => Boolean(playing) && !unsynced.has(t.subtitle);
    // Timed by speech in the audio (the file has no subtitle track, or nothing else fit): labelled
    // apart, so it's easy to spot and report.
    const audioOf = new Map<RankedSubtitle, "synced" | "trying">();
    tracks.forEach((t, i) => {
      if (!synced(t)) return;
      if (known[i] === "speech") audioOf.set(t.subtitle, "synced");
      else if (fileHas === "speech" && known[i] === "unknown") audioOf.set(t.subtitle, "trying");
    });
    for (const track of tracks) {
      const audio = audioOf.get(track.subtitle);
      if (track.code && playing && !synced(track)) track.lang = unsyncedLabel(track.code);
      else if (track.code && playing && audio) track.lang = audioLabel(track.code, audio);
      else if (!track.code && profile.langMode === "custom") track.lang = withStatus(track.lang, synced(track), audio);
    }
    console.log(`${who} subtitles ${stremioRequest.id} file=${stremioRequest.filename ?? "-"} results=${ranked.length}${ranked[0] ? `(${closedCaptions ? "cc:" : ""}${refOf(ranked[0])})` : ""} extra=${extras.map((e) => `${e.lang}:${refOf(e.subtitle)}(${tierName((e.subtitle.quality ?? 1) as QualityTier)}${e.subtitle.releaseMatch ? ` match ${e.subtitle.releaseMatch}` : ""})`).join(",") || "none"} sync=${playing ? (unsynced.size ? `on, ${unsynced.size} known unsynced` : "on") : "off"} hints=${stremioRequest.videoHash ? "hash" : "-"},${stremioRequest.videoSize ? "size" : "-"}`);

    // Start syncing now, so they're ready when one is picked.
    if (playing && profile.aiostreamsUrl) {
      // Fallbacks only when the track's own subtitle turns out not to sync, one at a time, so a
      // normal play costs nothing extra; the first that syncs is ready for the download and the next list.
      for (const track of tracks.filter((t) => t.alts.length)) {
        void (async () => {
          if (!(await listMayFetch(track.subtitle))) return;
          const own = await syncOne(track.subtitle, track.season, track.episode, track.code);
          if (syncedWell(own)) return;
          for (const alt of track.alts) {
            if (!(await listMayFetch(alt))) continue;
            const [s, e] = place(alt);
            const result = await syncOne(alt, s, e, track.code);
            if (syncedWell(result)) {
              console.log(`${who} ${stremioRequest.id}: ${refOf(track.subtitle)} doesn't sync to this file; fallback ${refOf(alt)} does`);
              return;
            }
          }
        })().catch(() => undefined);
      }
      for (const { subtitle, season, episode, code } of tracks.filter((t) => synced(t) && !t.alts.length)) {
        void listMayFetch(subtitle)
          .then((may) => (may ? syncOne(subtitle, season, episode, code) : undefined))
          .catch(() => undefined);
      }
    }

    // The link lists only what syncs: tracks known not to fit this file are left out. Syncs still
    // being worked out stay, and their fallbacks keep trying above, so a later list can show them.
    if (playing && profile.hideUnsynced) {
      const before = tracks.length;
      for (let i = tracks.length - 1; i >= 0; i--) if (unsynced.has(tracks[i].subtitle)) tracks.splice(i, 1);
      if (tracks.length < before) {
        count("tracks.hiddenUnsynced", before - tracks.length);
        console.log(`${who} ${stremioRequest.id}: ${before - tracks.length} unsynced left out (this link lists synced only)`);
      }
    }
    const syncedCount = tracks.filter(synced).length;
    res.locals.activity = { kind: "list", what, result: `${tracks.length} track${tracks.length === 1 ? "" : "s"}${playing ? `, ${syncedCount} synced` : ""}${partial ? ", partial" : ""}` };
    // A list that isn't settled is kept half a minute, not five: whoever keeps it (AIOStreams, a
    // player) asks again sooner and gets the settled one. Not settled: a track says "Trying audio
    // sync", a sync wasn't finished by the deadline (its "Synced" isn't known yet), or a source
    // didn't answer in time.
    const settling = [...audioOf.values()].includes("trying") || (Boolean(playing) && known.includes("unknown")) || partial;
    const keepFor = settling ? 30 : 300;
    res.set("Cache-Control", settling ? "max-age=30" : "max-age=300, stale-while-revalidate=900");
    res.json({
      subtitles: tracks.map((track) => ({
        id: `aiosub-${refOf(track.subtitle)}`,
        lang: sentLanguage(profile, track),
        // AIOStreams' Jellyfin server shows label as the track's description; AIOMetadata shows lang.
        label: trackLabel(track.code, synced(track), audioOf.get(track.subtitle), track.cc),
        url: downloadUrl(baseUrl, profile, track.subtitle, track.season, track.episode, synced(track) || track.alts.length ? playing : undefined, track.code, track.alts.map((alt) => ({ ref: refOf(alt), at: place(alt) })))
      })),
      cacheMaxAge: keepFor,
      staleRevalidate: settling ? 0 : 900,
      staleError: 900
    });
  }

  router.get("/subtitles/:type/:id.json", (req, res, next) => {
    subtitlesHandler(req, res).catch(next);
  });

  router.get("/subtitles/:type/:id/:extra.json", (req, res, next) => {
    subtitlesHandler(req, res).catch(next);
  });

  router.get("/download/:subtitleId/:filename", async (req, res, next) => {
    try {
      const profile = profileOf(res);
      if (!profile) {
        res.status(404).send("Configure AIOSubtitles first");
        return;
      }
      count("downloads", 1, profile.name);
      // Everything below, the subtitle's own fetch included, shares this one budget (see DOWNLOAD_BUDGET_MS).
      const deadline = Date.now() + DOWNLOAD_BUDGET_MS;
      let ref = param(req.params.subtitleId);
      if (!/^(?:ss|sd|os)?[\w-]{1,64}$/.test(ref)) {
        res.status(400).send("Invalid subtitle id");
        return;
      }

      let season = req.query.season ? Number(req.query.season) : undefined;
      let episode = req.query.episode ? Number(req.query.episode) : undefined;
      const src = typeof req.query.src === "string" ? openUrl(req.query.src) : undefined;
      const keys: SourceKeys = { ...keysOf(profile), addonUrl: src };
      const lang0 = typeof req.query.lang === "string" ? req.query.lang : undefined;
      const fileName = typeof req.query.file === "string" ? req.query.file : undefined;
      const what = `${lang0 ?? "English Dub"} · ${describe(fileName, `${ref}${season !== undefined ? ` S${season}E${episode ?? "?"}` : ""}`, season, episode)}`;
      res.locals.activity = { kind: "download", what, result: "error" };
      // "ref@season:episode,…" from the list: the subtitles next in line for this track.
      let alts = (typeof req.query.alt === "string" ? req.query.alt : "")
        .split(",")
        .map((a) => a.match(/^((?:ss|sd|os)?[\w-]{1,64})@(\d*):(\d*)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .slice(0, ALTERNATES);
      let subtitle: Awaited<ReturnType<typeof getCachedSubtitleFile>> | undefined;
      try {
        subtitle = await getCachedSubtitleFile(ref, season, episode, keys);
      } catch (error) {
        // This one can't be had (a pack that turned out not to hold the episode, a failed download):
        // the next in line takes its place now, so the player never gets an empty track. Subtitle
        // Cat's are passed over here: they are sent only once synced, further down.
        for (const [index, [, altRef, altSeason, altEpisode]] of alts.entries()) {
          if (Date.now() > deadline) break;
          if (altRef.startsWith("sc")) continue;
          const s = altSeason ? Number(altSeason) : undefined;
          const e = altEpisode ? Number(altEpisode) : undefined;
          try {
            subtitle = await getCachedSubtitleFile(altRef, s, e, keysOf(profile));
          } catch {
            continue;
          }
          console.log(`download ${ref}: ${error instanceof Error && error.name === "EpisodeNotInPack" ? "its pack doesn't hold the episode" : "couldn't be fetched"}; ${altRef} takes its place`);
          count("downloads.nextInLine");
          [ref, season, episode] = [altRef, s, e];
          alts = alts.slice(index + 1);
          break;
        }
        if (!subtitle) {
          // Nothing but Subtitle Cat's left: one of those, if it syncs to the file in time.
          const vid0 = typeof req.query.vid === "string" ? req.query.vid : "";
          const type0 = typeof req.query.type === "string" ? req.query.type : "";
          for (const [, altRef, altSeason, altEpisode] of alts.filter((a) => a[1].startsWith("sc"))) {
            if (!profile.aiostreamsUrl || !vid0 || !type0 || !fileName || Date.now() > deadline) break;
            const s = altSeason ? Number(altSeason) : undefined;
            const e = altEpisode ? Number(altEpisode) : undefined;
            try {
              const altFile = await getCachedSubtitleFile(altRef, s, e, keysOf(profile));
              const job = syncCaptions(syncKey(altRef, s, e, fileName), async () => altFile, profile.aiostreamsUrl, vid0, type0, fileName, lang0);
              const done = await Promise.race([job, new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), Math.max(0, deadline - Date.now())))]);
              if (syncedWell(done)) {
                subtitle = altFile;
                [ref, season, episode] = [altRef, s, e];
                alts = [];
                count("downloads.nextInLine");
                console.log(`download: the subtitle listed couldn't be had; ${altRef} synced and takes its place`);
                break;
              }
            } catch {}
          }
        }
        if (!subtitle) throw error;
      }
      let served = subtitle.file;
      let outcome = "sent as it came";

      const vid = typeof req.query.vid === "string" ? req.query.vid : "";
      const type = typeof req.query.type === "string" ? req.query.type : "";
      const file = typeof req.query.file === "string" ? req.query.file : "";
      const lang = typeof req.query.lang === "string" ? req.query.lang : undefined;
      // Final timing is cached for good; a stand-in (first-pass timing, or the file as it came) is
      // sent with no-store, so the next request gets the finished sync.
      let final = true;
      if (profile.aiostreamsUrl && vid && type && file) {
        const key = syncKey(ref, season, episode, file);
        const fetched = subtitle;
        const job = syncCaptions(key, async () => fetched, profile.aiostreamsUrl, vid, type, file, lang);
        const within = (ms: number) => Promise.race([job, new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), Math.max(0, Math.min(ms, deadline - Date.now()))))]);
        let synced = await within(SYNC_WAIT_MS);
        // Still refining after the wait: the first windows' timing is nearly always right already.
        if (synced === "wait" && firstPassSync(key)) {
          count("downloads.firstPass");
          served = (firstPassSync(key) as { file: string }).file;
          outcome = "first-pass timing";
          final = false;
        } else {
          // Not even the first windows yet (a slow stream lookup): a little longer, then the file as it came.
          if (synced === "wait") synced = await within(SYNC_SLOW_MS);
          if (synced === "wait") {
            const first = firstPassSync(key);
            count(first ? "downloads.firstPass" : "downloads.unsyncedStandIn");
            if (first) served = first.file;
            outcome = first ? "first-pass timing" : "unsynced stand-in";
            final = false;
          } else if (synced) {
            served = synced.file;
            outcome = synced.anchors.length > 0 ? (synced.bySpeech ? "synced (audio)" : "synced") : "couldn't sync";
          }
        }
        // Timed only by speech: an alternate that fits the file's subtitles is sent instead, if one does.
        if (final && !syncedWell(synced)) {
          for (const [, altRef, altSeason, altEpisode] of alts) {
            if (Date.now() > deadline) break;
            const s = altSeason ? Number(altSeason) : undefined;
            const e = altEpisode ? Number(altEpisode) : undefined;
            try {
              const altFile = await getCachedSubtitleFile(altRef, s, e, keysOf(profile));
              const altJob = syncCaptions(syncKey(altRef, s, e, file), async () => altFile, profile.aiostreamsUrl, vid, type, file, lang);
              const altSynced = await Promise.race([altJob, new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), Math.max(0, deadline - Date.now())))]);
              if (syncedWell(altSynced)) {
                served = altSynced.file;
                outcome = "synced (fallback)";
                count("downloads.fallback");
                console.log(`download ${ref}: not synced to ${file}; sent fallback ${altRef} instead`);
                break;
              }
            } catch {}
          }
        }
      }

      const ext = path.extname(served).toLowerCase();
      // Always SRT: the link says "subtitle.srt", and players that go by the name show nothing for ASS.
      const body = Buffer.from(toSrt(decodeSubtitle(await readFile(served), lang), ext), "utf8");

      res.locals.activity = { kind: "download", what, result: outcome };
      // Kept for good only when it's synced (or sync isn't asked for): a subtitle left unsynced may sync
      // later (a fallback, better rules), and a player keeping this answer would never ask again.
      const syncAsked = Boolean(profile.aiostreamsUrl && vid && type && file);
      const keep = final && (!syncAsked || outcome.startsWith("synced"));
      res.set("Cache-Control", keep ? "public, max-age=2592000, immutable" : "no-store");
      res.set("Content-Disposition", `inline; filename="${subtitle.filename.replace(/"/g, "").replace(/\.(ass|ssa|vtt)$/i, ".srt")}"`);
      res.type("text/plain; charset=utf-8");
      res.send(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createApp(): express.Express {
  const app = express();
  // A reverse proxy's X-Forwarded-For and -Proto are believed only from proxies on this machine or a
  // private network (Docker, LAN): someone reaching the port directly can't pick their own address
  // to dodge the sign-in lockout.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  app.use(cors());

  // The logo: cropped to its artwork (mark.png), and fitted to a square for tabs (favicon.png) and addon lists (logo.png).
  for (const [route, file] of [["/mark.png", "aiosubtitles-mark.png"], ["/favicon.png", "aiosubtitles-favicon-64.png"], ["/logo.png", "aiosubtitles-logo-256.png"]]) {
    app.get(route, (_req, res) => {
      res.set("Cache-Control", "public, max-age=86400");
      res.sendFile(fileURLToPath(new URL(`../assets/${file}`, import.meta.url)));
    });
  }

  app.get("/", (_req, res) => {
    res.redirect("/configure");
  });

  // Signing in and out (ADDON_PASSWORD, ADMIN_PASSWORD).
  app.use(accessRoutes());

  // The dashboard (usage and health): ADMIN_PASSWORD, or a login at the proxy, since it lists what was played.
  app.get("/stats", statsGate, async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.set("Referrer-Policy", "no-referrer");
      res.type("html").send(statsPage(await statsView(MANIFEST.version), sessionRoles(req).length > 0));
    } catch (error) {
      next(error);
    }
  });

  // One page of the dashboard's activity, for its Newer and Older buttons and filters. Behind the same
  // password as the dashboard.
  app.get("/stats/activity", statsGate, async (req, res, next) => {
    try {
      const text = (value: unknown) => (typeof value === "string" ? value : "");
      const page = activityPage({ offset: Number(text(req.query.offset)) || 0, link: text(req.query.link), kind: text(req.query.kind), limit: Number(text(req.query.limit)) || undefined });
      res.set("Cache-Control", "no-store");
      res.json({ html: activityRows(page.rows, await linkNames()), offset: page.offset, count: page.rows.length, total: page.total, range: pageRange(page.offset, page.rows.length, page.total) });
    } catch (error) {
      next(error);
    }
  });

  // Clearing the dashboard's recent errors: behind the same password, and only from the dashboard
  // itself. A browser sends a saved login or proxy cookie along on a form another site posts, so its
  // own word that the request comes from this site is required.
  app.post("/stats/errors/clear", statsGate, async (req, res, next) => {
    try {
      const site = req.get("sec-fetch-site");
      const origin = req.get("origin");
      const host = req.get("x-forwarded-host") ?? req.get("host");
      const sameSite = site ? site === "same-origin" : Boolean(origin && host && new URL(origin).host === host);
      if (!sameSite) {
        res.status(403).type("text").send("Clear errors from the dashboard itself");
        return;
      }
      if (req.query.undo === "1") await undoClearErrors();
      else await clearErrors();
      res.redirect(303, "/stats#errors");
    } catch (error) {
      next(error);
    }
  });

  const routes = addonRoutes();

  // Settings come from the path AIOStreams builds (see profile.ts); the router then sees only the resource.
  app.use((req, res, next) => {
    const routed = routePath(req.path);
    if (!routed) {
      res.status(404).json({ error: "Unknown link. Open /configure to make one" });
      return;
    }
    res.locals.profile = routed.profile;
    res.locals.settings = routed.settings;
    res.locals.token = routed.token;
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = routed.resource + query;
    const link = (routed.profile as Profile | undefined)?.name;
    if (!link) {
      next();
      return;
    }
    // Everything this request starts (searches, downloads, syncs) is counted for its link, and a
    // list or download handler leaves a line for the recent-activity list.
    const owner = routed.profile as Profile;
    noteLinkKeys(link, [["subsource", owner.subsourceKey], ["subdl", owner.subdlKey]]);
    noteLinkLabel(link, owner.label);
    // The dashboard's Edit opens the link a player or AIOStreams last used: its subtitle lists and
    // downloads count, a configure page someone opened doesn't (an old or copied link stays out).
    if (routed.token && /^\/(subtitles|download)\//.test(routed.resource)) noteLinkToken(link, routed.token);
    const started = Date.now();
    res.on("finish", () => {
      const note = res.locals.activity as { kind: "list" | "download"; what: string; result: string } | undefined;
      if (note) noteActivity({ ...note, link, ms: Date.now() - started, result: res.statusCode >= 400 && !note.result.startsWith("error") ? `error ${res.statusCode}` : note.result });
    });
    requestContext.run({ link }, next);
  }, routes);

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    // Messages can carry upstream bodies, never keys; the token stays out of logs (no URL logging).
    const message = error instanceof Error ? error.message : "Unexpected error";
    noteError("request", error, (res.locals.activity as { what?: string } | undefined)?.what);
    if (error instanceof Error && error.name === "EpisodeNotInPack") {
      if (res.locals.activity) res.locals.activity.result = "not in this pack";
      res.status(404).json({ error: "This subtitle pack doesn't have this episode" });
      return;
    }
    console.error(message);
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
