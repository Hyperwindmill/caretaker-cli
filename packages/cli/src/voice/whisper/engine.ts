// The built-in transcription engine: one warm Whisper model at a time, calls
// serialized, audio over 30 s split into windows and joined. Shares the ONNX runtime
// the built-in voice downloads (and loads) — see voice/pocket/engine.ts.

import { existsSync } from 'node:fs';
import os from 'node:os';
import type { VoiceConfig } from 'caretaker-types';
import type { BuiltinTranscriber } from '../../cli/web/voice_proxy.js';
import { loadOnnxRuntime } from '../pocket/engine.js';
import { runtimeEntry, whisperDir } from '../pocket/install.js';
import { DEFAULT_WHISPER_SIZE, WHISPER_MODELS, WHISPER_SAMPLE_RATE, type WhisperSize } from './catalog.js';
import { createWhisperModel, splitWindows, type WhisperModel } from './inference.js';

export type WhisperLoader = (size: WhisperSize) => Promise<WhisperModel>;

// Physical cores: the encoder scales with threads (6 beat 4 on a 6-core Zen 1),
// the decoder does not care.
const threads = () => Math.max(1, Math.floor(os.availableParallelism() / 2));

const defaultLoader: WhisperLoader = async (size) =>
  createWhisperModel(loadOnnxRuntime(), whisperDir(size), { threads: threads() });
let loader: WhisperLoader = defaultLoader;
export function setWhisperLoaderForTest(l: WhisperLoader | null): void {
  loader = l ?? defaultLoader;
}

type Slot = { size: WhisperSize; model: Promise<WhisperModel>; tail: Promise<void> };
let slot: Slot | null = null;

function closeSlot(s: Slot): Promise<void> {
  return s.tail
    .then(() => s.model)
    .then((m) => m.close())
    .catch(() => {});
}

function slotFor(size: WhisperSize): Slot {
  if (slot?.size === size) return slot;
  if (slot) void closeSlot(slot);
  const s: Slot = { size, model: loader(size), tail: Promise.resolve() };
  s.model.catch(() => slot === s && (slot = null));
  slot = s;
  return s;
}

export async function releaseWhisperModels(): Promise<void> {
  const s = slot;
  slot = null;
  if (s) await closeSlot(s);
}

const text = (status: number, body: string) => new Response(body, { status });

/** Primary subtag of the configured language, or null to let Whisper detect it. */
const languageOf = (voice: VoiceConfig) => voice.lang?.split(/[-_]/)[0]?.trim().toLowerCase() || null;

export const transcribeBuiltin: BuiltinTranscriber = async (voice, audio, signal) => {
  const size = voice.sttBuiltinModel ?? DEFAULT_WHISPER_SIZE;
  if (!Object.hasOwn(WHISPER_MODELS, size)) return text(400, `Unknown built-in transcription model: ${size}.`);
  if (!existsSync(runtimeEntry()))
    return text(409, 'The built-in voice runtime is not installed. Install a transcription model in Settings → Voice.');
  if (!existsSync(whisperDir(size)))
    return text(409, `The ${size} transcription model is not installed. Install it in Settings → Voice.`);

  // Take a turn on the model: one transcription at a time, in arrival order.
  const s = slotFor(size);
  let release!: () => void;
  const prev = s.tail;
  s.tail = new Promise<void>((r) => (release = r));
  await prev;
  try {
    const model = await s.model;
    const lang = languageOf(voice);
    const parts: string[] = [];
    for (const window of splitWindows(audio, WHISPER_SAMPLE_RATE)) {
      if (signal.aborted) return new Response(null, { status: 204 });
      const t = (await model.transcribe(window, lang, signal)).trim();
      if (t) parts.push(t);
    }
    return Response.json({ text: parts.join(' ') });
  } catch (e) {
    return text(500, e instanceof Error ? e.message : String(e));
  } finally {
    release();
  }
};
