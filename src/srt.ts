/**
 * Every subtitle goes out as SRT. Download links end in "subtitle.srt" (they
 * are made before the file is fetched), and some players, Jellyfin through
 * AIOMetadata among them, go by that name: an ASS file sent that way showed
 * nothing at all (seen with one service's Arabic). SRT is the one format
 * every player reads. ASS styling and positioning are dropped; the words and
 * timing stay.
 */

interface Line {
  start: number;
  end: number;
  text: string;
}

function srtStamp(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}`;
}

/** "0:01:02.34" (ASS) or "01:02.345" / "00:01:02.345" (VTT) to ms. */
function stamp(value: string): number {
  const parts = value.trim().replace(",", ".").split(":");
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

function fromAss(text: string): Line[] {
  const lines: Line[] = [];
  let fields: string[] = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^format\s*:/i.test(line) && /text\s*$/i.test(line)) {
      fields = line.replace(/^format\s*:/i, "").split(",").map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const values = line.replace(/^dialogue\s*:/i, "").split(",");
    const textAt = fields.indexOf("text");
    const body = values.slice(textAt).join(",");
    // Vector drawings ({\p1}) are shapes, not words.
    if (/\{[^}]*\\p[1-9]/.test(body)) continue;
    const words = body
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    if (!words) continue;
    lines.push({ start: stamp(values[fields.indexOf("start")]), end: stamp(values[fields.indexOf("end")]), text: words });
  }
  return lines;
}

function fromVtt(text: string): Line[] {
  const lines: Line[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at === -1) continue;
    const [a, b] = rows[at].split("-->");
    const words = rows
      .slice(at + 1)
      .map((r) => r.replace(/<(?!\/?[ibu]>)[^>]*>/g, "").trim())
      .filter(Boolean)
      .join("\n");
    if (!words) continue;
    lines.push({ start: stamp(a), end: stamp(b.trim().split(/\s+/)[0]), text: words });
  }
  return lines;
}

/** The subtitle as SRT; text that already is SRT is returned as it is. */
export function toSrt(text: string, ext: string): string {
  const kind = ext.toLowerCase();
  if (kind !== ".ass" && kind !== ".ssa" && kind !== ".vtt") return text;
  const lines = (kind === ".vtt" ? fromVtt(text) : fromAss(text)).filter((l) => l.end > l.start).sort((x, y) => x.start - y.start);
  return lines.map((l, i) => `${i + 1}\n${srtStamp(l.start)} --> ${srtStamp(l.end)}\n${l.text}\n`).join("\n");
}
