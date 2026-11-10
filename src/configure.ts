/**
 * The configure flow's server side. The page is opened bare (/configure) for a
 * new setup, or from AIOStreams' Reconfigure button (/<token>/configure) with
 * the current settings filled in. Saved keys are never sent to the browser:
 * their fields stay empty and are kept unless something new is typed.
 *
 * Each step is checked when the person moves on from it (checkStep), so a
 * mistake shows where it was made; saving checks everything again.
 */
import { config } from "./config.js";
import { fetchPublic, readCapped } from "./net.js";
import { LINK_LABEL, MAX_ADDONS, MAX_TOKEN, parseAiostreamsUrl, sealSettings, settingsProblem, type Addon, type Settings } from "./profile.js";

export { configurePage } from "./page.js";

/** What the page sends: the form as it stands. */
export type ConfigureInput = Partial<Settings> & { addAddons?: unknown; removeAddons?: unknown; label?: unknown };
type Problem = { error: string };

/** SubDL answers status: true for a working key (one search, never logged: the URL carries the key). */
async function subdlAccepts(apiKey: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ api_key: apiKey, imdb_id: "tt0111161", type: "movie", languages: "EN", subs_per_page: "1" });
    const response = await fetch(`https://api.subdl.com/api/v1/subtitles?${query}`, { signal: AbortSignal.timeout(15000) });
    const body = (await response.json()) as { status?: boolean };
    return response.ok && body.status === true;
  } catch {
    return false;
  }
}

