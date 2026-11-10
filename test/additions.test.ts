import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "../src/types.js";

type Matching = typeof import("../src/matching.js");
type Sources = typeof import("../src/sources.js");
type Profile = typeof import("../src/profile.js");
type Net = typeof import("../src/net.js");
type Text = typeof import("../src/text.js");
type Sync = typeof import("../src/sync.js");

let matching: Matching;
let sources: Sources;
let profile: Profile;
let net: Net;
let text: Text;
let sync: Sync;
const CACHE = ".cache-additions-test";

beforeAll(async () => {
  process.env.CONFIG_SECRET = "additions-test-secret-additions-test-1";
  process.env.CACHE_DIR = CACHE;
  [matching, sources, profile, net, text, sync] = await Promise.all([
    import("../src/matching.js"),
    import("../src/sources.js"),
    import("../src/profile.js"),
    import("../src/net.js"),
    import("../src/text.js"),
    import("../src/sync.js")
  ]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const request: StremioSubtitleRequest = { type: "series", id: "tt0000003:1:13", imdbId: "tt0000003", season: 1, episode: 13 };
const sub = (p: Partial<SubSourceSubtitle>): SubSourceSubtitle => ({ subtitleId: 0, movieId: 0, language: "arabic", releaseInfo: [], files: 1, downloads: 0, rating: null, episodeTrusted: true, ...p });

describe("release match with the playing file", () => {
  it("finds the group in anime and scene names", () => {
    expect(matching.releaseGroup("[SubsPlease] Iron Lantern - 13 (1080p) [A1B2C3D4].mkv")).toBe("subsplease");
    expect(matching.releaseGroup("Iron.Lantern.S01E13.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv")).toBe("varyg");
    expect(matching.releaseGroup("Iron.Lantern.S01E13.1080p.WEB-DL")).toBeUndefined();
    expect(matching.releaseGroup("Iron Lantern S01E13")).toBeUndefined();
  });

  it("scores group, service and source", () => {
    const file = "Iron.Lantern.S01E13.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv";
    expect(matching.releaseMatch(sub({ releaseInfo: ["Iron.Lantern.S01E13.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG"] }), file)).toBe(6);
    expect(matching.releaseMatch(sub({ releaseInfo: ["Iron.Lantern.S01E13.1080p.NF.WEB-DL-GROUP"] }), file)).toBe(0); // other service -1, same source +1
    expect(matching.releaseMatch(sub({ releaseInfo: ["Iron Lantern 13 BluRay"] }), file)).toBe(-1);
    expect(matching.releaseMatch(sub({ releaseInfo: ["anything"] }), undefined)).toBe(0);
    // SubsPlease rips Crunchyroll; underscores separate words too.
    expect(matching.releaseMatch(sub({ releaseInfo: ["Iron_Lantern_13_[CR]"] }), "[SubsPlease] Iron Lantern - 13 (1080p).mkv")).toBe(2);
  });

  it("ranks the matching release first within the same quality", () => {
    const playing = { ...request, filename: "Iron.Lantern.S01E13.1080p.CR.WEB-DL-VARYG.mkv" };
    const ranked = matching.filterAndRankDubtitles(
      [
        sub({ ref: "a", releaseInfo: ["Iron Lantern 13 BluRay"], downloads: 900 }),
        sub({ ref: "b", releaseInfo: ["Iron.Lantern.S01E13.1080p.CR.WEB-DL-VARYG"], downloads: 1 })
      ],
      playing,
      { requireDub: false }
    );
    expect(ranked.map((s) => s.ref)).toEqual(["b", "a"]);
  });
});

describe("UTF-16 subtitles", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nمرحبا\r\n";
  it("reads UTF-16 with and without a byte order mark", () => {
    const le = Buffer.from(srt, "utf16le");
    expect(text.decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), le]), "ara")).toBe(srt);
    expect(text.decodeSubtitle(le, "ara")).toBe(srt);
    const be = Buffer.from(le).swap16();
    expect(text.decodeSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), "ara")).toBe(srt);
    expect(text.utf16ToUtf8(le).toString("utf8")).toBe(srt);
  });
  it("leaves UTF-8 and legacy code pages alone", () => {
    const utf8 = Buffer.from(srt, "utf8");
    expect(text.utf16ToUtf8(utf8)).toBe(utf8);
    expect(text.decodeSubtitle(Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]), "ara")).toBe("مرحبا");
  });
});

