/**
 * The configure page: neutral blacks, paper-dark cards split by faint
 * dividers, a violet brand used sparingly.
 *
 * A guided flow, one step at a time: Sync (required: it's what AIOSubtitles is
 * for), Sources, Languages, Filters, then Name and create. The rail lists the
 * steps with a live one-line status each. Every step is checked by the server
 * when the person moves on, so a mistake shows under the field it's about,
 * in the step where it was made; a new link can't skip ahead past an
 * unfinished step. The one main action, Create my link, only exists on the
 * last step, next to a review of everything and an optional name for the link.
 *
 * Someone changing an existing link (AIOStreams' Reconfigure button) opens on
 * the review, can jump to any step, and saves from there.
 *
 * Served as one self-contained page. Saved keys and URLs are never written
 * into it: the page only knows they exist.
 */
import { config, PUBLIC_AIOSTREAMS } from "./config.js";
import { MAX_ADDONS, REGULAR_ENGLISH, type Settings } from "./profile.js";
import { logoutButton } from "./access.js";
import { escapeHtml, headTags, icon, rail, SHARED_CSS } from "./ui.js";

const COMMON_LANGUAGES = [
  "English", "Arabic", "French", "Spanish", "Portuguese", "German", "Italian", "Turkish",
  "Indonesian", "Malay", "Persian", "Urdu", "Russian", "Polish", "Dutch", "Japanese", "Korean", "Vietnamese"
];

/** The steps, in order: id, name in the rail, its icon. */
const STEPS: Array<[id: string, label: string, iconName: string]> = [
  ["sync", "Sync", "sync"],
  ["sources", "Sources", "sources"],
  ["languages", "Languages", "languages"],
  ["filters", "Filters", "filters"],
  ["finish", "Name and create", "tag"]
];

/** A source's tile, so each row reads at a glance: two letters for the built-in sites, a plug for added addons. */
function tile(letters: string): string {
  return `<span class="tile" aria-hidden="true">${letters === "plug" ? icon("plug", "i xs") : escapeHtml(letters)}</span>`;
}

type Secret = "subsource" | "subdl" | "aiostreams";

/** A key or URL row: saved values are never sent here, only the fact that one exists. */
function secretRow(opts: { name: Secret; label: string; placeholder: string; saved: boolean; help: string; removeLabel?: string; letters?: string; required?: boolean }): string {
  const { name, label, placeholder, saved, help, removeLabel, letters, required } = opts;
  const keep = removeLabel ? ` <button type="button" class="text-btn" data-remove>${removeLabel}</button>` : "";
  return `<div class="item field" data-field="${name}"${saved ? " data-saved" : ""}>
      <div class="field-head">
        ${letters ? tile(letters) : ""}
        <label for="f-${name}">${label}</label>
        ${saved ? `<span class="badge" data-badge>${icon("check", "i xs")}<span>Saved</span></span>` : required ? `<span class="badge need">Required</span>` : ""}
      </div>
      <div class="input-wrap">
        <input id="f-${name}" type="password" name="${name}" placeholder="${saved ? "Type a new one to replace it" : placeholder}" autocomplete="off" spellcheck="false" aria-describedby="h-${name}"${required && !saved ? " required" : ""}>
        <button type="button" class="reveal" data-reveal data-label="${label}" aria-label="Show ${label}" aria-pressed="false">${icon("eye")}</button>
      </div>
      <p class="hint" id="h-${name}">${saved ? `Saved. Leave empty to keep it.${keep}` : help}</p>
    </div>`;
}

function switchRow(name: string, title: string, help: string, on: boolean, letters?: string, extra = ""): string {
  return `<label class="item toggle">
      ${letters ? tile(letters) : ""}
      <span class="toggle-text"><span class="item-title" id="t-${name}">${title}</span><span class="hint" id="h-${name}">${help}</span>${extra}</span>
      <span class="switch"><input type="checkbox" name="${name}" aria-labelledby="t-${name}" aria-describedby="h-${name}"${on ? " checked" : ""}><span class="track" aria-hidden="true"></span></span>
    </label>`;
}

function card(title: string, description: string, rows: string): string {
  return `<div class="settings-card">
      ${title || description ? `<div class="card-head">${title ? `<h3 class="card-title">${title}</h3>` : ""}${description ? `<p class="card-desc">${description}</p>` : ""}</div>` : ""}
      <div class="card-body">${rows}</div>
    </div>`;
}

/** One step: its heading, its cards, and the way on (Back, Next) at the bottom. */
function stepPanel(index: number, title: string, description: string, cards: string, open: boolean): string {
  const [id, , iconName] = STEPS[index];
  const next = STEPS[index + 1];
  const back = index > 0 ? `<button type="button" class="btn ghost" data-back>${icon("chevron", "i xs flip")}Back</button>` : "<span></span>";
  const forward = next
    ? `<button type="button" class="btn primary" data-next><span class="label">Next: ${next[1]}</span><span class="btn-end" aria-hidden="true">${icon("chevron", "i xs")}<span class="spin"></span></span></button>`
    : "";
  return `<section class="panel" id="panel-${id}" data-step="${id}" aria-labelledby="title-${id}" tabindex="-1"${open ? "" : " hidden"}>
      <div class="panel-head"><h2 id="title-${id}"><span class="panel-icon" aria-hidden="true">${icon(iconName)}</span>${title}</h2><p>${description}</p></div>
      ${cards}
      ${next ? `<div class="step-nav">${back}<span class="step-count">Step ${index + 1} of ${STEPS.length}</span>${forward}<span class="sr-only" role="status" data-live></span></div><p class="step-status" role="status"></p>` : ""}
    </section>`;
}

/** The three things AIOSubtitles is for, shown side by side. */
function headline(iconName: string, title: string, text: string): string {
  return `<div class="headline"><h4 class="headline-title"><span class="headline-icon" aria-hidden="true">${icon(iconName, "i xs")}</span>${title}</h4><p class="headline-text">${text}</p></div>`;
}

/** A smaller feature: icon, name, one line. */
function perk(_iconName: string, title: string, text: string): string {
  return `<li class="perk"><h4 class="perk-title">${title}</h4><p class="perk-text">${text}</p></li>`;
}

/**
 * What AIOSubtitles does, for viewers rather than developers. It opens on what
 * they will actually see: their player's subtitle menu with AIOSubtitles'
 * tracks, and subtitles sliding into line with the voices. Then the three
 * main features, then the smaller ones in a line each. First thing a new
 * visitor sees, and the start of the flow.
 */
