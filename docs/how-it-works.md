# How it works

```
player -> AIOStreams -> AIOSubtitles -> SubSource, SubDL, OpenSubtitles, Subtitle Cat, other addons
                             |
                             +-> AIOStreams (find the playing file) -> the file's Matroska index (about 1 MB)
                                                                     -> else ffprobe/ffmpeg windows
```

## Finding subtitles

- Requests use an IMDb id (`tt…:season:episode`) or a Kitsu id (`kitsu:1000:13`). Kitsu ids are mapped to IMDb with the Anime Kitsu addon's metadata.
- SubSource records are tried in order: the requested season, the whole-series record (season 0), then season 1. Anime is often filed on the whole series. When SubSource has none of those, another season's record is searched, and from it only a subtitle whose name spells out the requested season and episode (`S02E17`) is taken: its plain episode numbers count from its own season. A show with a season map (below) has its other records searched too, after those three (8 records at most, the seasons nearest the one asked for first), and on every record a name the map can read is judged by the map, not by the record's season.
- A subtitle whose name gives a season ("Season 5 Ep 17") is for that season only, unless it says season 1 and its number is the episode counted across the whole show.
- **Seasons named by their titles (anime):** uploaders often name a later season by its own title (`Show: Second Arc - 03`) and count its episodes from 1, and a season's second part again from 1 (`Show: Third Arc Part 2 - 01`). The Anime Kitsu addon lists each season, part and special of such a show as an entry of its own, with its titles and the IMDb season and episode of each of its episodes. So for an anime series (a Kitsu id, or Cinemeta's animation from an anime country; other shows aren't looked up and their lists don't wait for it), the addon's catalog is searched by the show's name (Cinemeta's), and the entries with the show's IMDb id make its season map (kept a week; a show without one, an hour). It's looked up beside the searches; when the first look-up isn't back in time, the list goes as without it and is asked for again soon. It's used when the show has two entries or more, and any failure, even one entry that can't be read, means no map, as does a search that may not hold all of the show's entries (a full page of results) or a show with more than 12.
  - A name is read against the entry whose own title words it carries: the words of the entry's titles past the show's title (`second arc`, `2nd season`, `season 3 part 2`). The entry with the most of them wins, so a part over its season. Seasons and parts are compared in one form: `2nd Season`, `Second Season`, `Season Two` and `S2` are all season 2; `Part 2`, `Cour 2` and `2nd Cour` are all part 2. Titles in other scripts, and words two entries share, aren't used. A name carrying only the show's title is the first season's, except under the requested season's own record: there it goes by the rules above, as without a map, unless that record mixes seasons (one of its names carries another season's own title; a special's doesn't count).
  - The number right after the title is the episode within that entry, placed by the entry's own table; a pack's range (`[1 ~ 11]`, `01-11`) holds each of the entry's episodes in it, and a title alone holds them all (`Show S3` alone, where that entry is IMDb's season 3, the whole season). A number past the entry's own episodes counts on within its IMDb season (`Show: Third Arc - 21` when the first part has 11), when the map has that episode. The subtitle is taken when that is the episode asked for, and refused when its names place it elsewhere.
  - A name the map can't place goes by the rules above, as without a map: one with a title word the map doesn't know (a season not listed yet), a part the map doesn't know, two numbers in a row (`Show 2 - 03`), the show's title alone without a number or a season, or a season by number that isn't its entry's (`Show Season 5 Ep 17`). Names that spell out the season and episode (`S02E03`) go by those markers. From a source that searched for the episode itself, only a later season's own title can overrule it, not the show's title alone.
  - A pack's file is found by the entry's own number when it differs from IMDb's (`Part 2 - 01` for season 3's 12th): first a file named with the IMDb season and episode, then one with the entry's number (one giving both numbers first), then one numbered like the IMDb episode when none has the entry's number. A season's or part's number in a file name (`Part 2`) is never read as the episode.
