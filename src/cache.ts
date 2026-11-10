/**
 * The on-disk cache. Everything lives under CACHE_DIR, one folder per kind of
 * thing (results, downloads, subtitles, synced, anchors, stats). JSON results
 * carry their own expiry; other files stay until cleanup.ts prunes them.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/** A cached JSON value and the moment (ms) it stops being good. */
type Stored<T> = { expiresAt: number; data: T };

/** A path inside the cache folder. */
export function cachePath(...parts: string[]): string {
  return path.join(process.cwd(), config.cacheDir, ...parts);
}

/** A stable file name for anything JSON can describe. Existing cache files depend on it never changing. */
export function cacheKey(what: unknown): string {
  return createHash("sha256").update(JSON.stringify(what)).digest("hex");
}

const jsonFile = (folder: string, key: string) => cachePath(folder, `${key}.json`);

/** The value kept under folder/key, or nothing when it's missing, unreadable or past its time. */
export async function readJsonCache<T>(folder: string, key: string): Promise<T | undefined> {
  try {
    const stored = JSON.parse(await readFile(jsonFile(folder, key), "utf8")) as Stored<T>;
    return stored.expiresAt >= Date.now() ? stored.data : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a value under folder/key for ttlSeconds (by default the result lifetime from the config). */
export async function writeJsonCache<T>(folder: string, key: string, data: T, ttlSeconds = config.resultCacheTtlSeconds): Promise<void> {
  await mkdir(cachePath(folder), { recursive: true });
  const stored: Stored<T> = { expiresAt: Date.now() + ttlSeconds * 1000, data };
  await writeFile(jsonFile(folder, key), JSON.stringify(stored), "utf8");
}
