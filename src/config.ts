/** Settings from the environment (.env in development, compose's env_file in Docker). */
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const env = process.env;

/** A number from the environment; the fallback when it's unset or not a number. */
function envNumber(name: string, fallback: number): number {
  const value = Number(env[name] || NaN);
  return Number.isFinite(value) ? value : fallback;
}

/** A comma-separated list of origins, lower case, without trailing slashes. */
function list(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Public AIOStreams instances (rentry.co/community-jf-guide, read 2026-11-08). */
export const PUBLIC_AIOSTREAMS = [
  "https://aiostreams.viren070.me",
  "https://aiostreams.fortheweak.cloud",
  "https://aiostreamsfortheweebsstable.midnightignite.me",
  "https://aio.atbphosting.com"
];

/** An IANA time zone Intl knows, or UTC. */
function timeZone(value: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: value || "UTC" }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export const config = {
  port: envNumber("PORT", 7000),
  /** The clock the dashboard shows times on (TIME_ZONE, an IANA name). The days it counts stay UTC days, as SubDL's do. */
  timeZone: timeZone(env.TIME_ZONE),
  /** The public address of this addon (no trailing slash): manifest and download URLs use it. */
  publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
  /** Where the cache lives, relative to the working directory. */
  cacheDir: env.CACHE_DIR ?? ".cache",
  /** Most GB read from playing files in a day (UTC), over everyone; 0 for no limit. See reads.ts. */
  dailyReadGb: Math.max(0, envNumber("DAILY_READ_GB", 50)),
  get dailyReadBytes(): number {
    return this.dailyReadGb * 1e9;
  },
  /** How long search results are kept, in seconds (6 hours). */
  resultCacheTtlSeconds: envNumber("RESULT_CACHE_TTL_SECONDS", 6 * 60 * 60),
  /** Encrypts everyone's settings into their manifest URL. 32+ characters; changing it breaks every URL. */
  configSecret: env.CONFIG_SECRET || undefined,
  /** AIOStreams instances whose install URLs are accepted, as origins. Defaults to the public ones the community guides list. */
  allowedAiostreams: list(env.ALLOWED_AIOSTREAMS || PUBLIC_AIOSTREAMS.join(",")),
  /** This server's own AIOStreams, if any: its install URLs are accepted, and it's reached at AIOSTREAMS_BASE. */
  ownAiostreams: list(env.OWN_AIOSTREAMS)[0],
  /** Where OWN_AIOSTREAMS is reached from here, such as http://aiostreams:3000 on the same Docker network. Defaults to OWN_AIOSTREAMS itself. */
  aiostreamsBase: (env.AIOSTREAMS_BASE || list(env.OWN_AIOSTREAMS)[0] || "http://aiostreams:3000").replace(/\/+$/, ""),
  /** Signs in to the configure page. Unset: open, for a proxy that asks for its own login. */
  addonPassword: env.ADDON_PASSWORD || undefined,
  /** Signs in to the dashboard, and the configure page too. Required (server.ts refuses to start without it). */
  adminPassword: env.ADMIN_PASSWORD || undefined
};