function featuresPanel(editing: boolean, open: boolean): string {
  // Speech and caption blocks at the same spots: the captions slide into line once, on arrival.
  const spots = [[4, 17], [27, 24], [58, 13], [77, 19]];
  const lane = (cls: string) => spots.map(([left, width]) => `<i class="${cls}" style="left:${left}%;width:${width}%"></i>`).join("");
  const showcase = `<div class="showcase">
      <div class="showcase-copy">
        <h3 class="showcase-title">Subtitles that match the dub, timed to your video.</h3>
        <p class="showcase-text">Pick an episode. AIOSubtitles finds the best subtitles, lines them up with your exact file, and hands them to your player.</p>
        <div class="timing" aria-hidden="true">
          <div class="lane"><span class="lane-label">Voices</span><span class="lane-row">${lane("voice")}</span></div>
          <div class="lane"><span class="lane-label">Subtitles</span><span class="lane-row">${lane("cue")}</span></div>
          <p class="timing-note">${icon("check", "i xs")}Lined up with your file</p>
        </div>
        <div class="start">
          <button type="button" class="btn primary" data-goto="${editing ? "finish" : "sync"}">${editing ? "Back to my settings" : "Set up my link"}${icon("chevron", "i xs")}</button>
          <p class="hint">${editing ? "Your settings are as you left them." : "Takes about a minute."}</p>
        </div>
      </div>
      <div class="player" role="img" aria-label="Your player's subtitle menu, showing English dub captions and Spanish, synced, from AIOSubtitles">
        <p class="player-title">Subtitles</p>
        <span class="player-row on"><span class="radio"></span><span class="player-name">English<small>Dub · Synced · AIOSubtitles</small></span>${icon("check", "i xs")}</span>
        <span class="player-row"><span class="radio"></span><span class="player-name">Spanish<small>Synced · AIOSubtitles</small></span></span>
        <span class="player-row"><span class="radio"></span><span class="player-name">Off</span></span>
      </div>
    </div>`;
  const headlines = `<div class="headlines">
      ${headline("captions", "English Dub captions", "Written from the dub, so the words match the voices. Official English CC when a show has none.")}
      ${headline("sync", "Synced to your video", "Retimed to the exact file you play, even one with no subtitles of its own, or a subtitle made for another frame rate. No delay to adjust yourself.")}
      ${headline("globe", "Your languages too", "The best subtitle in each language you pick, like Spanish, right next to the English one.")}
    </div>`;
  const perks = `<ul class="perks">
      ${perk("star", "Real translations first", "Official, then made by people. No machine or AI unless you allow it.")}
      ${perk("target", "Made for your copy", "Subtitles from the same group or streaming service win.")}
      ${perk("layers", "Many sources, one pick", "SubSource, SubDL, OpenSubtitles, Subtitle Cat and your own addons.")}
      ${perk("hash", "Knows anime numbering", "Episode 113 or season 2 episode 13, season packs too.")}
      ${perk("tag", "Honest labels", "One that can't be synced to your file says so, or is left out if you choose.")}
      ${perk("play", "Works where you watch", "Through AIOStreams, in Stremio, Jellyfin and other players.")}
    </ul>`;
  return `<section class="panel" id="panel-features" data-step="features" aria-labelledby="title-features" tabindex="-1"${open ? "" : " hidden"}>
      <h2 class="sr-only" id="title-features">What AIOSubtitles does</h2>
      ${showcase}${headlines}
      <div class="picks"><h3 class="card-title">How it picks the best one</h3>${perks}</div>
    </section>`;
}

