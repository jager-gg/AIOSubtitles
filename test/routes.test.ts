import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings } from "../src/profile.js";

let base = "";
let close = () => {};
let seal: (s: Settings) => string;
let open: (t: string) => Settings | undefined;
let problem: (s: Settings) => string | undefined;

const KEY = "sk_friends_own_key_1234";
const AIO = "https://aiostreams.example.com/stremio/1234abcd-uuid/E2-encpass/manifest.json";
const settings: Settings = { subsource: KEY, aiostreams: AIO, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" };

beforeAll(async () => {
  process.env.CONFIG_SECRET = "routes-test-secret-routes-test-secret-1";
  process.env.ALLOWED_AIOSTREAMS = "https://aiostreams.example.com";
  process.env.PUBLIC_BASE_URL = "https://sync.example";
  const profile = await import("../src/profile.js");
  seal = profile.sealSettings;
  open = profile.openSettings;
  problem = profile.settingsProblem;
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(() => close());

describe("settings in the manifest URL", () => {
  it("round-trips and hides the keys", () => {
    const token = seal(settings);
    expect(token).toMatch(/^2[A-Za-z0-9_-]+$/);
    expect(open(token)).toEqual(settings);
    expect(Buffer.from(token.slice(1), "base64url").toString("latin1")).not.toContain("sk_friends");
  });

  it("refuses altered tokens", () => {
    const token = seal(settings);
    const flipped = token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21);
    expect(open(flipped)).toBeUndefined();
    expect(open("2garbage")).toBeUndefined();
  });

  it("accepts AIOStreams URLs only from the allowed instance", () => {
    expect(problem(settings)).toBeUndefined();
    expect(problem({ ...settings, aiostreams: "https://evil.example/stremio/a/b/manifest.json" })).toMatch(/AIOStreams/);
    expect(problem({ ...settings, aiostreams: "https://aiostreams.example.com/stremio/a/b" })).toMatch(/AIOStreams/);
    expect(problem({ ...settings, aiostreams: undefined })).toBeUndefined();
    expect(problem({ ...settings, languages: [] })).toMatch(/Languages/);
    expect(problem({ ...settings, subsource: "" })).toMatch(/SubSource/);
  });
});

describe("routes", () => {
  it("serves a configurable manifest, bare and with settings", async () => {
    const bare = (await (await fetch(`${base}/manifest.json`)).json()) as { behaviorHints: Record<string, boolean> };
    expect(bare.behaviorHints).toEqual({ configurable: true, configurationRequired: true });
    const token = seal(settings);
    const mine = (await (await fetch(`${base}/${token}/manifest.json`)).json()) as { id: string; behaviorHints: Record<string, boolean> };
    expect(mine.id).toBe("aio.subtitle");
    expect(mine.behaviorHints).toEqual({ configurable: true, configurationRequired: false });
  });

  it("serves the configure page, prefilled from the link without sending the keys", async () => {
    const blank = await (await fetch(`${base}/configure`)).text();
    expect(blank).toContain("SubSource API key");
    const token = seal(settings);
    const page = await (await fetch(`${base}/${token}/configure`)).text();
    expect(page).toContain("Saved. Leave empty to keep it");
    expect(page).toMatch(/value="Arabic" checked/);
    expect(page).not.toContain(KEY);
    expect(page).not.toContain("E2-encpass");
  });

  it("rejects bad settings before calling anyone", async () => {
    const response = await fetch(`${base}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subsource: KEY, aiostreams: "https://evil.example/stremio/a/b/manifest.json", languages: ["Arabic"] })
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/AIOStreams/);
  });

  it("needs sync to save, and checks each step where it is", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const noSync = await post("/configure", { opensubtitles: true, languages: ["English"] });
    expect(noSync.status).toBe(400);
    expect(((await noSync.json()) as { error: string }).error).toMatch(/^AIOStreams install URL: needed/);
    const sync = await post("/configure/check", { step: "sync", aiostreams: "" });
    expect(((await sync.json()) as { error: string }).error).toMatch(/^AIOStreams/);
    const sources = await post("/configure/check", { step: "sources", opensubtitles: false });
    expect(((await sources.json()) as { error: string }).error).toMatch(/^Sources:/);
    expect((await post("/configure/check", { step: "sources", opensubtitles: true })).status).toBe(200);
    expect((await post("/configure/check", { step: "languages", languages: [] })).status).toBe(400);
    expect((await post("/configure/check", { step: "name", label: "Sara's TV" })).status).toBe(200);
    expect((await post("/configure/check", { step: "name", label: "<script>" })).status).toBe(400);
  });

  it("carries a link's name, and refuses odd ones", () => {
    expect(problem({ ...settings, label: "Sara's TV" })).toBeUndefined();
    expect(problem({ ...settings, label: "a".repeat(41) })).toMatch(/^Link name/);
    expect(problem({ ...settings, label: "<b>" })).toMatch(/^Link name/);
  });

  it("gives unknown links and unconfigured subtitle requests nothing", async () => {
    expect((await fetch(`${base}/2notarealtoken/manifest.json`)).status).toBe(404);
    expect((await fetch(`${base}/subtitles/series/tt0000004:1:1.json`)).status).toBe(404);
    expect((await fetch(`${base}/not-a-thing`)).status).toBe(404);
  });
});

describe("sources and instances in the settings", () => {
  it("needs at least one source, and SubSource is optional", () => {
    expect(problem({ ...settings, subsource: undefined, opensubtitles: true })).toBeUndefined();
    expect(problem({ ...settings, subsource: undefined, subdl: "subdl_key_123456" })).toBeUndefined();
    expect(problem({ ...settings, subsource: undefined })).toMatch(/Sources/);
  });
});

describe("editing a link from its configure page", () => {
  it("keeps the saved keys and AIOStreams URL when their fields are left empty", async () => {
    process.env.PUBLIC_BASE_URL = "https://sync.example";
    const { saveConfiguration } = await import("../src/configure.js");
    const { openSettings } = await import("../src/profile.js");
    const current: Settings = { subsource: KEY, subdl: "subdl_friend_key_1234", aiostreams: AIO, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include", label: "Apple TV" };
    // The form as the page sends it: key and URL fields empty, one option switched.
    const saved = await saveConfiguration({ subsource: "", subdl: "", aiostreams: "", languages: ["English", "Arabic"], allowMachine: true, hearingImpaired: "include", label: "Apple TV" }, current);
    expect("manifestUrl" in saved).toBe(true);
    const token = (saved as { manifestUrl: string }).manifestUrl.split("/").at(-2)!;
    const next = openSettings(token)!;
    expect(next.subsource).toBe(KEY);
    expect(next.subdl).toBe("subdl_friend_key_1234");
    expect(next.aiostreams).toBe(AIO);
    expect(next.allowMachine).toBe(true);
    expect(next.label).toBe("Apple TV");
  });
});

describe("editing a link in place", () => {
  it("keeps the link's URL and serves the new settings from it", async () => {
    const token = seal({ ...settings, label: `Before ${Date.now()}` });
    const response = await fetch(`${base}/${token}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subsource: "", aiostreams: "", languages: ["English", "Arabic"], allowMachine: true, hearingImpaired: "include", label: "Edited" })
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { manifestUrl: string; inPlace?: boolean };
    expect(answer.inPlace).toBe(true);
    expect(answer.manifestUrl).toBe(`https://sync.example/${token}/manifest.json`);
    // The same URL now carries the edit; the keys it was made with are still there.
    const page = await (await fetch(`${base}/${token}/configure`)).text();
    expect(page).toMatch(/name="allowMachine"[^>]* checked/);
    expect(page).toContain("Edited");
    expect(page).toContain("Saved. Leave empty to keep it");
    expect(page).not.toContain(KEY);
    expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
  });
});

describe("clearing the dashboard's errors", () => {
  it("refuses a form another site posts, and clears from the dashboard itself", async () => {
    const { noteError, statsView } = await import("../src/stats.js");
    noteError("sync", new Error("ffmpeg failed"));
    const clear = (site: string) => fetch(`${base}/stats/errors/clear`, { method: "POST", headers: { "Sec-Fetch-Site": site }, redirect: "manual" });
    expect((await clear("cross-site")).status).toBe(403);
    expect((await statsView("t")).errors.length).toBeGreaterThan(0);
    const mine = await clear("same-origin");
    expect(mine.status).toBe(303);
    expect(mine.headers.get("location")).toBe("/stats#errors");
    const view = await statsView("t");
    expect(view.errors).toEqual([]);
    expect(view.errorsClearedAt).toBeGreaterThan(0);
    // The day's count is history and stays.
    expect(view.days[0].total["errors.sync"]).toBeGreaterThan(0);
  });
});

describe("the dashboard's activity pages", () => {
  it("pages a week of activity 50 at a time, filtered across all of it", async () => {
    const { noteActivity, activityPage } = await import("../src/stats.js");
    for (let i = 0; i < 120; i++) noteActivity({ kind: i % 3 ? "list" : "download", what: `Item ${i}`, result: "synced", link: i % 2 ? "aaaa1111/one" : "bbbb2222/two", ms: 5 });
    const first = activityPage();
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0].what).toBe("Item 119"); // newest first
    expect(activityPage({ offset: 100 }).rows.length).toBeGreaterThan(0);
    // Past the end lands on the last page, never an empty one.
    expect(activityPage({ offset: 10_000 }).offset).toBe(Math.floor((first.total - 1) / 50) * 50);
    const one = activityPage({ link: "aaaa1111/one", kind: "download" });
    expect(one.rows.every((a) => a.link === "aaaa1111/one" && a.kind === "download")).toBe(true);
    expect(one.total).toBe(20);
    const response = await fetch(`${base}/stats/activity?offset=50&link=aaaa1111%2Fone`);
    const page = (await response.json()) as { html: string; offset: number; count: number; total: number; range: string };
    expect(page.offset).toBe(50);
    expect(page.range).toBe(`51–${50 + page.count} of ${page.total}`);
    expect(page.html).toContain('data-link="aaaa1111/one"');
    expect(page.html).not.toContain('data-link="bbbb2222/two"');
  });
});

