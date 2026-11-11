/**
 * Speech in a stretch of audio, heard by Silero VAD (MIT, github.com/snakers4/silero-vad, v5.1.2,
 * assets/silero_vad.onnx) run on WebAssembly, so it works on Alpine with no native build. Loudness
 * alone can't tell speech from a laugh track or music (seen: 6 to 12 blurred bursts in
 * 40 s), and audio sync then refused 25 of 28 files.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-web";
import type { Cue } from "./sync.js";

const RATE = 16000;
/** Silero v5 at 16 kHz takes 512 new samples (32 ms) with the last 64 of the chunk before. */
const CHUNK = 512;
const CONTEXT = 64;
export const VAD_FRAME_MS = (CHUNK / RATE) * 1000;

let session: Promise<ort.InferenceSession> | undefined;

function model(): Promise<ort.InferenceSession> {
  if (!session) {
    ort.env.wasm.numThreads = 1;
    session = readFile(path.join(process.cwd(), "assets", "silero_vad.onnx")).then((bytes) => ort.InferenceSession.create(bytes));
    session.catch(() => (session = undefined));
  }
  return session;
}

/** The chance of speech in each 32 ms of 16 kHz mono 16-bit audio. */
export async function speechChances(pcm: Buffer): Promise<Float32Array> {
  const vad = await model();
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  const frames = Math.floor(samples.length / CHUNK);
  const out = new Float32Array(frames);
  let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []);
  const input = new Float32Array(CONTEXT + CHUNK);
  for (let f = 0; f < frames; f++) {
    // The last CONTEXT samples before this chunk (zeros at the start), then the chunk.
    input.fill(0, 0, CONTEXT);
    const start = f * CHUNK;
    if (start >= CONTEXT) input.set(samples.subarray(start - CONTEXT, start), 0);
    input.set(samples.subarray(start, start + CHUNK), CONTEXT);
    const result = await vad.run({ input: new ort.Tensor("float32", input.slice(), [1, CONTEXT + CHUNK]), state, sr });
    out[f] = (result.output.data as Float32Array)[0];
    state = result.stateN;
  }
  return out;
}

export interface SpeechShape {
  /** Speech starts above this chance, and ends below it minus 0.15 (Silero's own hysteresis). */
  threshold: number;
  /** Pauses shorter than this stay inside one stretch of speech, as words inside one line. */
  joinMs: number;
  minMs: number;
  maxMs: number;
}

export const SPEECH_SHAPE: SpeechShape = { threshold: 0.5, joinMs: 300, minMs: 250, maxMs: 12000 };

/** Stretches of speech from per-frame chances, as cues starting at `from` ms. */
export function speechFromChances(chances: Float32Array, from: number, shape: SpeechShape = SPEECH_SHAPE): Cue[] {
  const spans: Cue[] = [];
  let open: Cue | undefined;
  for (let f = 0; f < chances.length; f++) {
    const at = f * VAD_FRAME_MS;
    if (!open && chances[f] >= shape.threshold) open = { start: at, end: at + VAD_FRAME_MS };
    else if (open && chances[f] >= shape.threshold - 0.15) open.end = at + VAD_FRAME_MS;
    else if (open) {
      const last = spans[spans.length - 1];
      if (last && open.start - last.end <= shape.joinMs) last.end = open.end;
      else spans.push(open);
      open = undefined;
    }
  }
  if (open) {
    const last = spans[spans.length - 1];
    if (last && open.start - last.end <= shape.joinMs) last.end = open.end;
    else spans.push(open);
  }
  return spans
    .filter((s) => s.end - s.start >= shape.minMs && s.end - s.start <= shape.maxMs)
    .map((s) => ({ start: Math.round(from + s.start), end: Math.round(from + s.end) }));
}

/** Speech heard in 16 kHz mono 16-bit audio that starts at `from` ms. */
export async function heardSpeech(pcm: Buffer, from: number): Promise<Cue[]> {
  return speechFromChances(await speechChances(pcm), from);
}
