/**
 * Who can open the pages people use in a browser, the way AIOMetadata does it: ADDON_PASSWORD for
 * the configure page (making and editing links) and ADMIN_PASSWORD for the dashboard. The admin
 * password opens the configure page too, since the dashboard links to every link's configure page.
 * The addon paths AIOStreams and players call never ask. A password left unset leaves its pages
 * open, for a server whose reverse proxy asks for a login.
 *
 * Signing in sets a session cookie for SESSION_DAYS: the roles it opens, an expiry and an HMAC over
 * both, keyed by CONFIG_SECRET and the passwords, so changing a password signs everyone out. It is
 * SameSite=Lax: following a link from AIOStreams' Reconfigure button keeps you signed in, while a
 * form or fetch from another site doesn't carry it.
 *
 * Wrong passwords are slowed down per address (a second each) and, after LOGIN_MAX_FAILS in
 * LOGIN_WINDOW_MS, refused for the rest of that window. The configure checks, which call SubSource,
 * SubDL and AIOStreams, are limited to CHECK_MAX per minute per address.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Response } from "express";
import { config } from "./config.js";
import { escapeHtml, headTags, icon, MARK, SHARED_CSS } from "./ui.js";

export type Role = "addon" | "admin";

const COOKIE = "aiosub_session";
const SESSION_DAYS = 30;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_DELAY_MS = 1000;
const CHECK_MAX = 30;

const digest = (text: string) => createHash("sha256").update(text).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** The password a role needs, or undefined when that role's pages are open. */
function passwordFor(role: Role): string | undefined {
  return role === "admin" ? config.adminPassword : config.addonPassword;
}

/** Whether any password is set, so the pages show a Log out button. */
export function authEnabled(): boolean {
  return Boolean(config.addonPassword || config.adminPassword);
}

function sessionKey(): Buffer {
  return createHash("sha256").update(`session|${config.configSecret ?? ""}|${config.addonPassword ?? ""}|${config.adminPassword ?? ""}`).digest();
}

function sign(body: string): string {
  return createHmac("sha256", sessionKey()).update(body).digest("base64url");
}

