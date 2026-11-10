/**
 * What the configure and stats pages share: the colour tokens, base element
 * styles, line icons, the logo, and the full-height rail (a bar of tabs on
 * phones). Each page adds its own styles after these.
 */

import { readFileSync } from "node:fs";

/** Inter (SIL Open Font License), latin, weights 400 to 700, read once at start. */
const INTER = readFileSync(new URL("../assets/inter-latin.woff2", import.meta.url)).toString("base64");

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Line icons, one stroke weight, drawn for these pages. */
const ICON: Record<string, string> = {
  sources: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>',
  sync: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15"/><path d="M4 20v-5h5"/>',
  languages: '<path d="M4 5h9M8.5 3v2M6 5c0 4 3 7 7 8"/><path d="M11 5c-.5 3-2.5 6.5-6 8.5"/><path d="M13 21l4-9 4 9M14.5 18h5"/>',
  filters: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M3 20h18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  shield: '<path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3Z"/><path d="M9.5 12l1.8 1.8L15 10"/>',
  plug: '<path d="M9 7V3M15 7V3"/><path d="M6 7h12v4a6 6 0 0 1-12 0V7Z"/><path d="M12 17v4"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  features: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4L12 3Z"/><path d="M18.5 15.5l.8 2 2 .8-2 .7-.8 2-.8-2-2-.7 2-.8.8-2Z"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/>',
  hash: '<path d="M9 4 7 20M17 4l-2 16M4.5 9h16M3.5 15h16"/>',
  bot: '<path d="M12 4v4"/><circle cx="12" cy="3.5" r=".5"/><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M9 13v1.5M15 13v1.5M2 13.5v2M22 13.5v2"/>',
  ear: '<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/>',
  tag: '<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1a1 1 0 0 1 .7.3l7.4 7.4a1 1 0 0 1 0 1.4l-8.1 8.1a1 1 0 0 1-1.4 0l-7.4-7.4a1 1 0 0 1-.3-.7Z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.5v5l4.5-2.5L10 9.5Z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16.5 6.5l3 3M14 9l2 2"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  alert: '<path d="M12 8v5M12 16.5v.01"/><path d="M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20.3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'
};