describe("public https only for added addons", () => {
  it("refuses private, local and Docker addresses", () => {
    expect(net.publicHttpsUrl("https://opensubtitles.strem.io/manifest.json")).toBeDefined();
    for (const bad of ["http://example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.2/x", "https://172.20.0.3/x", "https://[::1]/x", "https://aiostreams:3000/x", "https://user:pw@example.com/x", "nonsense"]) {
      expect(net.publicHttpsUrl(bad), bad).toBeUndefined();
    }
  });
});

describe("added Stremio subtitle addons", () => {
  it("maps their language codes", () => {
    expect(sources.addonLanguage("ara")).toBe("arabic");
    expect(sources.addonLanguage("eng")).toBe("english");
    expect(sources.addonLanguage("ar")).toBe("arabic");
    expect(sources.addonLanguage("pt-br")).toBe("portuguese (br)");
    expect(sources.addonLanguage("zzz")).toBeUndefined();
  });

  it("asks like a player, keeps wanted languages, and never keeps a URL in the clear", async () => {
    const secretLink = "https://subs.example.com/file/arabic.srt?key=addon-secret-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ subtitles: [
      { id: 1, url: secretLink, lang: "ara", label: "Iron Lantern 13 [CR]" },
      { id: 2, url: "https://subs.example.com/file/fr.srt", lang: "fre" },
      { id: 3, url: "http://10.0.0.1/evil.srt", lang: "ara" }
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const addon = { name: "Test Subs", url: "https://addon.example.com/conf-with-key/manifest.json" };
    const found = await sources.addonSubtitles(addon, { ...request, filename: "Iron Lantern - 13.mkv", videoHash: "0123456789abcdef" }, ["arabic"]);
    const asked = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(asked).toBe("https://addon.example.com/conf-with-key/subtitles/series/tt0000003%3A1%3A13/filename=Iron+Lantern+-+13.mkv&videoHash=0123456789abcdef.json");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ language: "arabic", source: "addon", releaseInfo: ["Iron Lantern 13 [CR]"] });
    expect(JSON.stringify(found)).not.toContain("addon-secret-key");
    expect(profile.openUrl(found[0].sealedUrl as string)).toBe(secretLink);
    expect(found[0].ref).toMatch(/^cx[0-9a-f]{20}$/);
  });

  it("goes in the link, and counts as a source by itself", () => {
    const settings = { addons: [{ name: "Test Subs", url: "https://addon.example.com/k/manifest.json" }], languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    expect(profile.settingsProblem(settings)).toBeUndefined();
    expect(profile.openSettings(profile.sealSettings(settings))).toEqual(settings);
    expect(profile.settingsProblem({ ...settings, addons: [{ name: "x", url: "http://addon.example.com/manifest.json" }] })).toMatch(/https/);
  });
});

