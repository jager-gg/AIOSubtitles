/**
 * The sync benchmark's scenarios: each a way a subtitle comes to a played file, built from
 * synthetic.ts, with what today's code does with it. docs/benchmark.md says what each stands for and
 * how the floors move: raise a floor in the change that improves it; never lower one without saying
 * why in that change.
 */
import type { Scenario } from "./serve.js";
import {
  FILM,
  creeping,
  dialogue,
  dubCaptions,
  DUB_VOICE_AFTER_MS,
  drowned,
  dubbed,
  episode,
  extendedCut,
  faithful,
  handTimed,
  heard,
  heardVoices,
  indexFile,
  madeForRate,
  musicAt,
  retimedByOthers,
  runOn,
  shifted,
  signsTrack,
  songLyrics,
  speechOnlyFile,
  stepped,
  unrelated,
  windowFile,
  withExtras,
  without,
  type SubLine
} from "./synthetic.js";

/** The episode being played: 24 minutes, a cold open, an opening song, two ad breaks. */
const played = () => episode(101);
/** A film being played: 95 minutes, no opening song, no breaks. */
const film = () => episode(404, { minutes: 95, opening: false, breaks: 0 });
/** Another episode of another show. */
const elsewhere = () => episode(202, { minutes: 23 });
/** Another episode of the same show: the same runtime, opening and breaks, other dialogue. */
const sibling = () => episode(303, { like: played() });

/** Dub captions' lines where the dub speaks them (where they belong), to hear the dub's speech by. */
const spoken = (sub: SubLine[]) => sub.map((l) => ({ start: l.truth, end: l.truth + (l.end - l.start) }));

/**
 * The played episode with a 45 s recap before it (other dialogue), and its subtitle made for the
 * release without one: each line belongs 45 s later than it's written. Past the ±20 s a window is
 * searched over.
 */
function withRecap(dub = false, { windows = false, own }: { windows?: boolean; own?: (ep: ReturnType<typeof played>) => SubLine[] } = {}): ReturnType<Scenario["build"]> {
  const ep = played();
  const recap = 45000;
  const lines = [...dialogue(78, 2000, recap - 2000), ...ep.lines.map((c) => ({ start: c.start + recap, end: c.end + recap }))];
  const written = own ? own(ep) : dub ? dubCaptions(ep, 79) : faithful(ep.lines);
  const subtitle = written.map((l) => ({ ...l, truth: l.truth + recap }));
  const voice = dub ? heard([...dialogue(78, 2000, recap - 2000), ...spoken(subtitle)], 80, DUB_VOICE_AFTER_MS) : heard(lines, 80);
  return { record: windows ? windowFile(ep.duration + recap, lines, voice) : indexFile(ep.duration + recap, [lines], voice), subtitle };
}

/** An hour-long drama's episode: 43 minutes, a cold open and a short title, four ad breaks. */
const drama = () => episode(505, { minutes: 43, breaks: 4 });
/** Another episode of the same drama. */
const dramaSibling = () => episode(606, { like: drama() });

/**
 * The played episode opening with a recap of the previous episode: its first six minutes again,
 * after a 30 s title card, then the episode itself. The subtitle is the previous episode's, which
 * meets the recap at one shift and nothing after it.
 */
function recapHeavy(): ReturnType<Scenario["build"]> {
  const ep = played();
  const before = sibling();
  const card = 30000;
  const recap = 360000;
  const replayed = before.lines.filter((c) => c.end <= recap).map((c) => ({ start: c.start + card, end: c.end + card }));
  const lead = card + recap;
  const lines = [...replayed, ...ep.lines.map((c) => ({ start: c.start + lead, end: c.end + lead }))];
  return { record: indexFile(ep.duration + lead, [lines], heard(lines, 131)), subtitle: unrelated(before.lines) };
}

/** Another episode's subtitle: never served as synced, so there is no share to keep. */
const negative = { synced: false, floor: { "0.3": 0, "0.1": 0 } };

/** A film whose scenes change five times with a few seconds of silence: where an extended cut adds scenes. */
const scenesFilm = () => episode(707, { minutes: 95, opening: false, breaks: 5 });

