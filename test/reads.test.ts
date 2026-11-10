import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { fetchPublic, privateAddress } from "../src/net.js";
import { checkReads, noteRead, noteReadOk, noteRefusal, ReadsPaused, refusalStatus, resetReads } from "../src/reads.js";

const FILE = "https://cdn.debrid.example/dl/abc/Show.S01E01.mkv";
const MIN = 60_000;

describe("pausing reads when the file's host refuses", () => {
  beforeEach(() => resetReads());

  it("reads the refusal out of ffmpeg's and a range read's errors", () => {
    expect(refusalStatus("Command failed: ffmpeg -i <url>\n[https @ 0x55] Server returned 403 Forbidden (access denied)")).toBe(403);
    expect(refusalStatus("[https @ 0x55] HTTP error 429 Too Many Requests")).toBe(429);
    expect(refusalStatus("range read refused (HTTP 429)")).toBe(429);
    expect(refusalStatus("Server returned 404 Not Found")).toBeUndefined();
    // A number in the address is not a status.
    expect(refusalStatus("Command failed: ffprobe https://host.example/403/file.mkv\nInvalid data found")).toBeUndefined();
  });

  it("pauses at once on 429, for that host only", () => {
    expect(noteRefusal(FILE, 429, 0)).toBe(5 * MIN);
    expect(() => checkReads(FILE, 4 * MIN)).toThrow(ReadsPaused);
    expect(() => checkReads("https://other.example/file.mkv", 4 * MIN)).not.toThrow();
    expect(() => checkReads(FILE, 5 * MIN + 1)).not.toThrow();
  });

  it("takes three 403s in a row to pause: one is usually an expired link", () => {
    expect(noteRefusal(FILE, 403, 0)).toBe(0);
    expect(noteRefusal(FILE, 403, 0)).toBe(0);
    expect(() => checkReads(FILE, 1)).not.toThrow();
    expect(noteRefusal(FILE, 403, 0)).toBe(5 * MIN);
    expect(() => checkReads(FILE, 1)).toThrow(/HTTP 403/);
  });

  it("starts over after a read that works", () => {
    noteRefusal(FILE, 403, 0);
    noteRefusal(FILE, 403, 0);
    noteReadOk(FILE);
    expect(noteRefusal(FILE, 403, 0)).toBe(0);
  });

  it("doubles the pause while the host keeps refusing, up to an hour", () => {
    const pauses = [0, 1, 2, 3, 4, 5].map(() => noteRefusal(FILE, 429, 0));
    expect(pauses).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 40 * MIN, 60 * MIN, 60 * MIN]);
    noteReadOk(FILE);
    expect(noteRefusal(FILE, 429, 0)).toBe(5 * MIN);
  });
});

describe("the daily read limit", () => {
  const before = config.dailyReadGb;
  afterEach(() => {
    config.dailyReadGb = before;
  });

  it("stops new reads once the day's bytes are spent, and 0 means no limit", () => {
    config.dailyReadGb = 1000;
    expect(() => checkReads()).not.toThrow();
    noteRead(3_000_000);
    config.dailyReadGb = 0.002; // 2 MB
    expect(() => checkReads()).toThrow(/read limit/);
    config.dailyReadGb = 0;
    expect(() => checkReads()).not.toThrow();
  });
});

describe("a public name that leads to a private address", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(lookup).mockClear();
  });

  it("knows private addresses, IPv4 written as IPv6 included", () => {
    for (const a of ["10.0.0.5", "172.18.0.5", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.5", "::ffff:192.168.1.1"]) expect(privateAddress(a), a).toBe(true);
    for (const a of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) expect(privateAddress(a), a).toBe(false);
  });

  it("is refused before anything is fetched", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "172.18.0.5", family: 4 }] as never);
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/private/);
    // One private address among public ones is enough.
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }] as never);
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/private/);
    // A name that doesn't resolve isn't fetched either.
    vi.mocked(lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/public https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is refused as a redirect target too, and a public name is fetched", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://inside.example.com/x" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never).mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }] as never);
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/private/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const ok = vi.fn(async () => new Response("fine"));
    vi.stubGlobal("fetch", ok);
    expect(await (await fetchPublic("https://subs.example.com/manifest.json", 1000)).text()).toBe("fine");
  });
});
