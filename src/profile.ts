/**
 * Who a request is for. Each person's settings live in their manifest URL,
 * encrypted with CONFIG_SECRET:
 *
 *   https://<PUBLIC_BASE_URL>/<token>/manifest.json
 *
 * The configure page makes the token; AIOStreams' "Reconfigure" button opens
 * <token>/configure to change it. Nothing about anyone is stored here.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cachePath } from "./cache.js";
import { config } from "./config.js";

export interface Language {
  /** SubSource's name for it, lower case: "arabic". */
  name: string;
  /** The label players get, e.g. "Arabic". */
  code: string;
}

/** A Stremio subtitle addon someone added: its manifest URL may hold that addon's own keys. */
export interface Addon {
  name: string;
  url: string;
}

/** Most addons one link can carry; their URLs make the link longer. */
export const MAX_ADDONS = 3;

export interface Profile {
  /** The link's id in logs and on the usage page: AIOStreams uuid prefix and key tag. */
  name: string;
  /** The name its owner gave the link, if any ("Sara", "Living room TV"). */
  label?: string;
  /** Empty when SubSource isn't used. */
  subsourceKey: string;
  subdlKey?: string;
  /** OpenSubtitles V3+ (no key). */
  opensubtitles: boolean;
  /** Other Stremio subtitle addons asked too. */
  addons: Addon[];
  /** AIOStreams install URL used to find the playing file, as reached from here; no sync without it. */
  aiostreamsUrl?: string;
  /** English Dub captions on or off. */
  dub: boolean;
  extraLanguages: Language[];
  extraPerLanguage: number;
  langMode: "custom" | "standard";
  /** Keep machine and AI translations. */
  allowMachine: boolean;
  /** For the other languages; dub captions are hearing-impaired by nature. */
  hearingImpaired: "include" | "exclude" | "only";
  /**
   * Leave out a language the playing file already has full text subtitles in: they're timed to that
   * file already. Dub captions are always listed (a file's English is the translation, not the dub).
   */
  skipEmbedded: boolean;
  /** Leave out tracks known not to sync to the playing file (see Settings.hideUnsynced). */
  hideUnsynced: boolean;
  /** Path in front of this profile's URLs: "/<token>". */
  prefix: string;
}

/** What a manifest URL holds. */
export interface Settings {
  /** API keys of the sources used; at least one source is required. */
  subsource?: string;
  subdl?: string;
  /** OpenSubtitles V3+, which needs no key. */
  opensubtitles?: boolean;
  /** Other Stremio subtitle addons, by manifest URL. */
  addons?: Addon[];
  /** AIOStreams install URL (https://<allowed host>/stremio/<uuid>/<password>/manifest.json); no sync without it. */
  aiostreams?: string;
  /** SubSource language names; "English" means the English Dub captions. */
  languages: string[];
  allowMachine: boolean;
  hearingImpaired: "include" | "exclude" | "only";
  /** A name for the link, shown on the usage page instead of its id. */
  label?: string;
  /** List every language even when the file already has it embedded. Links made before this skip them. */
  keepEmbedded?: boolean;
  /** The status in the track's language name ("Arabic (Synced)"), as links did before; off sends the language alone. */
  statusInName?: boolean;
  /** Leave out tracks known not to sync to the playing file, instead of listing them unsynced. */
  hideUnsynced?: boolean;
}

const TOKEN_VERSION = "2";
const LANGUAGE_NAME = /^[A-Za-z][A-Za-z ()-]{1,30}$/;
/** Letters (any script), digits, spaces and a little punctuation, up to 40 characters. */
export const LINK_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .,'’&()_-]{0,39}$/u;

function secretKey(): Buffer {
  const secret = config.configSecret;
  if (!secret || secret.length < 32) throw new Error("CONFIG_SECRET (32+ characters) is not set");
  return createHash("sha256").update(secret).digest();
}

/** The AIOStreams URL split into its allowed origin and config path, or undefined when it isn't one. */
export function parseAiostreamsUrl(url: string): { origin: string; path: string } | undefined {
  const match = url.trim().match(/^(https?:\/\/[^/]+)(\/stremio\/[^/\s]+\/[^/\s]+)\/manifest\.json$/);
  if (!match) return undefined;
  const origin = match[1].toLowerCase();
  const allowed = config.allowedAiostreams.includes(origin) || origin === config.ownAiostreams;
  return allowed ? { origin, path: match[2] } : undefined;
}