export function icon(name: string, cls = "i"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

/** The logo cropped to its artwork (176×120), so it lines up with the name beside it. */
export const MARK = `<img class="mark" src="/mark.png?v=6" width="44" height="30" alt="">`;

/** The head both pages open with: favicon, Inter, colour scheme. */
export function headTags(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="/favicon.png?v=6">
`;
}

/** Tokens, base elements, and the rail. */
export const SHARED_CSS = `
  .tile { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 8px; background: #151515; border: 1px solid rgba(255,255,255,.08); color: var(--brand-300); font-size: 12px; font-weight: 700; letter-spacing: .02em; }
  /* Inter is inside the page itself, so it is there for the very first paint: no download to wait
     for, and nothing for the login in front of the site to block. "block" means text is drawn in
     Inter or not yet at all, never first in another font. If Inter ever fails, Arial stands in,
     scaled to Inter's measurements. */
  @font-face { font-family: "Inter"; font-style: normal; font-weight: 400 700; font-display: block; src: url("data:font/woff2;base64,${INTER}") format("woff2"); }
  @font-face { font-family: "Inter Fallback"; src: local("Arial"), local("ArialMT"), local("Helvetica"); size-adjust: 107.06%; ascent-override: 90.49%; descent-override: 22.56%; line-gap-override: 0%; }
  :root {
    --background: #070707; --paper: #0b0b0b; --paper-2: #101010; --field: #0d0d0d;
    --border: rgba(255,255,255,.1); --divider: rgba(40,40,40,.9);
    --subtle: rgba(255,255,255,.06); --subtle-2: rgba(255,255,255,.08);
    --foreground: #d1d1d1; --white: #f5f5f5; --muted: rgba(255,255,255,.52); --placeholder: rgba(255,255,255,.48);
    --brand: #6152df; --brand-300: #c7c2ff; --brand-400: #9f92ff; --brand-soft: rgba(97,82,223,.14);
    --green: #4ade80; --red: #f87171; --amber: #fbbf24;
    --control-border: rgba(255,255,255,.38);
    --radius: 8px; --radius-xl: 12px;
    --rail: 272px;
    --ease: cubic-bezier(.2,.8,.2,1);
    --font: Inter, "Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  /* Wide screens: the whole page a little larger, so at 100% it doesn't sit small in the middle of
     the window. Heights measured against the window divide by it (see .rail). */
  :root { --zoom: 1; }
  /* Height counts too, so a wide but short window (browser bars, a taskbar) isn't pushed into scrolling. */
  @media (min-width: 1680px) and (min-height: 760px) { :root { --zoom: 1.12; } }
  @media (min-width: 1920px) and (min-height: 1000px) { :root { --zoom: 1.22; } }
  @media (min-width: 2400px) and (min-height: 1250px) { :root { --zoom: 1.4; } }
  html { background: var(--background); zoom: var(--zoom); scrollbar-gutter: stable; }
  body { margin: 0; min-height: calc(100vh / var(--zoom)); color: var(--foreground); font: 15px/1.5 var(--font); -webkit-font-smoothing: antialiased;
    /* One soft violet light over the work area. */
    background: radial-gradient(1100px 520px at calc(var(--rail) + 38%) -260px, rgba(97,82,223,.13), transparent 70%) no-repeat, var(--background); }
  ::selection { background: var(--brand); color: #fff; }
  * { scrollbar-width: thin; scrollbar-color: #262626 transparent; }
  input, textarea { caret-color: var(--brand-400); }
  a { color: var(--brand-300); text-underline-offset: 3px; text-decoration-color: rgba(199,194,255,.4); }
  a:hover { text-decoration-color: currentColor; }
  :focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  [hidden] { display: none !important; }
  .i { width: 18px; height: 18px; flex: none; }
  .i.xs { width: 14px; height: 14px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }

  /* The shell: a full-height rail, then the page's work area. */
  .shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); align-content: start; min-height: calc(100vh / var(--zoom)); }
  .rail { position: sticky; top: 0; height: calc(100vh / var(--zoom)); display: flex; flex-direction: column; gap: 20px; padding: 24px 16px; background: rgba(11,11,11,.72); border-right: 1px solid var(--border); }
  .identity { display: flex; align-items: center; gap: 12px; padding: 0 8px; }
  .mark { width: 44px; height: 30px; flex: none; }
  .identity-name { font-weight: 700; font-size: 17px; color: var(--white); letter-spacing: -.01em; }
  .identity-state { font-size: 12.5px; color: var(--muted); }
  .tabs { display: grid; gap: 2px; }
  .nav-label { margin: 0 0 6px; padding: 0 12px; font-size: 12px; font-weight: 500; color: var(--muted); }
  .tab { position: relative; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 12px; border: 0; border-radius: var(--radius); background: transparent; color: var(--muted); font: 500 15px var(--font); text-align: left; text-decoration: none; cursor: pointer; transition: background .2s, color .2s; }
  .tab:hover { background: rgba(255,255,255,.03); color: var(--white); }
  .tab[aria-selected=true], .tab[aria-current=page] { background: var(--subtle); color: var(--white); }
  .tab[aria-selected=true]::before, .tab[aria-current=page]::before { content: ""; position: absolute; left: -16px; top: 12px; bottom: 12px; width: 2px; border-radius: 0 2px 2px 0; background: var(--brand-400); }
  .tab-i { width: 18px; height: 18px; }
  .tab[aria-selected=true] .tab-i, .tab[aria-current=page] .tab-i { color: var(--brand-400); }
  .tab-text { display: grid; min-width: 0; }
  .tab-label { line-height: 1.3; }
  .tab-sub { font-size: 12.5px; font-weight: 400; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tab-sub.warn { color: var(--amber); }
  .rail-foot { margin-top: auto; display: grid; gap: 8px; }
  .rail-link { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--radius); color: var(--muted); font-size: 13.5px; text-decoration: none; transition: color .2s, background .2s; }
  .rail-link:hover { color: var(--white); background: rgba(255,255,255,.03); }
  .rail-form { margin: 0; }
  .rail-button { width: 100%; border: 0; background: transparent; font-family: var(--font); text-align: left; cursor: pointer; }

  @media (max-width: 860px) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    .rail { position: static; height: auto; gap: 14px; padding: 16px; border-right: 0; border-bottom: 1px solid var(--border); background: rgba(11,11,11,.85); }
    .nav-label, .rail-foot, .tab-sub, .tab[aria-selected=true]::before, .tab[aria-current=page]::before { display: none; }
    .tabs { grid-auto-flow: column; grid-auto-columns: minmax(max-content, 1fr); overflow-x: auto; scrollbar-width: none; padding: 4px; background: var(--paper); border: 1px solid var(--border); border-radius: var(--radius-xl); }
    .tabs::-webkit-scrollbar { display: none; }
    .tab { justify-content: center; min-height: 40px; padding: 0 12px; font-size: 14px; gap: 8px; }
  }
  @media (max-width: 520px) { .tab-i { display: none; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/** The rail: logo and state, the page's tabs or links, then a footer. */
export function rail(state: string, nav: string, foot: string): string {
  return `<aside class="rail">
    <div class="identity">${MARK}<div><div class="identity-name">AIOSubtitles</div><div class="identity-state">${escapeHtml(state)}</div></div></div>
    ${nav}
    <div class="rail-foot">${foot}</div>
  </aside>`;
}
