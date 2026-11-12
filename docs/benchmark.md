# Sync benchmark

Made-up plays served through the live sync, with each served line scored against where it belongs in the file. It guards the two things the sync is for: closer timing with every change, and never serving as synced a subtitle that isn't.

## Running it

```bash
npm run bench                       # a table of every scenario
npm run bench -- --json out.json    # the results as JSON too, to compare two runs
npm run bench -- --only dub         # only scenarios whose name holds "dub"
npm run bench -- --log              # what the sync logged for each
npx vitest run test/benchmark.test.ts
```

`npm test` runs the benchmark as well, in about 4 seconds (`npm run bench` about the same). `npm run bench` exits 1 wherever the test would fail: a scenario below its floor, another episode's subtitle served as synced, a positive no longer synced, or a known gap that closed. It refuses an option it doesn't know, or `--json` and `--only` without a value.

The table's columns:

- **method**: how the served file was timed: `shift` (a shift per stretch of the file; a translation's then fitted by the file's line starts, and on a file timed from its index its lines moved onto their own where the pairing agrees), `rate` (rescaled for another frame rate, then shifted), `lines` (line by line), `starts` (a shift per stretch found by where lines start), `speech` (by speech heard in the audio), `unsynced` (left as it came), `wrong` (found not to belong to this file). A dub caption's `shift` is moved onto the English voices where they were heard.
- **synced**: whether it was served as synced.
- **<=0.1s, <=0.3s, <=1s**: the share of served lines that start within that distance of where they belong.
- **median**: the median distance.
- **floors**: the shares at 0.1 s and 0.3 s it must not fall below (see Floors).
- **note**: the sync's reason when it didn't sync, and "raise floor" when a share is more than 3 points above its floor.

## How a scenario is served

- `test/synthetic.ts` makes the file's dialogue and the subtitle. Each subtitle line knows where in the file it belongs, and that is what it is scored against, not the nearest line of the file's track. A line moved onto the wrong line of the file counts as wrong.
- `test/serve.ts` stores the file's readings in a cache folder of its own, as the sync keeps them, and calls `syncCaptions` with the subtitle, as a play would. Every fetch is refused, so nothing more of the file is read and nothing leaves the machine.
- A file read in windows keeps only its first pass. A live sync reads up to two more rounds where the timing steps or a window found nothing. The scores for these files are what a download gets before those rounds finish, or when the file's host refuses them.
- A file with no subtitle track keeps its first five windows too: the five more spots a live sync hears when those don't say clearly are refused. The `-more` scenarios are the same plays as the next request finds them, once those spots have been heard: ten windows.
- A file timed from its index has had its audio heard already, as the sync does when no track fits or after dub captions synced to it, so speech is there as the last resort and for refining dub captions. The exception is `dub-voices-unheard-index`, a first sync before the audio is heard. The background read it starts is refused, like every other read.
- Everything is seeded, so every run gives the same results.

### The dialogue

The played episode is 24 minutes long with about 330 lines. Lines last 0.8 to 4 s with pauses of 0.15 to 6 s, and now and then a scene change of 8 to 20 s with nobody talking. It has a cold open of a minute or two, a 90 s opening song, two ad breaks, and credits with an ending song. The film is 95 minutes long, with no songs or breaks. The drama's episode is 43 minutes long with a cold open, a short title and four ad breaks.

A file is read one of three ways:

- **index**: a Matroska file timed from its index, so every line is known.
- **windows**: five 40 s windows at 15, 32, 50, 68 and 85% of the runtime.
- **speech**: no subtitle track, so only speech heard in the audio of those five windows (ten in the `-more` scenarios: also at 10, 24, 41, 59 and 76%).

Translations carry a language, so line-by-line timing, timing by line starts, the shift fitted by where the file's lines start, moving lines onto their own and snapping apply. Dub captions don't, as live: they follow the dub, not the file's track, and are moved onto the voices instead.

