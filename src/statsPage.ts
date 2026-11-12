/**
 * The dashboard (/stats): what AIOSubtitles itself costs this server, and nothing
 * else on the machine. Every number comes from the addon's own container:
 * CPU time (AIOSubtitles and the ffmpeg it starts), memory, data downloaded
 * and sent, and the cache on disk. Same shell as the configure page; the
 * daily charts are plain HTML columns with a tooltip, and the table under
 * them is their exact-numbers view.
 */
import { ACTIVITY_PAGE, ERRORS_KEPT, type KeyUsage, type StatsView } from "./stats.js";
import { config } from "./config.js";
import { escapeHtml, headTags, icon, rail, SHARED_CSS } from "./ui.js";
import { logoutButton } from "./access.js";

/** "1–50 of 1,240". */
export function pageRange(offset: number, count: number, total: number): string {
  if (!total) return "Nothing matches these filters";
  return `${n(offset + 1)}–${n(offset + count)} of ${n(total)}`;
}

/** Activity rows, the same on the first page and every page fetched after it. */
export function activityRows(rows: StatsView["activity"], names: Record<string, string>): string {
  const who = (id: string) => {
    const name = names[id] ?? names[id.split("/")[0]];
    return name ? `<span class="who" title="${escapeHtml(id)}">${escapeHtml(name)}</span>` : `<span class="mono">${escapeHtml(id)}</span>`;
  };
  let day = "";
  return rows
    .map((a) => {
      const bad = a.result.startsWith("error");
      const thisDay = dayOf(a.at);
      const heading = thisDay === day ? "" : `<li class="act-day"><time datetime="${new Date(a.at).toISOString().slice(0, 10)}">${dayName(a.at)}</time></li>`;
      day = thisDay;
      return `${heading}<li class="act" data-link="${escapeHtml(a.link)}" data-kind="${a.kind}"><span class="act-when">${clockTag(a.at)}</span><span class="act-kind ${a.kind}">${a.kind === "list" ? "List" : "Subtitle"}</span><span class="act-what" title="${escapeHtml(a.what)}">${escapeHtml(a.what)}</span><span class="act-meta"><span class="act-result${bad ? " bad" : ""}"><span class="sr-only">Result: </span>${escapeHtml(a.result)}</span><span class="act-link"><span class="sr-only">Link: </span>${who(a.link)}</span></span><span class="act-ms"><span class="sr-only">Took </span>${a.ms >= 1000 ? `${(a.ms / 1000).toFixed(1)} s` : `${a.ms} ms`}</span></li>`;
    })
    .join("");
}

/** The calendar day of a moment on the dashboard's clock, as "2026-11-10". */
const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: config.timeZone }).format(ms);
/** "Today", "Yesterday", or "Sun 8 Nov", on the dashboard's clock. */
function dayName(ms: number): string {
  const day = dayOf(ms);
  if (day === dayOf(Date.now())) return "Today";
  if (day === dayOf(Date.now() - 86_400_000)) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: config.timeZone }).format(ms);
}
/** "22:46" today, "yesterday 22:46", "Sun 8 Nov 22:46" before that. */
const when = (ms: number) => {
  const name = dayName(ms);
  return name === "Today" ? hhmm(ms) : `${name === "Yesterday" ? "yesterday" : name} ${hhmm(ms)}`;
};

/** "21:52" on the dashboard's clock (config.timeZone, UTC unless set), the same for every viewer. */
const hhmm = (ms: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: config.timeZone }).format(ms);
const clockTag = (ms: number) => `<time datetime="${new Date(ms).toISOString()}">${hhmm(ms)}</time>`;
/** "4 h 12 min", "35 min". */
const span = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
};

type Counters = Record<string, number>;

const n = (value: number | undefined) => (value ? Math.round(value).toLocaleString("en-US") : "0");
const sum = (counters: Counters, prefix: string, suffix = "") =>
  Object.entries(counters).reduce((total, [k, v]) => (k.startsWith(prefix) && k.endsWith(suffix) && k !== "lastSeen" ? total + v : total), 0);

function bytes(value: number): string {
  const one = (v: number) => (Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v).toString() : v.toFixed(1));
  if (value >= 1e9) return `${one(value / 1e9)} GB`;
  if (value >= 1e6) return `${one(value / 1e6)} MB`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`;
  return `${Math.round(value)} B`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const whole = Math.round(seconds);
    const rest = whole % 60;
    return `${Math.floor(whole / 60)} min${rest ? ` ${rest} s` : ""}`;
  }
  const h = Math.floor(seconds / 3600);
  return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} h ${Math.floor((seconds % 3600) / 60)} min`;
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function dayLabel(date: string, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Yesterday";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** ffmpeg and ffprobe wall time, seconds. */
const procSeconds = (c: Counters) => sum(c, "proc.", ".ms") / 1000;
/** CPU time of the whole container (AIOSubtitles and its ffmpeg), seconds; days before it was counted have Node's own. */
const cpuSeconds = (c: Counters) => (c["own.cpu.ms"] ?? c["cpu.ms"] ?? 0) / 1000;
const downloaded = (c: Counters) => c["net.rx"] ?? 0;
const sent = (c: Counters) => c["net.tx"] ?? 0;
const apiCalls = (c: Counters) => sum(c, "api.") - sum(c, "api.", ".fail");

type Level = "ok" | "warn" | "bad";

/** A status always says its state in words next to the colour. */
function status(level: Level, words: string): string {
  return `<span class="status ${level}"><span class="dot" aria-hidden="true"></span>${words}</span>`;
}

function meterCard(opts: { label: string; value: string; hint: string; share?: number; level?: Level; words?: string }): string {
  const { label, value, hint, share, level, words } = opts;
  const meter =
    share === undefined
      ? ""
      : `<div class="meter" role="meter" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(share * 100))}" aria-valuetext="${Math.round(share * 100)}%"><span class="meter-fill ${level ?? "ok"}" style="width:${Math.max(2, Math.min(100, share * 100)).toFixed(1)}%"></span></div>`;
  return `<section class="tile-card">
      <div class="tile-head"><h3 class="tile-label">${label}</h3>${level && words ? status(level, words) : ""}</div>
      <p class="tile-value">${value}</p>
      ${meter}
      <p class="hint">${hint}</p>
    </section>`;
}

function card(title: string, description: string, body: string, id?: string): string {
  const head = title || description ? `<div class="card-head">${title ? `<h3 class="card-title"${id ? ` id="${id}-title"` : ""}>${title}</h3>` : ""}${description ? `<p class="card-desc">${description}</p>` : ""}</div>` : "";
  return `<section class="settings-card"${id ? ` id="${id}"` : ""}>${head}<div class="card-body">${body}</div></section>`;
}

/** A round top for a scale whose half is round too: "2 min / 1 min", "4 MB / 2 MB", never "5 s / 3 s". */
function niceTop(max: number, time: boolean): number {
  if (max <= 0) return time ? 60 : 1e6;
  if (time) return [2, 4, 10, 20, 40, 60, 120, 240, 600, 1200, 2400, 3600, 7200, 14400, 28800, 86400].find((v) => v >= max) ?? Math.ceil(max / 86400) * 86400;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 4, 10].map((m) => m * p).find((v) => v >= max) ?? max;
}

