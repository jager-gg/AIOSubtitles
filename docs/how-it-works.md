# How it works

```
player -> AIOStreams -> AIOSubtitles -> SubSource, SubDL, OpenSubtitles, Subtitle Cat, other addons
                             |
                             +-> AIOStreams (find the playing file) -> the file's Matroska index (about 1 MB)
                                                                     -> else ffprobe/ffmpeg windows
```

## Finding subtitles

- Requests use an IMDb id (`tt…:season:episode`) or a Kitsu id (`kitsu:1000:13`). Kitsu ids are mapped to IMDb with the Anime Kitsu addon's metadata.
- SubSource records are tried in order: the requested season, the whole-series record (season 0), then season 1. Anime is often filed on the whole series. When SubSource has none of those, another season's record is searched, and from it only a subtitle whose name spells out the requested season and episode (`S02E17`) is taken: its plain episode numbers count from its own season.
- A subtitle whose name gives a season ("Season 5 Ep 17") is for that season only, unless it says season 1 and its number is the episode counted across the whole show.
- Episodes are matched by `S01E13` markers, packs named like `Ep101-170` (by absolute episode), or a bare number such as `Iron Lantern - 013 [720p]`. Resolutions, years, CRCs and season numbers are ignored. The absolute episode comes from Cinemeta's season sizes.
- **Dub captions** must be tagged as such: `Dubbed Version`, `Eng Dub`, `English Dub` or `dub version`.
- **Regular English** is a language of its own (`English Subtitles` in a link's settings; `English` there means the dub captions). It's ranked like any other language, and subtitles tagged as dub captions are left out of it.
- **English CC fallback:** when nothing is tagged as dub captions, an official English hearing-impaired track (Netflix and the like) is served as **English CC**. On streaming services, the English CC of a dubbed show usually transcribes the dub.
- Season packs are unzipped. A pack whose only file names another episode is refused for other episodes. A file that covers a run of three or more episodes (`EP1-EP9 en.srt`, the subtitle of a compilation video) is never taken for one of them.
- **No empty tracks:** with a file playing, each listed pack is opened while the list is made (within the list's own time limit); one that lacks the episode gives its place to the next subtitle in line. A download that can't be had the same way sends the next subtitle in line instead of nothing.

### Ranking

- Machine and AI translations are dropped, whether the source's type tag says so or the notes do (ChatGPT, DeepL, Google Translate and the like), unless the link allows them. When allowed, they rank below every other subtitle of the same language.
- The rest are ranked: official (retail, or notes naming Crunchyroll, Netflix and the like), then human (translated or improved, or credited to a team), then unknown.
- Within a tier, subtitles made for the playing release come first, then ratings, then downloads. The release match compares the filename's release group (+3), streaming service (+2) and source (+1) with the subtitle's release names and notes; a different service or source counts -1. SubsPlease, Erai-raws and HorribleSubs count as Crunchyroll.
- UTF-16 files are converted to UTF-8. Other non-UTF-8 files are decoded with the language's Windows code page (1256 for Arabic).

### Sources

| Source | Needs | Notes |
|---|---|---|
| SubSource | the person's key | Searched by IMDb record |
| SubDL | the person's key | Searched by IMDb id, season and episode. Its download links carry the key, so they're fetched only by the server and never logged |
| OpenSubtitles V3+ | nothing | VTT files are repaired back to the original upload. Its episode match can be loose, so a result is trusted only when its release name doesn't name another episode |
| Subtitle Cat | nothing; off unless the link turns it on | Searched by the show's title with the episode number (films: title and year), since it has no ids. A result is kept only when its name is that title followed by that episode. The upload itself counts in the language it names; its other files are machine translations. Each download is checked to be written in the language it is listed under. Its subtitles are listed only once they have synced to the playing file (by shift, line by line, or by speech), so none is listed when no file is named |
| Other addons | whatever the addon's URL holds | Asked the way a player would, with a 10 s timeout. Their URLs stay encrypted and are never logged. Only public https hosts are fetched, redirects included, so an addon can't point the server at a private network. AIOStreams and AIOSubtitles itself are refused |

## Syncing to the playing file

1. The subtitle request carries the playing file's name, and usually its size. AIOSubtitles asks the link's AIOStreams for the episode's streams and picks the one with that name (the same-sized one when two share it, or a file of exactly that size when none has the name). Timing is stored by name and size, so files that only share a name don't share timing. AIOStreams' list can differ from one request to the next, so when the file isn't in it, the list is asked for again after 5 s and once more 15 s later; a file in none of them isn't looked for again for 10 minutes.
2. ffprobe ranks the file's subtitle tracks. Only the timing of their lines is used, so a text track in any language comes before a picture track (PGS, VobSub), then English, then tracks titled Full or Dialogue. Signs, songs and forced tracks are skipped. Up to 2 more text tracks are read in the same pass as the first, at no extra download.
3. **Matroska files:** the file's index (its Cues) is read: mkvmerge gives every subtitle line an index entry with its start and length, so the whole file's line timing comes from about 1 MB (`src/mkv.ts`). Karaoke and animated signs, which the index can't tell apart by style, are left out by shape: they're short and stacked on each other. The lines are cut into 1-minute windows, and a window far from both its agreeing neighbours is dropped as a chance fit. Picture subtitles (PGS) come from the index too: their entries alternate between showing a line and clearing it, an entry within 0.3 s after another is surely a line starting, and between those sure points shows and clears alternate (a stretch that doesn't add up is left out). Files without subtitle entries in their index, and other containers, use step 3b.
3b. ffmpeg reads 40 s at 5 points (15, 32, 50, 68 and 85% into the file), jumping there with the file's index. Heavy files get shorter windows, down to 20 s (about 60 MB each), so a 2160p remux is read in time.
4. A track with under half as many lines per minute as the subtitle (an unlabelled signs track) is skipped. If the first track doesn't fit, the next one is tried; speech in the audio comes only after every track.
5. At each point, the shift (within ±20 s) is found where the subtitle best covers the file's own lines, along with any other shift that fits nearly as well. The points are then walked in order, and the run of fits that scores best in total is taken, where each change of shift from one point to the next costs something. A chance fit off on its own is passed over, and a real change, which holds in every point after it, is followed. A point that still disagrees with all the others by more than 1.5 s is ignored.
6. If the points agree within 0.5 s, the median shift is used. Otherwise the shift changes at the pause between the disagreeing points where the most lines fit.

### Timing that changes mid-episode

A streaming release and a Blu-ray often differ at the ad breaks, so a subtitle's shift can change several times in one episode. After the first pass:

1. Up to 6 more 60 s windows are read: around points that found nothing, between far-apart points that disagree, and early in the file if nothing covers the first quarter.
2. Where neighbouring points still disagree, the stretch between them is read in full (up to 180 s) to place the change exactly.

Files whose points all agree read nothing more. What's read is cached per file, so later subtitles for the same file start from it.

### Subtitles made for another frame rate

A subtitle timed for 25 fps runs 4.3% fast on a 23.976 fps file (about a minute off by the end of an episode); 24 fps against 23.976 drifts about 1.4 s over 24 minutes. When a subtitle fits nowhere, or only with several changes, six frame-rate conversions are tried on the windows already read. A conversion is used when at least 3 windows, spread over 40% of the file, agree on one shift and the subtitle's line starts clearly match the file's at that shift.

### Snapping lines

For languages other than English Dub, a line within 0.3 s of one of the file's own line starts is moved onto it, when the pairing is unambiguous. This only applies inside the stretches of the file that were read. Dub captions and English CC are never snapped, because the file's own lines follow the original audio, not the dub.

### Timing by speech

When a subtitle fits none of the file's text subtitle tracks, or the file has no subtitle track at all, the subtitle is timed by where speech starts in the audio of the same windows. The audio is read in the same pass as text subtitles (for a file timed from its index, at the 5 usual points, only once nothing fits); files whose only subtitles are pictures (PGS, VobSub) don't have it read, so they have no speech fallback. Speech is detected with [Silero VAD](https://github.com/snakers4/silero-vad), run on WebAssembly. It needs at least 3 windows and a clear best shift. These tracks are labelled "Synced by audio".

On a file with no subtitle track, when speech can't time the top subtitle of a language but can time one further down the list, that one takes its place, in the list and in the download. Until the result is in, the list says "Trying audio sync" and is sent with a 30-second cache instead of 5 minutes, so a player that asks again gets the result.

### Subtitles that don't belong to the file

Real subtitles fit at the same shift window after window. When most windows disagree with each other (for example another episode's subtitles), the subtitle is left as it is and listed as not synced.

The same goes for a shift that jumps about. A subtitle made for another cut changes shift where the cuts differ, a handful of times. One that jumps by over a second more often than once per six points measured (and more than three times) can't be followed by a shift per stretch. It isn't served as synced that way; it goes to the line-by-line timing below.

### Timing line by line

Some subtitles are the file's own dialogue, line for line, but were timed by hand to another recording (a cinema recording, say), so every line sits a little differently and no shift fits. On a Matroska file timed from its index, every line of its subtitle tracks is known, so such a subtitle can take its timing from them directly (`src/align.ts`).

The subtitle's lines and the file's lines are paired in order by their rhythm: two timings of the same dialogue differ in where a line starts, far less in how long the pause to the next line is and how long a line lasts. A line on either side may be left out (a split line, a sign, a credit). Each paired line then starts where the file's line starts; a line left out moves with its neighbours.

It is used only when the pairing is beyond doubt: at least 60 lines on each side, 90% of the subtitle's lines paired, 85% of the pairs lasting within a second of each other, the shift moving by under 2 s from one pair to the next for 90% of them, and never more than 8 subtitle lines in a row unpaired. Against 4,573 stored pairs of a file with another episode's, show's or film's subtitle, none passed. It applies to languages other than English Dub, after the shift-based sync has found nothing to trust, and before speech.

## Responding in time

AIOStreams waits 7 s for subtitles. Every source is searched at once, and the list is answered within 4 s with whatever has arrived; slower searches continue and are cached for the next request. Sync starts when the list is requested. A download never takes more than 8 s: it waits up to 5 s for the sync, then gets the timing from the first pass, or the original file. Either stand-in isn't cached, so the next request gets the finished sync. Players give up on a subtitle that takes about 10 s and show nothing.

At most 6 ffprobe/ffmpeg processes run at once across all users.

## Holding back on the file's host

The file is read with the viewer's own debrid or usenet account, so reads stop in two cases (`src/reads.ts`):

- **The host refuses.** HTTP 429 pauses reads from that host at once. HTTP 403 pauses them after 3 in a row, because a single 403 is usually an expired link. A pause lasts 5 minutes and doubles each time the host refuses again straight after one, up to an hour. A read that works clears it.
- **The day's limit is spent.** `DAILY_READ_GB` (default 50) counts bytes read from playing files over everyone, per UTC day. Index reads are counted exactly; ffmpeg's windows are estimated from the file's bit rate.

While reads are held back, subtitles are listed unsynced and nothing is cached as a result, so syncing picks up on the next request after the pause.

## Caching

- Search results: 6 hours (`RESULT_CACHE_TTL_SECONDS`).
- Subtitle files, file readings and synced subtitles: deleted after 14 days without use. A synced subtitle whose file has been deleted is synced again on its next request.
- Dashboard counts: kept 60 days.
- `SYNC_VERSION` is part of the sync cache key and download URLs, so a change to the sync method ignores old results.

## Dashboard data

Counts are written to `cache/stats/<date>.json` every minute and on shutdown. API keys appear only as `service:hash`. The recent-activity list (`activity.json`) contains file names. `cache/stats/names.json` can map a link id to a name, for example `{ "a87f48f1": "Sara" }`; names given on the configure page are used otherwise.

## Replay check

`npm run replay` reruns the sync decisions over every past play in a server's cache and shows what a code change would alter. It pulls the cache over ssh: `REPLAY_HOST=<ssh host> npm run replay` (set `REPLAY_CONTAINER` if the container isn't named `aiosubtitles`). Its data stays in the gitignored `.replay/` folder. See `scripts/replay.ts`.