Speech is modelled simply: a voice starts 0.08 to 0.4 s after its line shows, one line in twenty is drowned out by music, and there is a noise now and then. For dub captions, the speech heard is the dub's. Some files with no subtitle track are harder: scored wall to wall, so only a third of the voices are heard (`drowned`), or with songs filling two of the five windows, where the detector hears only a few bursts of music (`musicAt`).

Dub captions come in two models:

- **As the original.** `dub-index`, `dub-windows`, `dub-steps-index`, `dub-steps-windows`, `recap-dub-index`, `dub-speech` and `sibling-dub-windows`: the dub's lines are its own, but each stretch of talk starts where the original's does, give or take 0.3 s, and its voices start 0 to 0.24 s after each line (`DUB_VOICE_AFTER_MS`: dub caption uploads lead the English voices by about 0.12 to 0.23 s on the stored plays, English subtitle tracks lead English voices by 0.04 to 0.12 s). Timed by the track, these land where they belong.
- **As an upload follows the dub.** The `dub-voices-` scenarios and `sibling-dub-index`: the English voices speak each stretch of the original's talk starting 0.2 s later than the original voice does, or earlier, give or take 0.25 s. The sentences, the pauses between them and the captions are the dub's own. Each caption starts 0.02 to 0.26 s before its voice and runs nearly into the next. A long sentence is sometimes split over two captions. The upload is right by the voices, and the detector hears each voice up to 60 ms late. Timed by the track alone, these land 0.14 to 0.28 s off, close to the 0.12 to 0.28 s seen live.

## Scenarios

**One shift**

| Scenario | What it stands for |
|---|---|
| `shift-index` | A subtitle from another release of the same cut: every line 2.3 s late. |
| `jitter-index` | A translation timed by someone else: each line a beat off its line (mostly under 0.4 s, now and then up to 0.8 s), some lines merged with the next or split in two, 1.4 s late overall. |
| `jitter-windows` | The same kind of translation on a file read in windows. |
| `wobble-windows` | A loosely timed translation (lines up to 0.8 s off, more of them merged and split) on a file read in windows. Its windows read a few hundred ms apart. |

**Steps and creep**

| Scenario | What it stands for |
|---|---|
| `steps-index` | A release cut differently at its opening and at two ad breaks (a recap, a bumper, a longer break): the shift steps three times, the cold open on a shift of its own. |
| `steps-windows` | A release cut differently at two ad breaks, on a file read in windows. Only one window falls in the middle stretch. |
| `creep-index` | A subtitle that runs a touch slow between its cuts: it falls behind by 0.5 s a minute and is back on time at each cut. |
| `jitter-steps-index` | A translation timed by someone else, for a release cut differently at its ad breaks. |
| `recap-index` | A release that opens with a 45 s recap the subtitle's release doesn't have: every line 45 s early, more than a window is searched over. |
| `recap-jitter-index` | A loosely timed translation (lines up to 0.8 s off, more merged and split) for a release without that recap. |
| `recap-windows` | A translation timed by someone else for a release without the recap, on a file read in windows: no line-by-line timing there, so only a search around the shift far off times it. |
| `runon-steps-index` | A drama's official translation whose lines stay on screen until the next one and merge short ones, so they cover the file's dialogue about as well at any shift. The release is cut differently at every break: +1.5 s rising to +15.8 s in five steps. |

**Frame rates**

| Scenario | What it stands for |
|---|---|
| `rate25-index` | A subtitle made for a 25 fps release (European TV or DVD) on a 23.976 fps web release: 4.3% fast. |
| `rate24-windows` | A subtitle made for a 24.000 fps release on a 23.976 fps file read in windows: 1.4 s of drift over the episode. |
| `rate24-film-index` | The same on a film: 5.7 s of drift by the end. |
| `rate25-steps-index` | A 25 fps subtitle for a release that is also cut differently. |

**Dub captions**

