/**
 * How well speech heard in a file's audio lines up with the file's own subtitle lines, over audio
 * windows recorded from past plays (.replay/audio, one folder per file: <from>.pcm 16 kHz mono
 * 16-bit, <from>.srt the subtitle track over the same 40 s, meta.json). The offset should be ~0.
 *
 *   npx tsx scripts/vad-eval.ts            the shipped speech shape
 *   npx tsx scripts/vad-eval.ts --sweep    a few shapes side by side
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { measureSpeech, measureWindow, parseCues, speechCues } from "../src/sync.js";
import { SPEECH_SHAPE, type SpeechShape, speechChances, speechFromChances } from "../src/vad.js";
import { cacheKey } from "../src/cache.js";

const root = path.resolve(".replay", "audio");
interface Window { file: string; from: number; lines: ReturnType<typeof parseCues>; chances: Float32Array; pcm: Buffer; dub: boolean }

const windows: Window[] = [];
for (const dir of (await readdir(root)).sort()) {
  if (!existsSync(path.join(root, dir, "meta.json"))) continue; // a file that failed partway
  const meta = JSON.parse(await readFile(path.join(root, dir, "meta.json"), "utf8"));
  if (!meta.text) continue;
  // Dual-audio anime: speech is the English dub's, lines are timed to the Japanese.
  const dub = meta.audioLangs.length > 1 && /^eng?$/.test(meta.audioLang ?? "") && meta.audioLangs.some((l: string) => /^(jpn|ja)$/.test(l));
  // The lines as the server read them (ffmpeg -copyts, true times). The .srt beside the audio was
  // written without -copyts: a line already showing at the window's start moves every line later.
  let stored: { windows: Array<{ from: number; cues: Array<{ start: number; end: number }> }> } | undefined;
  try {
    stored = JSON.parse(await readFile(path.resolve(".replay", "cache", "anchors", `${cacheKey({ kind: "file-anchors", filename: meta.filename })}.json`), "utf8"));
  } catch {}
  for (const from of meta.spots as number[]) {
    const pcm = await readFile(path.join(root, dir, `${from}.pcm`));
    const known = stored?.windows.find((w) => w.from === from);
    if (!known || known.cues.length < 3) continue;
    const lines = known.cues;
    windows.push({ file: meta.filename, from, lines, chances: await speechChances(pcm), pcm, dub });
  }
}

function score(name: string, speechOf: (w: Window) => ReturnType<typeof parseCues>, byOnsets = false) {
  const rows = windows.map((w) => ({ w, m: w.lines.length >= 3 ? (byOnsets ? measureSpeech(speechOf(w), w.lines) : measureWindow(w.lines, speechOf(w))) : undefined }));
  const group = (dub: boolean) => {
    const set = rows.filter((r) => r.w.dub === dub && r.w.lines.length >= 3);
    const offs = set.flatMap((r) => (r.m ? [Math.abs(r.m.offset)] : [])).sort((a, b) => a - b);
    const within = (ms: number) => `${set.filter((r) => r.m && Math.abs(r.m.offset) <= ms).length}/${set.length}`;
    return `${dub ? "dual-audio" : "single    "}: measured ${offs.length}/${set.length}, within 0.3 s ${within(300)}, 0.5 s ${within(500)}, 1 s ${within(1000)}, median ${offs.length ? offs[offs.length >> 1] : "-"} ms`;
  };
  console.log(`\n${name}\n  ${group(false)}\n  ${group(true)}`);
  return rows;
}

const sweep = process.argv.includes("--sweep");
console.log(`${windows.length} windows from ${new Set(windows.map((w) => w.file)).size} files`);
// The loudness detector as shipped before, on the same audio after the same band filter isn't
// available here: unfiltered audio, for a rough comparison only.
score("loudness (old, unfiltered audio)", (w) => speechCues(w.pcm, w.from));
const shapes: Array<[string, SpeechShape]> = sweep
  ? [0.3, 0.5, 0.7].flatMap((threshold) => [100, 300, 600].map((joinMs) => [`silero t=${threshold} join=${joinMs}`, { ...SPEECH_SHAPE, threshold, joinMs }] as [string, SpeechShape]))
  : [["silero (shipped shape)", SPEECH_SHAPE]];
let last;
for (const [name, shape] of shapes) score(`${name}, overlap`, (w) => speechFromChances(w.chances, w.from, shape));
score("loudness, line starts", (w) => speechCues(w.pcm, w.from), true);
for (const [name, shape] of shapes) last = score(`${name}, line starts`, (w) => speechFromChances(w.chances, w.from, shape), true);
if (!sweep && last) {
  console.log("\nper window (silero):");
  for (const { w, m } of last) console.log(`  ${w.file.slice(0, 44).padEnd(44)} ${String(Math.round(w.from / 1000)).padStart(5)}s lines=${String(w.lines.length).padStart(2)} speech=${String(speechFromChances(w.chances, w.from).length).padStart(2)} ${m ? `${m.offset}ms (${m.score})` : "-"}`);
}

// Whole files: every window of a file at once (measureSpeechFile), against the file's own lines
// (should land at ~0) and against another file's lines laid over the same windows (should fail).
if (process.argv.includes("--files")) {
  const { measureSpeechFile } = await import("../src/sync.js");
  const files = [...new Set(windows.map((w) => w.file))];
  const shapes2: Array<[string, SpeechShape]> = [[`t=0.5 join=300`, { ...SPEECH_SHAPE, threshold: 0.5, joinMs: 300 }]];
  for (const [name, shape] of shapes2) {
    console.log(`\nwhole files, silero ${name}:`);
    const neg: number[][] = [];
    for (const file of files) {
      const own = windows.filter((w) => w.file === file);
      const speechWindows = own.map((w) => ({ from: w.from, to: w.from + 40000, speech: speechFromChances(w.chances, w.from, shape) }));
      const lines = own.flatMap((w) => w.lines).sort((a, b) => a.start - b.start);
      const r = measureSpeechFile(speechWindows, lines);
      // Another file's lines, window by window, moved onto this file's windows.
      const other = windows.filter((w) => w.file === files[(files.indexOf(file) + 1) % files.length]);
      const fake = own.flatMap((w, i) => (other[i] ? other[i].lines.map((c) => ({ start: c.start - other[i].from + w.from, end: c.end - other[i].from + w.from })) : [])).sort((a, b) => a.start - b.start);
      const n = measureSpeechFile(speechWindows, fake);
      if (n) neg.push([n.score, n.margin]);
      console.log(`  ${own[0].dub ? "dual " : "single"} ${file.slice(0, 40).padEnd(40)} own: ${r ? `${r.offset}ms score ${r.score} margin ${r.margin} anchors ${r.anchors.map((a) => a.offset).join(",")}` : "-"}   other: ${n ? `${n.offset}ms score ${n.score} margin ${n.margin}` : "-"}`);
    }
  }
}