describe("errors the owner can trace and undo", () => {
  it("keep the link and title they happened on, and a clear can be undone", async () => {
    const stats = await import("../src/stats.js");
    stats.requestContext.run({ link: "cccc3333/three" }, () => stats.noteError("request", new Error("SubSource 503 for /subtitles"), "English Dub · Dr. Ember S2 - 01"));
    const noted = (await stats.statsView("t")).errors.find((e) => e.message.startsWith("SubSource 503"));
    expect(noted).toMatchObject({ link: "cccc3333/three", what: "English Dub · Dr. Ember S2 - 01" });
    await stats.clearErrors();
    expect((await stats.statsView("t")).errors).toEqual([]);
    expect(stats.canUndoClear()).toBe(true);
    const undo = await fetch(`${base}/stats/errors/clear?undo=1`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" }, redirect: "manual" });
    expect(undo.status).toBe(303);
    expect((await stats.statsView("t")).errors.some((e) => e.message.startsWith("SubSource 503"))).toBe(true);
    expect(stats.canUndoClear()).toBe(false);
  });

  it("filter activity to errors, and count how this week's subtitles came out", async () => {
    const stats = await import("../src/stats.js");
    stats.noteActivity({ kind: "download", what: "A", result: "synced", link: "dddd4444/four", ms: 1 });
    stats.noteActivity({ kind: "download", what: "B", result: "synced (audio)", link: "dddd4444/four", ms: 1 });
    stats.noteActivity({ kind: "download", what: "C", result: "couldn't sync", link: "dddd4444/four", ms: 1 });
    stats.noteActivity({ kind: "download", what: "D", result: "error 500", link: "dddd4444/four", ms: 1 });
    const errorsOnly = stats.activityPage({ link: "dddd4444/four", kind: "error" });
    expect(errorsOnly.rows.map((a) => a.what)).toEqual(["D"]);
    const out = stats.syncOutcomes();
    expect(out.synced).toBeGreaterThanOrEqual(2);
    expect(out.byAudio).toBeGreaterThanOrEqual(1);
    expect(out.failed).toBeGreaterThanOrEqual(1);
  });
});

describe("signing in (ADDON_PASSWORD, ADMIN_PASSWORD)", () => {
  const login = (password: string, next: string, ip = "10.0.0.1") =>
    fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip }, body: new URLSearchParams({ password, next }) });
  const session = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
  const html = { Accept: "text/html" };

  async function withPasswords(run: () => Promise<void>) {
    const { config } = await import("../src/config.js");
    config.addonPassword = "addon-pass";
    config.adminPassword = "admin-pass";
    try {
      await run();
    } finally {
      config.addonPassword = undefined;
      config.adminPassword = undefined;
    }
  }

  it("sends pages to the login page and back, never the addon paths", () =>
    withPasswords(async () => {
      const token = seal(settings);
      const page = await fetch(`${base}/${token}/configure`, { redirect: "manual", headers: html });
      expect(page.status).toBe(303);
      expect(page.headers.get("location")).toBe(`/login?${new URLSearchParams({ next: `/${token}/configure` })}`);
      expect((await fetch(`${base}/stats`, { redirect: "manual", headers: html })).headers.get("location")).toMatch(/^\/login\?next=%2Fstats&for=admin$/);
      // A page's own script gets 401 instead of a redirect.
      expect((await fetch(`${base}/configure/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
      expect((await fetch(`${base}/manifest.json`)).status).toBe(200);
      expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
      const form = await fetch(`${base}/login?next=/configure`);
      expect(await form.text()).toContain('name="password"');
    }));

  it("opens link setup with the addon password, and everything with the admin password", () =>
    withPasswords(async () => {
      const addon = await login("addon-pass", "/configure");
      expect(addon.status).toBe(303);
      expect(addon.headers.get("location")).toBe("/configure");
      expect(addon.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
      expect((await fetch(`${base}/configure`, { headers: { Cookie: session(addon) } })).status).toBe(200);
      expect((await fetch(`${base}/stats`, { redirect: "manual", headers: { ...html, Cookie: session(addon) } })).status).toBe(303);
      expect((await login("addon-pass", "/stats")).status).toBe(403);
      const admin = await login("admin-pass", "/stats");
      expect(admin.headers.get("location")).toBe("/stats");
      expect((await fetch(`${base}/stats`, { headers: { Cookie: session(admin) } })).status).toBe(200);
      expect((await fetch(`${base}/configure`, { headers: { Cookie: session(admin) } })).status).toBe(200);
    }));

  it("refuses forged or altered sessions, and goes back only to this site", () =>
    withPasswords(async () => {
      const { sessionValue } = await import("../src/access.js");
      const real = sessionValue(["addon"]);
      const [body, mac] = real.split(".");
      const forged = `${Buffer.from(JSON.stringify({ r: ["admin"], e: Date.now() + 1e9 })).toString("base64url")}.${mac}`;
      expect((await fetch(`${base}/configure`, { redirect: "manual", headers: { ...html, Cookie: `aiosub_session=${forged}` } })).status).toBe(303);
      expect((await fetch(`${base}/configure`, { headers: { Cookie: `aiosub_session=${body}.${mac}` } })).status).toBe(200);
      expect((await login("addon-pass", "https://evil.example/")).headers.get("location")).toBe("/configure");
      expect((await login("addon-pass", "//evil.example/")).headers.get("location")).toBe("/configure");
    }));

  it("slows down wrong passwords and stops them after five", () =>
    withPasswords(async () => {
      for (let i = 0; i < 5; i++) expect((await login("wrong", "/configure", "10.9.9.9")).status).toBe(401);
      // Even the right one is refused from that address for now; another address is fine.
      expect((await login("addon-pass", "/configure", "10.9.9.9")).status).toBe(429);
      expect((await login("addon-pass", "/configure", "10.8.8.8")).status).toBe(303);
    }), 20000);

  it("logs out, and shows the button only to someone signed in", async () => {
    const out = await fetch(`${base}/logout`, { method: "POST", redirect: "manual" });
    expect(out.headers.get("set-cookie")).toMatch(/^aiosub_session=; Path=\/; Max-Age=0/);
    const { config } = await import("../src/config.js");
    config.adminPassword = "admin-pass";
    try {
      // Setup stays open with only the admin password set, and a friend there sees no Log out.
      const open = await fetch(`${base}/configure`);
      expect(open.status).toBe(200);
      expect(await open.text()).not.toContain('action="/logout"');
      const admin = await login("admin-pass", "/configure", "10.7.7.7");
      expect(await (await fetch(`${base}/configure`, { headers: { Cookie: session(admin) } })).text()).toContain('action="/logout"');
      expect(await (await fetch(`${base}/stats`, { headers: { Cookie: session(admin) } })).text()).toContain('action="/logout"');
    } finally {
      config.adminPassword = undefined;
    }
  });
});

describe("the link the dashboard's Edit opens", () => {
  it("isn't changed by opening a link's configure page or manifest", async () => {
    const { knownLinks } = await import("../src/profile.js");
    const copy = seal({ ...settings, languages: ["English"] });
    const before = JSON.stringify(knownLinks());
    expect((await fetch(`${base}/${copy}/configure`)).status).toBe(200);
    expect((await fetch(`${base}/${copy}/manifest.json`)).status).toBe(200);
    expect(JSON.stringify(knownLinks())).toBe(before);
  });
});