/** One column chart over the 14 days, oldest on the left; columns are for the pointer, the table has every number. */
function columnChart(view: StatsView, opts: { title: string; hint: string; value: (c: Counters) => number; format: (v: number) => string; time: boolean; detail: (c: Counters) => string }): string {
  const chronological = [...view.days].reverse();
  const values = chronological.map((d) => opts.value(d.total));
  const top = niceTop(Math.max(...values), opts.time);
  const columns = chronological
    .map((day, i) => {
      const index = view.days.length - 1 - i;
      const v = values[i];
      const label = dayLabel(day.date, index);
      const height = v ? Math.max(3, (v / top) * 100) : 0;
      const tick = new Date(`${day.date}T12:00:00Z`).getUTCDate();
      return `<div class="col${index === 0 ? " today" : ""}" data-day="${escapeHtml(label)}" data-detail="${escapeHtml(v ? opts.detail(day.total) : "Nothing used")}">
          <span class="col-plot"><span class="col-bar" style="height:${height.toFixed(1)}%"></span></span>
          <span class="col-tick">${index === 0 ? "Today" : tick}</span>
        </div>`;
    })
    .join("");
  const week = values.slice(-7).reduce((a, b) => a + b, 0);
  if (values.every((v) => !v)) {
    return `<div class="chart">
      <div class="chart-head"><h3 class="chart-title">${opts.title}</h3><p class="hint">${opts.hint}</p></div>
      <p class="chart-empty">${icon("chart", "i xs")}Nothing counted yet. Days fill in as the addon is used.</p>
    </div>`;
  }
  return `<div class="chart">
      <div class="chart-head"><h3 class="chart-title">${opts.title}</h3><p class="hint">${opts.hint}</p></div>
      <div class="plot" role="img" aria-label="${escapeHtml(`${opts.title} over 14 days, ${opts.format(week)} in the last 7. Each day's numbers are listed below the charts.`)}">
        <div class="grid-line top"><span>${opts.format(top)}</span></div>
        <div class="grid-line mid"><span>${opts.format(top / 2)}</span></div>
        <div class="grid-line zero"><span>0</span></div>
        <div class="cols" aria-hidden="true">${columns}</div>
      </div>
      <div class="tip" aria-hidden="true" hidden><strong class="tip-value"></strong><span class="tip-day"></span></div>
    </div>`;
}

export function statsPage(view: StatsView, signedIn = false): string {
  const { now } = view;
  const today = view.days[0];
  const week = view.days.slice(0, 7);
  const weekTotal: Counters = {};
  for (const day of week) for (const [k, v] of Object.entries(day.total)) weekTotal[k] = (weekTotal[k] ?? 0) + v;
  const fmtTime = (s: number) => (s ? duration(s) : "0 s");
  // A link by the owner's name for it when there is one (by full id, or its AIOStreams uuid prefix).
  const nameOf = (id: string) => view.names[id] ?? view.names[id.split("/")[0]];

  // ---------- API keys: each key's calls against its free plan ----------
  // SubSource's free plan (its API docs): 60 calls a minute, 1,800 an hour, 7,200 a day, counted
  // over windows that start at a key's first call. SubDL's (its dashboard): 2,000 calls and 50
  // downloads a day, reset at midnight UTC, the same day this page counts.
  const keyIds = new Set([...Object.keys(view.windows), ...week.flatMap((d) => Object.keys(d.keys ?? {}))]);
  const limits: Array<{ what: string; used: number; max: number }> = [];
  // One limit: what's used of it, a thin bar, and one short line that says what to expect (when it
  // resets, the busiest minute); where the count comes from is in the hover text.
  const meterRow = (label: string, used: number, max: number, note: string, spoken: string, detail = "") => {
    const share = used / max;
    const level: Level = share >= 0.9 ? "bad" : share >= 0.6 ? "warn" : "ok";
    return `<div class="km"${detail ? ` title="${escapeHtml(detail)}"` : ""}>
        <div class="km-top"><span class="km-label">${label}${note ? `<span class="km-note"> · ${note}</span>` : ""}</span><span class="km-val"><b>${n(used)}</b>/${n(max)}<span class="km-pct ${level}">${share < 0.01 && used ? "<1" : Math.round(share * 100)}%</span></span></div>
        <div class="meter" role="meter" aria-label="${escapeHtml(spoken)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${Math.min(used, max)}" aria-valuetext="${n(used)} of ${n(max)}"><span class="meter-fill ${level}" style="width:${Math.max(used ? 1 : 0, Math.min(100, share * 100)).toFixed(1)}%"></span></div>
      </div>`;
  };
  // SubDL's day ends at midnight UTC: when that is on the dashboard's clock, and how long until then.
  const utcMidnight = (() => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); })();
  const keyBlock = (id: string) => {
    const [service, tag] = id.split(":");
    const todayUse: KeyUsage = view.days[0].keys?.[id] ?? { calls: 0, refused: 0, busiestMinute: 0 };
    const w = view.windows[id] ?? { minute: 0, hour: 0, day: 0 };
    let weekCalls = 0;
    let refused = 0;
    let lastRefused = 0;
    let last: KeyUsage | undefined;
    for (const day of week) {
      const u = day.keys?.[id];
      if (!u) continue;
      weekCalls += u.calls;
      refused += u.refused;
      lastRefused = Math.max(lastRefused, u.lastRefusedAt ?? 0);
      if (!last || (u.lastAt ?? 0) > (last.lastAt ?? 0)) last = u;
    }
    const name = service === "subsource" ? "SubSource" : service === "subdl" ? "SubDL" : service;
    // SubSource sends its own count with every reply (x-ratelimit-remaining, -hour, -day): that is
    // the real one, every app on the key included. It is used while its window lasts; after that,
    // or before the first reply, AIOSubtitles' own count stands in.
    const h = last?.headers ?? {};
    const site = (suffix: string, limit: number, windowMs: number): number | undefined => {
      const left = Number(h[`x-ratelimit-remaining${suffix}`]);
      const max = Number(h[`x-ratelimit-limit${suffix}`]) || limit;
      return h[`x-ratelimit-remaining${suffix}`] !== undefined && Number.isFinite(left) && last?.lastAt && Date.now() - last.lastAt < windowMs ? max - left : undefined;
    };
    const asOf = last?.lastAt ? `SubSource's own count, every app on the key included, as of ${hhmm(last.lastAt)}` : "";
    const siteMinute = site("", 60, 60_000);
    const siteHour = site("-hour", 1800, 3_600_000);
    const siteDay = site("-day", 7200, 86_400_000);
    // The busiest minute is what predicts a refusal, so it feeds the top figure; the bar is this minute.
    const busiest = todayUse.busiestMinute;
    const subdlRequests = todayUse.calls - (todayUse.downloads ?? 0);
    if (service === "subsource" && weekCalls) {
      limits.push({ what: `${name} · this minute`, used: siteMinute ?? w.minute, max: 60 });
      limits.push({ what: `${name} · this hour`, used: siteHour ?? w.hour, max: 1800 });
      limits.push({ what: `${name} · today`, used: siteDay ?? Math.max(w.day, todayUse.calls), max: 7200 });
    } else if (service === "subdl" && weekCalls) {
      limits.push({ what: `${name} · requests today`, used: subdlRequests, max: 2000 });
      limits.push({ what: `${name} · downloads today`, used: todayUse.downloads ?? 0, max: 50 });
    }
    const meters =
      service === "subsource"
        ? meterRow("Minute", siteMinute ?? w.minute, 60, busiest ? `our busiest ${n(busiest)}` : "", `${name} ${tag}, calls this minute`, siteMinute !== undefined ? asOf : "AIOSubtitles' count of the last 60 seconds") +
          meterRow("Hour", siteHour ?? w.hour, 1800, "", `${name} ${tag}, calls in the last hour`, siteHour !== undefined ? asOf : "AIOSubtitles' count of the last 60 minutes") +
          meterRow("Day", siteDay ?? Math.max(w.day, todayUse.calls), 7200, "", `${name} ${tag}, calls in the last 24 hours`, siteDay !== undefined ? asOf : "AIOSubtitles' count of the last 24 hours")
        : service === "subdl"
          ? meterRow("Requests today", subdlRequests, 2000, "", `${name} ${tag}, requests today`, "AIOSubtitles' count; SubDL's day ends at midnight UTC") +
            meterRow("Downloads today", todayUse.downloads ?? 0, 50, "", `${name} ${tag}, downloads today`, "AIOSubtitles' count; SubDL's day ends at midnight UTC") +
            `<div class="km" title="SubDL's day ends at midnight UTC"><div class="km-top"><span class="km-label">Resets<span class="km-note"> in ${span(utcMidnight - Date.now())}</span></span><span class="km-val"><b>${hhmm(utcMidnight)}</b></span></div><div class="meter blank" aria-hidden="true"></div></div>`
          : "";
    const headers = last?.headers && service !== "subsource"
      ? Object.entries(last.headers)
          .map(([k, v]) => `${escapeHtml(k.replace(/^x-/i, "").replace(/^rate-?limit-/i, "").replace(/-/g, " "))} <b>${escapeHtml(v)}</b>`)
          .join(" · ")
      : "";
    return `<div class="key">
        <div class="key-id">
          <span class="key-top"><span class="key-name">${name} <span class="mono">${escapeHtml(tag ?? "")}</span></span>${!weekCalls ? status("ok", "No calls yet") : refused ? status("bad", `Refused ${n(refused)}×, last ${ago(lastRefused)}`) : status("ok", "Never refused")}</span>
          <span class="key-week">${n(weekCalls)} calls this week${last?.lastAt ? ` · last ${ago(last.lastAt)}` : ""}</span>
        </div>
        <div class="key-meters">${meters}</div>
        ${headers ? `<p class="hint key-foot">${name} reports: ${headers}</p>` : ""}
      </div>`;
  };
  // Grouped by the link that uses each key (the latest one, if a key is shared), newest-used link first.
  const keyOwner = (id: string) => {
    let latest: KeyUsage | undefined;
    for (const day of week) {
      const u = day.keys?.[id];
      if (u?.link && (!latest || (u.lastAt ?? 0) >= (latest.lastAt ?? 0))) latest = u;
    }
    return { link: latest?.link ?? "", at: latest?.lastAt ?? 0 };
  };
  const keyGroups = new Map<string, { at: number; ids: string[] }>();
  for (const id of [...keyIds].sort()) {
    const { link, at } = keyOwner(id);
    const group = keyGroups.get(link) ?? { at: 0, ids: [] };
    group.ids.push(id);
    group.at = Math.max(group.at, at);
    keyGroups.set(link, group);
  }
  const callsThisWeek = (id: string) => week.reduce((sum, day) => sum + (day.keys?.[id]?.calls ?? 0), 0);
  const groupTitle = (link: string) => {
    const name = link ? nameOf(link) : undefined;
    return link ? (name ? `${escapeHtml(name)}<span class="mono group-id">${escapeHtml(link)}</span>` : `<span class="mono">${escapeHtml(link)}</span>`) : "No link yet";
  };
  const keyOrder = [...keyGroups.entries()].sort((a, b) => b[1].at - a[1].at);
  const busy = keyOrder.filter(([, g]) => g.ids.some((id) => callsThisWeek(id) > 0));
  const idle = keyOrder.filter(([, g]) => !g.ids.some((id) => callsThisWeek(id) > 0));
  const keyName = (id: string) => {
    const [service, tag] = id.split(":");
    return `${service === "subsource" ? "SubSource" : service === "subdl" ? "SubDL" : escapeHtml(service)} <span class="mono">${escapeHtml(tag ?? "")}</span>`;
  };
  const idleList = idle.length
    ? `<section class="key-group"><h3 class="group-title">No calls this week</h3><ul class="card-body idle-keys">${idle
        .map(([link, g]) => `<li class="idle-key"><span class="idle-who">${groupTitle(link)}</span><span class="idle-ids">${g.ids.map(keyName).join('<span class="ro-sep" aria-hidden="true">·</span>')}</span></li>`)
        .join("")}</ul></section>`
    : "";
  const keyList = keyIds.size
    ? busy.map(([link, group]) => `<section class="key-group"><h3 class="group-title">${groupTitle(link)}</h3><div class="card-body">${group.ids.map(keyBlock).join("")}</div></section>`).join("") + idleList
    : `<div class="card-body"><p class="empty">${icon("chart", "i xs")}No calls with a key yet. Each SubSource and SubDL key shows here after its first search.</p></div>`;

  // ---------- the last 7 days: what AIOSubtitles cost ----------
  const weekErrors = sum(weekTotal, "errors.");
  const weekAgo = Date.now() - 7 * 86_400_000;
  // Cleared by the owner (see clearErrors): from then on every error number on the page starts there.
  const cleared = view.errorsClearedAt >= weekAgo ? view.errorsClearedAt : 0;
  const listedErrors = view.errors.filter((e) => e.at >= Math.max(weekAgo, cleared));
  // The day counters and the kept list are noted together; the list keeps 30, so the larger one is right.
  const errorCount = cleared ? listedErrors.length : Math.max(weekErrors, listedErrors.length);
  const errorsAtLeast = cleared && listedErrors.length >= ERRORS_KEPT;
  const errorText = `${n(errorCount)}${errorsAtLeast ? "+" : ""}`;
  const errorScope = cleared ? `since you cleared them at ${hhmm(cleared)}` : "in the last 7 days";
  const figure = (label: string, value: string, note: string) =>
    `<div class="fig"><dt>${label}</dt><dd><span class="fig-value">${value}</span><span class="hint">${note}</span></dd></div>`;
  const closest = limits.sort((a, b) => b.used / b.max - a.used / a.max)[0];
  const closestShare = closest ? closest.used / closest.max : 0;
  const closestLevel: Level = closestShare >= 0.9 ? "bad" : closestShare >= 0.6 ? "warn" : "ok";
  const limitFigure = `<div class="fig fig-limit"><dt>Closest to a limit</dt><dd>${
    closest
      ? `<a class="fig-value fig-link" href="#keys">${n(closest.used)}<span class="unit"> / ${n(closest.max)}</span></a>${status(closestLevel, escapeHtml(closest.what))}`
      : `<span class="fig-value">–</span><span class="hint">No key used this week</span>`
  }</dd></div>`;
  // Whether it's doing its job: subtitles synced, nothing refused, no new errors. Cost comes after.
  const out = view.outcomes ?? { served: 0, synced: 0, byAudio: 0, asIs: 0, failed: 0 };
  const syncedShare = out.served ? out.synced / out.served : 0;
  const dayAgo = Date.now() - 86_400_000;
  let lastRefusal = 0;
  for (const day of week) for (const u of Object.values(day.keys ?? {})) lastRefusal = Math.max(lastRefusal, u.lastRefusedAt ?? 0);
  const errorsToday = listedErrors.filter((e) => e.at >= dayAgo).length;
  const problems: Array<[Level, string]> = [];
  if (lastRefusal >= dayAgo) problems.push(["bad", `A key was refused ${ago(lastRefusal)}`]);
  if (closest && closestShare >= 0.9) problems.push(["bad", `Close to a limit: ${closest.what}`]);
  else if (closest && closestShare >= 0.6) problems.push(["warn", `Getting close to a limit: ${closest.what}`]);
  if (errorsToday) problems.push(["warn", `${n(errorsToday)}${errorsAtLeast && errorsToday === listedErrors.length ? "+" : ""} ${errorsToday === 1 ? "error" : "errors"} in the last 24 hours`]);
  const verdictLevel: Level = problems.some(([l]) => l === "bad") ? "bad" : problems.length ? "warn" : "ok";
  const verdictText = problems.length ? problems.map(([, t]) => t).join(" · ") : "All good: nothing refused or failing in the last 24 hours";
  const verdict = `<p class="verdict ${verdictLevel}">${status(verdictLevel, escapeHtml(verdictText))}${out.served ? `<span class="verdict-sync">${Math.round(syncedShare * 100)}% of this week's ${n(out.served)} subtitles synced</span>` : ""}</p>`;
  const syncFigure = figure(
    "Subtitles synced",
    out.served ? `${Math.round(syncedShare * 100)}<span class="unit">%</span>` : "–",
    out.served ? `${n(out.synced)} of ${n(out.served)} this week${out.byAudio ? ` · ${n(out.byAudio)} by audio` : ""}${out.failed ? ` · ${n(out.failed)} failed` : ""}` : "None served this week"
  );
  const errorFigure = `<div class="fig"><dt>Errors</dt><dd><span class="fig-value">${errorText}</span>${errorCount ? `<a class="fig-note-link" href="#errors">${status("warn", cleared ? `Since cleared ${when(cleared)}` : "This week · see them")}</a>` : status("ok", cleared ? `None since cleared ${when(cleared)}` : "None this week")}</dd></div>`;
  const figures = `${verdict}<dl class="figs health">
      ${syncFigure}
      ${limitFigure}
      ${errorFigure}
    </dl><dl class="figs cost" aria-label="What it cost">
      ${figure("CPU time", fmtTime(cpuSeconds(weekTotal)), `Today ${fmtTime(cpuSeconds(today.total))}`)}
      ${figure("Downloaded", bytes(downloaded(weekTotal)), `Today ${bytes(downloaded(today.total))}`)}
      ${figure("Sent", bytes(sent(weekTotal)), `Today ${bytes(sent(today.total))}`)}
    </dl>`;
  const charts = `<div class="charts">
      ${columnChart(view, {
        title: "CPU time per day",
        hint: "AIOSubtitles and the ffmpeg it runs. A new episode adds a few seconds.",
        value: cpuSeconds,
        format: fmtTime,
        time: true,
        detail: (c) => `${fmtTime(cpuSeconds(c))} of CPU · ${n(c["sync.files"])} files read`
      })}
      ${columnChart(view, {
        title: "Data per day",
        hint: "Downloaded plus sent. Most of it is reading the videos played: their index (about 1 MB), or short windows of them.",
        value: (c) => downloaded(c) + sent(c),
        format: (v) => (v ? bytes(v) : "0"),
        time: false,
        detail: (c) => `${bytes(downloaded(c))} downloaded · ${bytes(sent(c))} sent`
      })}
    </div>`;

  const dayRows = view.days
    .map((day, i) => {
      const c = day.total;
      const empty = !Object.keys(c).some((k) => !k.startsWith("cpu.") && !k.startsWith("own.") && !k.startsWith("net."));
      return `<tr${empty ? ' class="quiet"' : ""}>
        <th scope="row">${dayLabel(day.date, i)}</th>
        <td>${cpuSeconds(c) >= 1 ? duration(cpuSeconds(c)) : "–"}</td>
        <td>${downloaded(c) ? bytes(downloaded(c)) : "–"}</td><td>${sent(c) ? bytes(sent(c)) : "–"}</td>
        <td>${day.peak.memMb ? `${day.peak.memMb} MB` : "–"}</td>
        <td>${n(c["sync.files"])}</td><td>${procSeconds(c) ? duration(procSeconds(c)) : "–"}</td>
        <td>${n(c.lists)}</td><td>${n(c.downloads)}</td>
        <td>${n(apiCalls(c))}</td><td${sum(c, "errors.") ? ' class="bad"' : ""}>${n(sum(c, "errors."))}</td>
      </tr>`;
    })
    .join("");
  const days = `${figures}${charts}<details class="day-table"><summary>Each day's numbers</summary><div class="table-wrap" tabindex="0" role="region" aria-label="Each day's numbers"><table>
      <thead><tr><th scope="col">Day</th><th scope="col">CPU</th><th scope="col">Downloaded</th><th scope="col">Sent</th><th scope="col">Peak memory</th><th scope="col">Files read</th><th scope="col">ffmpeg</th><th scope="col">Lists</th><th scope="col">Subtitles served</th><th scope="col">API calls</th><th scope="col">Errors</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table></div></details>`;

  // ---------- right now: the container only ----------
  const unavailable = "Only measured inside the addon's container.";
  const cpuShare = now.cpuPercent !== undefined ? now.cpuPercent / 100 : undefined;
  const cpuLevel: Level = cpuShare === undefined || cpuShare < 0.5 ? "ok" : cpuShare < 0.9 ? "warn" : "bad";
  const diskShare = now.disk ? 1 - now.disk.freeBytes / now.disk.totalBytes : undefined;
  const diskLevel: Level = diskShare === undefined || diskShare < 0.8 ? "ok" : diskShare < 0.92 ? "warn" : "bad";
  const tiles = [
    meterCard({
      label: "CPU",
      value: now.cpuPercent !== undefined ? `${now.cpuPercent < 10 ? now.cpuPercent.toFixed(1) : Math.round(now.cpuPercent)}% <span class="unit">of one core</span>` : "–",
      hint: now.cpuPercent !== undefined ? `Measured just now. This server has ${now.cores} cores; reading a new episode briefly uses more.` : unavailable,
      share: cpuShare,
      level: cpuShare === undefined ? undefined : cpuLevel,
      words: cpuShare === undefined ? undefined : cpuLevel === "ok" ? "Light" : cpuLevel === "warn" ? "Busy" : "Heavy"
    }),
    meterCard({
      label: "Memory",
      value: now.memMb !== undefined ? `${now.memMb} <span class="unit">MB</span>` : `${now.rssMb} <span class="unit">MB</span>`,
      hint:
        now.memMb !== undefined
          ? `Peak ${Math.max(now.memPeakMb ?? 0, today.peak.memMb ?? 0, now.memMb)} MB since it started ${duration(view.uptimeS)} ago. Includes ffmpeg while it runs.`
          : "AIOSubtitles alone; the container's figure is only measured inside it."
    }),
    meterCard({
      label: "Cache on disk",
      value: bytes(now.cache.bytes).replace(/ (\w+)$/, ' <span class="unit">$1</span>'),
      hint: `${n(now.cache.files)} files: subtitles, synced copies and each video's anchor points. Files unused for 14 days are removed daily.${now.disk ? ` ${bytes(now.disk.freeBytes)} free on the disk.` : ""}`,
      level: diskShare === undefined ? undefined : diskLevel,
      words: diskShare === undefined ? undefined : `Disk ${Math.round(diskShare * 100)}% full`
    })
  ].join("");

  // ---------- sources and links ----------
  const used = (source: string) => (weekTotal[`api.${source}`] ?? 0) + (weekTotal[`fetch.${source}`] ?? 0) + (weekTotal[`errors.${source}`] ?? 0) > 0;
  const sources = ["subsource", "subdl", "opensubtitles", "subtitlecat", "thesubtitledb", "gestdown", "animetosho", "addons"]
    // Subtitle Cat (off unless a link turns it on) and other addons only when one was used this week.
    .filter((source) => (source !== "addons" && source !== "subtitlecat") || used(source))
    .map((source) => {
      const label = { subsource: "SubSource", subdl: "SubDL", opensubtitles: "OpenSubtitles V3+", subtitlecat: "Subtitle Cat", thesubtitledb: "TheSubtitleDB", gestdown: "Gestdown", animetosho: "Anime Tosho", addons: "Added addons" }[source];
      const fails = (weekTotal[`api.${source}.fail`] ?? 0) + (weekTotal[`errors.${source}`] ?? 0);
      return `<tr><th scope="row">${label}</th><td>${n(weekTotal[`api.${source}`] ?? 0)}</td><td>${n(weekTotal[`fetch.${source}`])}</td><td${fails ? ' class="bad"' : ""}>${n(fails)}</td></tr>`;
    })
    .join("");
  const aiostreams = `<tr><th scope="row">AIOStreams</th><td>${n(weekTotal["api.aiostreams"])}</td><td>–</td><td>–</td></tr>`;
  const sourceTable = `<div class="table-wrap" tabindex="0" role="region" aria-label="Sources"><table>
      <thead><tr><th scope="col">Source</th><th scope="col">Calls</th><th scope="col">Downloads</th><th scope="col">Failures</th></tr></thead>
      <tbody>${sources}${aiostreams}</tbody>
    </table></div>`;

  const links = new Map<string, Counters>();
  for (const day of week) {
    for (const [id, c] of Object.entries(day.links)) {
      const into = links.get(id) ?? {};
      for (const [k, v] of Object.entries(c)) into[k] = k === "lastSeen" ? Math.max(into[k] ?? 0, v) : (into[k] ?? 0) + v;
      links.set(id, into);
    }
  }
  // Calls to each site per link; days before this was counted per link show a dash.
  // ---------- each link: what it's set to, and what it did this week ----------
  const seenIds = [...new Set([...links.keys(), ...Object.keys(view.settings)])].sort(
    (a, b) => (links.get(b)?.lastSeen ?? 0) - (links.get(a)?.lastSeen ?? 0)
  );
  // A list's worth of names, in plain English: "English Dub and Arabic", "SubSource, SubDL and OpenSubtitles".
  const andList = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  const initials = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? ["?"]).slice(0, 2).join("").toUpperCase();
  const linkRow = (id: string) => {
    const set = view.settings[id];
    const c = links.get(id) ?? {};
    const name = nameOf(id) ?? id;
    const edit = set && view.configure[id]
      ? `<a class="pill" href="${escapeHtml(view.configure[id])}" target="_blank" rel="noreferrer">Edit${icon("external", "i xs")}<span class="sr-only"> ${escapeHtml(name)}, opens in a new tab</span></a>`
      : "";
    const figure = (value: string, label: string) => `<div class="ro-fig"><dt>${label}</dt><dd>${value}</dd></div>`;
    const figures = `<dl class="ro-figs">${figure(n(c.lists ?? 0), "lists")}${figure(n(c.downloads ?? 0), "served")}${figure(c.lastSeen ? ago(c.lastSeen) : "–", "last seen")}</dl>`;
    // Each detail behind its icon; the words a screen reader hears say what the icon means.
    const item = (iconName: string, spoken: string, text: string, cls = "") =>
      `<li class="ro-item${cls}" title="${escapeHtml(spoken)}">${icon(iconName, "i xs")}<span class="sr-only">${escapeHtml(spoken)}: </span>${text}</li>`;
    const what = set
      ? `<ul class="ro-what">${item("languages", "Languages", escapeHtml(andList(set.languages) || "None"))}${item("sources", "Sources", escapeHtml(andList(set.sources) || "None"))}${set.aiostreams ? item("sync", "Syncs with", escapeHtml(set.aiostreams), " sync") : `<li class="ro-item"><span class="status warn"><span class="dot" aria-hidden="true"></span>No sync</span></li>`}</ul>`
      : `<p class="ro-later">Its settings show here after its next use.</p>`;
    const how = set
      ? `<ul class="ro-how">${[
          item("bot", set.allowMachine ? "Machine and AI translations allowed" : "Machine and AI translations left out", set.allowMachine ? "Machine subs allowed" : "No machine subs"),
          item("ear", { include: "Hearing-impaired subtitles included", exclude: "Hearing-impaired subtitles left out", only: "Hearing-impaired subtitles only" }[set.hearingImpaired], { include: "HI included", exclude: "No HI", only: "HI only" }[set.hearingImpaired]),
          item("film", set.skipEmbedded ? "Skips languages the file already has" : "Lists languages the file already has too", set.skipEmbedded ? "Skips the file's languages" : "Lists every language"),
          ...(set.hideUnsynced ? [item("sync", "Leaves out subtitles that don't sync", "Synced only")] : []),
          item("tag", set.statusInName ? "Status in the track name, like Arabic (Synced)" : "Tracks named by language alone", set.statusInName ? "Status in names" : "Language-only names")
        ].join("")}</ul>`
      : "";
    return `<li class="ro">
        <span class="tile ro-tile" aria-hidden="true">${escapeHtml(initials(name))}</span>
        <div class="ro-main">
          <h4 class="ro-name">${escapeHtml(name)}${set?.edited ? `<span class="edited" title="Changed on its configure page since the link was made">Edited</span>` : ""}<span class="sr-only">, </span><span class="mono ro-id">${escapeHtml(id)}</span></h4>
          ${what}
        </div>
        ${figures}
        <div class="ro-act">${edit}</div>
        ${how}
      </li>`;
  };
  const linkRows = seenIds.length ? `<ul class="roster">${seenIds.map(linkRow).join("")}</ul>` : `<p class="empty">No one has used a link in the last 7 days.</p>`;

  // ---------- recent activity: every list and download, newest first ----------
  // Times are on the dashboard's clock (config.timeZone), the same for every viewer.
  // Filters: which link, and lists or subtitles, over the whole week (pages come from /stats/activity).
  const activityLinks = view.activityLinks;
  const activityFilters = view.activity.length
    ? `<div class="filters" role="group" aria-label="Filter activity">
        <label class="filter"><span class="filter-label">Link</span><select id="f-link"><option value="">All links</option>${activityLinks
          .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(nameOf(id) ?? id)}</option>`)
          .join("")}</select></label>
        <span class="segmented" role="radiogroup" aria-label="Kind">${[["", "All"], ["list", "Lists"], ["download", "Subtitles"], ["error", "Errors"]]
          .map(([v, label]) => `<label><input type="radio" name="kind" value="${v}"${v ? "" : " checked"}><span>${label}</span></label>`)
          .join("")}</span>
      </div>`
    : "";
  const activityList = view.activity.length
    ? `<ul class="acts" id="acts" data-total="${view.activityTotal}">${activityRows(view.activity, view.names)}</ul><p class="empty" id="acts-none" hidden>Nothing matches these filters.</p>`
    : `<p class="empty">${icon("chart", "i xs")}Nothing yet. Each list and subtitle a player asks for shows here.</p>`;
  const activityPager = view.activity.length
    ? `<nav class="pager" aria-label="Activity pages"><button type="button" class="pill" id="act-newer" disabled>${icon("chevron", "i xs flip")}Newer</button><span class="hint" id="act-range" role="status">${pageRange(0, view.activity.length, view.activityTotal)}</span><button type="button" class="pill" id="act-older"${view.activityTotal > view.activity.length ? "" : " disabled"}>Older${icon("chevron", "i xs")}</button></nav>`
    : "";

  // Repeats of one error (a player retrying a link) are one row with a count. Each row opens to the
  // whole message, which link hit it, on what, and when it started, with a way to the activity.
  type ErrorGroup = { where: string; message: string; times: number; first: number; last: number; links: Set<string>; what?: string };
  const groups = new Map<string, ErrorGroup>();
  for (const e of listedErrors) {
    const key = `${e.where}\n${e.message}`;
    const group = groups.get(key) ?? { where: e.where, message: e.message, times: 0, first: e.at, last: e.at, links: new Set<string>() };
    group.times++;
    group.first = Math.min(group.first, e.at);
    group.last = Math.max(group.last, e.at);
    if (e.link) group.links.add(e.link);
    if (e.what && !group.what) group.what = e.what;
    groups.set(key, group);
  }
  const WHERE: Record<string, string> = { sync: "Sync", request: "Request", download: "Download", subdl: "SubDL", subsource: "SubSource", opensubtitles: "OpenSubtitles", subtitlecat: "Subtitle Cat", thesubtitledb: "TheSubtitleDB", gestdown: "Gestdown", animetosho: "Anime Tosho", addons: "Other addons" };
  const errorRow = (g: ErrorGroup) => {
    const linkIds = [...g.links];
    const facts = [
      linkIds.length ? `<div><dt>Link</dt><dd>${linkIds.map((id) => escapeHtml(nameOf(id) ?? id)).join(", ")}</dd></div>` : "",
      g.what ? `<div><dt>On</dt><dd>${escapeHtml(g.what)}</dd></div>` : "",
      `<div><dt>${g.times > 1 ? "First, last" : "When"}</dt><dd>${g.times > 1 ? `${clockTag(g.first)} – ${clockTag(g.last)}` : clockTag(g.last)}</dd></div>`
    ].join("");
    const show = `<a class="pill" href="#activity" data-show-link="${escapeHtml(linkIds.length === 1 ? linkIds[0] : "")}" data-show-kind="error">Show in activity${icon("chevron", "i xs")}</a>`;
    return `<li class="err"><details><summary><span class="err-where">${escapeHtml(WHERE[g.where] ?? g.where)}</span><span class="err-msg mono">${escapeHtml(g.message)}</span><span class="err-when">${g.times > 1 ? `<b class="err-times">×${g.times}</b> ` : ""}${ago(g.last)}</span></summary>
        <div class="err-more"><p class="err-full mono">${escapeHtml(g.message)}</p><dl class="err-facts">${facts}</dl>${show}</div></details></li>`;
  };
  const sortedGroups = [...groups.values()].sort((a, b) => b.last - a.last);
  const errorRows = sortedGroups.length
    ? `<ul class="errs">${sortedGroups.map(errorRow).join("")}</ul>`
    : `<p class="empty">${icon("check", "i xs")}${cleared ? `No errors since you cleared them at ${hhmm(cleared)}.` : "No errors in the last 7 days."}</p>`;
  const recentErrors = listedErrors.length;
  const scopeLine = recentErrors
    ? `<b>${n(recentErrors)}</b> ${recentErrors === 1 ? "error" : "errors"}${sortedGroups.length > 1 ? `, ${sortedGroups.length} kinds,` : ""} ${errorScope}${!cleared && errorCount > recentErrors ? ` (newest ${recentErrors} listed of ${n(errorCount)})` : ""}`
    : cleared ? `Cleared at ${hhmm(cleared)}` : "";
  const undo = view.canUndoClear ? `<form method="post" action="/stats/errors/clear?undo=1"><button type="submit" class="text-btn">Undo clear</button></form>` : "";
  const clearBar = scopeLine || undo
    ? `<div class="err-bar"><p class="hint">${scopeLine}</p><div class="err-actions">${undo}${recentErrors ? `<form method="post" action="/stats/errors/clear"><button type="submit" class="pill">${icon("close", "i xs")}Clear errors</button></form>` : ""}</div></div>`
    : "";

  const lastSeen = view.activity[0]?.at;
  const SECTIONS: Array<[id: string, label: string, iconName: string, state: string]> = [
    ["overview", "Overview", "chart", out.served ? `${Math.round(syncedShare * 100)}% synced · ${verdictLevel === "ok" ? "all good" : verdictLevel === "bad" ? "needs a look" : "worth a look"}` : `${bytes(downloaded(weekTotal))} · ${fmtTime(cpuSeconds(weekTotal))} CPU`],
    ["keys", "API usage", "key", closest ? `Closest: ${n(closest.used)} / ${n(closest.max)}` : "No key used this week"],
    ["activity", "Activity", "activity", lastSeen ? `Last request ${ago(lastSeen)}` : "Nothing yet"],
    ["links", "Links", "layers", `${links.size} ${links.size === 1 ? "link" : "links"} this week`],
    ["errors", "Errors", "alert", errorCount ? `${errorText} ${cleared ? "since cleared" : "this week"}` : cleared ? "None since cleared" : "None this week"]
  ];
  const nav = `<nav class="nav" aria-label="Dashboard"><p class="nav-label">Dashboard</p><div class="tabs">${SECTIONS.map(
    ([id, label, iconName, state]) =>
      `<a class="tab" href="#${id}" data-sec="${id}">${icon(iconName, "i tab-i")}<span class="tab-text"><span class="tab-label">${label.replace(" usage", '<span class="tab-more"> usage</span>')}</span><span class="tab-sub${id === "errors" && errorCount ? " warn" : ""}">${state}</span></span>${id === "errors" && errorCount ? `<span class="tab-badge" aria-hidden="true">${errorCount > 99 ? "99+" : errorText}</span>` : ""}</a>`
  ).join("")}</div></nav>
    <script>(function () { var a = document.querySelector('.tab[data-sec="' + (document.documentElement.getAttribute("data-open") || "overview") + '"]'); if (a) a.setAttribute("aria-current", "page"); })();</script>`;
  const foot = `<div class="rail-meta"><span>Updated ${clockTag(Date.now())}</span><a class="refresh" href="/stats" onclick="this.href = location.pathname + location.search + location.hash">Refresh</a></div>
      <a class="rail-link" href="/configure">${icon("settings", "i xs")}Configure a link</a>${logoutButton(signedIn)}`;
  /** One section: its heading and a line about it, then its content. */
  const section = (id: string, title: string, about: string, body: string, iconName = SECTIONS.find(([s]) => s === id)?.[2] ?? "chart") =>
    `<section class="panel" id="sec-${id}" data-section="${id}" aria-labelledby="title-${id}" tabindex="-1"${id === "overview" ? "" : " hidden"}>
      <div class="panel-head"><h2 id="title-${id}"><span class="panel-icon" aria-hidden="true">${icon(iconName)}</span>${title}</h2><p>${about}</p></div>
      ${body}
    </section>`;

  return `<!doctype html>