/** A session cookie's value for these roles. */
export function sessionValue(roles: Role[], now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ r: roles, e: now + SESSION_DAYS * 86400_000 })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The roles a request's session opens; none without a valid, unexpired session. */
export function sessionRoles(req: Request): Role[] {
  const raw = (req.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return [];
  const [body, mac] = raw.split(".");
  if (!body || !mac || !same(mac, sign(body))) return [];
  try {
    const { r, e } = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { r: Role[]; e: number };
    return Array.isArray(r) && typeof e === "number" && e > Date.now() ? r : [];
  } catch {
    return [];
  }
}

/** Whether the request may open a role's pages: no password for it, or a session that opens it (admin opens both). */
export function allowed(req: Request, role: Role): boolean {
  if (!passwordFor(role)) return true;
  const roles = sessionRoles(req);
  return roles.includes(role) || (role === "addon" && roles.includes("admin"));
}

/** Only a path on this site to go back to after signing in. */
function safeNext(raw: unknown): string {
  const next = typeof raw === "string" ? raw : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/configure";
}

/**
 * Lets the request through when it may open the role's pages. Otherwise a page is sent to the
 * login page and back, and a request from a page's own script gets 401.
 */
export function requireRole(role: Role): RequestHandler {
  return (req, res, next) => {
    if (allowed(req, role)) {
      next();
      return;
    }
    res.set("Cache-Control", "no-store");
    if (req.method === "GET" && req.accepts(["html", "json"]) === "html") {
      res.redirect(303, `/login?${new URLSearchParams({ next: req.originalUrl, ...(role === "admin" ? { for: "admin" } : {}) })}`);
      return;
    }
    res.status(401).json({ error: "Signed out. Reload the page to sign in again" });
  };
}

// ---------- rate limits ----------

const failures = new Map<string, number[]>();

function recentFails(ip: string, now = Date.now()): number[] {
  const kept = (failures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (kept.length) failures.set(ip, kept);
  else failures.delete(ip);
  return kept;
}

const checks = new Map<string, number[]>();

/** At most CHECK_MAX of the configure page's checks and saves per minute per address. */
export const checkLimit: RequestHandler = (req, res, next) => {
  const ip = req.ip ?? "?";
  const now = Date.now();
  const kept = (checks.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (kept.length >= CHECK_MAX) {
    res.set("Retry-After", "60").status(429).json({ error: "Too many tries in a minute. Wait a moment and try again" });
    return;
  }
  kept.push(now);
  checks.set(ip, kept);
  next();
};

/** Forgets old entries now and then, so the maps don't grow. */
setInterval(() => {
  const now = Date.now();
  for (const ip of failures.keys()) recentFails(ip, now);
  for (const [ip, times] of checks) if (!times.some((t) => now - t < 60_000)) checks.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- the login page ----------

function cookie(req: Request, value: string, maxAgeSeconds: number): string {
  return [`${COOKIE}=${value}`, "Path=/", `Max-Age=${maxAgeSeconds}`, "HttpOnly", "SameSite=Lax", ...(req.secure ? ["Secure"] : [])].join("; ");
}

export function loginPage(next: string, forAdmin: boolean, error?: string): string {
  const what = forAdmin ? "the dashboard" : "link setup";
  return `<!doctype html>
<html lang="en">
<head>
${headTags("Sign in · AIOSubtitles")}
<style>${SHARED_CSS}
  .login { display: grid; place-items: center; min-height: calc(100vh / var(--zoom)); padding: 24px 16px; }
  .login-card { width: 100%; max-width: 380px; display: grid; gap: 20px; padding: 28px; background: var(--paper); border: 1px solid var(--border); border-radius: var(--radius-xl); animation: rise .4s var(--ease); }
  .login-head { display: flex; align-items: center; gap: 12px; }
  .login-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--white); letter-spacing: -.01em; }
  .login-text { margin: 0; font-size: 14px; color: var(--muted); }
  .login label { display: block; margin-bottom: 8px; font-weight: 500; font-size: 14px; color: var(--white); }
  .login input { width: 100%; height: 44px; padding: 0 12px; background: var(--field); border: 1px solid var(--control-border); border-radius: var(--radius); color: var(--white); font: 15px var(--font); }
  .login input:focus { outline: none; border-color: var(--brand-400); box-shadow: 0 0 0 3px rgba(97,82,223,.3); }
  .login-error { display: flex; gap: 8px; margin: 0; font-size: 13.5px; color: var(--red); }
  .login-error .i { margin-top: 2px; }
  .login button { width: 100%; height: 46px; border-radius: var(--radius); border: 1px solid rgba(159,146,255,.3); background: rgba(97,82,223,.82); color: #fff; font: 500 15px var(--font); cursor: pointer; }
  .login button:hover { background: rgba(97,82,223,.98); }
</style>
</head>
<body>
<main class="login">
  <form class="login-card" method="post" action="/login">
    <div class="login-head">${MARK}<h1 class="login-title">Sign in</h1></div>
    <p class="login-text">Enter the password for ${what}.</p>
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <div>
      <label for="password">Password</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required autofocus${error ? ' aria-describedby="login-error" aria-invalid="true"' : ""}>
    </div>
    ${error ? `<p class="login-error" id="login-error" role="alert">${icon("alert", "i xs")}<span>${escapeHtml(error)}</span></p>` : ""}
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

/** /login and /logout. */
export function accessRoutes(): express.Router {
  const router = express.Router();

  router.get("/login", (req, res) => {
    const next = safeNext(req.query.next);
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    if (!authEnabled()) {
      res.redirect(303, next);
      return;
    }
    res.type("html").send(loginPage(next, req.query.for === "admin"));
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), async (req: Request, res: Response) => {
    const next = safeNext(req.body?.next);
    const forAdmin = next.startsWith("/stats");
    const ip = req.ip ?? "?";
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    if (recentFails(ip).length >= LOGIN_MAX_FAILS) {
      res.status(429).type("html").send(loginPage(next, forAdmin, "Too many wrong passwords. Try again in 15 minutes."));
      return;
    }
    const given = typeof req.body?.password === "string" ? req.body.password : "";
    const roles: Role[] = [];
    if (config.adminPassword && same(given, config.adminPassword)) roles.push("admin", "addon");
    else if (config.addonPassword && same(given, config.addonPassword)) roles.push("addon");
    if (roles.length === 0) {
      failures.set(ip, [...recentFails(ip), Date.now()]);
      await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
      console.log("login: wrong password");
      res.status(401).type("html").send(loginPage(next, forAdmin, "That password isn't right."));
      return;
    }
    if (forAdmin && config.adminPassword && !roles.includes("admin")) {
      res.status(403).type("html").send(loginPage(next, true, "That password opens link setup, not the dashboard."));
      return;
    }
    failures.delete(ip);
    res.set("Set-Cookie", cookie(req, sessionValue(roles), SESSION_DAYS * 86400));
    res.redirect(303, next);
  });

  router.post("/logout", (req, res) => {
    res.set("Set-Cookie", cookie(req, "", 0));
    res.set("Cache-Control", "no-store");
    res.redirect(303, "/login");
  });

  return router;
}

/** The Log out button for a page's rail, for someone who is signed in. */
export function logoutButton(signedIn: boolean): string {
  return signedIn
    ? `<form method="post" action="/logout" class="rail-form"><button type="submit" class="rail-link rail-button">${icon("key", "i xs")}Log out</button></form>`
    : "";
}