| Scenario | What it stands for |
|---|---|
| `dub-index` | English dub captions from another release. The dub plays the same scenes, but its lines are its own: split differently, of other lengths, each stretch of talk starting a little off the original's. |
| `dub-windows` | The same on a file read in windows. |
| `dub-steps-index` | Dub captions from a release cut differently at its ad breaks. |
| `dub-steps-windows` | The same at one break, on a file read in windows. |
| `dub-voices-index` | Dub captions 1.6 s late, right by the dub's voices, which start 0.2 s after the original's. The file's English audio has been heard. |
| `dub-voices-early-index` | The same with voices that start 0.2 s before the original's. |
| `dub-voices-steps-index` | The same kind of dub captions from a release cut differently at its two ad breaks. |
| `dub-voices-windows` | The same kind on a file read in windows, its audio heard in the same reads. |
| `dub-voices-unheard-index` | The play of `dub-voices-index` before the file's English audio has been heard: its first sync, by the track alone. |
| `recap-dub-index` | Dub captions for a release without the 45 s recap this file opens with. |
| `recap-dub-windows` | The same on a file read in windows. |
| `dub-speech` | Dub captions on a file with no subtitle track, timed by the dub's speech. |

**Timed by hand to another recording**

| Scenario | What it stands for |
|---|---|
| `wander-film-index` | A film's subtitle timed by hand to another recording, such as a cinema one: the shift each line needs wanders smoothly between -3 and +9 s through the film. |
| `wander-film-windows` | The same subtitle on a file read in windows, which has no index. |
| `wander-small-index` | A subtitle timed by hand to a close recording: the shift wanders only between -0.9 and +1.3 s. |

**Lines on one side only, and which track**

| Scenario | What it stands for |
|---|---|
| `extras-index` | A translation that also subtitles the songs' lyrics and a dozen signs, none of them on the file's track. |
| `missing-index` | A subtitle missing 15% of the file's lines, on a track that is itself missing 10% of the subtitle's. |
| `signs-first-index` | A file whose first subtitle track holds only signs and songs. Its full dialogue is the second track. |
| `speech-only` | A translation on a file with no subtitle track, timed by the speech in its audio. |

**Files with no subtitle track, harder to hear**

| Scenario | What it stands for |
|---|---|
| `speech-sparse` | A translation on a file with no subtitle track, scored wall to wall, so only a third of its voices are heard: its first five windows. A known gap: they hold too few voices to time it. |
| `speech-sparse-more` | The same play once five more spots of its audio are heard, as the next request finds it. |
| `speech-music` | A translation on a file with no subtitle track where songs fill two of the five windows. |
| `speech-music-more` | The same once five more spots are heard. |
| `speech-steps` | A translation for a release cut differently at its first break (+0.8 s, then +3.4 s), on a file with no subtitle track. A known gap: two windows on one side show the step, too few to place it, so it isn't timed by one shift. |
| `speech-steps-more` | The same once five more spots are heard: each side timed by its own windows. |

**Not this file's: never served as synced**

| Scenario | What it stands for |
|---|---|
| `other-index` | Another show's episode. |
| `other-aligned-index` | Another show's episode, moved to start where this one's dialogue starts. |
| `sibling-index` | Another episode of the same show, with the same runtime, opening and breaks and similar pacing. |
| `sibling-songs-index` | The same, and both the file's track and the subtitle carry the same opening and ending lyrics at the same places. |
| `sibling-windows` | Another episode of the same show, on a file read in windows. |
| `sibling-dub-windows` | Dub captions of another episode of the same show, on a file read in windows with the dub heard. |
| `sibling-dub-index` | Dub captions of another episode of the same show, on an index file with the English audio heard. |
| `sibling-speech` | Another episode of the same show, on a file with no subtitle track. |
| `sibling-speech-more` | The same, with ten windows of the file's audio heard. |
| `sibling-speech-sparse` | The same, where only a third of the voices are heard. |
| `sibling-speech-sparse-more` | The same with ten windows heard. |
| `sibling-speech-steps-more` | Another episode of the same show, stepping at the first break as `speech-steps` does, with ten windows heard. |

**Not this file's, where a search past ±20 s or by line starts could be fooled: never served as synced**