export function configurePage(current?: Settings, signedIn = false): string {
  const editing = Boolean(current);
  const chosen = new Set((current?.languages ?? ["English"]).map((l) => l.toLowerCase()));
  const others = (current?.languages ?? []).filter((l) => ![...COMMON_LANGUAGES, REGULAR_ENGLISH].some((c) => c.toLowerCase() === l.toLowerCase()));
  const hi = current?.hearingImpaired ?? "include";
  const openSubtitlesOn = current ? current.opensubtitles === true : true;
  const subtitleCatOn = current?.subtitlecat === true;
  // The public instances a link may use, each opening its own site (where Save & install is) in a new tab.
  // This server's own AIOStreams comes first, when it has one.
  const instanceLinks = [...(config.ownAiostreams ? [config.ownAiostreams] : []), ...PUBLIC_AIOSTREAMS.filter((o) => config.allowedAiostreams.includes(o) && o !== config.ownAiostreams)]
    .map((o) => `<li><a class="instance" href="${escapeHtml(o)}" target="_blank" rel="noopener"><span class="instance-host">${escapeHtml(o.replace(/^https?:\/\//, ""))}</span>${icon("external", "i xs")}<span class="sr-only"> (opens in a new tab)</span></a></li>`)
    .join("");
  const instancesDialog = `<dialog class="dialog" id="instances" aria-labelledby="instances-title" tabindex="-1">
      <div class="dialog-head">
        <h2 class="dialog-title" id="instances-title">${icon("globe")}Which AIOStreams instances work?</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon("close")}</button>
      </div>
      <p class="hint">If someone set one up for you, use theirs${config.ownAiostreams ? " (the first one here)" : ""}. Otherwise any of these works: open it, set it up, then copy the install URL from <b>Save &amp; install</b>.</p>
      <ul class="instances">${instanceLinks}</ul>
    </dialog>`;

  // Saved addons show by name and host only: the rest of their URL can hold that addon's keys.
  const savedAddons = current?.addons ?? [];
  const addonRows = savedAddons
    .map((addon, i) => `<div class="item addon" data-addon="${i}" data-name="${escapeHtml(addon.name)}">
          ${tile("plug")}
          <span class="toggle-text"><span class="item-title">${escapeHtml(addon.name)}</span><span class="hint">${escapeHtml(new URL(addon.url).hostname)}</span></span>
          <button type="button" class="text-btn" data-remove-addon aria-label="Remove ${escapeHtml(addon.name)}">Remove</button>
        </div>`)
    .join("");

  // English comes twice: "English" in the settings is the dub captions (as on every link so far), and
  // REGULAR_ENGLISH the regular subtitles; the hint under the chips says which is which.
  const chip = (value: string, label: string) =>
    `<label class="chip"><input type="checkbox" name="lang" value="${value}"${chosen.has(value.toLowerCase()) ? " checked" : ""}><span>${label}</span></label>`;
  const chips = [
    chip("English", "English Dub"),
    chip(REGULAR_ENGLISH, "English"),
    ...COMMON_LANGUAGES.filter((name) => name !== "English").map((name) => chip(name, name))
  ].join("");

  // A new visitor starts on what AIOSubtitles does; someone changing their link starts on the review.
  const opening = editing ? "finish" : "features";
  // Editing, the last step is a review rather than a creation.
  const stepLabel = (id: string, label: string) => (editing && id === "finish" ? "Review and save" : label);
  const stepButtons = STEPS.map(
    ([id, label], i) =>
      `<li><button type="button" class="tab step-tab" data-tab="${id}" id="tab-${id}"><span class="step-num" aria-hidden="true"><span class="n">${i + 1}</span>${icon("check", "i xs tick")}</span><span class="tab-text"><span class="tab-label">${stepLabel(id, label)}</span><span class="tab-sub" data-sub="${id}"></span><span class="sr-only" data-state-text></span></span></button></li>`
  ).join("");
  const nav = `<nav class="nav" aria-label="Setup">
      <button type="button" class="tab intro-tab" data-tab="features" id="tab-features">${icon("features", "i tab-i")}<span class="tab-text"><span class="tab-label">What it does</span></span></button>
      <p class="nav-label" id="steps-label">${editing ? "Your settings" : "Set up your link"}</p>
      <ol class="tabs steps-list" aria-labelledby="steps-label">${stepButtons}</ol>
    </nav>`;

  const reviewRows = STEPS.slice(0, 4).map(
    ([id, label]) =>
      `<div class="review-row"><span class="review-label">${label}</span><span class="review-value" data-sum="${id}"></span><button type="button" class="text-btn" data-goto="${id}">Change<span class="sr-only"> ${label.toLowerCase()}</span></button></div>`
  ).join("");

  // What to do with the link, one action per line. Someone changing a link pastes it into Reconfigure.
  const afterSteps = editing
    ? `<li>Open <b>AIOSubtitles</b> in your addons and press <b>Reconfigure</b>.</li>
       <li><b>Paste</b> this link into its box and save.</li>`
    : `<li>Go to <b>Addons</b> and choose <b>Add addon → Custom</b>.</li>
       <li><b>Paste</b> this link as the Manifest URL.</li>
       <li>Tick <b>Subtitles</b> under Resources, then save.</li>`;

  const panels = [
    featuresPanel(editing, opening === "features"),
    stepPanel(0, "Connect AIOStreams", "It tells AIOSubtitles which file you're playing, so every subtitle can be timed to it. Nothing in AIOStreams is changed.",
      card("", "", `
        ${secretRow({ name: "aiostreams", label: "AIOStreams install URL", placeholder: "https://…/stremio/…/…/manifest.json", saved: Boolean(current?.aiostreams), help: "In AIOStreams, open <b>Save &amp; install</b> and copy the install URL. It's the same one you add to Stremio or Jellyfin.", letters: "AS", required: true })}
        <div class="item"><button type="button" class="link-btn" data-open="instances" aria-haspopup="dialog">${icon("globe", "i xs")}<span>Which AIOStreams instances work?</span></button></div>`), false),
    stepPanel(1, "Choose your sources", "Where subtitles are searched. Turn on at least one; the best result wins, whichever site it's from.",
      card("Subtitle sites", "Your keys stay encrypted inside your link.", `
        ${secretRow({ name: "subsource", label: "SubSource API key", placeholder: "sk_…", saved: Boolean(current?.subsource), help: 'Optional. From <a href="https://subsource.net/api" target="_blank" rel="noopener">subsource.net/api</a>.', removeLabel: "Stop using SubSource", letters: "SS" })}
        ${secretRow({ name: "subdl", label: "SubDL API key", placeholder: "Your SubDL key", saved: Boolean(current?.subdl), help: 'Optional. From <a href="https://subdl.com/panel/api" target="_blank" rel="noopener">subdl.com/panel/api</a>. Often has dub caption packs.', removeLabel: "Stop using SubDL", letters: "SD" })}
        ${switchRow("opensubtitles", "OpenSubtitles", "Through OpenSubtitles V3+. No key needed.", openSubtitlesOn, "OS")}
        ${switchRow("subtitlecat", "Subtitle Cat", "Uploads the other sites lack, such as fan translations. Found by name, so one is listed only once it has synced to your file. No key needed; works beside at least one other source.", subtitleCatOn, "SC")}`) +
      card("Other subtitle addons", "Optional. Any Stremio subtitle addon is asked too, and what it finds is ranked and synced.", `
        ${addonRows}
        <details class="item more"${savedAddons.length ? " open" : ""}>
          <summary>${icon("plug", "i xs")}<span>${savedAddons.length ? "Add more addons" : "Add an addon"}</span></summary>
          <div class="field">
            <label class="sr-only" for="f-addons">Addon manifest URLs</label>
            <textarea id="f-addons" name="addAddons" rows="2" placeholder="https://…/manifest.json, one per line" spellcheck="false" autocomplete="off" aria-describedby="h-addons"></textarea>
            <p class="hint" id="h-addons">Up to ${MAX_ADDONS}, by manifest URL. Not AIOStreams itself, since it asks AIOSubtitles.</p>
          </div>
        </details>`), false),
    stepPanel(2, "Pick your languages", "Every language you pick gets its best subtitle, synced to your file.",
      card("", "", `
        <div class="item"><fieldset class="chips" aria-describedby="h-english"><legend class="sr-only">Subtitle languages</legend>${chips}</fieldset>
          <p class="hint english-hint" id="h-english">The two English choices only matter for anime and other shows not made in English. <b>English Dub</b> is for watching the English dub: captions written from it, so they match the English voices. <b>English</b> is for watching in Japanese or the original language: regular subtitles. Shows made in English get regular English subtitles with either.</p></div>
        <div class="item field">
          <div class="field-head"><label for="f-other">Other languages</label></div>
          <input id="f-other" type="text" name="otherLangs" placeholder="Comma-separated, e.g. Greek, Thai" value="${escapeHtml(others.join(", "))}" spellcheck="false">
        </div>`), false),
    stepPanel(3, "Set your filters", "Which subtitles are allowed. Official translations always rank first, then people's.",
      card("", "", `
        ${switchRow("allowMachine", "Machine and AI translations", "On: they can be picked too. Off leaves them out completely.", Boolean(current?.allowMachine))}
        ${switchRow("skipEmbedded", "Skip languages the file already has", "On: a language the video already has full subtitles in is left out. English Dub always stays.", current?.keepEmbedded !== true)}
        ${switchRow("hideUnsynced", "Only subtitles that sync", "On: a subtitle that can't be synced to your file is left out, instead of listed as not synced.", current?.hideUnsynced === true)}
        ${switchRow("statusInName", "Status in the track name", "On: for players that show only the track's name. How yours will list them:", current?.statusInName === true, undefined,
          `<span class="track-preview" aria-hidden="true" data-preview></span>`)}
        <div class="item toggle">
          <span class="toggle-text"><span class="item-title" id="hi-title">Hearing-impaired subtitles</span><span class="hint">For the other languages: include them, leave them out, or use only them. Dub captions always describe sounds.</span></span>
          <span class="segmented" role="radiogroup" aria-labelledby="hi-title">${(["include", "exclude", "only"] as const)
            .map((v) => `<label><input type="radio" name="hi" value="${v}"${hi === v ? " checked" : ""}><span>${v[0].toUpperCase()}${v.slice(1)}</span></label>`)
            .join("")}</span>
        </div>`), false),
    stepPanel(4, editing ? "Review and save" : "Name it and create your link", editing ? "Change any step, then save. Your link stays the same." : "Check everything once more, give the link a name, and create it.",
      card("", "", `
        <div class="item field">
          <div class="field-head"><label for="f-label">Link name</label><span class="badge soft">Optional</span></div>
          <input id="f-label" type="text" name="label" maxlength="40" placeholder="e.g. Sara, Living room TV" value="${escapeHtml(current?.label ?? "")}" spellcheck="false" autocomplete="off" aria-describedby="h-label">
          <p class="hint" id="h-label">Shown on the dashboard instead of the link's id, so you can tell links apart.</p>
        </div>`) +
      card("Review", "", `<div class="review">${reviewRows}</div>`) +
      `<div class="finish" id="finish">
        <button type="button" class="btn ghost" data-back>${icon("chevron", "i xs flip")}Back</button>
        <button type="submit" class="btn primary big" id="save"><span class="spin" aria-hidden="true"></span><span id="save-label">${editing ? "Save changes" : "Create my link"}</span></button>
        <p id="status" role="status"></p>
      </div>
      <section class="result" id="result" aria-labelledby="result-title" hidden>
        <h3 class="result-title" id="result-title">${icon("check", "i xs")}<span>Your link is ready</span></h3>
        <output id="url" aria-label="Your AIOSubtitles link"></output>
        <p class="stale-note">${editing ? "Settings changed. Save them to apply." : "Settings changed. Save them to get the updated link."}</p>
        <p class="in-place-note">Your link stays the same. AIOStreams uses the new settings from the next play, nothing to paste.</p>
        <button type="button" class="btn primary big" id="copy"><span class="state idle">${icon("copy", "i xs")}Copy link</span><span class="state done" aria-hidden="true">${icon("check", "i xs")}Copied</span></button>
        <span class="sr-only" id="copy-status" role="status"></span>
        <h4 class="after-title">Then, in AIOStreams</h4>
        <ol class="after">${afterSteps}</ol>
      </section>`, opening === "finish")
  ].join("");

  const foot = `<a class="rail-link" href="/stats">${icon("chart", "i xs")}Dashboard</a>${logoutButton(signedIn)}`;

  return `<!doctype html>
<html lang="en">
<head>
${headTags("AIOSubtitles")}
<style>
${SHARED_CSS}
  .work { display: grid; grid-template-columns: minmax(0, 760px); justify-content: center; align-content: start; padding: 36px 48px 32px; min-width: 0; }
  /* The intro is read, not filled in: a wider column, so it fits a screen without scrolling. */
  .features-open .work { grid-template-columns: minmax(0, 920px); padding-top: 32px; padding-bottom: 28px; }

  /* ---------- the steps in the rail ---------- */
  .nav { display: grid; gap: 4px; }
  .intro-tab { margin-bottom: 14px; }
  .steps-list { margin: 0; padding: 0; list-style: none; }
  .steps-list li { display: grid; }
  .step-num { position: relative; display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 50%; border: 1.5px solid rgba(255,255,255,.22); font-size: 12.5px; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; transition: background .2s, border-color .2s, color .2s; }
  .step-num .tick { display: none; }
  .step-tab[data-state=done] .step-num { border-color: rgba(159,146,255,.5); color: var(--brand-300); background: rgba(97,82,223,.14); }
  .step-tab[data-state=done] .step-num .n { display: none; }
  .step-tab[data-state=done] .step-num .tick { display: block; }
  .step-tab[aria-current=step] .step-num { border-color: var(--brand-400); background: var(--brand); color: #fff; }
  .step-tab[aria-current=step] .step-num .n { display: block; }
  .step-tab[aria-current=step] .step-num .tick { display: none; }
  .tab[aria-current=step] { background: var(--subtle); color: var(--white); }
  .tab[aria-current=step]::before { content: ""; position: absolute; left: -16px; top: 12px; bottom: 12px; width: 2px; border-radius: 0 2px 2px 0; background: var(--brand-400); }
  .step-tab:disabled { cursor: default; opacity: .45; }
  .step-tab:disabled:hover { background: transparent; color: var(--muted); }

  /* ---------- a step ---------- */
  .panel { display: grid; gap: 24px; }
  .panel:focus { outline: none; }
  h1.sr-only { font-size: 22px; }
  /* The icon sits on the title's line; the line under it starts on the same edge as the icon and the cards. */
  .panel-head { display: grid; gap: 8px; }
  .panel-head h2 { display: flex; align-items: center; gap: 12px; }
  .panel-icon { display: grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 9px; background: linear-gradient(180deg, rgba(97,82,223,.2), rgba(97,82,223,.06)); border: 1px solid rgba(159,146,255,.22); color: var(--brand-300); }
  .panel-icon .i { width: 18px; height: 18px; }
  .panel-head h2 { margin: 0; font-size: 22px; font-weight: 600; color: var(--white); letter-spacing: -.02em; line-height: 1.2; text-wrap: balance; }
  .panel-head p { margin: 0; color: var(--muted); max-width: 64ch; text-wrap: pretty; }

  .step-nav { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; padding-top: 20px; border-top: 2px solid var(--divider); }
  .step-count { justify-self: center; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .step-status { margin: -12px 0 0; font-size: 13px; color: var(--red); }
  .step-status:empty { display: none; }
  .flip { transform: rotate(180deg); }

  .settings-card { display: grid; gap: 12px; }
  .card-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--white); }
  .card-desc { margin: 2px 0 0; font-size: 14px; color: var(--muted); }
  .card-body { background: var(--paper); border: 1px solid var(--border); border-radius: var(--radius-xl); overflow: clip; }
  .item { padding: 16px 18px; transition: background .2s; }
  .item + .item { border-top: 2px solid var(--divider); }
  label.item:hover { background: var(--paper-2); }

  .field { display: grid; gap: 10px; }
  .field-head { display: flex; align-items: center; gap: 10px; min-height: 30px; }
  .field-head label { font-weight: 500; font-size: 14px; color: var(--white); }
  .badge { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--green); background: rgba(74,222,128,.1); }
  .badge.off { color: var(--red); background: rgba(248,113,113,.1); }
  .badge.need { color: var(--brand-300); background: rgba(97,82,223,.16); }
  .badge.soft { color: var(--muted); background: var(--subtle); font-weight: 500; }
  .input-wrap { position: relative; }
  /* Field edges at 3:1 against the card, so an empty field is still visibly a field. */
  input[type=text], input[type=password], textarea { width: 100%; height: 42px; padding: 0 12px; background: var(--field); border: 1px solid var(--control-border); border-radius: var(--radius); color: var(--white); font: 14px var(--font); transition: border-color .2s, box-shadow .2s; }
  textarea { display: block; height: auto; min-height: 68px; padding: 10px 12px; line-height: 1.5; resize: vertical; }
  .input-wrap input { padding-right: 46px; }
  input::placeholder, textarea::placeholder { color: var(--placeholder); }
  input[type=text]:hover, input[type=password]:hover, textarea:hover { border-color: rgba(255,255,255,.46); }
  input[type=text]:focus, input[type=password]:focus, textarea:focus { outline: none; border-color: var(--brand-400); box-shadow: 0 0 0 3px rgba(97,82,223,.3); }
  [aria-invalid=true] { border-color: var(--red) !important; box-shadow: 0 0 0 3px rgba(248,113,113,.18) !important; }
  .field-error { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 13px; color: var(--red); }
  .field-error .i { margin-top: 2px; }
  .addon { display: flex; align-items: center; gap: 12px; }
  .addon .toggle-text { flex: 1; min-width: 0; }
  .addon .hint { overflow-wrap: anywhere; }
  .addon .text-btn { flex: none; font-size: 13px; padding: 6px 4px; }
  .addon.removing .item-title { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--red); }
  .addon.removing .tile { opacity: .4; }
  .field.removing input { opacity: .4; }
  .more > summary { display: inline-flex; align-items: center; gap: 8px; list-style: none; cursor: pointer; color: var(--brand-300); font-size: 14px; font-weight: 500; border-radius: 4px; }
  .more > summary::-webkit-details-marker { display: none; }
  .more > summary:hover span { text-decoration: underline; text-underline-offset: 3px; }
  .more[open] > summary { margin-bottom: 12px; color: var(--white); }
  .reveal { position: absolute; right: 3px; top: 3px; width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--placeholder); cursor: pointer; }
  .reveal:hover { color: var(--white); background: var(--subtle); }
  .reveal[aria-pressed=true] { color: var(--brand-400); }
  .hint { margin: 0; font-size: 13px; color: var(--muted); }
  .link-btn { display: inline-flex; align-items: center; gap: 8px; padding: 0; border: 0; background: none; color: var(--brand-300); font: 500 14px var(--font); cursor: pointer; border-radius: 4px; }
  .link-btn:hover span { text-decoration: underline; text-underline-offset: 3px; }
  .dialog { width: min(480px, calc(100vw / var(--zoom) - 32px)); padding: 20px; border-radius: var(--radius-xl); border: 1px solid rgba(255,255,255,.14); background: var(--paper); color: var(--foreground); box-shadow: 0 24px 64px -16px rgba(0,0,0,.9); }
  .dialog[open] { display: grid; gap: 14px; }
  .dialog::backdrop { background: rgba(0,0,0,.6); }
  .dialog:focus { outline: none; }
  .dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .dialog-title { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 16px; font-weight: 600; color: var(--white); }
  .dialog-title .i { color: var(--brand-300); }
  .icon-btn { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border: 0; border-radius: var(--radius); background: transparent; color: var(--muted); cursor: pointer; }
  .icon-btn:hover { color: var(--white); background: var(--subtle); }
  .instances { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius); overflow: clip; }
  .instances li + li { border-top: 1px solid var(--divider); }
  .instance { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 14px; color: var(--white); text-decoration: none; }
  .instance:hover { background: var(--paper-2); }
  .instance .i { color: var(--muted); }
  .instance:hover .i { color: var(--brand-300); }
  .instance-host { font: 13.5px var(--mono); overflow-wrap: anywhere; }
  .instance:focus-visible { outline-offset: -3px; }
  .hint b { color: var(--foreground); font-weight: 600; }
  .more .hint { margin-top: 0; }
  .text-btn { border: 0; background: none; padding: 0; font: inherit; color: var(--brand-300); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(199,194,255,.4); }
  .text-btn:hover { text-decoration-color: currentColor; }

  .toggle { display: flex; align-items: center; gap: 12px; cursor: pointer; }
  div.toggle { cursor: default; }
  .toggle-text { display: grid; gap: 1px; flex: 1; min-width: 0; }
  .item-title { font-weight: 500; font-size: 14px; color: var(--white); }
  .switch { position: relative; flex: none; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .track { display: block; width: 36px; height: 21px; border-radius: 999px; background: rgba(255,255,255,.1); border: 1px solid var(--control-border); transition: background .2s, border-color .2s; }
  .track::after { content: ""; position: absolute; top: 2.5px; left: 2.5px; width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,.72); box-shadow: 0 2px 6px rgba(0,0,0,.5); transition: transform .2s var(--ease), background .2s; }
  label.item:hover .track { background: rgba(255,255,255,.14); }
  .switch input:checked + .track, label.item:hover .switch input:checked + .track { background: var(--brand); border-color: var(--brand-400); }
  .switch input:checked + .track::after { transform: translateX(15px); background: #fff; }
  .switch input:focus-visible + .track { outline: 2px solid var(--brand-400); outline-offset: 2px; }

  .segmented { display: inline-flex; flex: none; padding: 3px; gap: 2px; background: var(--field); border: 1px solid var(--control-border); border-radius: var(--radius); }
  .segmented label { position: relative; cursor: pointer; }
  .segmented input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .segmented span { display: block; padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--muted); transition: background .2s, color .2s; }
  .segmented label:hover span { color: var(--white); }
  .segmented input:checked + span { background: rgba(255,255,255,.12); color: var(--white); }
  .segmented input:focus-visible + span { outline: 2px solid var(--brand-400); outline-offset: 1px; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
  .chip { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 13px; border-radius: var(--radius); border: 1px solid rgba(255,255,255,.16); background: var(--field); color: var(--muted); font-size: 13.5px; font-weight: 500; cursor: pointer; user-select: none; transition: background .2s, color .2s, border-color .2s; }
  .chip:hover { color: var(--white); border-color: rgba(255,255,255,.3); }
  .chip input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .chip:has(input:checked) { color: var(--white); background: rgba(97,82,223,.2); border-color: rgba(159,146,255,.45); }
  .chip:has(input:focus-visible) { outline: 2px solid var(--brand-400); outline-offset: 2px; }
  .english-hint { margin-top: 12px; }

  /* ---------- the last step: review, the one main action, the link ---------- */
  .review { display: grid; }
  .review-row { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; align-items: baseline; gap: 14px; padding: 14px 18px; }
  .review-row + .review-row { border-top: 2px solid var(--divider); }
  .review-label { font-size: 13px; color: var(--muted); }
  .review-value { font-size: 14px; font-weight: 500; color: var(--white); overflow-wrap: anywhere; }
  .review-value.warn { color: var(--amber); }
  /* A 20px-tall word, with a tap area of 40px around it that doesn't move the row. */
  .review-row .text-btn { font-size: 13px; padding: 10px 8px; margin: -10px -8px; }
  .finish { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 12px; }
  .finish .btn.ghost { height: 48px; }
  #status { grid-column: 1 / -1; margin: 0; font-size: 13px; color: var(--muted); }
  /* Room kept for the message, so it never pushes anything when it appears. */
  #status { min-height: 20px; }
  #status.bad { color: var(--red); }
  #status.ok { color: var(--green); }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 44px; padding: 0 18px; border-radius: var(--radius); font: 500 14px var(--font); white-space: nowrap; cursor: pointer; transition: background .2s, opacity .2s, color .2s, border-color .2s; }
  .btn.big { width: 100%; height: 48px; font-size: 15px; }
  .btn.primary { color: #fff; border: 1px solid rgba(159,146,255,.3); background: rgba(97,82,223,.82); }
  .btn.primary:hover { background: rgba(97,82,223,.98); }
  .btn.ghost { color: var(--foreground); border: 1px solid var(--border); background: transparent; }
  .btn.ghost:hover { color: var(--white); background: rgba(255,255,255,.04); }
  .btn.outline { color: var(--brand-300); border: 1px solid rgba(159,146,255,.32); background: transparent; }
  .btn.outline:hover { background: rgba(97,82,223,.15); }
  .btn.busy { cursor: progress; opacity: .75; }
  /* Not ready yet: grey and off, the same size, so nothing moves when it turns on. */
  .btn.primary:disabled:not(.busy), .btn.primary:disabled:not(.busy):hover { opacity: 1; color: var(--muted); background: rgba(255,255,255,.06); border-color: var(--border); cursor: not-allowed; }
  .btn:disabled:not(.busy) { opacity: .5; cursor: default; }
  .spin { display: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: spin .7s linear infinite; }
  .btn.busy .spin { display: block; }
  .btn-end { display: grid; width: 14px; height: 14px; }
  .btn-end > * { grid-area: 1 / 1; }
  .btn.busy .btn-end .i { visibility: hidden; }
  /* The full-width buttons keep their label centred: the spinner sits at the end. */
  .btn.big { position: relative; }
  .btn.big .spin { position: absolute; right: 18px; top: calc(50% - 7px); }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Copy → Copied: both states sit in one grid cell and cross-fade, so the button never resizes. */
  #copy { display: inline-grid; place-items: center; }
  /* Opacity only, each state on a layer it keeps, so the text never shifts when the fade ends. */
  #copy .state { grid-area: 1 / 1; display: inline-flex; align-items: center; gap: 8px; will-change: opacity; transition: opacity .2s var(--ease); }
  #copy .done { opacity: 0; }
  #copy.copied { color: var(--green); border-color: rgba(74,222,128,.4); background: rgba(74,222,128,.1); }
  #copy.copied .idle { opacity: 0; }
  #copy.copied .done { opacity: 1; }

  .result { display: grid; gap: 12px; padding: 18px; border-radius: var(--radius-xl); background: var(--paper); border: 1px solid rgba(74,222,128,.25); }
  .result-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; color: var(--white); }
  .result-title .i { color: var(--green); }
  .in-place-note { display: none; margin: 0; color: var(--muted); }
  .result.in-place .in-place-note { display: block; }
  .result.in-place #url, .result.in-place #copy, .result.in-place .after-title, .result.in-place .after { display: none; }
  .result output { display: block; padding: 10px 12px; background: var(--field); border: 1px solid var(--border); border-radius: var(--radius); font: 12.5px/1.5 var(--mono); color: var(--brand-300); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stale-note { display: none; margin: 0; font-size: 13px; color: var(--amber); }
  .result.stale { border-color: rgba(251,191,36,.3); }
  .result.stale output, .result.stale .after { opacity: .45; }
  .result.stale .result-title .i { color: var(--muted); }
  .result.stale .stale-note { display: block; }
  .after-title { margin: 6px 0 0; font-size: 13.5px; font-weight: 600; color: var(--white); }
  .after { margin: 0; padding-left: 20px; color: var(--foreground); font-size: 14px; display: grid; gap: 8px; }
  .after li::marker { color: var(--brand-300); font-weight: 600; }
  .after b { color: var(--white); font-weight: 600; }

  /* ---------- what it does ---------- */
  .showcase { position: relative; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 28px; align-items: center; padding: 28px; border-radius: 16px; border: 1px solid rgba(159,146,255,.18); background: radial-gradient(520px 260px at 100% 0%, rgba(97,82,223,.16), transparent 70%), var(--paper); overflow: hidden; }
  .showcase-title { margin: 0; font-size: 24px; line-height: 1.25; font-weight: 600; letter-spacing: -.02em; color: var(--white); text-wrap: balance; }
  .showcase-text { margin: 10px 0 0; font-size: 14.5px; line-height: 1.6; color: var(--muted); max-width: 46ch; }
  /* Voices and subtitles: the subtitle blocks arrive off by a beat and settle into line, once. */
  .timing { display: grid; gap: 8px; margin-top: 18px; }
  .lane { display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: center; gap: 10px; }
  .lane-label { font-size: 12px; color: var(--muted); }
  .lane-row { position: relative; height: 12px; border-radius: 999px; background: rgba(255,255,255,.04); }
  .lane-row i { position: absolute; top: 0; bottom: 0; border-radius: 999px; }
  .voice { background: rgba(255,255,255,.22); }
  .cue { background: var(--brand-400); animation: settle 1.1s var(--ease) .5s both; }
  @keyframes settle { from { transform: translateX(-22px); opacity: .55; } }
  /* Fades in after the subtitles settle. Opacity only, on a layer it keeps for good: when an animated
     layer goes away, the browser redraws the text with different smoothing and it visibly snaps. */
  .timing-note { display: flex; align-items: center; gap: 6px; margin: 4px 0 0 74px; font-size: 12.5px; color: var(--green); will-change: opacity; animation: appear .4s var(--ease) 1.5s both; }
  @keyframes appear { from { opacity: 0; } }
  .player { display: grid; gap: 4px; padding: 14px; border-radius: 12px; background: #121212; border: 1px solid rgba(255,255,255,.1); box-shadow: 0 24px 48px -24px rgba(0,0,0,.95); }
  .player-title { margin: 0 0 6px; padding: 0 8px; font-size: 13px; font-weight: 600; color: var(--white); }
  .player-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border-radius: 8px; color: var(--foreground); font-size: 14px; }
  .player-row.on { background: rgba(97,82,223,.2); color: var(--white); }
  .player-row .i { margin-left: auto; color: var(--brand-300); }
  .radio { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 1.5px solid rgba(255,255,255,.4); }
  .player-row.on .radio { border-color: var(--brand-300); background: radial-gradient(circle, var(--brand-300) 0 3.5px, transparent 4px); }
  .player-name { display: grid; line-height: 1.3; }
  .player-name small { font-size: 12px; color: var(--muted); }
  .track-preview { display: grid; gap: 2px; margin-top: 8px; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius); background: rgba(255,255,255,.02); max-width: 320px; }
  .track-row { display: grid; padding: 6px 8px; border-radius: 6px; color: var(--foreground); font-size: 13.5px; font-weight: 500; line-height: 1.35; }
  .track-row:first-child { background: rgba(255,255,255,.05); }
  .track-row small { font-size: 12px; font-weight: 400; color: var(--muted); }
  .headlines { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); background: var(--paper); border: 1px solid var(--border); border-radius: var(--radius-xl); overflow: clip; }
  .headline { display: grid; align-content: start; gap: 6px; padding: 16px 20px; }
  .headline + .headline { border-left: 1px solid var(--divider); }
  .headline-icon { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 7px; background: rgba(97,82,223,.16); color: var(--brand-300); }
  .headline-title { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 15px; font-weight: 600; color: var(--white); }
  .headline-text { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--muted); }
  .picks { display: grid; gap: 14px; }
  .perks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 28px; margin: 0; padding: 0; list-style: none; }
  .perk { padding-top: 12px; border-top: 1px solid var(--divider); }
  .perk-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--white); }
  .perk-text { margin: 3px 0 0; font-size: 13px; line-height: 1.5; color: var(--muted); }
  .start { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; }
  /* On phones the way in comes right after the showcase, not four screens down. */
  .showcase .start { margin-top: 20px; flex-wrap: nowrap; }
  .showcase .start .btn { flex: none; }
  .showcase .start .hint { flex: 1; min-width: 0; }
  .features-open .panel { gap: 20px; }

  /* ---------- narrower screens ---------- */
  @media (max-width: 1240px) {
    .showcase { grid-template-columns: minmax(0, 1fr); }
    .perks { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .player { max-width: 380px; }
  }
  @media (max-width: 860px) {
    .work { padding: 20px 16px 48px; }
    .nav { gap: 8px; }
    .nav > .nav-label { display: none; }
    .intro-tab { justify-self: start; min-height: 44px; margin: 0; padding: 0 8px; font-size: 13.5px; }
    /* Thumb-sized: 44px for the small buttons (language chips keep their size). */
    .reveal { top: 0; right: 0; width: 44px; height: 44px; }
    input[type=text], input[type=password] { height: 44px; }
    .input-wrap input { padding-right: 50px; }
    .icon-btn { width: 44px; height: 44px; }
    .segmented span { padding: 12px 14px; }
    .link-btn { min-height: 44px; }
    .intro-tab .tab-i { display: block; width: 16px; height: 16px; }
    /* The bar shows numbers; every step keeps its name for screen readers. */
    .step-tab:not([aria-current=step]) .tab-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .step-tab .tab-sub { display: none; }
    .tabs.steps-list { grid-auto-columns: auto; padding: 4px; }
    .step-tab { min-height: 44px; }
    .tab[aria-current=step]::before { display: none; }
    .panel-head h2 { font-size: 20px; }
    .showcase { padding: 20px; }
    .showcase-title { font-size: 21px; }
    .headlines, .perks { grid-template-columns: minmax(0, 1fr); }
    .headline + .headline { border-left: 0; border-top: 1px solid var(--divider); }
    .start .btn { width: 100%; }
    .showcase .start { flex-wrap: wrap; }
    .item { padding: 14px 16px; }
    div.toggle { flex-wrap: wrap; }
    div.toggle .segmented { width: 100%; }
    div.toggle .segmented label { flex: 1; text-align: center; }
    .step-nav { grid-template-columns: auto 1fr; }
    .step-count { display: none; }
    .step-nav [data-next] { justify-self: end; }
    .review-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
    .review-value { grid-column: 1; }
    .review-row .text-btn { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
  }
</style>
</head>
<body${opening === "features" ? ' class="features-open"' : ""}>
<div class="shell">
  ${rail(editing ? (current?.label ? `Editing ${current.label}` : "Editing your link") : "New link", nav, foot)}
  <main class="work">
    <h1 class="sr-only">${editing ? "Change your AIOSubtitles link" : "Set up AIOSubtitles"}</h1>
    <form id="form" autocomplete="off" novalidate>${panels}</form>
  </main>
</div>
${instancesDialog}
<script>
  // ---------- the instances dialog: Esc, the close button, or a click outside closes it ----------
  for (const opener of document.querySelectorAll("[data-open]")) {
    const dialog = document.getElementById(opener.dataset.open);
    // The dialog itself takes focus, so Tab starts at its first link and no ring shows on opening.
    opener.addEventListener("click", () => { dialog.showModal(); dialog.focus(); });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target.closest("[data-close]")) dialog.close();
    });
    dialog.addEventListener("close", () => opener.focus());
  }

  const form = document.getElementById("form");
  const status = document.getElementById("status");
  const save = document.getElementById("save");
  const saveLabel = document.getElementById("save-label");
  const result = document.getElementById("result");
  const copyButton = document.getElementById("copy");
  const editing = ${editing ? "true" : "false"};
  const calm = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STEPS = ${JSON.stringify(STEPS.map(([id]) => id))};
  const NAMES = ${JSON.stringify(STEPS.map(([id, label]) => (editing && id === "finish" ? "Review and save" : label)))};
  const setStatus = (text, kind) => { status.textContent = text; status.className = kind || ""; };

  // ---------- the flow ----------
  // How far a new link has got: steps after it stay locked until each one before is done.
  // Someone changing a link has done them all, so every step is open.
  let reached = editing ? STEPS.length - 1 : -1;
  let current = ${JSON.stringify(opening)};
  const tabs = [...document.querySelectorAll("[data-tab]")];
  /** Once every step before the last is done, moving on from a step goes straight back to the review. */
  const toReview = () => reached >= STEPS.length - 2;
  const paint = () => {
    const b = body();
    for (const tab of tabs) {
      const id = tab.dataset.tab;
      const i = STEPS.indexOf(id);
      if (id === current) tab.setAttribute("aria-current", i >= 0 ? "step" : "page");
      else tab.removeAttribute("aria-current");
      if (i < 0) continue;
      // Open: every step done so far, and the one after it. Done: passed, and still valid as it stands.
      tab.disabled = i > reached + 1;
      const done = id !== current && i <= reached && !localProblem(id, b);
      tab.dataset.state = done ? "done" : "todo";
      tab.querySelector("[data-state-text]").textContent = id === current ? ", current step" : tab.disabled ? ", locked until " + NAMES[i - 1] + " is done" : done ? ", done" : "";
    }
    // Next stays on: pressing it with something missing says what, under the field.
    for (const button of document.querySelectorAll("[data-next]")) {
      const id = button.closest("[data-step]").dataset.step;
      const i = STEPS.indexOf(id);
      button.querySelector(".label").textContent = toReview() ? "Back to review" : "Next: " + NAMES[i + 1];
    }
    if (!save.classList.contains("busy")) save.disabled = linkShown && JSON.stringify(b) === savedState;
  };
  const show = (id, focus) => {
    current = id;
    document.body.classList.toggle("features-open", id === "features");
    for (const panel of document.querySelectorAll("[data-step]")) panel.hidden = panel.dataset.step !== id;
    paint();
    const panel = document.getElementById("panel-" + id);
    if (focus !== false) {
      panel.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: calm ? "smooth" : "auto" });
    }
  };
  for (const tab of tabs) tab.addEventListener("click", () => !tab.disabled && show(tab.dataset.tab));
  /** Opens a step and puts the cursor on one of its fields. */
  const goTo = (id, fieldId) => {
    show(id, false);
    const field = fieldId && document.getElementById(fieldId);
    const target = field && !field.disabled ? field : document.getElementById("panel-" + id);
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: calm ? "smooth" : "auto", block: "center" });
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-goto]");
    if (!link) return;
    show(link.dataset.goto);
  });

  for (const button of document.querySelectorAll("[data-reveal]")) {
    button.addEventListener("click", () => {
      const input = button.parentElement.querySelector("input");
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      // One signal for the state: the name stays "Show …", pressed says whether it's shown.
      button.setAttribute("aria-pressed", String(visible));
    });
  }

  // Removing a saved key: the server clears it when the field says "remove".
  for (const button of document.querySelectorAll("[data-remove]")) {
    const field = button.closest(".field");
    const input = field.querySelector("input");
    const badge = field.querySelector("[data-badge]");
    const label = button.textContent;
    button.addEventListener("click", () => {
      const removing = !field.classList.contains("removing");
      field.classList.toggle("removing", removing);
      input.disabled = removing;
      input.value = "";
      button.textContent = removing ? "Undo" : label;
      if (badge) { badge.classList.toggle("off", removing); badge.lastElementChild.textContent = removing ? "Will be removed" : "Saved"; }
      refresh();
    });
  }

  // Removing a saved addon: sent by position; Undo takes it back.
  for (const button of document.querySelectorAll("[data-remove-addon]")) {
    const row = button.closest("[data-addon]");
    button.addEventListener("click", () => {
      const removing = row.classList.toggle("removing");
      button.textContent = removing ? "Undo" : "Remove";
      button.setAttribute("aria-label", (removing ? "Keep " : "Remove ") + row.dataset.name);
      refresh();
    });
  }

  const value = (name) => {
    const field = form.querySelector('[data-field="' + name + '"]');
    if (field && field.classList.contains("removing")) return "remove";
    return String(new FormData(form).get(name) || "").trim();
  };
  /** A key or URL that will be in the link: typed now, or saved and not being removed. */
  const present = (name) => {
    const field = form.querySelector('[data-field="' + name + '"]');
    if (!field || field.classList.contains("removing")) return false;
    return field.hasAttribute("data-saved") || value(name) !== "";
  };

  const body = () => {
    const data = new FormData(form);
    return {
      subsource: value("subsource"),
      subdl: value("subdl"),
      opensubtitles: data.get("opensubtitles") === "on",
      subtitlecat: data.get("subtitlecat") === "on",
      addAddons: String(data.get("addAddons") || ""),
      removeAddons: [...document.querySelectorAll("[data-addon].removing")].map((row) => Number(row.dataset.addon)),
      aiostreams: value("aiostreams"),
      languages: [...data.getAll("lang"), ...String(data.get("otherLangs") || "").split(",").map((s) => s.trim()).filter(Boolean)],
      allowMachine: data.get("allowMachine") === "on",
      keepEmbedded: data.get("skipEmbedded") !== "on",
      statusInName: data.get("statusInName") === "on",
      hideUnsynced: data.get("hideUnsynced") === "on",
      hearingImpaired: data.get("hi") || "include",
      label: String(data.get("label") || "").trim()
    };
  };

  // ---------- errors under the field they're about ----------
  // The server's messages start with the field's name ("SubDL API key: …"); each maps to its step and field.
  const FIELDS = [
    ["SubSource", "sources", "f-subsource"], ["SubDL", "sources", "f-subdl"], ["Other addons", "sources", "f-addons"],
    ["Sources", "sources", "f-subsource"], ["AIOStreams", "sync", "f-aiostreams"], ["Languages", "languages", "f-other"],
    ["Link name", "finish", "f-label"], ["Hearing", "filters", ""]
  ];
  const stepStatus = (id) => document.querySelector('#panel-' + id + ' .step-status') || status;
  const clearErrors = () => {
    for (const el of document.querySelectorAll(".field-error")) el.remove();
    for (const el of document.querySelectorAll(".step-status")) el.textContent = "";
    for (const el of document.querySelectorAll("[aria-invalid]")) {
      el.removeAttribute("aria-invalid");
      if (el.dataset.describedby !== undefined) el.setAttribute("aria-describedby", el.dataset.describedby);
    }
  };
  const showError = (message) => {
    const hit = FIELDS.find(([prefix]) => message.startsWith(prefix));
    const field = hit && hit[2] ? document.getElementById(hit[2]) : null;
    if (!hit || !field) {
      stepStatus(current).textContent = message;
      if (stepStatus(current) === status) status.className = "bad";
      return;
    }
    if (hit[2] === "f-addons") field.closest("details").open = true;
    const note = document.createElement("p");
    note.className = "field-error";
    note.id = "err-" + hit[2];
    note.innerHTML = ${JSON.stringify(icon("alert", "i xs"))};
    const text = document.createElement("span");
    text.textContent = message.replace(/^[^:]+:\\s*/, "").replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.");
    note.append(text);
    (field.closest(".input-wrap") || field).after(note);
    field.dataset.describedby = field.getAttribute("aria-describedby") || "";
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", (note.id + " " + field.dataset.describedby).trim());
    goTo(hit[1], hit[2]);
  };

  // ---------- each step's one-line state, in the rail and the review ----------
  const set = (key, text, kind, short) => {
    for (const el of document.querySelectorAll('[data-sum="' + key + '"], [data-sub="' + key + '"]')) {
      el.textContent = el.hasAttribute("data-sub") && short ? short : text;
      // Amber only in the review: in the rail, a step not reached yet isn't a problem.
      el.classList.toggle("warn", kind === "warn" && el.hasAttribute("data-sum"));
    }
  };
  const HI = { include: "included", exclude: "left out", only: "only" };
  /** The AIOStreams URL the server last accepted: "" for the saved one, which it accepted when it was saved. */
  let checkedAio = document.querySelector('[data-field="aiostreams"][data-saved]') ? "" : null;
  let savedState = JSON.stringify(body());
  let linkShown = false;
  const refresh = () => {
    const b = body();
    const syncOn = present("aiostreams");
    const syncChecked = syncOn && b.aiostreams === checkedAio;
    set("sync", !syncOn ? "Not connected yet" : syncChecked ? "On, to the file you play" : "Checked when you move on", syncOn ? "" : "warn", !syncOn ? "Needed" : syncChecked ? "Connected" : "Not checked yet");
    const sites = [present("subsource") && "SubSource", present("subdl") && "SubDL", b.opensubtitles && "OpenSubtitles", b.subtitlecat && "Subtitle Cat"].filter(Boolean);
    const addons = document.querySelectorAll("[data-addon]:not(.removing)").length + b.addAddons.split(/\\s+/).filter(Boolean).length;
    const total = sites.length + addons;
    if (addons) sites.push(addons === 1 ? "1 addon" : addons + " addons");
    set("sources", sites.length ? sites.join(", ") : "None yet", sites.length ? "" : "warn", total > 2 ? total + " on" : "");
    const langs = b.languages.map((l) => (l === "English" ? "English Dub" : l === "${REGULAR_ENGLISH}" ? "English" : l));
    set("languages", langs.length ? langs.join(", ") : "None chosen", langs.length ? "" : "warn");
    set("filters", "Machine translations " + (b.allowMachine ? "allowed" : "off") + " · Hearing-impaired " + HI[b.hearingImpaired] + (b.keepEmbedded ? "" : " · Skips the file's languages") + (b.hideUnsynced ? " · Synced only" : ""), "", "Machine translations " + (b.allowMachine ? "allowed" : "off"));
    set("finish", b.label ? b.label : editing ? "Save your changes" : "Create your link", "");
    const preview = document.querySelector("[data-preview]");
    if (preview) {
      // As players show them: the name, then the label under it.
      const pick = b.languages.find((l) => l !== "English");
      const other = pick === "${REGULAR_ENGLISH}" ? "English" : pick || "Spanish";
      const rows = [
        b.languages.includes("English") && [b.statusInName ? "English Dub (Synced)" : "English", "Dub · Synced · AIOSubtitles"],
        [b.statusInName ? other + " (Synced)" : other, "Synced · AIOSubtitles"]
      ].filter(Boolean);
      preview.innerHTML = rows.map(([name, label]) => '<span class="track-row">' + name.replace(/[<&]/g, "") + "<small>" + label + "</small></span>").join("");
    }

    // Once the link exists, copying it is the one thing to do; saving comes back only after a change.
    const dirty = JSON.stringify(b) !== savedState;
    result.classList.toggle("stale", linkShown && dirty);
    copyButton.disabled = linkShown && dirty;
    document.getElementById("finish").hidden = linkShown && !dirty;
    saveLabel.textContent = editing || linkShown ? "Save changes" : "Create my link";
    paint();
  };
  const edited = (event) => {
    const field = event.target;
    if (field.getAttribute && field.getAttribute("aria-invalid")) clearErrors();
    refresh();
  };
  form.addEventListener("input", edited);
  form.addEventListener("change", edited);

  // ---------- moving on: each step is checked where it is ----------
  const checkUrl = location.pathname.replace(/\\/$/, "") + "/check";
  // The label stays put while checking (a spinner takes the chevron's place); what's happening is
  // said to screen readers instead, so the button never changes size.
  const busy = (button, on, text) => {
    button.disabled = on;
    button.classList.toggle("busy", on);
    const live = button.parentElement.querySelector("[data-live]");
    if (live) live.textContent = on ? text : "";
  };
  /** What can be told without asking the server. A declaration, so paint() can use it from the start. */
  function localProblem(id, b) {
    if (id === "sync" && !present("aiostreams")) return "AIOStreams install URL: needed. Paste the install link from AIOStreams";
    if (id === "sync" && b.aiostreams && b.aiostreams !== "remove" && !/\\/manifest\\.json$/.test(b.aiostreams)) return "AIOStreams install URL: it ends in /manifest.json";
    if (id === "sources" && !present("subsource") && !present("subdl") && !b.opensubtitles && !document.querySelectorAll("[data-addon]:not(.removing)").length && !b.addAddons.trim()) return "Sources: " + (b.subtitlecat ? "Subtitle Cat needs another source beside it. " : "") + "Add a SubSource or SubDL key, turn on OpenSubtitles, or add an addon";
    if (id === "languages" && !b.languages.length) return "Languages: pick at least one";
    return "";
  }
  const CHECKING = { sync: "Checking your AIOStreams link…", sources: "Checking your keys…" };
  const next = async (button) => {
    clearErrors();
    const id = current;
    const b = body();
    const local = localProblem(id, b);
    if (local) return showError(local);
    busy(button, true, CHECKING[id] || "Checking…");
    try {
      const response = await fetch(checkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: id, ...b }) });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) return showError(answer.error || "Couldn't check this step. Try again in a moment.");
      const i = STEPS.indexOf(id);
      if (id === "sync") checkedAio = b.aiostreams;
      reached = Math.max(reached, i);
      refresh();
      show(toReview() ? "finish" : STEPS[i + 1]);
    } catch {
      showError("Couldn't reach AIOSubtitles. Check your connection and try again.");
    } finally {
      busy(button, false);
      paint();
    }
  };
  for (const button of document.querySelectorAll("[data-next]")) button.addEventListener("click", () => next(button));
  for (const button of document.querySelectorAll("[data-back]")) {
    button.addEventListener("click", () => show(STEPS[STEPS.indexOf(current) - 1]));
  }

  // A link is short to look at, whole when copied.
  const short = (url) => url.replace(/^(https?:\\/\\/[^/]+\\/)(.{10}).+(.{6})(\\/manifest\\.json)$/, "$1$2…$3$4");

  // Enter in a field moves the flow on; only the last step saves.
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (current !== "finish") {
      // Enter does what the button does, and nothing while the button is off.
      const button = document.querySelector("#panel-" + current + " [data-next]");
      if (button && !button.disabled) next(button);
      return;
    }
    if (save.disabled) return;
    // A step above that still needs something: shown there, under its field.
    const missing = STEPS.slice(0, -1).find((id) => localProblem(id, body()));
    if (missing) {
      clearErrors();
      show(missing, false);
      showError(localProblem(missing, body()));
      return;
    }
    clearErrors();
    const sent = body();
    save.disabled = true;
    save.classList.add("busy");
    setStatus("Checking everything once more…");
    try {
      const response = await fetch(location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent) });
      const answer = await response.json();
      if (!response.ok) throw new Error(answer.error || "Couldn't save. Try again in a moment.");
      const url = document.getElementById("url");
      url.textContent = short(answer.manifestUrl);
      url.dataset.full = answer.manifestUrl;
      result.classList.toggle("in-place", Boolean(answer.inPlace));
      document.querySelector("#result-title span").textContent = answer.inPlace ? "Saved to your link" : "Your link is ready";
      result.hidden = false;
      linkShown = true;
      reached = STEPS.length - 1;
      savedState = JSON.stringify(sent);
      setStatus("");
      result.scrollIntoView({ behavior: calm ? "smooth" : "auto", block: "nearest" });
      if (!answer.inPlace) copyButton.focus({ preventScroll: true });
    } catch (error) {
      setStatus("");
      showError(error.message);
    } finally {
      save.classList.remove("busy");
      refresh();
      paint();
    }
  });

  copyButton.addEventListener("click", async () => {
    const output = document.getElementById("url");
    const text = output.dataset.full || output.textContent;
    try { await navigator.clipboard.writeText(text); } catch { const area = document.createElement("textarea"); area.value = text; document.body.append(area); area.select(); document.execCommand("copy"); area.remove(); }
    copyButton.classList.add("copied");
    document.getElementById("copy-status").textContent = "Link copied. Paste it into AIOStreams.";
    clearTimeout(copyButton.resetTimer);
    copyButton.resetTimer = setTimeout(() => copyButton.classList.remove("copied"), 1800);
  });

  refresh();
</script>
</body>
</html>`;
}
