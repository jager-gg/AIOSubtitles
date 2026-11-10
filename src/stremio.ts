/**
 * What a Stremio subtitles request asks for. AIOStreams calls
 * /subtitles/<type>/<id>/<extra>.json, where id is "tt0903747" for a movie or
 * "tt0903747:1:2" for an episode, and extra is a query string with the
 * playing file's name, hash and size.
 */
import type { StremioSubtitleRequest } from "./types.js";

/** An IMDb id, optionally followed by ":season:episode". */
const IMDB_ID = /^(tt\d+)(?::(\d+):(\d+))?$/i;

/** The "extra" path segment as key/value pairs ("filename=…&videoSize=…", with or without ".json"). */
export function parseExtraArgs(raw = ""): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw.replace(/\.json$/, "")));
}

/** The request as AIOSubtitles uses it. A video id in extra wins over the path's id. */
export function parseStremioSubtitleRequest(type: string, id: string, extra: Record<string, string> = {}): StremioSubtitleRequest {
  const videoId = extra.videoId ?? extra.videoID ?? id;
  const [, imdb, season, episode] = IMDB_ID.exec(videoId) ?? IMDB_ID.exec(id) ?? [];
  return {
    type,
    id: videoId,
    filename: extra.filename,
    videoHash: extra.videoHash || undefined,
    videoSize: extra.videoSize || undefined,
    ...(imdb ? { imdbId: imdb.toLowerCase() } : {}),
    ...(season ? { season: Number(season), episode: Number(episode) } : {})
  };
}
