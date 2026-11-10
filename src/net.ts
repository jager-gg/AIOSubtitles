/**
 * Fetching from addresses a third party gave us (a subtitle addon someone
 * added, and the subtitle URLs it answers with). Only public https hosts are
 * fetched, redirects included, so an addon can't point this server at
 * itself, at the Docker network (aiostreams, aiosubtitles) or at a home LAN.
 *
 * A name is judged twice: as written (publicHttpsUrl), and by the addresses it resolves to
 * (fetchPublic), since a public-looking name can have a DNS record that points at a private
 * address. The look-up and the fetch are separate, so a name whose record changes between the two
 * still gets through; https stops that mattering much, as the private host would have to hold a
 * valid certificate for the name.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** Whether an IP address is one only this machine or its own networks can reach. */
export function privateAddress(address: string): boolean {
  const host = address.toLowerCase();
  const ip = isIP(host);
  if (ip === 4) return PRIVATE_V4.some((range) => range.test(host));
  if (ip === 6) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.5) is judged as that IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
    if (mapped) return privateAddress(mapped);
    return host === "::1" || host === "::" || /^f[cd]|^fe[89ab]|^::ffff:/.test(host);
  }
  return true; // not an address at all
}

/** Whether a host name resolves only to public addresses. An address is checked as it is. */
async function resolvesPublic(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !privateAddress(host);
  try {
    const found = await lookup(host, { all: true });
    return found.length > 0 && found.every((a) => !privateAddress(a.address));
  } catch {
    return false; // a name that doesn't resolve can't be fetched either
  }
}

/** An https URL on a public host name or address, or undefined. */
export function publicHttpsUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return undefined;
  const ip = isIP(host);
  if (ip !== 0 && privateAddress(host)) return undefined;
  // A bare name ("aiostreams", "aiosubtitles") is a container on the Docker network.
  if (ip === 0 && !host.includes(".")) return undefined;
  return url;
}

/** fetch() for third-party URLs: public https only (by name and by where the name leads), at most 3 redirects, each one checked. */
export async function fetchPublic(raw: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  let url = publicHttpsUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    if (!url) throw new Error("not a public https address");
    if (!(await resolvesPublic(url.hostname))) throw new Error("not a public https address (the name leads to a private one, or nowhere)");
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!next) return response;
    await response.body?.cancel();
    url = publicHttpsUrl(new URL(next, url).toString());
  }
  throw new Error("too many redirects");
}

/** The body, refused past maxBytes (subtitles are small; anything big isn't one). */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error("response too large");
  return body;
}