| Scenario | What it stands for |
|---|---|
| `sibling-far-index` | Another episode of the same show, 45 s late: past the usual search, where only the wider one looks. |
| `sibling-far-windows` | Another episode of the same show, 45 s early, on a file read in windows. |
| `runon-sibling-index` | Another episode of the drama, its official translation's lines running on and stepping at the breaks like `runon-steps-index`'s. |
| `longer-cut-index` | The same episode's subtitle of a much longer cut: scenes of 70, 80 and 90 s the file doesn't have, after the opening and at both breaks. The line starts single out 70 s, which holds for only a third of the file. |
| `longer-cut-early-index` | A longer cut with one 70 s scene more, after the cold open: everything but the cold open sits 70 s off, and the cold open's lines would go before the file starts. |
| `recap-heavy-index` | A file that opens with a six-minute recap of the previous episode, after a 30 s title card, and the previous episode's subtitle: it meets the recap at one shift, 30 s off, and nothing after it. |

**Not this file's, met in one stretch of it only: never served as synced**

A subtitle with a third to half as many lines a minute as the file's track overlaps few of the file's windows well enough to be measured, and the tests of measured windows judge nothing below three. Each of these was served as synced before every timing had to account for the whole file ([how it works](how-it-works.md#subtitles-that-dont-belong-to-the-file)); they stand for what the [cross check](scoring.md#cross-check-subtitles-that-arent-the-files) found on the stored plays.

| Scenario | What it stands for |
|---|---|
| `film-on-episode-index` | A film's subtitle, half as dense as the episode's track, on an episode: 95 minutes of lines on a 24-minute file. |
| `episode-on-film-index` | Another show's 23-minute episode, half as dense, on a film: its lines cover a quarter of the file. |
| `half-other-index` | Another show's 20-minute episode, half as dense, on a 43-minute drama's: it meets the first half of the file only. |
| `longer-other-index` | A 43-minute drama's episode subtitle, a third as dense, on a 24-minute episode: most of its lines would fall past the file's end. |
| `trailer-index` | Another title's first two and a half minutes (a trailer's subtitle, 30 lines or so) on an episode. |
| `extended-cut-film-index` | A translation of the film's extended cut that folds half the lines together, with three 10-minute scenes the file doesn't have after its 47th minute: the first half sits where it is written, the rest 10 to 30 minutes late. |

## Floors

Each scenario that belongs to the file has two floors in `test/scenarios.ts`. One is the share of lines within 0.3 s of where they belong, the other the share within 0.1 s. Each is set at the share measured when it was set, less 2 points, rounded down. The 0.3 s floor guards the timing. The 0.1 s floor guards the steps that put single lines in place: snapping and moving lines onto their own line for translations, the move onto the voices for dub captions.

- A change that brings a share below its floor fails `npm test`.
- A change that raises a share passes, and `npm run bench` says "raise floor". Raise the floor in the same change, to the new share less 2 points, so the gain can't be lost unnoticed later.
- Never lower a floor without saying why in that change. A trade is a reason: one scenario losing a little so others gain a lot. Give the numbers.
- A scenario that belongs to the file but isn't served synced today is a known gap. Its `gap` says why, and the test expects it unsynced. The test fails once it is served synced: then set `synced: true` and raise its floors.
- A subtitle that isn't this file's must never be served as synced. It has no floor, and no change is worth one being served.

## Adding a scenario

Add it to `test/scenarios.ts` with a short name, a sentence on what it stands for, the file kind and language, and a `build` made from the pieces in `test/synthetic.ts`. Use new seeds, so as not to repeat another scenario. Run `npm run bench -- --only <name>` and set its floors from the shares it prints. Describe it in the table above.

## What it doesn't show

The scenarios are made up: they show what a change does to each kind of case, not how often each kind comes up. The replay check (`npm run replay`) runs a change over real past plays, and the two are best run together.

Unlike the [sync score](scoring.md), the benchmark knows where every line belongs, so a line moved onto the wrong line of the file counts as wrong here. That makes it the check for steps that move single lines onto the file's own, which the score, judging by those same lines, can't vouch for (see [held-out lines](scoring.md#held-out-lines)).