export const SCENARIOS: Scenario[] = [
  // ---------- one shift ----------
  {
    name: "shift-index",
    about: "a subtitle from another release of the same cut, every line 2.3 s late",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 1)), subtitle: shifted(faithful(ep.lines), 2300) };
    }
  },
  {
    name: "jitter-index",
    about: "a translation timed by someone else: each line a beat off, some merged or split, 1.4 s late",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.97, "0.1": 0.96 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 2)), subtitle: shifted(retimedByOthers(faithful(ep.lines), 11), 1400) };
    }
  },
  {
    name: "jitter-windows",
    about: "the same kind of translation on a file read in windows, 0.8 s early",
    file: "windows",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.94, "0.1": 0.52 } },
    build: () => {
      const ep = played();
      return { record: windowFile(ep.duration, ep.lines, heard(ep.lines, 3)), subtitle: shifted(retimedByOthers(faithful(ep.lines), 81), -800) };
    }
  },
  {
    name: "wobble-windows",
    about: "a loosely timed translation (lines up to 0.8 s off, more merged and split) on a file read in windows, 1.9 s late",
    file: "windows",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.63, "0.1": 0.31 } },
    build: () => {
      const ep = played();
      return { record: windowFile(ep.duration, ep.lines, heard(ep.lines, 14)), subtitle: shifted(retimedByOthers(faithful(ep.lines), 15, { jitter: 800, merge: 0.12, split: 0.12 }), 1900) };
    }
  },
  // ---------- steps ----------
  {
    name: "steps-index",
    about: "a release cut differently at its opening and two ad breaks: +0.6, +3.1, -1.2, +2.0 s",
    file: "index",
    lang: "Dutch",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 4)), subtitle: stepped(faithful(ep.lines), [ep.cuts[0], ep.cuts[2], ep.cuts[3]], [600, 3100, -1200, 2000]) };
    }
  },
  {
    name: "steps-windows",
    about: "a release cut differently at its two ad breaks, on a file read in windows: -0.9, +1.6, +4.2 s",
    file: "windows",
    lang: "Dutch",
    today: { synced: true, floor: { "0.3": 0.68, "0.1": 0.68 } },
    build: () => {
      const ep = played();
      return { record: windowFile(ep.duration, ep.lines, heard(ep.lines, 5)), subtitle: stepped(faithful(ep.lines), [ep.cuts[2], ep.cuts[3]], [-900, 1600, 4200]) };
    }
  },
  {
    name: "creep-index",
    about: "a subtitle running a touch slow between its cuts: +0.5 s a minute, back at each cut",
    file: "index",
    lang: "Dutch",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 6)), subtitle: creeping(faithful(ep.lines), [ep.cuts[0], ep.cuts[2], ep.cuts[3]], [-1200, 800, 2400, -400], 500) };
    }
  },
  {
    name: "jitter-steps-index",
    about: "a translation timed by someone else, for a release cut differently: +2.4, -0.7, +1.9 s at the ad breaks",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.97, "0.1": 0.96 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 12)), subtitle: stepped(retimedByOthers(faithful(ep.lines), 13), [ep.cuts[2], ep.cuts[3]], [2400, -700, 1900]) };
    }
  },
  {
    name: "recap-index",
    about: "a release that opens with a 45 s recap the subtitle's release doesn't have: every line 45 s early",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => withRecap()
  },
  {
    name: "recap-jitter-index",
    about: "a loosely timed translation for a release without the 45 s recap this file opens with",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.87, "0.1": 0.87 } },
    build: () => withRecap(false, { own: (ep) => retimedByOthers(faithful(ep.lines), 84, { jitter: 800, merge: 0.12, split: 0.12 }) })
  },
  {
    name: "recap-windows",
    about: "a translation timed by someone else for a release without the 45 s recap, on a file read in windows",
    file: "windows",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.92, "0.1": 0.53 } },
    build: () => withRecap(false, { windows: true, own: (ep) => retimedByOthers(faithful(ep.lines), 85) })
  },
  {
    name: "runon-steps-index",
    about: "an official translation whose lines run on and merge, for a release cut differently at every break: +1.5 s rising to +15.8 s",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = drama();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 121)), subtitle: stepped(runOn(faithful(ep.lines), 122, { merge: 0.6, hold: 6000 }), ep.cuts.slice(1), [1500, 4600, 7400, 10300, 13100, 15800]) };
    }
  },
  // ---------- frame rates ----------
  {
    name: "rate25-index",
    about: "a subtitle made for a 25 fps (European TV or DVD) release, on a 23.976 fps file, 0.6 s late",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 7)), subtitle: madeForRate(faithful(ep.lines), 25 / FILM, 600) };
    }
  },
  {
    name: "rate24-windows",
    about: "a subtitle made for a 24.000 fps release, on a 23.976 fps file read in windows: 1.4 s of drift",
    file: "windows",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      return { record: windowFile(ep.duration, ep.lines, heard(ep.lines, 8)), subtitle: madeForRate(faithful(ep.lines), 24 / FILM, -300) };
    }
  },
  {
    name: "rate24-film-index",
    about: "a film's subtitle made for 24.000 fps on a 23.976 fps file: 5.7 s of drift by the end",
    file: "index",
    lang: "Dutch",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const f = film();
      return { record: indexFile(f.duration, [f.lines], heard(f.lines, 9)), subtitle: madeForRate(faithful(f.lines), 24 / FILM, 1200) };
    }
  },
  {
    name: "rate25-steps-index",
    about: "a 25 fps subtitle for a release that is also cut differently: 4.3% fast, then +0.4, +2.9 s at the ad breaks",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 10)), subtitle: madeForRate(stepped(faithful(ep.lines), [ep.cuts[2], ep.cuts[3]], [0, 400, 2900]), 25 / FILM) };
    }
  },
  // ---------- dub captions (no language set: no snapping, no line-by-line) ----------
  {
    name: "dub-index",
    about: "English dub captions from another release, 1.8 s late: same scenes, lines of their own",
    file: "index",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubCaptions(ep, 21);
      return { record: indexFile(ep.duration, [ep.lines], heard(spoken(dub), 22, DUB_VOICE_AFTER_MS)), subtitle: shifted(dub, 1800) };
    }
  },
  {
    name: "dub-windows",
    about: "English dub captions on a file read in windows, 2.6 s early",
    file: "windows",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubCaptions(ep, 31);
      return { record: windowFile(ep.duration, ep.lines, heard(spoken(dub), 32, DUB_VOICE_AFTER_MS)), subtitle: shifted(dub, -2600) };
    }
  },
  {
    name: "dub-steps-index",
    about: "English dub captions from a release cut differently at its two ad breaks: +1.0, +3.5, +6.1 s",
    file: "index",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubCaptions(ep, 41);
      return { record: indexFile(ep.duration, [ep.lines], heard(spoken(dub), 42, DUB_VOICE_AFTER_MS)), subtitle: stepped(dub, [ep.cuts[2], ep.cuts[3]], [1000, 3500, 6100]) };
    }
  },
  {
    name: "dub-steps-windows",
    about: "English dub captions from a release cut differently, on a file read in windows: -1.5, +2.0 s at the second break",
    file: "windows",
    today: { synced: true, floor: { "0.3": 0.95, "0.1": 0.95 } },
    build: () => {
      const ep = played();
      const dub = dubCaptions(ep, 45);
      return { record: windowFile(ep.duration, ep.lines, heard(spoken(dub), 46, DUB_VOICE_AFTER_MS)), subtitle: stepped(dub, [ep.cuts[3]], [-1500, 2000]) };
    }
  },
  {
    name: "dub-voices-index",
    about: "dub captions right by the dub's voices, which start 0.2 s after the original's: 1.6 s late, the English audio heard",
    file: "index",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubbed(ep, 121, { lag: 440 });
      return { record: indexFile(ep.duration, [ep.lines], heardVoices(dub.voices, 122)), subtitle: shifted(dub.captions, 1600) };
    }
  },
  {
    name: "dub-voices-early-index",
    about: "dub captions whose voices start 0.2 s before the original's: 0.9 s early, the English audio heard",
    file: "index",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubbed(ep, 123, { lag: 40 });
      return { record: indexFile(ep.duration, [ep.lines], heardVoices(dub.voices, 124)), subtitle: shifted(dub.captions, -900) };
    }
  },
  {
    name: "dub-voices-steps-index",
    about: "the same kind of dub captions from a release cut differently at its two ad breaks: +0.8, +3.3, -1.4 s",
    file: "index",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubbed(ep, 125, { lag: 440 });
      return { record: indexFile(ep.duration, [ep.lines], heardVoices(dub.voices, 126)), subtitle: stepped(dub.captions, [ep.cuts[2], ep.cuts[3]], [800, 3300, -1400]) };
    }
  },
  {
    name: "dub-voices-windows",
    about: "dub captions whose voices start 0.2 s after the original's, on a file read in windows: 2.2 s early",
    file: "windows",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubbed(ep, 127, { lag: 440 });
      return { record: windowFile(ep.duration, ep.lines, heardVoices(dub.voices, 128)), subtitle: shifted(dub.captions, -2200) };
    }
  },
  {
    name: "dub-voices-unheard-index",
    about: "the play of dub-voices-index before the file's English audio has been heard: its first sync",
    file: "index",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0 } },
    build: () => {
      const ep = played();
      // The same dub and upload as dub-voices-index. The audio is there to hear, but hasn't been yet:
      // the sync reads it in the background after this first sync (refused here, as every read is).
      const dub = dubbed(ep, 121, { lag: 440 });
      return { record: { ...indexFile(ep.duration, [ep.lines]), audio: 1 }, subtitle: shifted(dub.captions, 1600) };
    }
  },
  {
    name: "recap-dub-index",
    about: "English dub captions for a release without the 45 s recap this file opens with",
    file: "index",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => withRecap(true)
  },
  {
    name: "recap-dub-windows",
    about: "English dub captions for a release without the 45 s recap, on a file read in windows",
    file: "windows",
    today: {
      synced: false,
      floor: { "0.3": 0, "0.1": 0 },
      // A known gap: when this is served synced, set synced: true and raise the floor.
      gap: "Dub captions 45 s off on a file read in windows: five windows hold 59 lines, and dub lines start where the file's do only where a stretch of talk starts, so the line starts single out no shift (wideFit margin 0.02, under FAR_MIN_MARGIN) and the search isn't moved."
    },
    build: () => withRecap(true, { windows: true })
  },
  {
    name: "dub-speech",
    about: "English dub captions on a file with no subtitle track, timed by the dub's speech, 1.3 s early",
    file: "speech",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const dub = dubCaptions(ep, 43);
      return { record: speechOnlyFile(ep.duration, heard(spoken(dub), 44, DUB_VOICE_AFTER_MS)), subtitle: shifted(dub, -1300) };
    }
  },
  // ---------- timed by hand to another recording ----------
  {
    name: "wander-film-index",
    about: "a film's subtitle timed by hand to another recording: the shift wanders between -3 and +9 s",
    file: "index",
    lang: "Dutch",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const f = film();
      return { record: indexFile(f.duration, [f.lines], heard(f.lines, 51)), subtitle: handTimed(faithful(f.lines), 52) };
    }
  },
  {
    name: "wander-film-windows",
    about: "the same hand-timed film subtitle on a file read in windows (no index)",
    file: "windows",
    lang: "Dutch",
    today: {
      synced: false,
      floor: { "0.3": 0.03, "0.1": 0 },
      // A known gap: when this is served synced, set synced: true and raise the floor.
      gap: "Line by line (byLines) needs every line of the file, so only index files get it; five 40 s windows of a shift wandering over 12 s fit no shift per stretch."
    },
    build: () => {
      const f = film();
      return { record: windowFile(f.duration, f.lines, heard(f.lines, 53)), subtitle: handTimed(faithful(f.lines), 52) };
    }
  },
  {
    name: "wander-small-index",
    about: "a subtitle timed by hand to a close recording: the shift wanders between -0.9 and +1.3 s",
    file: "index",
    lang: "Dutch",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 54)), subtitle: handTimed(faithful(ep.lines), 55, { low: -900, high: 1300 }) };
    }
  },
  // ---------- lines on one side only ----------
  {
    name: "extras-index",
    about: "a translation that also subtitles the opening song and signs the file's track leaves out, 1.7 s early",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.97 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 61)), subtitle: shifted(withExtras(retimedByOthers(faithful(ep.lines), 62, { jitter: 250 }), ep, 63), -1700) };
    }
  },
  {
    name: "missing-index",
    about: "a subtitle missing 15% of the file's lines, on a track missing 10% of the subtitle's, 1.1 s late",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.98 } },
    build: () => {
      const ep = played();
      const track = ep.lines.filter((_, i) => (i * 7919) % 10 !== 3);
      return { record: indexFile(ep.duration, [track], heard(ep.lines, 71)), subtitle: shifted(without(faithful(ep.lines), 72, 0.15), 1100) };
    }
  },
  // ---------- which track, and no track ----------
  {
    name: "signs-first-index",
    about: "a file whose first subtitle track is signs and songs, its full dialogue the second, 1.1 s late",
    file: "index",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.97 } },
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [signsTrack(ep.duration, 91), ep.lines], heard(ep.lines, 92)), subtitle: shifted(retimedByOthers(faithful(ep.lines), 93, { jitter: 250 }), 1100) };
    }
  },
  {
    name: "speech-only",
    about: "a translation on a file with no subtitle track, timed by the speech in its audio, 2.1 s late",
    file: "speech",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.96, "0.1": 0.57 } },
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, heard(ep.lines, 95)), subtitle: shifted(retimedByOthers(faithful(ep.lines), 96, { jitter: 250 }), 2100) };
    }
  },
  {
    name: "speech-sparse",
    about: "a translation on a file with no subtitle track, scored wall to wall, so only a third of its voices are heard: 1.4 s late, its first five windows",
    file: "speech",
    lang: "Arabic",
    today: {
      synced: false,
      floor: { "0.3": 0, "0.1": 0 },
      // A known gap on the first pass: the next request is speech-sparse-more.
      gap: "Five windows hear too few voices to time it (speech unclear). The sync then hears five more spots of the audio in the background, and the next request is timed by ten windows: speech-sparse-more."
    },
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, drowned(heard(ep.lines, 151), 152, 0.33)), subtitle: shifted(retimedByOthers(faithful(ep.lines), 153, { jitter: 250 }), 1400) };
    }
  },
  {
    name: "speech-sparse-more",
    about: "the play of speech-sparse once five more spots of the file's audio are heard",
    file: "speech",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.98, "0.1": 0.67 } },
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, drowned(heard(ep.lines, 151), 152, 0.33), { more: true }), subtitle: shifted(retimedByOthers(faithful(ep.lines), 153, { jitter: 250 }), 1400) };
    }
  },
  {
    name: "speech-music",
    about: "a translation on a file with no subtitle track where songs fill two of its five windows: 0.9 s early",
    file: "speech",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.95, "0.1": 0.39 } },
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, musicAt(heard(ep.lines, 154), ep.duration, [0.32, 0.68], 155)), subtitle: shifted(retimedByOthers(faithful(ep.lines), 156, { jitter: 250 }), -900) };
    }
  },
  {
    name: "speech-music-more",
    about: "the play of speech-music once five more spots of the file's audio are heard",
    file: "speech",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.97, "0.1": 0.59 } },
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, musicAt(heard(ep.lines, 154), ep.duration, [0.32, 0.68], 155), { more: true }), subtitle: shifted(retimedByOthers(faithful(ep.lines), 156, { jitter: 250 }), -900) };
    }
  },
  {
    name: "speech-steps",
    about: "a translation for a release cut differently at the first break, on a file with no subtitle track: +0.8 s, then +3.4 s",
    file: "speech",
    lang: "Arabic",
    today: {
      synced: false,
      floor: { "0.3": 0, "0.1": 0 },
      // A known gap on the first pass: the next request is speech-steps-more.
      gap: "Five windows show the step (two on one side, three on the other) but too few to place it: the one shift three of them agree on would leave the other side's lines 2.6 s off, so it isn't timed. The sync hears five more spots, and the next request is timed per stretch: speech-steps-more."
    },
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, heard(ep.lines, 157)), subtitle: stepped(retimedByOthers(faithful(ep.lines), 158, { jitter: 250 }), [ep.cuts[2]], [800, 3400]) };
    }
  },
  {
    name: "speech-steps-more",
    about: "the play of speech-steps once five more spots of the file's audio are heard",
    file: "speech",
    lang: "Arabic",
    today: { synced: true, floor: { "0.3": 0.97, "0.1": 0.63 } },
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, heard(ep.lines, 157), { more: true }), subtitle: stepped(retimedByOthers(faithful(ep.lines), 158, { jitter: 250 }), [ep.cuts[2]], [800, 3400]) };
    }
  },
  // ---------- not this file's: never served as synced ----------
  {
    name: "other-index",
    about: "another show's episode, on an index file",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 101)), subtitle: unrelated(elsewhere().lines) };
    }
  },
  {
    name: "other-aligned-index",
    about: "another show's episode, moved to start where this one's dialogue starts",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      const other = elsewhere().lines;
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 102)), subtitle: shifted(unrelated(other), ep.lines[0].start - other[0].start) };
    }
  },
  {
    name: "sibling-index",
    about: "another episode of the same show (same runtime, opening and breaks), 1.0 s late",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 103)), subtitle: shifted(unrelated(sibling().lines), 1000) };
    }
  },
  {
    name: "sibling-songs-index",
    about: "another episode of the same show whose opening and ending lyrics sit exactly where this file's do",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      // The same songs at the same places, on the file's track and in the subtitle.
      const songs = songLyrics(ep, 777);
      const track = [...ep.lines, ...songs].sort((a, b) => a.start - b.start);
      return { record: indexFile(ep.duration, [track], heard(ep.lines, 109)), subtitle: [...unrelated(sibling().lines), ...faithful(songs)] };
    }
  },
  {
    name: "sibling-windows",
    about: "another episode of the same show, on a file read in windows",
    file: "windows",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: windowFile(ep.duration, ep.lines, heard(ep.lines, 104)), subtitle: unrelated(sibling().lines) };
    }
  },
  {
    name: "sibling-dub-windows",
    about: "dub captions of another episode of the same show, on a file read in windows with the dub heard",
    file: "windows",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      const dub = dubCaptions(ep, 105);
      return { record: windowFile(ep.duration, ep.lines, heard(spoken(dub), 106, DUB_VOICE_AFTER_MS)), subtitle: unrelated(dubCaptions(sibling(), 107)) };
    }
  },
  {
    name: "sibling-dub-index",
    about: "dub captions of another episode of the same show, on an index file with the English audio heard",
    file: "index",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      const dub = dubbed(ep, 131, { lag: 440 });
      return { record: indexFile(ep.duration, [ep.lines], heardVoices(dub.voices, 132)), subtitle: unrelated(dubbed(sibling(), 133, { lag: 440 }).captions) };
    }
  },
  {
    name: "sibling-speech",
    about: "another episode of the same show, on a file with no subtitle track",
    file: "speech",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, heard(ep.lines, 108)), subtitle: unrelated(sibling().lines) };
    }
  },
  {
    name: "sibling-speech-more",
    about: "another episode of the same show, on a file with no subtitle track with ten windows of its audio heard",
    file: "speech",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, heard(ep.lines, 108), { more: true }), subtitle: unrelated(sibling().lines) };
    }
  },
  {
    name: "sibling-speech-sparse",
    about: "another episode of the same show, on a file with no subtitle track where only a third of the voices are heard",
    file: "speech",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, drowned(heard(ep.lines, 161), 162, 0.33)), subtitle: unrelated(sibling().lines) };
    }
  },
  {
    name: "sibling-speech-sparse-more",
    about: "the same, with ten windows of the file's audio heard",
    file: "speech",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: speechOnlyFile(ep.duration, drowned(heard(ep.lines, 161), 162, 0.33), { more: true }), subtitle: unrelated(sibling().lines) };
    }
  },
  {
    name: "sibling-speech-steps-more",
    about: "another episode of the same show, cut differently at its first break, on a file with no subtitle track with ten windows heard",
    file: "speech",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      const other = sibling();
      return { record: speechOnlyFile(ep.duration, heard(ep.lines, 163), { more: true }), subtitle: stepped(unrelated(other.lines).map((l, i) => ({ ...l, truth: other.lines[i].start })), [ep.cuts[2]], [800, 3400]).map((l) => ({ ...l, truth: NaN })) };
    }
  },
  // ---------- not this file's, where a search beyond ±20 s could be fooled ----------
  {
    name: "sibling-far-index",
    about: "another episode of the same show, 45 s late: past the usual search, where only a wider one looks",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 141)), subtitle: shifted(unrelated(sibling().lines), 45000) };
    }
  },
  {
    name: "sibling-far-windows",
    about: "another episode of the same show, 45 s early, on a file read in windows",
    file: "windows",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: windowFile(ep.duration, ep.lines, heard(ep.lines, 142)), subtitle: shifted(unrelated(sibling().lines), -45000).filter((l) => l.start >= 0) };
    }
  },
  {
    name: "runon-sibling-index",
    about: "another episode of the same drama, its official translation's lines running on and merging, stepped at the breaks",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = drama();
      const other = dramaSibling();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 143)), subtitle: stepped(runOn(faithful(other.lines), 144, { merge: 0.6, hold: 6000 }), other.cuts.slice(1), [1500, 4600, 7400, 10300, 13100, 15800]).map((l) => ({ ...l, truth: NaN })) };
    }
  },
  {
    name: "longer-cut-index",
    about: "the same episode's subtitle of a much longer cut: scenes of 70, 80 and 90 s the file doesn't have, after the opening and at both breaks",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 145)), subtitle: extendedCut(faithful(ep.lines), ep.cuts.slice(1), [70000, 80000, 90000], 146) };
    }
  },
  {
    name: "longer-cut-early-index",
    about: "the same episode's subtitle of a longer cut with one 70 s scene the file doesn't have, after the cold open: all but the cold open sits 70 s off",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 147)), subtitle: extendedCut(faithful(ep.lines), [ep.cuts[0]], [70000], 148) };
    }
  },
  {
    name: "recap-heavy-index",
    about: "a file opening with a six-minute recap of the previous episode, and the previous episode's subtitle, which meets the recap 30 s off",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => recapHeavy()
  },
  // ---------- not this file's, met in one stretch of the file only ----------
  // A subtitle with a third to half as many lines a minute as the file's track overlaps few of its
  // windows well enough to be measured at all, and the tests of the measured windows judge nothing
  // below three. These are what the cross check over the stored plays found served as synced
  // (docs/scoring.md): a film's subtitle on an episode, an episode's on a film, a short subtitle on
  // a longer file and the reverse, a longer cut's. Each one here was served as synced before
  // accountsForFile.
  {
    name: "film-on-episode-index",
    about: "a film's subtitle, half as dense as the episode's track, on an episode: 95 minutes of lines on a 24-minute file",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 151)), subtitle: without(unrelated(episode(2031, { minutes: 95, opening: false, breaks: 0 }).lines), 2031, 0.5) };
    }
  },
  {
    name: "episode-on-film-index",
    about: "another show's 23-minute episode, half as dense as the film's track, on a film: its lines cover a quarter of the file",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const f = film();
      return { record: indexFile(f.duration, [f.lines], heard(f.lines, 152)), subtitle: without(unrelated(episode(2002, { minutes: 23 }).lines), 2002, 0.5) };
    }
  },
  {
    name: "half-other-index",
    about: "another show's 20-minute episode, half as dense, on a 43-minute drama's: it meets the first half of the file only",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = drama();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 157)), subtitle: without(unrelated(episode(2015, { minutes: 20 }).lines), 2015, 0.5) };
    }
  },
  {
    name: "longer-other-index",
    about: "a 43-minute drama's episode subtitle, a third as dense, on a 24-minute episode: most of its lines would fall past the file's end",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 159)), subtitle: without(unrelated(episode(2021, { minutes: 43, breaks: 4 }).lines), 2021, 0.35) };
    }
  },
  {
    name: "trailer-index",
    about: "another title's first two and a half minutes (a trailer's subtitle, 30 lines or so) on an episode",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const ep = played();
      return { record: indexFile(ep.duration, [ep.lines], heard(ep.lines, 155)), subtitle: unrelated(dialogue(156, 2000, 150000)) };
    }
  },
  {
    name: "extended-cut-film-index",
    about: "a translation of the film's extended cut, folding half the lines together, with three 10-minute scenes the file doesn't have after the 47th minute: the first half sits where it is written, the rest 10 to 30 minutes late",
    file: "index",
    lang: "Arabic",
    negative: true,
    today: negative,
    build: () => {
      const f = scenesFilm();
      return { record: indexFile(f.duration, [f.lines], heard(f.lines, 153)), subtitle: extendedCut(without(faithful(f.lines), 3000, 0.5), f.cuts.slice(2), [600000, 600000, 600000], 3000).map((l) => ({ ...l, truth: NaN })) };
    }
  }
];