- A special (IMDb season 0) is matched loosely, but a name that gives only other seasons (`Show.S03.1080p.WEB`, `Show.S03E05`) or another special (`S00E02`) is refused, unless it says it is a special (`OVA`, `Special`). Its file in a pack is found like an episode's (`S00E01`), not like a film's.
- From a source that searched for the episode itself (SubDL, OpenSubtitles, added addons), a name giving season 1 and the episode's number is still taken for a later season (anime sequels are often released as their own `S01`), but a name spelling out the season asked for ranks above it.
- Episodes are matched by `S01E13` markers, packs named like `Ep101-170` (by absolute episode), or a bare number such as `Show - 013 [720p]`. Resolutions, years, CRCs and season numbers are ignored. The absolute episode comes from Cinemeta's season sizes.
- **Dub captions** must be tagged as such: `Dubbed Version`, `Eng Dub`, `English Dub` or `dub version`. At most 3 dub caption tracks are listed; the ones further down stand behind them as fallbacks.
- **Regular English** is a language of its own (`English Subtitles` in a link's settings; `English` there means the dub captions). It's ranked like any other language, and subtitles tagged as dub captions are left out of it.
- **English CC fallback:** when nothing is tagged as dub captions, an official English hearing-impaired track (Netflix and the like) is served as **English CC**. On streaming services, the English CC of a dubbed show usually transcribes the dub. One is listed, with the other official ones as its fallbacks.
- Season packs are unzipped. A pack whose only file names another episode is refused for other episodes, and a season's number in a file name (`S02E01`) is never read as the episode number. Dub captions in a pack known not to hold the episode don't count as dub captions for it, so the English CC and regular English fallbacks get their turn. A file that covers a run of three or more episodes (`EP1-EP9 en.srt`, the subtitle of a compilation video) is never taken for one of them.
- **No empty tracks:** with a file playing, each listed pack is opened while the list is made (within the list's own time limit); one that lacks the episode gives its place to the next subtitle in line. A download that can't be had the same way sends the next subtitle in line instead of nothing.

### Ranking

- Machine and AI translations are dropped, whether the source's type tag says so or the notes do (ChatGPT, DeepL, Google Translate and the like), unless the link allows them. When allowed, they rank below every other subtitle of the same language.
- The rest are ranked: official (retail, or notes naming Crunchyroll, Netflix and the like), then human (translated or improved, or credited to a team), then unknown.
- Within a tier, subtitles made for the playing release come first, then ratings, then downloads. The release match compares the filename's release group (+3), streaming service (+2) and source (+1) with the subtitle's release names and notes; a different service or source counts -1. SubsPlease, Erai-raws and HorribleSubs count as Crunchyroll.
- UTF-16 files are converted to UTF-8. Other non-UTF-8 files are decoded with the language's usual code page: Windows' (1256 for Arabic, 1250 for Central European languages, 1257 Baltic, 874 Thai, 1258 Vietnamese), GBK or Big5 for Chinese, Shift JIS for Japanese, EUC-KR for Korean, else 1252.

### Sources

| Source | Needs | Notes |
|---|---|---|
| SubSource | the person's key | Searched by IMDb record |
| SubDL | the person's key | Searched by IMDb id, season and episode. Its download links carry the key, so they're fetched only by the server and never logged |
| OpenSubtitles V3+ | nothing | VTT files are repaired back to the original upload. Its episode match can be loose, so a result is trusted only when its release name doesn't name another episode |
| TheSubtitleDB | nothing; on unless the link turns it off | `api.thesubtitledb.org`, by IMDb id, narrowed to the episode. One ask per language (its limit is shared by every language in one ask). Text formats only (SubRip, ASS, SSA, WebVTT); rows that name another episode are left out. Rows it marks as made by AI (transcribed from the audio or translated) count as machine translations. Downloads go through its counted link, each hop checked like an addon's, 10 MB at most |
| Gestdown | nothing; on unless the link turns it off | `api.gestdown.info`, Addic7ed's TV subtitles. Series only: the show by its TVDB id (from Cinemeta), then the episode per language, by Addic7ed's names (`Portuguese (Brazilian)`). Unfinished translations are left out, and a language it refuses (too many asks) is left out of this list only. The release it names (`CREW`, `720p.TEAM`) is what its fit to the playing file is judged by |
| Anime Tosho | nothing; on unless the link turns it off | `feed.animetosho.net`, a mirror of anime releases that keeps every subtitle track of every file. Asked only for anime (a Kitsu id, a show with a season map, or Cinemeta's animation from an anime country) when English Dub is chosen. See [dub captions from anime releases](#dub-captions-from-anime-releases) |
| Subtitle Cat | nothing; off unless the link turns it on | Searched by the show's title with the episode number (films: title and year), since it has no ids. A result is kept only when its name is that title followed by that episode. The upload itself counts in the language it names; its other files are machine translations. Each download is checked to be written in the language it is listed under. Its subtitles are listed only once they have synced to the playing file (by any of the timings below), so none is listed when no file is named |
| Other addons | whatever the addon's URL holds | Asked the way a player would, with a 10 s timeout. Their URLs stay encrypted and are never logged. Only public https hosts are fetched, redirects included, so an addon can't point the server at a private network. AIOStreams and AIOSubtitles itself are refused |

### Dub captions from anime releases

A dub's own release (an English dub's web release, a dual-audio one) carries the streaming service's English captions of the dub as a track of its file, and those are often in no subtitle site. Anime Tosho extracts every track of every file it mirrors and lists them in its open API, so they can be had as files of a few KB, without the video.

- Its search matches words, not episode markers (`S02E04` doesn't find `S2 - 04`), and lists the newest releases first, 75 a page. So the show's dub releases are listed whole: its name with `English Dub` (up to 10 pages), `UNCUT` and `Dubbed` (2 each), its dual-audio releases naming this episode (`Dual Audio S02E04`, 1), and each title the season goes by with `English Dub` (from the season map, 2). A search asks its first page alone, and the next ones (a few at a time) only when that one was full. Searches are kept 12 hours, shared by every episode of the show; at most 3 requests to it are in flight, and two lists asking for the same page or release at once share one request.
- A release counts when it is mirrored whole (`complete`, or `unknown` on older ones; one still `processing` is left out until it is done), its name says dub (an English dub's own release before a dual-audio one, and a streaming service's web release before others; never a TV capture), its own name is the show's or the season's (after a leading `[Group]`, the name followed by a separator, an episode or season marker or a release tag, so `Show` isn't `Show Next Generation`), and it holds the episode by the same name matching as every subtitle. A batch whose name gives a range the matching doesn't read (`S02E03-11`) is opened unless it names only other seasons, since its files are matched one by one; a file named only by its number (`Season 2/Show - 03.mkv`) goes by the season its folder, else the release's name, gives. Its 1080p and 720p are one release, and the complete one of them is opened. At most 6 are opened, each kept 30 days; one without any subtitle track yet, or not yet complete, an hour.
- In the episode's file, the track taken is an English text track named as captions or dub captions (`CC`, `SDH`, `Closed Captions`, `Dub`, `Dubtitles`), or the one English text track of a file whose every audio track is English (from the file's mediainfo). Signs, songs and forced tracks never count, nor a dual-audio file's plain `English`, which is the translation.
- It is listed as dub captions made by the service (official), and synced like any other, onto the playing file's English voices. Its AniDB tags aren't used: later seasons' releases are often tagged as the first season's.
- A show's first look takes several seconds (its searches and releases), so it may miss the first list (which is then sent as partial, and asked for again soon). When it finds any, the next episode is looked into at once, so its first list has them.

## Syncing to the playing file

1. The subtitle request carries the playing file's name, and usually its size. AIOSubtitles asks the link's AIOStreams for the episode's streams and picks the one with that name (the same-sized one when two share it, or a file of exactly that size when none has the name). Timing is stored by name and size, so files that only share a name don't share timing. AIOStreams' list can differ from one request to the next, so when the file isn't in it, the list is asked for again after 5 s and once more 15 s later; a file in none of them isn't looked for again for 10 minutes.
2. ffprobe ranks the file's subtitle tracks. Only the timing of their lines is used, so a text track in any language comes before a picture track (PGS, VobSub), then English, then tracks titled Full or Dialogue. Signs, songs and forced tracks are skipped. Up to 2 more text tracks are read in the same pass as the first, at no extra download.
3. **Matroska files:** the file's index (its Cues) is read: mkvmerge gives every subtitle line an index entry with its start and length, so the whole file's line timing comes from about 1 MB (`src/mkv.ts`). Karaoke and animated signs, which the index can't tell apart by style, are left out by shape: they're short and stacked on each other. The lines are cut into 1-minute windows, and a window far from both its agreeing neighbours is dropped as a chance fit. Picture subtitles (PGS) come from the index too: their entries alternate between showing a line and clearing it, an entry within 0.3 s after another is surely a line starting, and between those sure points shows and clears alternate (a stretch that doesn't add up is left out). Files without subtitle entries in their index, and other containers, use step 3b.
3b. ffmpeg reads 40 s at 5 points (15, 32, 50, 68 and 85% into the file), jumping there with the file's index. Heavy files get shorter windows, down to 20 s (about 60 MB each), so a 2160p remux is read in time.
4. A track with under half as many lines per minute as the subtitle (an unlabelled signs track) is skipped. If the first track doesn't fit, the next one is tried; speech in the audio comes only after every track.
5. At each point, the shift (within ±20 s) is found where the subtitle best covers the file's own lines, along with any other shift that fits nearly as well. The points are then walked in order, and the run of fits that scores best in total is taken, where each change of shift from one point to the next costs something. A chance fit off on its own is passed over, and a real change, which holds in every point after it, is followed. A point that still disagrees with all the others by more than 1.5 s is ignored.
6. If the points agree within 0.5 s, the median shift is used. Otherwise the shift changes at the pause between two neighbouring points that disagree by over 0.5 s, where the most lines fit, and each stretch between such changes takes the median shift of its own points. Dub captions keep this timing until their voices are heard. Translations are timed more closely from here, by the file's own lines ([translations](#translations-timed-by-the-files-own-lines)).

A subtitle goes through these, in order, and the first that times it is used:

- a shift per stretch, as above, when it is one this file's subtitle would have ([subtitles that don't belong to the file](#subtitles-that-dont-belong-to-the-file)), after more of the file is read where the timing steps, and at another frame rate when that fits better;
- when no shift fits: [line by line](#timing-line-by-line) (translations), then [one shift further off than ±20 s](#timing-further-off-than-the-search), then [by line starts](#timing-by-line-starts) (translations), then [by speech](#timing-by-speech);
- otherwise it is served as it came, and listed as not synced.

Then [translations](#translations-timed-by-the-files-own-lines) are brought closer to the file's own lines, and [dub captions](#dub-captions) to the English voices. These last steps only refine a timing already found: none of them can make a subtitle count as synced.

### Timing that changes mid-episode

A streaming release and a Blu-ray often differ at the ad breaks, so a subtitle's shift can change several times in one episode. After the first pass:

1. Up to 6 more 60 s windows are read: around points that found nothing, between far-apart points that disagree, and early in the file if nothing covers the first quarter.
2. Where neighbouring points still disagree, the stretch between them is read in full (up to 180 s) to place the change exactly.

Files whose points all agree read nothing more. What's read is cached per file, so later subtitles for the same file start from it. A download that can't wait for these reads gets the timing of the first pass, but only when those points already pass every test a synced result must (above, and [subtitles that don't belong to the file](#subtitles-that-dont-belong-to-the-file)).

### Subtitles made for another frame rate

A subtitle timed for 25 fps runs 4.3% fast on a 23.976 fps file (about a minute off by the end of an episode); 24 fps against 23.976 drifts about 1.4 s over 24 minutes. When a subtitle fits nowhere, or only with several changes, six frame-rate conversions are tried on the windows already read. A conversion is used when at least 3 windows, spread over 40% of the file, agree on one shift and the subtitle's line starts clearly match the file's at that shift.

### Subtitles that don't belong to the file

Real subtitles fit at the same shift window after window. When most windows disagree with each other (for example another episode's subtitles), the subtitle is left as it is and listed as not synced.

The same goes for a shift that jumps about. A subtitle made for another cut changes shift where the cuts differ, a handful of times. One that jumps by over a second more often than once per six points measured (and more than three times) can't be followed by a shift per stretch. It isn't served as synced that way; it goes to the timings below, which have tests of their own.

These tests judge the points that were measured, and a point is measured only where the subtitle has lines near the file's, fitting well enough; with fewer than three they judge nothing. So a subtitle that meets only a stretch of the file passed them on the few points it met, at chance shifts: a film's subtitle on an episode (most of its lines past the episode's end), a short subtitle on a longer file, a subtitle so sparse that few points fit it at all. Every timing, whichever way it was found, must also account for the file as a whole (`accountsForFile` in `src/sync.ts`):

- at least 90% of the subtitle's lines start within the file, as timed;
- it has lines in at least three quarters of the file's points with dialogue (an index minute with 6 lines or more, a window read with 3 or more; on a file with no subtitle track, a window with 3 voices heard or more);
- a shift per stretch, and a timing at another frame rate, rest on at least 60% of those points, and on 3 at least.

A subtitle that fails is left as it came and listed as not synced, after the other ways of timing below have had their turn under the same test. Timing by line starts and far off have their own landing tests over every point; timing line by line and by speech rest on no point fits, so only the first two apply to them. Timing by speech that steps is placed by each side's own windows, but it needs three of them a side already ([timing by speech](#timing-by-speech)): six of at most ten windows heard, the share a shift per stretch must rest on.

These tests judge the timing a subtitle was found to belong by. A translation is then timed more closely by the file's line starts ([a shift per stretch, by line starts](#a-shift-per-stretch-by-line-starts)), which never makes a subtitle count as synced, but can join two stretches and move one by a few seconds. That timing must pass the first two tests too, or the one it refined is served.

On the stored plays, every played file was synced with every cached subtitle the data shows to be another episode's or another title's ([cross check](scoring.md#cross-check-subtitles-that-arent-the-files)): 63 of 11,767 had been served as synced, and none is now. The file's own subtitles start within it (99% of their lines at least), have lines in 96% of its points at least, and their timing rests on 79% of them at least; every one that synced still does, timed as before the test (it changes no timing, it only refuses).

### Timing line by line

Some subtitles are the file's own dialogue, line for line, but were timed by hand to another recording (a cinema recording, say), so every line sits a little differently and no shift fits. On a Matroska file timed from its index, every line of its subtitle tracks is known, so such a subtitle can take its timing from them directly (`src/align.ts`).

The subtitle's lines and the file's lines are paired in order by their rhythm: two timings of the same dialogue differ in where a line starts, far less in how long the pause to the next line is and how long a line lasts. A line on either side may be left out (a split line, a sign, a credit). Each paired line then starts where the file's line starts; a line left out moves with its neighbours. The lines are kept in order and apart, as lines moved one by one always are ([kept in order](#kept-in-order)).

It is used only when the pairing is beyond doubt: at least 60 lines on each side, 90% of the subtitle's lines paired, 85% of the pairs lasting within a second of each other, the shift moving by under 2 s from one pair to the next for 90% of them, and never more than 8 subtitle lines in a row unpaired. Against 4,573 stored pairs of a file with another episode's, show's or film's subtitle, none passed. It applies to languages other than English Dub.

### Timing further off than the search

A release that opens with a recap, or a longer cold open than the subtitle's release, moves every line by a minute or so: past the ±20 s each point is searched over, so nothing fits. Then the line starts of every point are matched at once over ±2 minutes: the shift where the most of the file's lines have a subtitle line starting within 0.2 s of them. Line starts meet at one shift only, where how lines overlap changes little from one shift to the next.

When that shift stands out (at least a fifth of the file's lines met, and a tenth more than at any shift over a second away) and lies more than 10 s off, every point is measured again around it, as in step 5. The result is used only when it passes the usual tests and holds for nearly the whole file:

- three quarters of the points land on it with their own best fit;
- never more than two points in a row miss it (a recap of a minute or two);
- no more than two lines go before the file starts.

A longer cut's subtitle with one scene more after its cold open sits a minute off everywhere but the cold open, and the cold open's lines would go before the start. Its shift is refused.

Over 3,611 pairs of a file with another episode's or another show's subtitle, the shift the line starts singled out stood at most 0.05 above the next one. A file's own subtitles at one shift stood 0.2 to 0.84 above it.

This applies to dub captions too: their lines are their own, but each stretch of talk starts where the file's does.

### Timing by line starts

Some official translations keep each line on screen until the next one and merge short lines. Such lines cover the file's dialogue about as well at any shift. So each point's best fit is a chance one, the points disagree, and the subtitle would be refused. The lines still start where the file's lines start. One show's official Arabic subtitles shift by about 3 s more at each break (+1.7, +5.1, +8.6, +11.1 and +15.6 s through one episode). On four of them, only 10 to 15 of the 39 to 43 points had their own best fit on the timing, 5 to 7 of the rest at the very edge of the ±20 s. Their line starts put 22 to 34 points on it.

On a Matroska file timed from its index, a translation that no shift fits is measured again by line starts alone. Each minute of the file takes the shift at which the most of its line starts have a subtitle line starting within 0.2 s, searched over ±20 s. The timing is used only when:

- it passes the usual tests;
- at least 24 minutes have 6 lines or more, and half of them land on the timing with their own best fit (on fewer, chance lands too large a share: a 24-minute episode is too short);
- never more than four minutes in a row miss it.

Within each stretch the shift then follows the minutes from one to the next instead of taking their median, since such a subtitle's shift creeps a little between its steps (seen: +2.4 s rising to +4.0 s over 20 minutes). The minutes are fits by line starts already, so this timing isn't fitted again as other translations are (below; doing so made no difference over the stored plays). Its lines are then moved and snapped like any translation's.

Over 3,611 pairs of a file with another episode's or another show's subtitle, none was timed this way; the most minutes any of them landed was 41% of 20 to 29, and 33% of 40 or more. It applies to languages other than English Dub.

### Timing by speech

When a subtitle fits none of the file's text subtitle tracks, or the file has no subtitle track at all, the subtitle is timed by where speech starts in the audio of the same windows. The audio is read in the same pass as text subtitles (for a file timed from its index, at the 5 usual points, once nothing fits, or in the background for [dub captions](#dub-captions)); files whose only subtitles are pictures (PGS, VobSub) don't have it read, so they have no speech fallback. Speech is detected with [Silero VAD](https://github.com/snakers4/silero-vad), run on WebAssembly. These tracks are labelled "Synced by audio".

The subtitle's line starts are matched with where voices start after a pause, in every window at once. The timing is used only when it is clear:

- at least 3 windows land on it;
- at least 35% of the voices heard meet a line there;
- it stands out from any shift a second or more away by 15% of the voices heard, and by more than chance does among that many voices: 1.2 times the square root of their number. With few voices heard (a show scored wall to wall) chance alone makes a shift stand out. Over 12,000 made-up plays of another episode's subtitle on files where half to a fifth of the voices were heard, the 15% alone let 25 through and this lets none. Every timing by speech of the stored plays stands out by more.

Each line is placed a little before the voice it meets, as subtitles are: a translation 0.2 s before, a dub caption 0.12 s. The lead depends on who timed the subtitle. Measured as where speech best meets the lines where they belong, a file's own subtitle track led its voices by 0.04 to 0.26 s (6 files), and uploads for files with no subtitle track, as they came (taken to be made for that release), by 0.08 to 0.31 s (6 files). For translations, every lead from 0.14 to 0.2 s lands lines about as close over both (83 to 86 ms off on average), so it stays at 0.2 s. Dub caption uploads lead the English voices by about 0.12 to 0.23 s (4 uploads), English subtitle tracks lead English voices by 0.04 to 0.12 s (3 files): 0.12 s is 38 ms from each on average, where 0.2 s was 82 ms.

**A subtitle that steps.** A subtitle for a release cut differently steps at a break, and the windows on each side meet the voices at a shift of their own. Each side is then timed by its own windows, when each has at least 3 windows that say so clearly on their own (the same tests as above), the two shifts over a second apart. A step that only 2 windows on one side show can't be placed: the one shift the other windows agree on would leave that side's lines seconds off, so the subtitle isn't timed until more of the file is heard.

Like every timing, timing by speech must account for the whole file ([subtitles that don't belong to the file](#subtitles-that-dont-belong-to-the-file)), by its plan, steps and all. On a file with no subtitle track, its points are the windows heard.

**Hearing more of a file with no subtitle track.** Five windows of 40 s often hold too few voices: songs, fights and silence take whole windows, and in a show scored wall to wall most voices are drowned. On the stored plays, 7 of 20 files with no subtitle track had speech enough to measure in only 2 or 3 of their 5 windows; 8 of the 18 subtitles on such files couldn't be timed, and 5 of the 10 timed rested on 3 windows. So when the first five windows don't time a subtitle clearly (no clear fit, a fit the whole-file test refuses, fewer than 4 windows on it, or a window with speech enough to measure that lands elsewhere, where the timing may step), the audio is heard at 5 more spots, between the first five (10, 24, 41, 59 and 76% into the file):

- In the background, as the English audio is for dub captions: the list and the download answer as fast as before, with the timing of the first five windows (or the subtitle as it came). Until the audio has been heard, the download is sent with `no-store`, and the next request for any subtitle on the file is timed by all ten windows.
- It costs what the first pass did: the file's bit rate over 5 windows of 40 s, shorter for heavy files. For the web releases on the stored plays (3 to 11 Mb/s) that is 67 to 272 MB, about 100 MB for most. A file heavier than 25 Mb/s isn't heard more.
- Once per file, kept with the file's readings. The spots are read one after another, the read counts towards `DAILY_READ_GB`, stops as soon as the file's host refuses or the day's limit is spent (it is tried again later), and isn't started once the day's reads pass 80% of the limit ([holding back on the file's host](#holding-back-on-the-files-host)).

A translation timed by speech on a file that has text subtitle lines (they fit no shift, yet may be the same dialogue) is then fitted to those lines and snapped, as below, but only when at least a quarter of the lines in a stretch meet the timing heard. Speech is heard a little after a line shows, so its timing is off by a beat; the file's lines aren't. Otherwise the timing heard stays. Its lines are never moved one by one, and dub captions keep the timing heard.

On a file with no subtitle track, when speech can't time the top subtitle of a language but can time one further down the list, that one takes its place, in the list and in the download. Until the result is in, the list says "Trying audio sync" and is sent with a 30-second cache instead of 5 minutes, so a player that asks again gets the result.

### Translations timed by the file's own lines

A translation of this release is timed to the file's own lines, so where those lines start says its timing more closely than how the lines overlap. Overlap reads each point a few hundred ms off, differently from one point to the next, because a translation's lines are held longer or split differently. Only the stretches of the file that were read count. Four steps follow one another, and each starts from where the one before left the lines, so no line is moved twice in different directions:

1. **A shift per stretch, by line starts** (`followShifts` in `src/sync.ts`).
2. **Lines moved onto their own line**, on a file timed from its index.
3. **Snapping**, for the lines still a little off.
4. **Kept in order**, for whatever moved line by line.

#### A shift per stretch, by line starts

- Each point's shift is fitted again, within 0.7 s of what overlap found, to where the most of its line starts have one of the subtitle's within 0.12 s. It counts when at least 4 lines, and a quarter of them, meet.
- The points are cut into stretches wherever neighbours disagree by over 0.5 s. A stretch still spread over more than 0.5 s is cut again at its largest jump, unless its points lie along a straight line (a subtitle that runs a touch slow or fast). A point that straddles a cut reads in between the two shifts, close enough to both to join them otherwise.
- Each stretch takes the one shift at which the most of all its lines start within 0.4 s of the subtitle's. When the points lie along a slope, a shift that moves steadily through the stretch is tried too, and taken when it makes clearly more lines meet (within 0.2 s): 3% more, and at least 1.5 times the square root of the number that meet. A count of lines that meet varies by about its square root from one fit to the next, so a fit with more freedom always gains something by chance. A stretch where under a quarter of the lines meet keeps the median of its points, as in step 6.
- Two neighbouring stretches are joined again when one shift makes the lines on each side meet nearly as well: neither side loses more lines than that same margin. A point with few lines can be a few hundred ms off, enough to cut. The pair that loses fewest lines is joined first, and of two that lose equally few, the pair whose shifts are closer. A stretch where too few lines meet has only its points' overlap to go by, so it first joins a neighbour that overlap agrees with (half its points within 1 s of that neighbour's shift).
- These margins matter most for a loosely timed translation, where only about a quarter of each point's lines meet. There, 3% was a line or two. A slope or a step fitted to a few lines a beat off served whole minutes 0.3 s off, and a stretch whose lines met nothing could join the neighbour 2.5 s away. Over the stored plays, with every fifth of the file's lines hidden from the sync in turn, the hidden lines that the shift per stretch alone (before any line is moved or snapped) met within 0.3 s went from 63.8% to 64.5%. Step 6's median shifts met 61.9%.
- Between stretches, the shift changes at the pause after which the most line starts meet. Among pauses the lines can't tell apart, the longest is used; when those pauses spread over a stretch that wasn't read, the middle one. The change before a stretch of one point and the change after it are both looked for across that point; if they come out the wrong way round, each is looked for again on its own half of it.
- No line is moved before the line written ahead of it, nor over it when they didn't overlap as written. Timing by line starts keeps its own shifts (above), held the same way. That holds the shift's changes from line to line. Where it steps back by more than 0.1 s, by more than the pause the step sits in, the line after the step is left where the step puts it, as [kept in order](#kept-in-order) leaves lines a step put out of order. Held, it pushed the lines after it later one after another: a step 4 s back in a 1.5 s pause put the next five lines 2.5, 1.9, 1.3, 0.7 and 0.1 s late.
- The timing that comes of these steps must still account for the whole file, as the one it refines did ([subtitles that don't belong to the file](#subtitles-that-dont-belong-to-the-file)); where it doesn't, the timing it refined is served instead. None has failed, on the stored plays or the benchmark.

#### Lines moved onto their own line

A shift per stretch can fit and still leave lines off: a subtitle that runs a touch slow creeps up to half a second a minute between its cuts, one timed by hand to a close recording wanders a second either way, and a translator's own timing puts a line here or there half a second off, more than snapping moves. On a Matroska file timed from its index, every line of the file is known, so the translation is also paired with the file's lines one by one, by rhythm, as in [timing line by line](#timing-line-by-line) (`linesOverShift` in `src/align.ts`). The shift per stretch has already vouched for the subtitle, so each pair is judged on its own, by whether the pairs around it agree.

Each pair says how far its file line starts from where the shift puts the subtitle's line. A line moves onto its own when its pair agrees with the 7 pairs on either side of it:

- its own distance is within 0.5 s of their median;
- at least half of them are within 0.5 s of that median too (where the pairing went wrong, the distances scatter);
- that median is within 1 s of the shift, so the pairing can't pull a stretch far from the shift on its own. A second pass measures it against what the first pass confirmed nearby instead, so a drift that grows past a second is followed outward step by step. A run of lines paired one line off (a line missing from the file's track, in quick exchange) stays held back by the lines at the shift on either side of it.

The other lines keep the shift. Timing heard in speech is never moved this way: no shift on the track vouched for it.

On the made-up plays of the [benchmark](benchmark.md), where each line's true place is known, this took a translation timed by someone else from 94% to 99% of its lines within 0.3 s of where they belong, and a subtitle timed by hand to a close recording from 99% to 100%. The sync score can't show it fairly: a moved line starts on one of the file's lines, the same lines the score measures by. With every fifth line of the file hidden from the sync, the hidden lines were met as often with the moves as without (64.8% within 0.3 s, against 64.9%), as they must be: a line can't be moved onto a line the sync doesn't see.

#### Snapping

A line within 0.3 s of one of the file's own line starts is moved onto it, when the pairing is unambiguous: no other of the file's line starts is within 0.6 s of it, and no other subtitle line is nearer to that line start. A line moved onto its own line in step 2 already starts there, so it isn't snapped again, and it keeps the others from snapping onto its line.

#### Kept in order

Lines that move one by one, in step 2 or by timing line by line, are kept in order and apart. A line that would pass a moved neighbour, or come within half a second of it (unless it was that near as written or before the moves), moves with that neighbour; where that still isn't enough between two moved lines, the lines between them are put in proportion. A line ends where a moved line now starts, rather than overlap it more than it did. Lines the shift itself put out of order, where it steps back by more than the pause it is placed in, are left as they were.

### Dub captions

Dub captions (English that follows an English dub, and English CC) are synced without a language. They follow the dub's voices, but the file's own subtitle track follows the original audio. Timed against that track alone, they land a beat off the English voices: 0.12 to 0.28 s early or late on the files checked, where the uploads themselves were right.

So the track only gives the rough timing: the shift per stretch of step 6 (or one further off), its steps, another frame rate. Dub captions are never timed line by line or by line starts, moved onto the file's lines or snapped. Once the file's English audio has been heard (English audio is picked first), the voices refine that timing:

1. The captions, as the track times them, are matched against where the voices start at the 5 spots, up to 1 s either way.
2. Each stretch between two of the track's steps moves by its own spots when they agree. A stretch with no spot of its own moves as the whole file does. A stretch can only move far from the others when two of its spots agree on it.
3. Each line ends up 0.12 s before the voice it meets, the lead dub captions keep when timed by speech ([timing by speech](#timing-by-speech)). A release's own captions track, as Anime Tosho keeps it, ends up 0.32 s before: on the one file measured, the service started its lines that far ahead of the voices, and the viewer found them late on two other releases at 0.12 s. That lead rests on that one file, so it is provisional. It is used when they are timed by speech too.
4. When the voices don't say clearly, the track's timing stands. That means fewer than 3 spots agreeing, too few voices meeting a line, or another move almost as good.
5. Captions that are the file's own track aren't moved at all: they fit it at one shift (within 50 ms) with 95% overlap or more in 9 of every 10 points, and at least 5 points. That track's timing is the file's own. Uploads that follow a track score about as high, but their points spread over hundreds of ms, so they are moved as above.

The voices only refine captions the track already found to be this file's, by under a second. They never decide that captions belong. Audio tagged in another language (no English audio) isn't used for this. Translations keep the track's timing.

A file read in windows hears its audio in the same reads as its lines, so its dub captions are refined on the first sync. The Matroska index has no audio, so on a file timed from its index:

- The first sync serves the track's timing, as before, then reads the English audio at the 5 spots in the background. Nothing waits for that: the list and the download answer as fast as before.
- Until the audio has been heard, the download is sent with `no-store`, so the player asks again next time. The next request for any dub caption on the file is synced again, by the voices.
- The read costs 5 windows of the file: its bit rate over 5 × 40 s, with shorter windows for heavy files (step 3b). That is about 56 MB for a 2.2 Mb/s web episode, 220 MB for a 9 Mb/s Blu-ray encode, and 315 MB at most for anything up to 25 Mb/s. Heavier files (a 2160p remux) aren't read for this.
- Once heard, the audio is kept with the file's readings and never read again (a read that failed at every spot is tried again later). The spots are read one after another, using one ffmpeg process instead of five. The read counts towards `DAILY_READ_GB` and stops when the host refuses (see [holding back on the file's host](#holding-back-on-the-files-host)). It isn't started once the day's reads pass 80% of the limit, so the rest stays free for syncs a viewer is waiting on.

## Responding in time

AIOStreams waits 7 s for subtitles. Every source is searched at once and waited on by itself, and the list is answered within 4 s with whatever has arrived; slower searches continue and are cached for the next request. A source that fails (SubSource refusing a key, say) is left out of that list, and noted on the dashboard. A list missing a source that was late is sent with a 30-second cache instead of 5 minutes.

Sync starts when the list is requested, and so does the read of the playing file's header. With "Skip languages the file already has" on, a first play's list leaves out the languages the file has full text subtitles in once they are known: for a Matroska file, from one read of its first 512 KB, which is done well before the full header check (waited on as long as that one). A list answered before either is done lists them.

On a file timed by its own subtitle track, the list waits for the syncs within those 4 s, so the first list already says which tracks synced and can list a fallback in place of a subtitle that doesn't fit. A list whose syncs weren't all finished in time is also sent with a 30-second cache.

A download never takes more than 8 s from the moment it's asked for, fetching the subtitle and trying fallbacks included: it waits up to 5 s for the sync, then gets the timing from the first pass, or the original file. Either stand-in isn't cached, so the next request gets the finished sync. Neither are dub captions waiting for the file's English audio to be heard ([dub captions](#dub-captions)). Players give up on a subtitle that takes about 10 s and show nothing.

SubDL allows a key 50 downloads a day. Once a key is down to its last 10, a list no longer downloads new SubDL subtitles to sync ahead (a list may be for an episode nobody plays): those are kept for subtitles a player asks for.

At most 6 ffprobe/ffmpeg processes run at once across all users. Speech detection lets other requests through every 2 s of audio it hears, so hearing a 40 s window never holds up a list or a download for more than a few milliseconds at a time.

## Holding back on the file's host

The file is read with the viewer's own debrid or usenet account, so reads stop in two cases (`src/reads.ts`):

- **The host refuses.** HTTP 429 pauses reads from that host at once. HTTP 403 pauses them after 3 in a row, because a single 403 is usually an expired link. A pause lasts 5 minutes and doubles each time the host refuses again straight after one, up to an hour. A read that works clears it.
- **The day's limit is spent.** `DAILY_READ_GB` (default 50) counts bytes read from playing files over everyone, per UTC day. Index reads are counted exactly; ffmpeg's windows are estimated from the file's bit rate. Reads nobody waits for (the English audio for dub captions, more of the audio of a file with no subtitle track) stop at 80% of the limit.

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

`npm run score` runs the same plays through the whole sync offline and measures how close the served lines land to the file's own lines. With `--holdout 5` it hides every fifth of those lines from the sync and judges by them alone, for the steps that time a subtitle by the very lines it is judged by: see [scoring.md](scoring.md). `npm run negatives` syncs every played file with every cached subtitle that is another's, and lists each one served as synced: there must be none ([cross check](scoring.md#cross-check-subtitles-that-arent-the-files)).

`npm run bench` serves made-up plays through the sync (a shifted release, a cut that steps, another frame rate, a recap, dub captions and their voices, a hand-timed film, another episode's subtitle) and scores each line against where it belongs: see [benchmark.md](benchmark.md).