/** Returns what's wrong with the settings, or undefined when they're fine. */
export function settingsProblem(s: Settings): string | undefined {
  const key = (k?: string) => !k || (k.length >= 10 && !/\s/.test(k));
  if (!key(s.subsource)) return "SubSource API key: that doesn't look like a key";
  if (!key(s.subdl)) return "SubDL API key: that doesn't look like a key";
  const addons = s.addons ?? [];
  if (!Array.isArray(addons) || addons.length > MAX_ADDONS) return `Other addons: up to ${MAX_ADDONS}`;
  if (addons.some((a) => typeof a?.name !== "string" || a.name.length > 60 || typeof a.url !== "string" || a.url.length > 2048 || !/^https:\/\/\S+\/manifest\.json$/.test(a.url))) {
    return "Other addons: each must be an https manifest URL ending in /manifest.json";
  }
  if (!s.subsource && !s.subdl && !s.opensubtitles && addons.length === 0) return "Sources: add a SubSource or SubDL key, turn on OpenSubtitles, or add an addon";
  if (s.aiostreams && !parseAiostreamsUrl(s.aiostreams)) {
    return "AIOStreams install URL: must end in /manifest.json and come from a supported AIOStreams instance";
  }
  if (!Array.isArray(s.languages) || s.languages.length === 0) return "Languages: pick at least one";
  if (s.languages.length > 10 || s.languages.some((l) => !LANGUAGE_NAME.test(l))) return "Languages: up to 10 SubSource language names";
  if (!["include", "exclude", "only"].includes(s.hearingImpaired)) return "Hearing impaired: include, exclude or only";
  if (s.label !== undefined && (typeof s.label !== "string" || !LINK_LABEL.test(s.label))) return "Link name: use up to 40 letters, digits, spaces or simple punctuation";
  return undefined;
}

/** Longest token accepted; links stay well under what servers allow in a URL. */
export const MAX_TOKEN = 6000;

/**
 * The nonce comes from the text itself (an HMAC of it), so the same settings
 * always give the same link. Only equal texts share a nonce, and they then
 * give equal ciphertexts, which tells nothing new.
 */