<html lang="en">
<head>
${headTags("AIOSubtitles dashboard")}
<meta name="robots" content="noindex">
<script>
  // The section named in the address, read before anything paints (the script at the end takes over).
  (function () { var id = location.hash.slice(1); if (${JSON.stringify(SECTIONS.map(([id]) => id).filter((id) => id !== "overview"))}.indexOf(id) >= 0) document.documentElement.setAttribute("data-open", id); })();
</script>
<style>
${SECTIONS.filter(([id]) => id !== "overview").map(([id]) => `  html[data-open="${id}"] #sec-overview { display: none !important; }
  html[data-open="${id}"] #sec-${id}[hidden] { display: grid !important; }`).join("\n")}
${SHARED_CSS}
  .work { display: grid; max-width: 1180px; width: 100%; margin: 0 auto; padding: 36px 48px 40px; min-width: 0; align-content: start; }
  .panel { display: grid; gap: 24px; min-width: 0; }
  .panel:focus { outline: none; }
  @keyframes appear { from { opacity: 0; } }
  /* The icon sits on the title's line; the line under it starts on the same edge as the icon and the cards. */
  .panel-head { display: grid; gap: 8px; }
  .panel-head h2 { display: flex; align-items: center; gap: 12px; }
  .panel-icon { display: grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 9px; background: linear-gradient(180deg, rgba(97,82,223,.2), rgba(97,82,223,.06)); border: 1px solid rgba(159,146,255,.22); color: var(--brand-300); }
  .panel-icon .i { width: 18px; height: 18px; }
  .panel-head h2 { margin: 0; font-size: 22px; font-weight: 600; color: var(--white); letter-spacing: -.02em; line-height: 1.2; }
  .panel-head p { margin: 0; color: var(--muted); max-width: 64ch; text-wrap: pretty; }
  .now { display: grid; gap: 0; }
  .now .section-title { margin-bottom: 10px; }
  .rail-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 12px; font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
  .filter { display: inline-flex; align-items: center; gap: 8px; }
  .filter-label { font-size: 13px; color: var(--muted); }
  select { height: 36px; padding: 0 32px 0 12px; border-radius: var(--radius); border: 1px solid var(--control-border); background: var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center / 14px; color: var(--white); font: 13.5px var(--font); appearance: none; cursor: pointer; }
  select:focus-visible { outline: 2px solid var(--brand-400); outline-offset: 2px; }
  .segmented { display: inline-flex; flex: none; padding: 3px; gap: 2px; background: var(--field); border: 1px solid var(--control-border); border-radius: var(--radius); }
  .segmented label { position: relative; cursor: pointer; }
  .segmented input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .segmented span { display: block; padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--muted); transition: background .2s, color .2s; }
  .segmented label:hover span { color: var(--white); }
  .segmented input:checked + span { background: rgba(255,255,255,.12); color: var(--white); }
  .segmented input:focus-visible + span { outline: 2px solid var(--brand-400); outline-offset: 1px; }
  .filter-count { margin-left: auto; font-variant-numeric: tabular-nums; }
  .refresh, .pill { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 30px; padding: 0 12px; border: 1px solid rgba(159,146,255,.32); border-radius: 999px; color: var(--brand-300); font-size: 12.5px; font-weight: 500; text-decoration: none; transition: background .2s; }
  .refresh:hover, .pill:hover { background: rgba(97,82,223,.15); }
  .pill .i { width: 13px; height: 13px; }
  .figs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0; border-bottom: 2px solid var(--divider); }
  .fig-limit dd { gap: 4px; }
  .fig-link { color: var(--white); text-decoration: none; border-radius: 4px; }
  .fig-link:hover { color: var(--brand-300); }
  .fig-note-link { text-decoration: none; border-radius: 4px; }
  .fig-note-link:hover .status { color: var(--white); }
  .settings-card[id] { scroll-margin-top: 24px; }
  .fig { padding: 16px 18px; min-width: 0; }
  .fig + .fig { border-left: 1px solid var(--divider); }
  .fig dt { font-size: 13px; color: var(--muted); }
  .fig dd { display: grid; gap: 2px; margin: 4px 0 0; }
  .fig-value { font-size: 22px; font-weight: 600; color: var(--white); letter-spacing: -.01em; font-variant-numeric: tabular-nums; line-height: 1.25; }

  .section-title { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: var(--white); }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .tile-card { display: grid; align-content: start; gap: 8px; padding: 14px 18px; background: var(--paper); border: 1px solid var(--border); border-radius: var(--radius-xl); }
  .tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .tile-label { margin: 0; font-size: 13px; font-weight: 500; color: var(--muted); }
  .tile-value { margin: 0; font-size: 22px; font-weight: 600; color: var(--white); letter-spacing: -.01em; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .unit { font-size: 13px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--foreground); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .status.ok .dot { background: var(--green); box-shadow: 0 0 0 3px rgba(74,222,128,.15); }
  .status.warn .dot { background: var(--amber); box-shadow: 0 0 0 3px rgba(251,191,36,.15); }
  .status.bad .dot { background: var(--red); box-shadow: 0 0 0 3px rgba(248,113,113,.15); }
  .meter { height: 6px; border-radius: 999px; background: rgba(255,255,255,.07); overflow: hidden; }
  .meter-fill { display: block; height: 100%; border-radius: 999px; background: var(--brand-400); }
  .meter-fill.warn { background: var(--amber); }
  .meter-fill.bad { background: var(--red); }
  .hint { margin: 0; font-size: 13px; color: var(--muted); }

  .settings-card { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; }
  .card-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--white); }
  .card-desc { margin: 2px 0 0; font-size: 14px; color: var(--muted); max-width: 64ch; }
  .card-body { background: var(--paper); border: 1px solid var(--border); border-radius: var(--radius-xl); overflow: clip; }
  .item { padding: 14px 18px; }
  .item + .item { border-top: 2px solid var(--divider); }
  .row-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 16px; }
  .item-title { font-weight: 500; font-size: 14px; color: var(--white); }
  .mono { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
  .errs { margin: 0; padding: 0; list-style: none; }
  .err { font-size: 13px; }
  .err + .err { border-top: 1px solid var(--divider); }
  .err summary { display: grid; grid-template-columns: 108px minmax(0, 1fr) auto; align-items: baseline; gap: 12px; padding: 11px 18px; cursor: pointer; list-style: none; }
  .err summary::-webkit-details-marker { display: none; }
  .err summary:hover .err-msg { color: var(--foreground); }
  .err summary:focus-visible { outline-offset: -3px; }
  .err details[open] > summary .err-msg { visibility: hidden; }
  .err-when b.err-times { color: var(--amber); font-weight: 600; }
  .err-more { display: grid; gap: 12px; justify-items: start; padding: 2px 18px 16px 138px; }
  .err-full { margin: 0; color: var(--foreground); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
  .err-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 0; }
  .err-facts > div { display: contents; }
  .err-facts dt { color: var(--muted); }
  .err-facts dd { margin: 0; color: var(--foreground); overflow-wrap: anywhere; }
  .err-actions { display: flex; align-items: center; gap: 14px; }
  .text-btn { padding: 0; border: 0; background: none; color: var(--brand-300); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; }
  .text-btn:hover { text-decoration: underline; }
  .verdict { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 18px; margin: 0; padding: 16px 18px; border-bottom: 1px solid var(--divider); }
  .verdict .status { font-size: 14px; }
  .verdict-sync { font-size: 13px; color: var(--muted); }
  .figs.health, .figs.cost { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .figs.cost .fig { padding-top: 12px; padding-bottom: 12px; }
  .figs.cost .fig-value { font-size: 17px; }
  .fig-value .unit { font-size: .6em; color: var(--muted); font-weight: 500; }
  .tab-badge { display: none; }
  @media (max-width: 860px) { .tab-more { display: none; } }
  .err-where { font-weight: 500; color: var(--white); }
  .err-msg { color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .err-when { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .err-when b { color: var(--foreground); font-weight: 600; }
  .more-errs > summary { padding: 10px 18px; border-top: 1px solid var(--divider); color: var(--brand-300); font-size: 13px; cursor: pointer; list-style: none; }
  .more-errs > summary::-webkit-details-marker { display: none; }
  .key-groups { display: grid; gap: 20px; }
  .key-group { display: grid; gap: 10px; }
  .group-title { display: flex; align-items: baseline; gap: 10px; margin: 0; font-size: 15px; font-weight: 600; color: var(--white); }
  .group-id { font-size: 12px; font-weight: 400; color: var(--muted); }
  /* One key, one row: who and how it's doing on the left, its limits on the right. */
  .key { display: grid; grid-template-columns: 280px minmax(0, 1fr); align-items: center; gap: 10px 28px; padding: 14px 18px; }
  .key + .key { border-top: 1px solid var(--divider); }
  .key-id { display: grid; gap: 3px; justify-items: start; min-width: 0; }
  .key-week { font-size: 12.5px; color: var(--muted); }
  .key-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; }
  .key-top .status { font-size: 12.5px; }
  .key-meters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 24px; }
  .key-foot { grid-column: 1 / -1; margin: 0; }
  .idle-keys { margin: 0; padding: 0; list-style: none; }
  .idle-key { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; padding: 12px 18px; font-size: 13.5px; }
  .idle-key + .idle-key { border-top: 1px solid var(--divider); }
  .idle-who { font-weight: 600; color: var(--white); display: flex; align-items: baseline; gap: 10px; }
  .idle-who .group-id { font-weight: 400; }
  .idle-ids { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; color: var(--muted); }
  .idle-ids .mono { color: var(--muted); }
  .ro-sep { color: var(--muted); }
  .km { display: grid; gap: 5px; min-width: 0; }
  .km-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .km-label { font-size: 12.5px; color: var(--muted); }
  .km-val { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .km-val b { font-size: 15px; font-weight: 600; color: var(--white); }
  .km-pct { margin-left: 8px; color: var(--muted); }
  .km-pct.warn { color: var(--amber); }
  .km-pct.bad { color: var(--red); }
  .km-note { color: var(--muted); }
  .km .meter.blank { background: none; }
  .km .meter { height: 4px; }
  .key-head { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
  .key-name { font-weight: 600; font-size: 14px; color: var(--white); }
  .key-name .mono { color: var(--muted); font-weight: 400; margin-left: 4px; }
  /* Links: a roster. Who it is and what it gets on the left, this week's numbers and Edit on the right. */
  .err-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; }
  .err-bar .hint { margin: 0; }
  .err-bar form { margin: 0; }
  button.pill { background: none; font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; }
  .pager { display: flex; align-items: center; justify-content: center; gap: 16px; }
  #sec-activity .settings-card { box-sizing: border-box; }
  .pager .hint { margin: 0; min-width: 140px; text-align: center; font-variant-numeric: tabular-nums; }
  button.pill:disabled { opacity: .55; cursor: default; }
  button.pill:disabled:hover { background: none; }
  .i.flip { transform: rotate(180deg); }
  .acts[aria-busy="true"] { opacity: .5; transition: opacity .15s; }
  .roster { margin: 0; padding: 0; list-style: none; }
  /* Every row is as tall as one with its settings shown, so a link without them doesn't sit shorter. */
  .ro { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; align-content: start; gap: 6px 18px; padding: 16px 18px; min-height: 108px; }
  .ro + .ro { border-top: 1px solid var(--divider); }
  .ro-tile { width: 38px; height: 38px; border-radius: 10px; font-size: 13px; align-self: start; }
  .ro-main { display: grid; gap: 4px; min-width: 0; }
  .ro-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin: 0; font-size: 15px; font-weight: 600; color: var(--white); }
  .ro-id { font-size: 12px; font-weight: 400; color: var(--muted); }
  .edited { padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--muted); align-self: center; }
  .ro-what, .ro-how { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 20px; margin: 0; padding: 0; list-style: none; }
  .ro-what { font-size: 14px; color: var(--foreground); }
  .ro-how { grid-column: 2 / -1; grid-row: 2; gap: 4px 18px; font-size: 13px; color: var(--muted); }
  .ro-item { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
  .ro-item .i { width: 15px; height: 15px; flex: none; color: var(--muted); }
  .ro-how .ro-item .i { width: 14px; height: 14px; color: var(--muted); }
  .ro-item.sync .i { color: var(--green); }
  .ro-later { margin: 0; font-size: 13px; color: var(--muted); }
  .ro-figs { display: grid; grid-template-columns: 56px 56px 96px; gap: 0 18px; margin: 0; }
  .ro-fig { display: grid; justify-items: end; gap: 1px; }
  .ro-fig dd { order: -1; margin: 0; font-size: 15px; font-weight: 600; color: var(--white); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ro-fig dt { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .ro-act { display: flex; justify-content: flex-end; min-width: 76px; }
  .key-foot { overflow-wrap: anywhere; }
  .key-foot b { font-weight: 600; color: var(--foreground); font-variant-numeric: tabular-nums; }
  .acts { margin: 0; padding: 0; list-style: none; }
  .act { display: grid; grid-template-columns: 44px 62px minmax(0, 1fr) minmax(0, 360px) 52px; align-items: baseline; gap: 12px; padding: 9px 18px; font-size: 13px; }
  .act + .act { border-top: 1px solid var(--divider); }
  .act-day { padding: 14px 18px 6px; font-size: 12px; font-weight: 600; color: var(--foreground); }
  .act-day:not(:first-child) { border-top: 1px solid var(--divider); }
  .act-when, .act-ms { color: var(--muted); font-variant-numeric: tabular-nums; }
  .act-ms { text-align: right; }
  .act-kind { font-size: 12px; font-weight: 500; color: var(--muted); }
  .act-kind.download { color: var(--brand-300); }
  .act-what { color: var(--white); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .act-link { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .act-result { color: var(--foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .act-result.bad { color: var(--red); }
  /* Result and link in columns of their own, so each link's name sits in the same place on every row. */
  .act-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 120px); gap: 14px; min-width: 0; align-items: baseline; }
  .who { font-weight: 500; color: var(--foreground); }
  .act-link .who { font-size: 12.5px; color: var(--muted); }
  .link-id { display: block; margin-top: 2px; font-weight: 400; color: var(--muted); font-size: 12px; }
  /* The ring would be cut by the card's clipped edge; draw it inside. */
  .card-body summary:focus-visible { outline-offset: -3px; }
  .table-wrap:focus-visible { outline-offset: -3px; }
  .empty { display: flex; align-items: center; gap: 8px; margin: 0; padding: 18px; font-size: 13.5px; color: var(--muted); }
  .empty .i { color: var(--green); }

  /* Two charts side by side: one column per day, oldest on the left; the mark is the hit target. */
  .charts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); border-bottom: 2px solid var(--divider); }
  .chart { position: relative; padding: 18px 18px 14px; min-width: 0; }
  .chart + .chart { border-left: 1px solid var(--divider); }
  .chart-head { margin-bottom: 14px; }
  .chart-empty { display: flex; align-items: center; justify-content: center; gap: 8px; height: 180px; margin: 0; border: 1px dashed rgba(255,255,255,.1); border-radius: var(--radius); font-size: 13px; color: var(--muted); }
  .chart-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--white); }
  .plot { position: relative; height: 120px; margin: 0 0 30px 60px; }
  .grid-line { position: absolute; left: 0; right: 0; border-top: 1px dashed rgba(255,255,255,.08); pointer-events: none; }
  .grid-line.top { top: 0; }
  .grid-line.mid { top: 50%; }
  .grid-line.zero { top: 100%; border-top-color: transparent; }
  .grid-line span { position: absolute; right: calc(100% + 10px); top: -9px; font-size: 12px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .cols { position: absolute; inset: 0 0 -28px; display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); }
  .col { min-width: 0; display: grid; grid-template-rows: 1fr 28px; justify-items: stretch; border-radius: 6px; }
  .col-plot { position: relative; border-bottom: 1px solid rgba(255,255,255,.16); display: flex; align-items: flex-end; justify-content: center; border-radius: 6px 6px 0 0; transition: background .15s; }
  .col-bar { display: block; width: min(18px, 60%); border-radius: 4px 4px 0 0; background: var(--brand-400); transition: background .15s; }
  .col:hover .col-bar { background: var(--brand-300); }
  .col:hover .col-plot { background: rgba(255,255,255,.03); }
  /* Zero-width and centred, so a long label ("Today") never widens its column. */
  .col-tick { align-self: center; justify-self: center; width: 0; display: flex; justify-content: center; white-space: nowrap; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .col:nth-last-child(even) .col-tick { visibility: hidden; }
  .col.today .col-tick { color: var(--white); font-weight: 500; }
  .tip { position: absolute; z-index: 2; display: grid; gap: 2px; min-width: 150px; max-width: 260px; padding: 8px 10px; border-radius: 8px; background: #161616; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 28px -12px rgba(0,0,0,.9); pointer-events: none; font-size: 12.5px; color: var(--muted); }
  .tip strong { font-size: 13px; font-weight: 600; color: var(--white); }

  /* A soft edge shows when a wide table scrolls sideways. */
  .table-wrap { overflow-x: auto; background: linear-gradient(90deg, var(--paper) 30%, transparent) left / 32px 100% no-repeat local, linear-gradient(270deg, var(--paper) 30%, transparent) right / 32px 100% no-repeat local, radial-gradient(farthest-side at 0 50%, rgba(255,255,255,.12), transparent) left / 12px 100% no-repeat scroll, radial-gradient(farthest-side at 100% 50%, rgba(255,255,255,.12), transparent) right / 12px 100% no-repeat scroll; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; font-variant-numeric: tabular-nums; }
  th, td { padding: 10px 16px; text-align: right; white-space: nowrap; }
  th:first-child { text-align: left; }
  thead th { font-weight: 500; font-size: 12.5px; color: var(--muted); border-bottom: 2px solid var(--divider); }
  tbody th { font-weight: 500; color: var(--white); }
  tbody tr + tr > * { border-top: 1px solid var(--divider); }
  tbody tr:hover > * { background: var(--paper-2); }
  tr.quiet > * { color: var(--muted); font-weight: 400; }
  td.bad { color: var(--red); }
  .day-table > summary { display: flex; align-items: center; gap: 8px; padding: 14px 18px; list-style: none; cursor: pointer; color: var(--brand-300); font-size: 14px; font-weight: 500; }
  .day-table > summary::-webkit-details-marker { display: none; }
  .day-table > summary::before { content: ""; width: 7px; height: 7px; border-right: 1.75px solid currentColor; border-bottom: 1.75px solid currentColor; transform: rotate(-45deg); transition: transform .2s var(--ease); }
  .day-table[open] > summary::before { transform: rotate(45deg); }
  .day-table > summary:hover { background: rgba(255,255,255,.03); }
  .day-table[open] > summary { border-bottom: 2px solid var(--divider); }
  .pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }

  @media (max-width: 1240px) {
    .figs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .figs.health, .figs.cost { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .act { grid-template-columns: 44px 62px minmax(0, 1fr) 52px; row-gap: 2px; }
    .act-meta { grid-column: 3; grid-row: 2; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); }
    .act-ms { grid-column: 4; grid-row: 1; }
  }
  @media (max-width: 980px) { .pair, .charts, .tiles { grid-template-columns: minmax(0, 1fr); } .chart + .chart { border-left: 0; border-top: 1px solid var(--divider); } }
  @media (max-width: 860px) {
    .work { padding: 20px 16px 40px; gap: 24px; }
    .panel-head h2 { font-size: 20px; }
    .version { display: none; }
    .plot { margin-left: 52px; height: 130px; }
    th, td { padding: 9px 12px; }
    .err summary { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
    .err-more { padding-left: 18px; }
    /* Five tabs that fit, with the error count on its tab, and Refresh kept. */
    .tabs { grid-auto-columns: minmax(0, 1fr); overflow: visible; }
    .tab { padding: 0 4px; font-size: 13px; }
    .tab-badge { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: rgba(251,191,36,.16); color: var(--amber); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .rail-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; }
    .rail-foot .rail-meta { flex: 1 0 100%; padding: 0; gap: 12px; }
    .rail-foot .rail-link { min-height: 44px; padding: 0; }
    .rail-foot .rail-form { margin-left: auto; }
    select { height: 40px; }
    .segmented span { padding: 9px 12px; }
    .fig-link, .fig-note-link { display: inline-flex; align-items: center; min-height: 40px; }
    .figs.health, .figs.cost { grid-template-columns: minmax(0, 1fr); }
    .figs .fig + .fig { border-left: 0; border-top: 1px solid var(--divider); }
    .act { grid-template-columns: 40px minmax(0, 1fr) auto; row-gap: 2px; }
    .act-kind { display: none; }
    .act-meta { grid-column: 2; grid-row: 2; display: flex; flex-wrap: wrap; gap: 2px 12px; }
    .act-ms { grid-row: 1; grid-column: 3; }
    .refresh, .pill { height: 40px; padding: 0 16px; }
    .err-where { grid-column: 1 / -1; font-size: 12px; color: var(--muted); }
  }
  @media (max-width: 900px) {
    .ro { grid-template-columns: auto minmax(0, 1fr) auto; min-height: 0; }
    .ro-figs { grid-column: 2 / -1; grid-row: 3; grid-template-columns: repeat(3, auto); gap: 0 24px; justify-content: start; margin-top: 8px; }
    .ro-fig { justify-items: start; }
    .ro-act { grid-column: 3; grid-row: 1; align-self: start; min-width: 0; }
  }
  @media (max-width: 900px) { .key { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 520px) { .key-meters { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 520px) {
    .ro { padding: 14px; gap: 4px 12px; }
    .ro-tile { width: 32px; height: 32px; font-size: 12px; }
    .ro-what { display: grid; gap: 4px; }
  }
  @media (max-width: 520px) { .tiles { grid-template-columns: minmax(0, 1fr); } th, td { padding: 9px 10px; } }
</style>
</head>
<body>
<div class="shell">
  ${rail("Dashboard", nav, foot)}
  <main class="work">
    <h1 class="sr-only">AIOSubtitles dashboard</h1>
    ${section("overview", "Overview", "Whether AIOSubtitles is doing its job this week, then what it costs this server; the charts go back 14 days. Downloaded is mostly short windows read from videos, sent is subtitles going out to players.",
      card("", "", days) +
      `<section class="now" aria-labelledby="now-title"><h3 class="section-title" id="now-title">Right now</h3><div class="tiles">${tiles}</div></section>`)}
    ${section("keys", "API usage", "Each link's keys, by a short id (never the key), against their free plans. SubSource's bars use its own count, every app on the key included; SubDL's count AIOSubtitles' calls.", `<div class="key-groups">${keyList}</div>`)}
    ${section("activity", "Activity", "Every list and subtitle a player asked for in the last 7 days, which link asked, and how it went. Newest first.", activityFilters + card("", "", activityList) + activityPager)}
    ${section("links", "Links and sources", "What each link is set to, the searches and downloads it caused, and each site's share. Cached results cost none.",
      card("Links", "What each link is set to. Edit opens its configure page; saving there keeps its URL. Keys are never shown.", linkRows) + card("Sources, last 7 days", "All links together.", sourceTable))}
    ${section("errors", "Errors", "What failed, which link it happened to and on what. Repeats are one row with a count; open a row for the whole message. Addresses and tokens are taken out.", clearBar + card("", "", errorRows))}
  </main>
</div>
<script>
  // ---------- sections: one at a time, named in the address so a link or Back opens the same one ----------
  const sections = [...document.querySelectorAll("[data-section]")];
  const showSection = (id, focus) => {
    if (!sections.some((s) => s.dataset.section === id)) id = "overview";
    for (const s of sections) s.hidden = s.dataset.section !== id;
    for (const a of document.querySelectorAll("[data-sec]")) {
      if (a.dataset.sec === id) {
        a.setAttribute("aria-current", "page");
        a.scrollIntoView({ block: "nearest", inline: "nearest" });
      } else a.removeAttribute("aria-current");
    }
    document.documentElement.removeAttribute("data-open");
    if (focus) document.getElementById("sec-" + id).focus({ preventScroll: true });
    window.scrollTo(0, 0);
  };
  addEventListener("hashchange", () => showSection(location.hash.slice(1), true));
  showSection(location.hash.slice(1), false);

  // ---------- activity: filters and pages, both from the server ----------
  const acts = document.getElementById("acts");
  if (acts) {
    const linkFilter = document.getElementById("f-link");
    const newer = document.getElementById("act-newer");
    const older = document.getElementById("act-older");
    const range = document.getElementById("act-range");
    let offset = 0;
    let asked = 0;
    // A page is as many rows as fit the window, with Newer and Older kept at the bottom of it.
    let limit = ${ACTIVITY_PAGE};
    const card = acts.closest(".settings-card");
    const pager = newer.closest(".pager");
    const fit = () => {
      if (acts.closest("[data-section]").hidden) return false;
      const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const row = acts.querySelector(".act");
      if (!row) return false;
      // The card reaches down to just above the pager, whatever the page holds, so the pager stays put.
      card.style.minHeight = "0px";
      const box = card.getBoundingClientRect();
      const list = acts.getBoundingClientRect();
      const below = document.documentElement.scrollHeight - (box.bottom + scrollY);
      const height = innerHeight - box.top - below;
      card.style.minHeight = Math.max(0, height / z) + "px";
      // Rows that fit in it: measured rows (borders included), with room for two day headings, since a
      // page can span midnight, and the card's own padding under the list.
      const rows = acts.querySelectorAll(".act");
      const rowH = (rows[rows.length - 1].getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top) / rows.length;
      const day = acts.querySelector(".act-day");
      const dayH = Math.max(rowH, day ? day.getBoundingClientRect().height : rowH);
      const room = height - (list.top - box.top) - (box.bottom - list.bottom) - 2 * dayH;
      const fits = Math.max(3, Math.min(${ACTIVITY_PAGE}, Math.floor(room / rowH)));
      const changed = fits !== limit;
      limit = fits;
      return changed;
    };
    // The first page as the server drew it: cut to size where it is, so the long list never shows.
    let fresh = true;
    const trim = () => {
      const rows = [...acts.querySelectorAll(".act")];
      for (const row of rows.slice(limit)) row.remove();
      while (acts.lastElementChild && acts.lastElementChild.classList.contains("act-day")) acts.lastElementChild.remove();
      const total = Number(acts.dataset.total) || rows.length;
      const shown = Math.min(limit, rows.length);
      range.textContent = "1–" + shown.toLocaleString("en-US") + " of " + total.toLocaleString("en-US");
      older.disabled = shown >= total;
    };
    const load = async (to) => {
      const kind = (document.querySelector('input[name="kind"]:checked') || {}).value || "";
      const ask = ++asked;
      acts.setAttribute("aria-busy", "true");
      try {
        const query = new URLSearchParams({ offset: String(Math.max(0, to)), link: linkFilter.value, kind, limit: String(limit) });
        const response = await fetch("/stats/activity?" + query, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const page = await response.json();
        if (ask !== asked) return; // a later click won
        offset = page.offset;
        fresh = false;
        acts.innerHTML = page.html;
        document.getElementById("acts-none").hidden = page.total > 0;
        range.textContent = page.range;
        newer.disabled = offset === 0;
        older.disabled = offset + page.count >= page.total;
      } catch {
        if (ask === asked) range.textContent = "Couldn't load that page. Try again.";
      } finally {
        if (ask === asked) acts.removeAttribute("aria-busy");
      }
    };
    // Filters live in the address (?link=…&kind=…), so a view can be bookmarked, refreshed or shared.
    const keepInAddress = () => {
      const kind = (document.querySelector('input[name="kind"]:checked') || {}).value || "";
      const query = new URLSearchParams();
      if (linkFilter.value) query.set("link", linkFilter.value);
      if (kind) query.set("kind", kind);
      history.replaceState(null, "", location.pathname + (query.size ? "?" + query : "") + location.hash);
    };
    const apply = (link, kind) => {
      if ([...linkFilter.options].some((o) => o.value === link)) linkFilter.value = link;
      const radio = document.querySelector('input[name="kind"][value="' + (kind || "") + '"]');
      if (radio) radio.checked = true;
      keepInAddress();
      load(0);
    };
    linkFilter.addEventListener("change", () => { keepInAddress(); load(0); });
    for (const radio of document.querySelectorAll('input[name="kind"]')) radio.addEventListener("change", () => { keepInAddress(); load(0); });
    for (const a of document.querySelectorAll("[data-show-kind]")) a.addEventListener("click", () => apply(a.dataset.showLink || "", a.dataset.showKind));
    const asked0 = new URLSearchParams(location.search);
    if (asked0.get("link") || asked0.get("kind")) apply(asked0.get("link") || "", asked0.get("kind") || "");
    newer.addEventListener("click", () => load(offset - limit));
    older.addEventListener("click", () => load(offset + limit));
    // Fitted when the section opens and when the window changes size.
    const refit = () => {
      if (!fit()) return;
      if (fresh && offset === 0 && acts.querySelectorAll(".act").length >= limit) trim();
      else load(offset);
    };
    addEventListener("hashchange", refit);
    let resizing;
    addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(refit, 150); });
    refit();
  }

  // One tooltip per chart, for the pointer: value first, then the day. Text only, never HTML.
  for (const col of document.querySelectorAll(".col")) {
    const chart = col.closest(".chart");
    const tip = chart.querySelector(".tip");
    col.addEventListener("pointerenter", () => {
      tip.querySelector(".tip-value").textContent = col.dataset.detail;
      tip.querySelector(".tip-day").textContent = col.dataset.day;
      tip.hidden = false;
      // Measured on screen, placed in the page's own pixels: on wide screens the page is zoomed (see --zoom).
      const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zoom")) || 1;
      const box = chart.getBoundingClientRect();
      const bar = col.getBoundingClientRect();
      const width = box.width / z;
      tip.style.left = Math.min(Math.max((bar.left - box.left + bar.width / 2) / z - tip.offsetWidth / 2, 8), width - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max((bar.top - box.top) / z + 24, 8) + "px";
    });
    col.addEventListener("pointerleave", () => { tip.hidden = true; });
  }
</script>
</body>
</html>`;
}
