import { describe, expect, it } from "vitest";
import { describe as describeRequest, syncedLabel } from "../src/app.js";

describe("synced track labels", () => {
  it("names synced tracks so they stand apart from other addons' plain language", () => {
    expect(syncedLabel("ara")).toBe("Arabic (Synced)");
    expect(syncedLabel("eng")).toBe("English (Synced)");
    expect(syncedLabel("Arabic")).toBe("Arabic (Synced)");
    expect(syncedLabel("french")).toBe("French (Synced)");
  });

  it("names unsynced tracks after the addon too, not a plain language", async () => {
    const { unsyncedLabel } = await import("../src/app.js");
    expect(unsyncedLabel("Arabic")).toBe("Arabic · AIOSubtitles");
    expect(unsyncedLabel("ara")).toBe("Arabic · AIOSubtitles");
  });
});

describe("track descriptions (AIOStreams' label)", async () => {
  const { trackLabel } = await import("../src/app.js");
  it("names the addon on every track", () => {
    expect(trackLabel(undefined, true)).toBe("English Dub · Synced · AIOSubtitles");
    expect(trackLabel(undefined, false)).toBe("English Dub · AIOSubtitles");
    expect(trackLabel("Arabic", true)).toBe("Synced · AIOSubtitles");
    expect(trackLabel("Arabic", false)).toBe("AIOSubtitles");
  });

  it("marks timing by speech in the audio apart", async () => {
    const { audioLabel } = await import("../src/app.js");
    expect(trackLabel("Arabic", true, "synced")).toBe("Synced by audio · AIOSubtitles");
    expect(trackLabel(undefined, true, "synced")).toBe("English Dub · Synced by audio · AIOSubtitles");
    expect(trackLabel("Arabic", false, "synced")).toBe("AIOSubtitles");
    expect(audioLabel("ara")).toBe("Arabic (Synced by audio)");
  });

  it("doesn't claim an audio sync that hasn't finished", async () => {
    const { audioLabel } = await import("../src/app.js");
    expect(trackLabel("Arabic", true, "trying")).toBe("Trying audio sync · AIOSubtitles");
    expect(trackLabel(undefined, true, "trying")).toBe("English Dub · Trying audio sync · AIOSubtitles");
    expect(audioLabel("ara", "trying")).toBe("Arabic (Trying audio sync)");
  });

  it("puts the episode in front of a file named by a random id, in the activity list", () => {
    expect(describeRequest("po0xCP6G.mkv", "tt0000006:3:8", 3, 8)).toBe("S03E08 · po0xCP6G");
    expect(describeRequest("The.Analyst.S03E09.1080p.mkv", "tt0000006:3:9", 3, 9)).toBe("The.Analyst.S03E09.1080p");
    expect(describeRequest("[LanternGuild] Iron Lantern 013 (BD 1080p).mkv", "kitsu:1", 1, 13)).toBe("[LanternGuild] Iron Lantern 013 (BD 1080p)");
    expect(describeRequest(undefined, "tt0000006:3:8", 3, 8)).toBe("tt0000006:3:8");
  });
});

describe("track names a player's preferred language picks", async () => {
  const { sentLanguage } = await import("../src/app.js");
  const { profileFromSettings } = await import("../src/profile.js");
  const base = { subsource: "sk_friends_own_key_1234", languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" as const };
  it("sends the language alone by default, links made before included", () => {
    const profile = profileFromSettings(base, "t");
    expect(sentLanguage(profile, { lang: "Arabic (Synced)", code: "Arabic" })).toBe("Arabic");
    expect(sentLanguage(profile, { lang: "Arabic · AIOSubtitles", code: "ara" })).toBe("Arabic");
    expect(sentLanguage(profile, { lang: "English Dub" })).toBe("English");
  });
  it("keeps the status in the name when the link asks for it", () => {
    const profile = profileFromSettings({ ...base, statusInName: true }, "t");
    expect(sentLanguage(profile, { lang: "Arabic (Synced)", code: "Arabic" })).toBe("Arabic (Synced)");
    expect(sentLanguage(profile, { lang: "English Dub" })).toBe("English Dub");
  });
});

describe("listing synced subtitles only", async () => {
  const { profileFromSettings } = await import("../src/profile.js");
  const { configurePage } = await import("../src/page.js");
  const base = { subsource: "sk_friends_own_key_1234", languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" as const };
  it("is off for links made before the switch, on when the link asks", () => {
    expect(profileFromSettings(base, "t").hideUnsynced).toBe(false);
    expect(profileFromSettings({ ...base, hideUnsynced: true }, "t").hideUnsynced).toBe(true);
  });
  it("shows its switch on the configure page, set from the link", () => {
    expect(configurePage()).toMatch(/name="hideUnsynced"(?![^>]*checked)/);
    expect(configurePage({ ...base, hideUnsynced: true })).toMatch(/name="hideUnsynced"[^>]*checked/);
  });
});

describe("English Dub and regular English", async () => {
  const { profileFromSettings, REGULAR_ENGLISH, linkSummary, sealSettings } = await import("../src/profile.js");
  const { configurePage } = await import("../src/page.js");
  const base = { subsource: "sk_friends_own_key_1234", allowMachine: false, hearingImpaired: "include" as const };
  it("keeps English meaning the dub captions, as links always have", () => {
    const profile = profileFromSettings({ ...base, languages: ["English", "Arabic"] }, "t");
    expect(profile.dub).toBe(true);
    expect(profile.extraLanguages).toEqual([{ name: "arabic", code: "Arabic" }]);
  });
  it("adds regular English as a language of its own, beside the dub or without it", () => {
    const both = profileFromSettings({ ...base, languages: ["English", REGULAR_ENGLISH] }, "t");
    expect(both.dub).toBe(true);
    expect(both.extraLanguages).toEqual([{ name: "english", code: "English" }]);
    const regularOnly = profileFromSettings({ ...base, languages: [REGULAR_ENGLISH, "Arabic"] }, "t");
    expect(regularOnly.dub).toBe(false);
    expect(regularOnly.extraLanguages.map((l) => l.code)).toEqual(["English", "Arabic"]);
  });
  it("shows both chips with what each is for, and names them apart on the dashboard", async () => {
    const html = configurePage({ ...base, languages: [REGULAR_ENGLISH] });
    expect(html).toMatch(/value="English"><span>English Dub<\/span><\/label>/);
    expect(html).toMatch(/value="English Subtitles" checked><span>English<\/span>/);
    expect(html).toContain("only matter for anime and other shows not made in English");
    const { config } = await import("../src/config.js");
    config.configSecret ??= "label-test-secret-label-test-secret-1";
    expect(linkSummary(sealSettings({ ...base, languages: ["English", REGULAR_ENGLISH] }))?.languages).toEqual(["English Dub", "English"]);
  });
});
