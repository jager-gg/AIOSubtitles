/**
 * Keeps the cache from growing for ever: once a day, files nobody has used
 * for KEEP_DAYS are deleted from the caches that rebuild themselves
 * (downloads, unpacked subtitles, synced copies, each video's anchor points,
 * search results). The usage counts in cache/stats are never touched.
 *
 * "Used" is the later of a file's last read and last write; the filesystem
 * updates read times at most once a day, which is plenty for a 14-day rule.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { cachePath } from "./cache.js";
import { count } from "./stats.js";

export const KEEP_DAYS = 14;
const PRUNED = ["downloads", "subtitles", "synced", "anchors", "results"];

/** Deletes files under the pruned caches unused for KEEP_DAYS; returns how many and their size. */
export async function pruneCache(now = Date.now()): Promise<{ files: number; bytes: number }> {
  const cutoff = now - KEEP_DAYS * 86400_000;
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const info = await stat(full);
        if (Math.max(info.atimeMs, info.mtimeMs) < cutoff) {
          await rm(full, { force: true });
          files++;
          bytes += info.size;
        }
      } catch {}
    }
  };
  for (const name of PRUNED) await walk(cachePath(name));
  return { files, bytes };
}

/** Runs the clean-up a minute after start, then every day. */
export function startCleanup(): void {
  const once = async () => {
    const { files, bytes } = await pruneCache();
    count("cache.prunedFiles", files);
    count("cache.prunedBytes", bytes);
    if (files) console.log(`cache: removed ${files} files unused for ${KEEP_DAYS} days (${Math.round(bytes / 1048576)} MB)`);
  };
  setTimeout(() => void once(), 60_000).unref();
  setInterval(() => void once(), 86400_000).unref();
}
