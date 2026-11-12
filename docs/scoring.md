# Sync score

`npm run score` measures how well the sync works on real plays. It syncs every past play again with the current code, offline, and checks how close each served line starts to a line of the playing file's own subtitles. Run it before and after a change to sync: the change should bring lines closer, and it should never leave a subtitle served as synced when it isn't. The [cross check](#cross-check-subtitles-that-arent-the-files) (`npm run negatives`) guards the second half: every played file with every subtitle that is another's.

## Running it

The score reads a replay cache, the same data as the [replay check](how-it-works.md#replay-check): `anchors/`, `subtitles/`, `synced/` and `stats/activity.json`, by default in `.replay/cache`.

```bash
npm run score                                         # .replay/cache, written to .replay/score-current.json
npm run score -- --label before                       # written to .replay/score-before.json
npm run score -- --compare .replay/score-before.json  # also what changed since that run
npm run score -- --data <folder> --only <text> --brief
npm run score -- --holdout 5 --label held             # every 5th line hidden from the sync, and judged by
```

- `--data <folder>`: another replay cache.
- `--label <name>`: names the result file, `.replay/score-<name>.json`. The default is `current`.
- `--compare <file>`: prints how the headline and every group moved since that run, then every pair that changed, worst first. A pair that went from synced to not synced, or the other way, is flagged.
- `--only <text>`: only the pairs whose file or subtitle name contains the text.
- `--brief`: leaves out the table of every pair.
- `--holdout <n>`: hides every nth line of the files' tracks from the sync and judges the served lines by those alone (see [held-out lines](#held-out-lines)).

The usual loop: run with `--label before` on the code as it is, make the change, then run with `--compare .replay/score-before.json`. The result file holds every pair and every group, with no times or dates, so two runs of the same code give the same file.

## What it does

**Pairs.** Each stored sync result names a played file and a cached subtitle. Every distinct pair whose file readings and subtitle are both kept is scored once. Two names for one file (with and without its size) and two releases whose index holds the same subtitle track give the same reading, byte for byte. When the subtitle and language are also the same, those pairs are merged, so they don't count twice. The merged names are listed under `sameAs`.

**Offline.** Each pair goes through the real `syncCaptions`, against a copy of the data in which nothing more can be read:

- Every reading counts as fully read: no extra windows are fetched, and a file with no subtitle track isn't heard at more spots.
- A file timed from its index whose audio was never heard counts as heard, with no speech. Live, the sync would read the audio as a last resort. Such a file gets `speechUnread`, and the table marks the pair "audio never heard" when it didn't sync.
- `fetch` is refused at once, and `ffmpeg`/`ffprobe` can't start. Anything that still tries is listed in the pair's `blocked` field, and a warning is printed.

The data folder itself is only read.

**Language.** The server syncs dub captions (English that follows an English dub) without a language, and translations with one. Only translations are timed line by line or by line starts, timed by where the file's lines start, moved onto their own line or snapped onto the file's lines. The score picks the language from the subtitle's text: Arabic, Dutch or English, else "Other". For ASS files only the dialogue counts. An English subtitle is taken as a dub caption when the activity list has an "English Dub" download for that file. When the list doesn't name the file, the downloads of other files with the same title decide, if they all agree. Otherwise it's a translation. Each pair's `langBy` says which rule decided.

## What the numbers mean

For each pair:

- **method**: how the sync ended.
  - `shift`: a shift per stretch.
  - `rate xN`: rescaled from another frame rate.
  - `lines`: timed line by line.
  - `starts`: a shift per stretch found by where lines start, not how they overlap.
  - `speech`: timed by speech in the audio after nothing fit the track.
  - `speech (no track)`: the file has no subtitle track.
  - `not synced`: served as it came.
  - `wrong file`: judged not to belong to the file.
- **served** and **uploaded**: the share of the subtitle's lines that start within 0.1 s, 0.3 s and 1 s of the nearest reference point. This is given for the served file and for the subtitle as it came. An unsynced pair is served as it came, so both are the same. **med** is the median gap of the served lines within 1 s.
- **reference**: what the lines are judged against.
  - Usually the starts of the file's own subtitle lines, from every text track that was read. For a file timed from its index that is the whole file. For a file read in windows, only lines inside those windows count.
  - For a file with no subtitle track, the reference is where speech starts, whatever the language. Only speech that follows a pause of at least 250 ms counts, and a line counts as on time when it starts its lead before the voice (start + lead is compared with the onset): 200 ms for a translation, and for a dub caption the lead the sync places that subtitle at (below).
- **speech** (dub captions only): the same shares against the voices, by the same speech rule at the subtitle's own lead, wherever speech was stored. Otherwise "no reference". Next to them, **signed**: the median of the same gaps with their sign, over the lines within 1 s, served and uploaded. Negative is early, positive late.
- **The leads** are the sync's own, taken from `src/sync.ts` rather than copied: `SPEECH_LEAD_MS` (200 ms) for translations, and `voiceLeadFor` for dub captions, 120 ms (`VOICE_LEAD_MS`), or 320 ms for a release's own captions as Anime Tosho keeps them (`at…` files, `OFFICIAL_CAPTIONS_LEAD_MS`). They were measured on the stored plays: dub caption uploads lead the English voices Silero hears by about 0.12 to 0.23 s, and English subtitle tracks lead English voices by 0.04 to 0.12 s. Translations lead by more, and by how much depends on who timed them (0.04 to 0.31 s per file), so theirs stays 200 ms. Each dub pair's lead is in its `speech.leadMs`. The shares only say how many lines land near that lead, so a lead that is wrong can still score well. The signed median says which way and by how much the lines sit from it: dub captions placed at a lead their voices don't keep show a median well away from 0. A run judged with other leads can't be compared with this one in those columns: the sync's dub captions, placed 120 ms ahead of their voices since sync version 14, score 34% within 0.1 s at 120 ms and 28% at the old 200 ms, the same within 0.3 s and 1 s.

For each group, the counts of pairs and synced pairs, and the shares two ways. The groups are: translation or dub; then by index or windows; then by method.

- **Line-weighted:** all lines together, so a film weighs more than an episode.
- **Pair-averaged:** each pair weighs the same.

**Score**: the headline. It is the line-weighted share of served lines within 0.3 s of the file's own, over translation pairs that synced. The share within 1 s is printed next to it. **As served** is the same over every translation pair, the unsynced ones as they came: what viewers actually get.

## Held-out lines

The score judges a translation by the same lines the sync times it by. A line snapped or moved onto one of the file's lines scores 0 ms whether it belongs there or not, and a shift fitted to the file's line starts is fitted to the very points it is judged by. `--holdout <n>` judges by lines the sync never saw:

- Every nth line of each file is taken out of the copy of its reading that the sync is given. The lines are counted in order over all of the file's text tracks at once, and starts on different tracks within 50 ms of each other count as one line, so a line is hidden from every track or from none.
- Each hidden line is then judged against the nearest start of the served subtitle: the shares within 0.1, 0.3 and 1 s are of hidden lines met, not of subtitle lines. The uploaded subtitle is judged the same way. The headline then reads `score, held out`: the share of hidden lines that a synced translation's line meets within 0.3 s.
- Files with no subtitle track have no lines to hide, so they aren't judged in this mode. The result file records `holdout`, and `--compare` warns when two runs held out differently.

Compare a held-out run only with a held-out run of the code before, with the same n. Hiding lines also changes what syncs: a file missing a fifth of its lines can fail to sync where it did, or sync by another method. So read the groups and the pairs both runs synced, not only the headline.

What it can show: timing that carries over to lines it wasn't fitted to, such as a shift per stretch. What it can't: a line is snapped or moved onto the file's line only when the sync sees that line, so per-line moves can't gain here. Held out, they can only lose, by moving a subtitle line whose own line is hidden onto a neighbour. Judge those by the [benchmark](benchmark.md), where every line's true place is known.

## Cross check: subtitles that aren't the file's

The score judges the pairs that were played, and those are nearly all a file with its own subtitles: lists are found by the title's id and episode. It can't show what the sync does with a subtitle that isn't the file's, which a misfiled upload or a source searched by name (Subtitle Cat) can bring. The cross check syncs every played file with every cached subtitle the data shows to be another's, and counts how many are served as synced. That number must be 0: no gain in the score is worth one.

```bash
npm run negatives                                         # every pair, in parallel; written to .replay/negatives-current.json
npm run negatives -- --label before                       # written to .replay/negatives-before.json
npm run negatives -- --compare .replay/negatives-before.json
npm run negatives -- --own                                # also the files' own pairs, which must stay synced
npm run negatives -- --sample 4 --jobs 4 --only <text>    # a quarter of the pairs, 4 processes, names holding <text>
```

- `--sample <n>`: only the pairs whose names hash to every nth, the same ones on every run.
- `--jobs <n>`: how many processes sync at once (default: one less than the machine's cores, at most 8). Each has its own copy of the data, as the score does.
- `--own`: adds every pair of a file with a subtitle of its own show and place. A change that refuses more of the others must keep these: `--compare` flags each one lost.
- `--compare`, `--only`, `--data` and `--label` work as for the score.

It runs the real `syncCaptions` the same way the score does (offline, nothing more read) and exits 1 when any pair that isn't the file's is served as synced. Each subtitle is synced as a translation in the language its text reads as: that tries every way a dub caption is timed, and timing line by line and by line starts as well.

**Which subtitles are another's.** Everything comes from the data (`scripts/cross-pairs.ts`), never from titles in the code:

- A cached subtitle's name is the place it was downloaded for: the request's season and episode, or a film. A `.missing` marker beside a name means its upload was found not to hold that episode, so what is kept under that name is another episode's, and the name says nothing. Copies with the same bytes are one subtitle; subtitles that are the same dialogue word for word (half the lines of the shorter one, of 30 or more) share their places, so one kept under the wrong episode's name isn't counted as another's.
- A played file was played as the places of the subtitles stored results served it. A file without a stored result is placed by the season and episode its name spells out, or not at all.
- A file and a subtitle are the same show when a stored result served the one for the other, two subtitles when they share an upload or their dialogue, two files when their names start with the same title words.

Each pair is then one of:

- `sibling`: the file's show, another episode;
- `other`: another title, either a show other files are, or a film's subtitle on an episode and the other way round;
- `elsewhere`: another episode, of a show no played file is (another episode of this show or another show's, surely not this file's).

A subtitle of an unknown show at the file's own place, or one with no place, isn't used. Files whose readings are the same byte for byte are synced once.

**What it prints.** The pairs and the synced ones per class and method, then every pair served as synced: the places on each side, the file's length, the subtitle's span and lines, the shift, the share of its lines that landed near the file's own, and what the sync logged. With `--compare`, each pair whose verdict changed, with the reason it is now refused.

**Run time.** The replay cache's 62 played files and 268 subtitles make 11,767 pairs. They take 3 to 4 minutes in 8 processes, the most `--jobs` starts on its own (0.1 to 0.2 s a pair, the longest about a second), and about 25 minutes in one; `--sample 10` takes a tenth of that. `--own` adds 248 pairs.

**Limits.** The classes are only as right as the data: a subtitle cached under the wrong episode whose words match no other subtitle is taken for that episode's, and then a correct sync of it would be counted against the check. Each pair served as synced is listed, to be looked at: one whose lines land on the file's own as a real subtitle's do is likely the file's own, filed wrongly. Chance fits are what the check finds, so it is only as wide as the subtitles kept. Before the whole-file test, 63 of the 11,767 were served as synced, all by a shift per stretch; since, none, and all 233 own pairs that synced still do, timed as before the test, which changes no timing (see [how it works](how-it-works.md#subtitles-that-dont-belong-to-the-file)).

## Limits

- **The reference is the file's own subtitles.** For a translation of that release this is the right target: the file's lines are timed to its picture and audio. A translation timed by someone else can still sit a beat off its counterpart, so a well-synced subtitle doesn't reach 100%.
- **Lines with no counterpart count as misses**, in served and uploaded alike: signs, songs, credits, lines split or merged differently. Compare served with uploaded, and with the last run, not with 100%.
- **Snapping inflates the 0.1 s share.** Snapping moves a translation's lines onto the file's line starts, the same points the score measures against, so a snapped line scores 0 ms by construction. Snapping only moves lines that are already within 0.3 s, which is why the headline uses 0.3 s.
- **Lines paired with the file's own score themselves.** On a file timed from its index, a line timed line by line (method `lines`), or moved onto its own line over a shift (counted as `shift`, see [how it works](how-it-works.md#lines-moved-onto-their-own-line)), starts exactly on one of the file's lines, from up to a few seconds away. A line paired with the wrong line of the file scores 0 ms too. The same goes, a little, for a shift per stretch fitted to the file's line starts. So a change to any of these needs the [held-out check](#held-out-lines) as well.
- **Chance alone scores.** In dense dialogue, a subtitle of another episode lands about a fifth of its lines within 0.3 s and about half within 1 s; the `wrong file` rows show it. A share within 1 s says little on its own.
- **Dub captions follow the dub's voices**, not the file's lines, which follow the original audio. The score judges them by stored speech where there is any, and few files have it. Speech onsets only exist after pauses: a line that starts in the middle of a stretch of speech can't meet one. So even perfect timing scores well under 100% against speech. Read those numbers against the uploaded ones.
- **Dub captions are timed by the voices where speech is stored** ([dub captions](how-it-works.md#dub-captions)), so against the file's own lines they can score lower than when they followed the track. Judge them by the speech columns. A file whose audio was never heard is timed by the track alone here: live, its English audio would be read after the first sync, and the next request would be timed by the voices.
- **Offline isn't live.**
  - No extra windows are read, and no audio is heard for the first time. A pair that would have fallen back to speech live may end unsynced here.
  - The summary line counts the pairs whose method differs from the server's own stored result at the current `SYNC_VERSION`.
- **The language rule is a guess**, from the text and a short activity list. Check `langBy` when a pair's group looks wrong.
- **The data is what was played**: many episodes of a few shows. A change tuned to these pairs can still be wrong elsewhere, so look at the pairs that changed, not only the headline.
- **The score doesn't decide whether "synced" was right.** A pair served as synced with a low share is the case to look at first: either the sync is off, or it should not have been served as synced. The [cross check](#cross-check-subtitles-that-arent-the-files) tries the pairs that surely aren't.
