import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CACHE = ".cache-stats-test";
let base = "";
let close = () => {};
let stats: typeof import("../src/stats.js");
let profile: typeof import("../src/profile.js");
let page: typeof import("../src/statsPage.js");

beforeAll(async () => {
  process.env.CONFIG_SECRET = "stats-test-secret-stats-test-secret-12";
  process.env.CACHE_DIR = CACHE;
  process.env.PUBLIC_BASE_URL = "https://sync.example";
  [stats, profile, page] = await Promise.all([import("../src/stats.js"), import("../src/profile.js"), import("../src/statsPage.js")]);
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(async () => {
  close();
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

describe("links", () => {
  it("are the same for the same settings, and still open", () => {
    const settings = { opensubtitles: true, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    const a = profile.sealSettings(settings);
    expect(profile.sealSettings({ ...settings })).toBe(a);
    expect(profile.sealSettings({ ...settings, languages: ["English"] })).not.toBe(a);
    expect(profile.openSettings(a)).toEqual(settings);
  });
});

describe("usage and health", () => {
  it("keeps addresses and tokens out of error notes", () => {
    expect(stats.scrub("ffmpeg failed on https://debrid.example/dl/abc?token=x and key sk_0123456789abcdef0123456789abcdef0")).toBe("ffmpeg failed on <url> and key <token>");
  });

  it("counts per day and per link, and renders", async () => {
    stats.count("lists", 1, "1234abcd/ab12cd");
    stats.count("downloads", 2, "1234abcd/ab12cd");
    stats.count("sync.files");
    stats.count("sync.videoSeconds", 200);
    stats.count("own.cpu.ms", 200_000);
    stats.count("net.rx", 5_000_000);
    stats.count("net.tx", 250_000);
    stats.count("proc.ffmpeg.ms", 8000);
    stats.count("api.subdl", 3);
    stats.noteError("subdl", new Error("HTTP 403 from https://api.subdl.com/api/v1/subtitles?api_key=secret"));
    const view = await stats.statsView("1.3.0");
    expect(view.days).toHaveLength(14);
    expect(view.days[0].total).toMatchObject({ lists: 1, downloads: 2, "sync.files": 1, "api.subdl": 3, "errors.subdl": 1 });
    expect(view.days[0].links["1234abcd/ab12cd"]).toMatchObject({ lists: 1, downloads: 2 });
    expect(view.now.cores).toBeGreaterThan(0);
    const token = profile.sealSettings({ subsource: "sk_dashboard_test_key_1234", opensubtitles: true, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "exclude" });
    profile.noteLinkToken("1234abcd/ab12cd", token);
    const html = page.statsPage(await stats.statsView("1.3.0"));
    expect(html).toContain("AIOSubtitles dashboard");
    // Each link it has seen: its settings, without its keys, and Edit to its configure page.
    expect(html).toContain(`href="/${token}/configure"`);
    expect(html).toContain("English Dub and Arabic");
    expect(html).toContain("SubSource, OpenSubtitles, TheSubtitleDB, Gestdown and Anime Tosho");
    expect(html).toContain("No HI");
    expect(html).toContain("No sync");
    expect(html).not.toContain("sk_dashboard_test_key_1234");
    expect(html).toContain("1234abcd/ab12cd");
    expect(html).toContain("3 min 20 s"); // CPU time of the container
    expect(html).toContain("5 MB"); // downloaded
    expect(html).toContain("250 KB"); // sent
    expect(html).not.toContain("api_key");
  });

  it("counts each key by an anonymous id, per link, against its free plan", async () => {
    const ok = new Response("{}", { headers: { "x-ratelimit-remaining": "59", "content-type": "application/json" } });
    await stats.requestContext.run({ link: "9999aaaa/cd34ef" }, async () => {
      stats.count("api.subsource");
      stats.noteKeyCall("subsource", "secret-subsource-key", ok);
      stats.noteKeyCall("subsource", "secret-subsource-key", new Response("", { status: 429 }));
      stats.noteKeyCall("subdl", "secret-subdl-key", ok);
      stats.noteKeyCall("subdl", "secret-subdl-key", ok, true);
    });
    stats.noteActivity({ link: "9999aaaa/cd34ef", kind: "download", what: "Arabic · Show S2 - 01", result: "synced", ms: 1200 });
    const view = await stats.statsView("1.3.0");
    const id = stats.keyId("subsource", "secret-subsource-key");
    expect(id).toMatch(/^subsource:[0-9a-f]{6}$/);
    expect(view.days[0].keys?.[id]).toMatchObject({ calls: 2, refused: 1, busiestMinute: 2, link: "9999aaaa/cd34ef", headers: { "x-ratelimit-remaining": "59" } });
    expect(view.days[0].keys?.[stats.keyId("subdl", "secret-subdl-key")]).toMatchObject({ calls: 2, downloads: 1 });
    expect(view.windows[id]).toEqual({ minute: 2, hour: 2, day: 2 });
    expect(view.days[0].links["9999aaaa/cd34ef"]).toMatchObject({ "api.subsource": 1 });
    const html = page.statsPage(view);
    expect(html).not.toContain("secret-");
    expect(html).toContain("/7,200"); // SubSource's day
    expect(html).toContain("/50"); // SubDL's downloads
    expect(html).toMatch(/Resets<span class="km-note"> in [^<]+<\/span><\/span><span class="km-val"><b>\d\d:00<\/b>/); // SubDL's day, on the dashboard's clock
    expect(html).toContain("Refused 1×");
    expect(html).toContain("Show S2 - 01");
  });

  it("names a link by the name given on the configure page", async () => {
    stats.noteLinkLabel("7777cccc/dd22ee", "Sara's TV");
    const view = await stats.statsView("1.3.0");
    expect(view.names["7777cccc/dd22ee"]).toBe("Sara's TV");
    stats.count("lists", 1, "7777cccc/dd22ee");
    expect(page.statsPage(await stats.statsView("1.3.0"))).toContain("Sara&#39;s TV");
  });

  it("shows a link's keys from its first request, before any call", async () => {
    stats.noteLinkKeys("5555bbbb/aa11bb", [["subsource", "never-called-key"], ["subdl", undefined]]);
    const view = await stats.statsView("1.3.0");
    const id = stats.keyId("subsource", "never-called-key");
    expect(view.days[0].keys?.[id]).toMatchObject({ calls: 0, link: "5555bbbb/aa11bb" });
    expect(Object.keys(view.days[0].keys ?? {}).filter((k) => k.startsWith("subdl:"))).toHaveLength(1); // only the one called earlier
    // A link whose keys made no calls this week is one line under the busy ones.
    const html = page.statsPage(view);
    expect(html).toContain("No calls this week");
    expect(html).toMatch(/<li class="idle-key">.*5555bbbb\/aa11bb.*SubSource/s);
  });
});

describe("the stats page", () => {
  it("opens without a password when ADMIN_PASSWORD is unset (a proxy login guards it)", async () => {
    const shown = await fetch(`${base}/stats`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(await shown.text()).toContain("Right now");
  });

  it("puts the logo and the sources in the manifest", async () => {
    const manifest = (await (await fetch(`${base}/manifest.json`)).json()) as { logo?: string; description: string };
    expect(manifest.logo).toBe("https://sync.example/logo.png");
    expect(manifest.description).toMatch(/SubDL, OpenSubtitles and any subtitle addon/);
    expect((await fetch(`${base}/logo.png`)).headers.get("content-type")).toBe("image/png");
  });
});

describe("the dashboard's sources", () => {
  it("lists Subtitle Cat once a link has used it, with its errors by name", async () => {
    expect(page.statsPage(await stats.statsView("1.3.0"))).not.toContain('<th scope="row">Subtitle Cat</th>');
    stats.count("api.subtitlecat", 4);
    stats.count("fetch.subtitlecat", 1);
    stats.noteError("subtitlecat", new Error("search failed: HTTP 503"));
    const html = page.statsPage(await stats.statsView("1.3.0"));
    expect(html).toContain('<th scope="row">Subtitle Cat</th><td>4</td><td>1</td><td class="bad">1</td>');
    expect(html).toContain('<span class="err-where">Subtitle Cat</span>');
  });

  it("describes the status-in-name setting as it looks", async () => {
    const token = profile.sealSettings({ opensubtitles: true, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include", statusInName: true });
    profile.noteLinkToken("4444dddd/ee33ff", token);
    stats.count("lists", 1, "4444dddd/ee33ff");
    expect(page.statsPage(await stats.statsView("1.3.0"))).toContain("Status in the track name, like Arabic (Synced)");
  });
});