async function reachable(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** AIOSubtitles' own manifest id: adding it to itself would ask itself forever. */
const OWN_ID = "aio.subtitle";

/**
 * A pasted addon checked the way AIOStreams would: its manifest loads and
 * offers subtitles. Returns its name, or what's wrong. AIOStreams itself is
 * turned away: it asks AIOSubtitles for subtitles, so it would ask itself.
 */
export async function checkAddon(raw: string): Promise<Addon | Problem> {
  const url = raw.trim().replace(/^stremio:\/\//i, "https://");
  if (!/^https:\/\/\S+\/manifest\.json$/.test(url) || url.length > 2048) return { error: "Other addons: paste the addon's https manifest URL, ending in /manifest.json" };
  let manifest: { id?: string; name?: string; resources?: Array<string | { name?: string }> };
  try {
    const response = await fetchPublic(url, 10000, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = JSON.parse((await readCapped(response, 500_000)).toString("utf8"));
  } catch {
    return { error: "Other addons: one of them didn't load. Check its URL (it must be public and https)" };
  }
  const name = String(manifest.name ?? "").trim().slice(0, 40) || new URL(url).hostname;
  if (manifest.id === OWN_ID || (config.publicBaseUrl && url.startsWith(`${config.publicBaseUrl}/`))) return { error: "Other addons: that's AIOSubtitles itself" };
  if (/aiostreams/i.test(`${manifest.id ?? ""} ${manifest.name ?? ""}`)) {
    return { error: "Other addons: add the subtitle addons themselves, not AIOStreams (it asks AIOSubtitles, so it would ask itself)" };
  }
  const resources = (manifest.resources ?? []).map((r) => (typeof r === "string" ? r : r?.name));
  if (!resources.includes("subtitles")) return { error: `Other addons: ${name} doesn't offer subtitles` };
  return { name, url };
}

/** A typed value replaces the saved one, "remove" clears it, empty keeps it. */
function keepOrReplace(typed: unknown, saved?: string): string | undefined {
  const value = typeof typed === "string" ? typed.trim() : "";
  if (value.toLowerCase() === "remove") return undefined;
  return value || saved || undefined;
}

/** Saved addons stay unless removed by position; pasted ones (one per line) are checked and added. */
async function gatherAddons(input: ConfigureInput, current?: Settings): Promise<Addon[] | Problem> {
  const remove = new Set(Array.isArray(input.removeAddons) ? input.removeAddons.map(Number) : []);
  const addons = (current?.addons ?? []).filter((_, i) => !remove.has(i));
  const pasted = (typeof input.addAddons === "string" ? input.addAddons : "").split(/\s+/).filter(Boolean);
  if (addons.length + pasted.length > MAX_ADDONS) return { error: `Other addons: up to ${MAX_ADDONS}` };
  for (const raw of pasted) {
    const checked = await checkAddon(raw);
    if ("error" in checked) return checked;
    if (!addons.some((a) => a.url === checked.url)) addons.push(checked);
  }
  return addons;
}

/** The link name as typed: trimmed, with runs of spaces made one. Empty means none. */
function labelOf(typed: unknown): string | undefined {
  const label = typeof typed === "string" ? typed.trim().replace(/\s+/g, " ") : "";
  return label || undefined;
}

/** The settings the form describes, keeping saved keys and the AIOStreams URL when their fields are empty. */
function draft(input: ConfigureInput, addons: Addon[], current?: Settings): Settings {
  const label = labelOf(input.label);
  return {
    subsource: keepOrReplace(input.subsource, current?.subsource),
    subdl: keepOrReplace(input.subdl, current?.subdl),
    opensubtitles: input.opensubtitles === true,
    ...(addons.length ? { addons } : {}),
    aiostreams: keepOrReplace(input.aiostreams, current?.aiostreams),
    languages: [...new Set((input.languages ?? []).map((l) => String(l).trim()).filter(Boolean))],
    allowMachine: input.allowMachine === true,
    hearingImpaired: (input.hearingImpaired as Settings["hearingImpaired"]) ?? "include",
    ...(input.keepEmbedded === true ? { keepEmbedded: true } : {}),
    ...(input.statusInName === true ? { statusInName: true } : {}),
    ...(input.hideUnsynced === true ? { hideUnsynced: true } : {}),
    ...(label ? { label } : {})
  };
}

/** Sync is what AIOSubtitles is for: every link needs an AIOStreams install URL that its instance recognises. */
async function syncProblem(aiostreams: string | undefined, current?: Settings): Promise<Problem | undefined> {
  if (!aiostreams) return { error: "AIOStreams install URL: needed. It's how AIOSubtitles finds the file you're playing" };
  const aio = parseAiostreamsUrl(aiostreams);
  if (!aio) return { error: "AIOStreams install URL: must end in /manifest.json and come from a supported AIOStreams instance" };
  if (aiostreams === current?.aiostreams) return undefined;
  const base = aio.origin === config.ownAiostreams ? config.aiostreamsBase : aio.origin;
  if (!(await reachable(`${base}${aio.path}/manifest.json`))) {
    return { error: "AIOStreams install URL: that instance didn't recognise it. Copy the install URL again from Save & install in AIOStreams" };
  }
  return undefined;
}

/** New keys must be accepted by their site; saved ones were checked when they were added. */
async function keysProblem(settings: Settings, current?: Settings): Promise<Problem | undefined> {
  if (settings.subsource && settings.subsource !== current?.subsource) {
    const ok = await reachable("https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=tt0111161", {
      headers: { "X-API-Key": settings.subsource, Accept: "application/json" }
    });
    if (!ok) return { error: "SubSource API key: SubSource didn't accept it" };
  }
  if (settings.subdl && settings.subdl !== current?.subdl && !(await subdlAccepts(settings.subdl))) {
    return { error: "SubDL API key: SubDL didn't accept it" };
  }
  return undefined;
}

/** What's wrong with one part of the settings, from settingsProblem's checks for that part. */
function partProblem(settings: Settings, prefixes: string[]): Problem | undefined {
  const problem = settingsProblem(settings);
  return problem && prefixes.some((p) => problem.startsWith(p)) ? { error: problem } : undefined;
}

/**
 * Checks one step of the flow before the person moves on: "sync", "sources",
 * "languages" or "name". Steps with nothing to check pass.
 */
export async function checkStep(step: string, input: ConfigureInput, current?: Settings): Promise<{ ok: true } | Problem> {
  if (step === "sync") return (await syncProblem(keepOrReplace(input.aiostreams, current?.aiostreams), current)) ?? { ok: true };
  if (step === "sources") {
    const addons = await gatherAddons(input, current);
    if ("error" in addons) return addons;
    const settings = draft(input, addons, current);
    // The other steps aren't filled in yet: only this step's own checks count here.
    const local = { ...settings, aiostreams: undefined, languages: ["English"], label: undefined };
    return partProblem(local, ["SubSource", "SubDL", "Other addons", "Sources"]) ?? (await keysProblem(settings, current)) ?? { ok: true };
  }
  if (step === "languages") {
    const settings = draft(input, [], current);
    return partProblem({ ...settings, subsource: undefined, subdl: undefined, opensubtitles: true, aiostreams: undefined, label: undefined }, ["Languages"]) ?? { ok: true };
  }
  if (step === "name") {
    const label = labelOf(input.label);
    return label && !LINK_LABEL.test(label) ? { error: "Link name: use up to 40 letters, digits, spaces or simple punctuation" } : { ok: true };
  }
  return { ok: true };
}

/** Builds the settings from the whole form, checks them all, and returns the new manifest URL. */
export async function saveConfiguration(input: ConfigureInput, current?: Settings): Promise<{ manifestUrl: string; settings: Settings } | Problem> {
  const addons = await gatherAddons(input, current);
  if ("error" in addons) return addons;
  const settings = draft(input, addons, current);
  const problem = settingsProblem(settings);
  if (problem) return { error: problem };
  const failed = (await syncProblem(settings.aiostreams, current)) ?? (await keysProblem(settings, current));
  if (failed) return failed;
  if (!config.publicBaseUrl) return { error: "This server has no PUBLIC_BASE_URL set" };
  const token = sealSettings(settings);
  if (token.length > MAX_TOKEN) return { error: "Other addons: their URLs are too long to fit in one link. Remove one" };
  return { manifestUrl: `${config.publicBaseUrl}/${token}/manifest.json`, settings };
}