describe("what's known about a sync", () => {
  it("says unsynced for a file without embedded subtitles, unknown before a play", async () => {
    const { cachePath } = await import("../src/cache.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const key = sync.syncKey("ss1", 1, 13, "no-subs.mkv");
    expect(await sync.knownSync(key, "no-subs.mkv")).toBe("unknown");
    const { cacheKey } = await import("../src/cache.js");
    await mkdir(cachePath("anchors"), { recursive: true });
    const record = path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename: "no-subs.mkv" })}.json`);
    // Written before speech sync: the file may have audio to time by, so it isn't settled yet.
    await writeFile(record, JSON.stringify({ duration: 1, windows: [] }));
    expect(await sync.knownSync(key, "no-subs.mkv")).toBe("unknown");
    await writeFile(record, JSON.stringify({ duration: 1, windows: [], speechChecked: true }));
    expect(await sync.knownSync(key, "no-subs.mkv")).toBe("unsynced");
    await mkdir(cachePath("synced"), { recursive: true });
    const other = sync.syncKey("ss2", 1, 13, "with-subs.mkv");
    await writeFile(path.join(cachePath("synced"), `${other}.json`), JSON.stringify({ file: "x", anchors: [{ from: 0, offset: 100 }] }));
    expect(await sync.knownSync(other, "with-subs.mkv")).toBe("synced");
    // Captions shown not to belong to the file (another episode's) are "wrong", and lists leave them out.
    const stray = sync.syncKey("sd1-2", 1, 13, "with-subs.mkv");
    await writeFile(path.join(cachePath("synced"), `${stray}.json`), JSON.stringify({ file: "x", anchors: [], noFit: true }));
    expect(await sync.knownSync(stray, "with-subs.mkv")).toBe("wrong");
  });
});

describe("season packs that hold another episode", () => {
  it("won't pass a pack's only file off as a different episode", async () => {
    const { namesAnotherEpisode } = await import("../src/downloads.js");
    expect(namesAnotherEpisode("Iron Lantern - S01E01 (001).English[SDH].srt", 13)).toBe(true);
    expect(namesAnotherEpisode("Iron Lantern - S01E001.English[SDH].ass", 13)).toBe(true);
    expect(namesAnotherEpisode("Iron Lantern - S01E13.English[SDH].srt", 13)).toBe(false);
    expect(namesAnotherEpisode("[SubsPlease] Iron Lantern - 13 (1080p).ass", 13)).toBe(false);
    expect(namesAnotherEpisode("Iron Lantern English.srt", 13)).toBe(false);
  });

  it("doesn't count a sync built mostly from second-best fits", async () => {
    const { landsOnTiming } = await import("../src/sync.js");
    const win = (from: number, offset: number) => ({ from, measured: { offset, score: 0.9, alternatives: [] } });
    const anchor = (from: number, offset: number) => ({ from, to: from + 40000, offset, score: 0.9 });
    // Dr. Ember S2E01, misfiled Arabic: 1 of 8 windows' own best fit on the final timing.
    expect(landsOnTiming([win(216e3, -19760), win(401e3, -10280), win(461e3, 16720), win(501e3, -9280), win(661e3, 1680), win(721e3, -6800), win(980e3, -19730), win(1265e3, 2320)],
      [anchor(401e3, -9520), anchor(501e3, -9280), anchor(661e3, -7800), anchor(721e3, -9400)])).toBe(false);
    // Iron Lantern E13: 6 of 7 land on it.
    expect(landsOnTiming([win(215e3, -945), win(398e3, -1065), win(458e3, -900), win(498e3, -880), win(716e3, -1000), win(974e3, -840), win(1217e3, 14615)],
      [anchor(215e3, -945), anchor(716e3, -1000), anchor(1217e3, -980)])).toBe(true);
    // The Analyst S3E8 English: two false readings early, then timing drifting from -0.1 to 1 s.
    expect(landsOnTiming([win(379e3, 11055), win(809e3, -4130), win(1264e3, -100), win(1719e3, 200), win(2148e3, 980)],
      [anchor(379e3, 40), anchor(809e3, -25), anchor(1264e3, -100), anchor(1719e3, 200), anchor(2148e3, 320)])).toBe(true);
  });

  it("tells captions for this file from another episode's", async () => {
    const { fitsFile } = await import("../src/sync.js");
    const at = (...ms: number[]) => ms.map((offset) => ({ measured: { offset, score: 0.9, alternatives: [] } }));
    // Real E13 and E14 dub captions: every window agrees.
    expect(fitsFile(at(-960, -1080, -880, -880, -1000, -840, 14600))).toBe(true);
    expect(fitsFile(at(-1160, -1150, -960, -1320, -880, -1160))).toBe(true);
    // A timing step mid-episode (Odd Journey S1E7): windows agree on each side of it.
    expect(fitsFile(at(500, 520, 1200, 2900, 2880))).toBe(true);
    // Episode 1's captions measured against episode 13: best fits all over the place.
    expect(fitsFile(at(6560, -11760, -15880, 2120, 14800, 6760, 3400))).toBe(false);
    expect(fitsFile(at(-3440, -15360, 15280, -7880, 4760, -3240, -6600))).toBe(false);
    // Timing that drifts a little (The Analyst S3E8 English): three windows within 1.5 s fit.
    expect(fitsFile(at(11100, -4100, -100, 200, 1000))).toBe(true);
    // The misfiled Dr. Ember Arabic (another season) still doesn't.
    expect(fitsFile(at(14600, -17600, 20900, -13500, 4200, 1600, 18300, 13200, -10500, 800))).toBe(false);
  });
});

describe("cache clean-up", () => {
  it("removes files unused for 14 days and keeps the rest and the usage counts", async () => {
    const { cachePath } = await import("../src/cache.js");
    const { mkdir, writeFile, utimes, access } = await import("node:fs/promises");
    const { pruneCache } = await import("../src/cleanup.js");
    const old = new Date(Date.now() - 20 * 86400_000);
    const files = {
      stale: path.join(cachePath("downloads"), "old.bin"),
      fresh: path.join(cachePath("subtitles"), "new.srt"),
      stats: path.join(cachePath("stats"), "2026-01-01.json")
    };
    for (const file of Object.values(files)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "x".repeat(100));
    }
    await utimes(files.stale, old, old);
    await utimes(files.stats, old, old);
    const pruned = await pruneCache();
    expect(pruned.files).toBeGreaterThanOrEqual(1);
    const there = (f: string) => access(f).then(() => true, () => false);
    expect(await there(files.stale)).toBe(false);
    expect(await there(files.fresh)).toBe(true);
    expect(await there(files.stats)).toBe(true);
  });
});

describe("every subtitle goes out as SRT", () => {
  it("turns ASS into SRT, dropping styling and drawings", async () => {
    const { toSrt } = await import("../src/srt.js");
    const ass = [
      "[Script Info]", "Title: x", "", "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      String.raw`Dialogue: 0,0:00:04.01,0:00:06.27,Main,Soyuz,0000,0000,0000,,{\i1}كـ-كاد يكتمل، صحيح؟{\i0}`,
      String.raw`Dialogue: 0,0:00:09.44,0:00:15.41,Main,Suika,0000,0000,0000,,First line\NSecond, with a comma`,
      String.raw`Dialogue: 0,0:00:10.00,0:00:12.00,Sign,,0,0,0,,{\p1}m 0 0 l 100 0 100 100{\p0}`
    ].join("\r\n");
    expect(toSrt(ass, ".ass")).toBe("1\n00:00:04,010 --> 00:00:06,270\nكـ-كاد يكتمل، صحيح؟\n\n2\n00:00:09,440 --> 00:00:15,410\nFirst line\nSecond, with a comma\n");
  });
  it("turns VTT into SRT and leaves SRT alone", async () => {
    const { toSrt } = await import("../src/srt.js");
    expect(toSrt("WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n<v Senku>Ten billion percent</v>\n", ".vtt")).toBe("1\n00:00:01,000 --> 00:00:02,500\nTen billion percent\n");
    expect(toSrt("1\n00:00:01,000 --> 00:00:02,000\nhi\n", ".srt")).toBe("1\n00:00:01,000 --> 00:00:02,000\nhi\n");
  });
});

describe("the subtitle track to time against", () => {
  const sub = (index: number, language: string, codec = "subrip", title = "", forced = 0) => ({ index, codec_type: "subtitle", codec_name: codec, tags: { language, title }, disposition: { forced } });
  it("takes English full dialogue first", async () => {
    const { pickTrack } = await import("../src/sync.js");
    expect(pickTrack([sub(2, "spa"), sub(3, "eng", "ass", "Signs & Songs"), sub(4, "eng", "ass", "Full")])?.index).toBe(4);
  });
  it("takes a text track in any language over a picture one", async () => {
    const { pickTrack, rankTracks } = await import("../src/sync.js");
    expect(pickTrack([sub(2, "jpn"), sub(3, "eng", "hdmv_pgs_subtitle")])?.index).toBe(2);
    expect(pickTrack([sub(3, "eng", "hdmv_pgs_subtitle")])?.index).toBe(3);
    expect(rankTracks([sub(2, "jpn"), sub(3, "eng", "hdmv_pgs_subtitle"), sub(4, "eng"), sub(5, "spa")]).map((t) => t.index)).toEqual([4, 2, 5, 3]);
  });
  it("falls back to another language when there's no English, never to signs", async () => {
    const { pickTrack } = await import("../src/sync.js");
    expect(pickTrack([sub(2, "eng", "ass", "Signs"), sub(3, "spa")])?.index).toBe(3);
    expect(pickTrack([sub(2, "fre", "subrip", "", 1), sub(3, "por", "subrip")])?.index).toBe(3);
    expect(pickTrack([sub(2, "eng", "ass", "Songs")])).toBeUndefined();
    expect(pickTrack([{ index: 1, codec_type: "audio", codec_name: "aac" }])).toBeUndefined();
  });
});

describe("finding the playing file in AIOStreams", () => {
  it("treats another version of the same release as the same file", async () => {
    const { releaseName } = await import("../src/sync.js");
    const played = "[sam] Sora no Nikki - 01 [BD 1080p FLAC] [E55294ED].mkv";
    expect(releaseName("[sam] Sora no Nikki - 01v2 [BD 1080p FLAC] [58719017].mkv")).toBe(releaseName(played));
    expect(releaseName("[sam] Sora no Nikki - 02 [BD 1080p FLAC] [EF25BE70].mkv")).not.toBe(releaseName(played));
    expect(releaseName("[MTBB] The Herbalist Notes - 01 (BD 1080p) [BA2F293F].mkv")).not.toBe(releaseName(played));
    expect(releaseName("Show.S01E01.1080p.WEB-DL.H.264-GRP")).toBe(releaseName("Show.S01E01.1080p.WEB-DL.H.264-GRP.mkv"));
  });
});

describe("speech in the audio", () => {
  /** 16 kHz mono 16-bit: quiet hiss, with loud bursts at the given [start, end] ms. */
  const audio = (ms: number, bursts: Array<[number, number]>) => {
    const samples = (ms * 16000) / 1000;
    const pcm = Buffer.alloc(samples * 2);
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    for (let i = 0; i < samples; i++) {
      const t = (i * 1000) / 16000;
      const loud = bursts.some(([a, b]) => t >= a && t < b);
      pcm.writeInt16LE(Math.round(noise() * (loud ? 9000 : 60)), i * 2);
    }
    return pcm;
  };

  it("finds where people speak, offset by the window's start", async () => {
    const { speechCues } = await import("../src/sync.js");
    const cues = speechCues(audio(10000, [[1000, 2500], [4000, 4600], [7000, 9000]]), 300000);
    expect(cues).toHaveLength(3);
    expect(Math.abs(cues[0].start - 301000)).toBeLessThanOrEqual(40);
    expect(Math.abs(cues[2].end - 309000)).toBeLessThanOrEqual(40);
  });

  it("ignores blips and a stretch with no contrast", async () => {
    const { speechCues } = await import("../src/sync.js");
    expect(speechCues(audio(10000, [[1000, 1100]]), 0)).toHaveLength(0);
    expect(speechCues(audio(10000, []), 0)).toHaveLength(0);
  });

  it("hears the English track first, then the default one", async () => {
    const { pickAudio } = await import("../src/sync.js");
    const a = (index: number, language: string, isDefault = 0) => ({ index, codec_type: "audio", tags: { language }, disposition: { default: isDefault } });
    expect(pickAudio([a(1, "jpn", 1), a(2, "eng")])).toBe(2);
    expect(pickAudio([a(1, "jpn"), a(2, "spa", 1)])).toBe(2);
    expect(pickAudio([{ index: 0, codec_type: "video" }])).toBeUndefined();
  });
});

describe("speech in the audio as the last resort", () => {
  // Lines of uneven length and spacing, the way dialogue comes (deterministic, no randomness).
  const lines = (from: number, to: number, seed: number) => {
    const cues: Array<{ start: number; end: number }> = [];
    let at = from;
    let n = seed;
    while (at < to) {
      n = (n * 1103515245 + 12345) % 2147483648;
      const length = 900 + (n % 2600);
      const gap = 300 + ((n >> 8) % 2200);
      cues.push({ start: at, end: at + length });
      at += length + gap;
    }
    return cues;
  };
  const captions = lines(0, 1_500_000, 7);
  const shifted = (shift: number) => captions.map((c) => ({ start: c.start + shift, end: c.end + shift }));
  const windowAt = (from: number, speech: Array<{ start: number; end: number }>, seed: number) => ({
    from,
    to: from + 40000,
    // The subtitle track has another rhythm altogether (a translation timed to other audio).
    cues: lines(from, from + 40000, seed).filter((_, i) => i % 3 === 0),
    speech: speech.filter((c) => c.start >= from && c.end <= from + 40000)
  });

  it("times captions by speech when they fit the subtitle track nowhere", async () => {
    const { bySpeech, judge } = await import("../src/sync.js");
    const heard = shifted(1000);
    const found = { duration: 1_500_000, speechBy: "silero" as const, windows: [200_000, 450_000, 700_000, 950_000, 1_200_000].map((from, i) => windowAt(from, heard, 100 + i)) };
    const speech = bySpeech(found, captions);
    expect(speech?.anchors.length).toBeGreaterThanOrEqual(3);
    // Less the 200 ms a line usually shows ahead of the voice: here speech starts right on each line.
    for (const anchor of speech!.anchors) expect(Math.abs(anchor.offset - 800)).toBeLessThanOrEqual(80);
    const verdict = judge(found, captions);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.bySpeech).toBe(true);
  });

  it("still times captions that put two sentences in one line", async () => {
    const { bySpeech } = await import("../src/sync.js");
    // Every other pair of lines shown as one (The Analyst's SDH track does this), while the voice
    // still starts twice.
    const merged = captions.flatMap((c, i, all) => (i % 4 === 0 && all[i + 1] ? [{ start: c.start, end: all[i + 1].end }] : i % 4 === 1 ? [] : [c]));
    const found = { duration: 1_500_000, speechBy: "silero" as const, windows: [200_000, 450_000, 700_000, 950_000, 1_200_000].map((from, i) => windowAt(from, shifted(1000), 100 + i)) };
    const speech = bySpeech(found, merged);
    expect(speech?.anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of speech!.anchors) expect(Math.abs(anchor.offset - 800)).toBeLessThanOrEqual(80);
  });

  it("times a file with no subtitle track by its speech alone", async () => {
    const { judge } = await import("../src/sync.js");
    const heard = shifted(-2500);
    const found = {
      duration: 1_500_000,
      speechOnly: true,
      speechBy: "silero" as const,
      windows: [200_000, 450_000, 700_000, 950_000, 1_200_000].map((from) => ({ from, to: from + 40000, cues: heard.filter((c) => c.start >= from && c.end <= from + 40000) }))
    };
    const verdict = judge(found, captions);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.bySpeech).toBe(true);
    for (const anchor of verdict.anchors) expect(Math.abs(anchor.offset - -2700)).toBeLessThanOrEqual(80);
  });

  it("doesn't use speech heard by loudness alone (before Silero)", async () => {
    const { bySpeech } = await import("../src/sync.js");
    const found = { duration: 1_500_000, windows: [200_000, 450_000, 700_000, 950_000, 1_200_000].map((from, i) => windowAt(from, shifted(1000), 100 + i)) };
    expect(bySpeech(found, captions)).toBeUndefined();
  });

  it("leaves captions unsynced when speech doesn't fit them either", async () => {
    const { bySpeech } = await import("../src/sync.js");
    const found = { duration: 1_500_000, speechBy: "silero" as const, windows: [200_000, 450_000, 700_000, 950_000, 1_200_000].map((from, i) => windowAt(from, lines(0, 1_500_000, 900 + i), 100 + i)) };
    expect(bySpeech(found, captions)).toBeUndefined();
  });

  it("isn't used with fewer than three windows of speech", async () => {
    const { bySpeech } = await import("../src/sync.js");
    const found = { duration: 1_500_000, speechBy: "silero" as const, windows: [200_000, 450_000].map((from, i) => windowAt(from, shifted(1000), 100 + i)) };
    expect(bySpeech(found, captions)).toBeUndefined();
  });
});

describe("the voice detector", () => {
  it("hears no speech in a steady tone or in silence", async () => {
    const { heardSpeech } = await import("../src/vad.js");
    const pcm = Buffer.alloc(16000 * 4 * 2);
    for (let i = 16000; i < 32000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * 3000), i * 2);
    expect(await heardSpeech(pcm, 0)).toEqual([]);
  });
});

describe("languages the file already has", () => {
  const sub = (index: number, language: string, codec = "subrip", title = "", forced = 0) => ({ index, codec_type: "subtitle", codec_name: codec, tags: { language, title }, disposition: { forced } });
  it("counts full text tracks only, not signs, forced lines or pictures", async () => {
    const { fullTextLanguages } = await import("../src/sync.js");
    expect(fullTextLanguages([sub(2, "eng", "subrip", "SDH"), sub(3, "eng", "subrip", "Stripped"), sub(4, "ara"), sub(5, "spa", "ass", "Signs"), sub(6, "fre", "subrip", "", 1), sub(7, "ger", "hdmv_pgs_subtitle"), sub(8, "und")])).toEqual(["eng", "ara"]);
    expect(fullTextLanguages([{ index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "eng" } }])).toEqual([]);
  });

  it("skips them by default, links made before the option included, and lists them when asked", async () => {
    const { profileFromSettings, openSettings, sealSettings } = await import("../src/profile.js");
    const base = { subsource: "sk_friends_own_key_1234", languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    // A link made before the option: its settings have no keepEmbedded.
    const old = openSettings(sealSettings(base))!;
    expect(old.keepEmbedded).toBeUndefined();
    expect(profileFromSettings(old, "t").skipEmbedded).toBe(true);
    expect(profileFromSettings({ ...base, keepEmbedded: true }, "t").skipEmbedded).toBe(false);
  });
});