function seal(text: string): string {
  const iv = createHmac("sha256", secretKey()).update("nonce\0").update(text).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function unseal(sealed: string): string | undefined {
  try {
    if (sealed.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(sealed)) return undefined;
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export function sealSettings(settings: Settings): string {
  const problem = settingsProblem(settings);
  if (problem) throw new Error(problem);
  return TOKEN_VERSION + seal(JSON.stringify(settings));
}

/** The settings in a token, or undefined if it isn't one of ours or was altered. */
export function openSettings(token: string): Settings | undefined {
  if (!token.startsWith(TOKEN_VERSION)) return undefined;
  const json = unseal(token.slice(TOKEN_VERSION.length));
  if (!json) return undefined;
  try {
    const settings = JSON.parse(json) as Settings;
    return settingsProblem(settings) ? undefined : settings;
  } catch {
    return undefined;
  }
}

/**
 * A subtitle URL from an added addon, encrypted for its download link: it can
 * carry that addon's keys, so it never appears in the clear or on disk here.
 * "u" keeps these apart from settings tokens.
 */
export function sealUrl(url: string): string {
  return `u${seal(url)}`;
}

export function openUrl(sealed: string): string | undefined {
  return sealed.startsWith("u") ? unseal(sealed.slice(1)) : undefined;
}

/**
 * The settings' name for regular English subtitles: translated from the original audio and timed to
 * it, picked and synced like any other language. "English" on its own has meant the English Dub
 * captions since the first links, so it keeps that meaning.
 */
export const REGULAR_ENGLISH = "English Subtitles";

export function profileFromSettings(settings: Settings, token: string): Profile {
  const aio = settings.aiostreams ? parseAiostreamsUrl(settings.aiostreams) : undefined;
  const uuid = aio?.path.split("/")[2] ?? "no-sync";
  const keyTag = createHash("sha256").update(settings.subsource || settings.subdl || "opensubtitles").digest("hex").slice(0, 6);
  const own = aio && config.ownAiostreams === aio.origin;
  return {
    name: `${uuid.slice(0, 8)}/${keyTag}`,
    label: settings.label,
    subsourceKey: settings.subsource ?? "",
    subdlKey: settings.subdl || undefined,
    opensubtitles: settings.opensubtitles === true,
    addons: settings.addons ?? [],
    // This server's own instance is looked up inside the Docker network; others over the internet.
    aiostreamsUrl: aio ? `${own ? config.aiostreamsBase : aio.origin}${aio.path}/manifest.json` : undefined,
    dub: settings.languages.some((l) => l.toLowerCase() === "english"),
    extraLanguages: settings.languages
      .filter((l) => l.toLowerCase() !== "english")
      .map((l) => (l.toLowerCase() === REGULAR_ENGLISH.toLowerCase() ? { name: "english", code: "English" } : { name: l.toLowerCase(), code: l })),
    extraPerLanguage: 1,
    langMode: settings.statusInName === true ? "custom" : "standard",
    allowMachine: settings.allowMachine,
    hearingImpaired: settings.hearingImpaired,
    skipEmbedded: settings.keepEmbedded !== true,
    hideUnsynced: settings.hideUnsynced === true,
    prefix: `/${token}`
  };
}

const RESOURCE = /\/(manifest\.json|configure(?:\/check)?|subtitles\/.+|download\/.+)$/;

export interface Routed {
  /** Undefined on the bare /manifest.json and /configure, which belong to no one. */
  profile?: Profile;
  token?: string;
  settings?: Settings;
  /** The rest of the path, e.g. "/subtitles/series/tt1:1:1.json". */
  resource: string;
}

/** Splits "/<token>/<resource>". Undefined for anything else, including altered tokens. */
export function routePath(path: string): Routed | undefined {
  const match = path.match(RESOURCE);
  if (!match) return undefined;
  const head = path.slice(0, match.index);
  const resource = `/${match[1]}`;
  if (head === "") return ["/manifest.json", "/configure", "/configure/check"].includes(resource) ? { resource } : undefined;
  const token = head.slice(1);
  if (!openSettings(token)) return undefined;
  // Edits made on the link's configure page are kept under the link, so its URL never changes.
  const settings = storedSettings(token) ?? (openSettings(token) as Settings);
  return { profile: profileFromSettings(settings, token), token, settings, resource };
}

// ---------- settings edited in place ----------

/**
 * Where a link's edited settings are kept: cache/links/<hash of the link's token>.json, holding them
 * sealed the same way a token is (so the file alone, without CONFIG_SECRET, says nothing). The link's
 * URL stays what AIOStreams already has; a missing file means the settings the URL was made with.
 */
function linkFile(token: string): string {
  return path.join(cachePath("links"), `${createHash("sha256").update(token).digest("hex").slice(0, 40)}.json`);
}

/** Read once per link, then kept in memory (this server is the only one writing them). */
const stored = new Map<string, Settings | null>();

export function storedSettings(token: string): Settings | undefined {
  const file = linkFile(token);
  if (!stored.has(file)) {
    try {
      const { sealed } = JSON.parse(readFileSync(file, "utf8")) as { sealed: string };
      stored.set(file, openSettings(sealed) ?? null);
    } catch {
      stored.set(file, null);
    }
  }
  return stored.get(file) ?? undefined;
}

/**
 * Each link's token by its id, remembered from its requests (cache/links/known.json), so the
 * dashboard can open a link's configure page. The newest token wins when one id has several (a link
 * made again with the same AIOStreams and key). The dashboard needs ADMIN_PASSWORD or a login at the proxy.
 */
let known: Record<string, string> | undefined;

function knownFile(): string {
  return path.join(cachePath("links"), "known.json");
}

export function knownLinks(): Record<string, string> {
  if (!known) {
    try {
      known = JSON.parse(readFileSync(knownFile(), "utf8")) as Record<string, string>;
    } catch {
      known = {};
    }
  }
  return known;
}

export function noteLinkToken(link: string, token: string): void {
  const links = knownLinks();
  if (links[link] === token) return;
  known = { ...links, [link]: token };
  try {
    mkdirSync(path.dirname(knownFile()), { recursive: true });
    const temp = `${knownFile()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(known));
    renameSync(temp, knownFile());
  } catch (error) {
    console.error(`links: not saved: ${error instanceof Error ? error.message : error}`);
  }
}

/** What a link is set to, for the dashboard: which keys are set, never the keys. */
export interface LinkSummary {
  languages: string[];
  sources: string[];
  /** The AIOStreams instance's host; undefined without sync. */
  aiostreams?: string;
  allowMachine: boolean;
  hearingImpaired: Settings["hearingImpaired"];
  skipEmbedded: boolean;
  statusInName: boolean;
  hideUnsynced: boolean;
  /** Edited on its configure page since it was made. */
  edited: boolean;
}

export function linkSummary(token: string): LinkSummary | undefined {
  const original = openSettings(token);
  if (!original) return undefined;
  const edited = storedSettings(token);
  const s = edited ?? original;
  const addons = s.addons?.length ?? 0;
  const sources = [
    ...(s.subsource ? ["SubSource"] : []),
    ...(s.subdl ? ["SubDL"] : []),
    ...(s.opensubtitles ? ["OpenSubtitles"] : []),
    ...(addons ? [addons === 1 ? "1 addon" : `${addons} addons`] : [])
  ];
  return {
    languages: s.languages.map((l) => (l.toLowerCase() === "english" ? "English Dub" : l.toLowerCase() === REGULAR_ENGLISH.toLowerCase() ? "English" : l)),
    sources,
    aiostreams: s.aiostreams ? parseAiostreamsUrl(s.aiostreams)?.origin.replace(/^https?:\/\//, "") : undefined,
    allowMachine: s.allowMachine,
    hearingImpaired: s.hearingImpaired,
    skipEmbedded: s.keepEmbedded !== true,
    statusInName: s.statusInName === true,
    hideUnsynced: s.hideUnsynced === true,
    edited: Boolean(edited)
  };
}

/** Keeps new settings for an existing link: its URL keeps working, with these from now on. */
export function storeSettings(token: string, settings: Settings): void {
  const file = linkFile(token);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ sealed: sealSettings(settings), at: new Date().toISOString() }));
  renameSync(temp, file);
  stored.set(file, settings);
}
