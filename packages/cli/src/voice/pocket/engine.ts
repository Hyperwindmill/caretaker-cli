// The built-in voice engine: one warm Pocket model per language, calls on a model
// serialized, PCM int16 LE streamed back as it is generated. The ONNX runtime is the
// one the installer downloaded, loaded by absolute path (never a package dependency).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import type { VoiceConfig } from 'caretaker-types';
import type { BuiltinSpeaker } from '../../cli/web/voice_proxy.js';
import { POCKET_LANGUAGES, POCKET_SAMPLE_RATE, POCKET_VOICES, type PocketLanguage } from './catalog.js';
import { createPocketModel, type OrtModule, type PocketModel } from './inference.js';
import { bundleDir, runtimeEntry } from './install.js';

export type { PocketModel } from './inference.js';
export type ModelLoader = (lang: PocketLanguage) => Promise<PocketModel>;

export const PCM_CONTENT_TYPE = `audio/pcm;rate=${POCKET_SAMPLE_RATE};channels=1`;

let ort: OrtModule | null = null;
let lastLoadError: string | undefined;

/** True once the native runtime is loaded into this process (its files are then in use). */
export const runtimeLoaded = () => ort !== null;

/** onnxruntime-node from the downloaded runtime. Throws a readable error when it is
 *  missing or cannot load on this system (the reason is kept for `runtimeLoadError`). */
export function loadOnnxRuntime(): OrtModule {
  if (ort) return ort;
  const entry = runtimeEntry();
  if (!existsSync(entry)) throw new Error('The built-in voice runtime is not installed.');
  try {
    ort = createRequire(entry)(entry) as OrtModule;
    lastLoadError = undefined;
    return ort;
  } catch (e) {
    lastLoadError = e instanceof Error ? e.message : String(e);
    throw new Error(`The built-in voice runtime could not be loaded: ${lastLoadError}`);
  }
}

/** Why the installed runtime cannot load, probing it once if never tried. */
export function runtimeLoadError(): string | undefined {
  if (!ort && existsSync(runtimeEntry())) {
    try {
      loadOnnxRuntime();
    } catch {
      /* recorded in lastLoadError */
    }
  }
  return lastLoadError;
}

// ponytail: physical cores capped at 4 — measured on a 6-core Zen 1: 4 threads
// slightly beat 6, 12 halved the speed. Make it a setting if other machines disagree.
const threads = () => Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 2)));

const defaultLoader: ModelLoader = async (lang) =>
  createPocketModel(loadOnnxRuntime(), bundleDir(lang), { threads: threads() });
let loader: ModelLoader = defaultLoader;
export function setModelLoaderForTest(l: ModelLoader | null): void {
  loader = l ?? defaultLoader;
}

// ponytail: inference runs on the server's event loop (onnxruntime-node runs each
// graph synchronously, up to ~100 ms per call). Move it to a worker_thread if the
// web server's latency during speech becomes noticeable.
type Slot = { model: Promise<PocketModel>; tail: Promise<void> };
const slots = new Map<PocketLanguage, Slot>();

function closeSlot(s: Slot): void {
  void s.tail
    .then(() => s.model)
    .then((m) => m.close())
    .catch(() => {});
}

function slotFor(lang: PocketLanguage): Slot {
  let s = slots.get(lang);
  if (s) return s;
  for (const [other, o] of slots) {
    slots.delete(other);
    closeSlot(o);
  }
  s = { model: loader(lang), tail: Promise.resolve() };
  s.model.catch(() => slots.get(lang) === s && slots.delete(lang));
  slots.set(lang, s);
  return s;
}

export async function releasePocketModels(): Promise<void> {
  const all = [...slots.values()];
  slots.clear();
  await Promise.all(all.map((s) => s.tail.then(() => s.model).then((m) => m.close()).catch(() => {})));
}

function toPcm16(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return new Uint8Array(out.buffer);
}

const text = (status: number, body: string) => new Response(body, { status });

export const speakBuiltin: BuiltinSpeaker = async (voice: VoiceConfig, input: string, signal: AbortSignal) => {
  const lang = voice.ttsLanguage as PocketLanguage;
  const spec = Object.hasOwn(POCKET_LANGUAGES, lang ?? '') ? POCKET_LANGUAGES[lang] : null;
  if (!spec) return text(400, `Unknown built-in voice language: ${voice.ttsLanguage ?? '(none)'}.`);
  if (!existsSync(runtimeEntry()))
    return text(409, 'The built-in voice runtime is not installed. Install a language in Settings → Voice.');
  if (!existsSync(bundleDir(lang)))
    return text(409, `The ${lang} built-in voice is not installed. Install it in Settings → Voice.`);
  const name = voice.ttsVoice && POCKET_VOICES.includes(voice.ttsVoice) ? voice.ttsVoice : spec.nativeVoice;

  // Take a turn on this language's model: calls run one at a time, in arrival order.
  const slot = slotFor(lang);
  let release!: () => void;
  const prev = slot.tail;
  slot.tail = new Promise<void>((r) => (release = r));
  await prev;

  let model: PocketModel;
  try {
    model = await slot.model;
  } catch (e) {
    release();
    return text(500, e instanceof Error ? e.message : String(e));
  }
  if (signal.aborted) {
    release();
    return new Response(null, { status: 204 });
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          for await (const frame of model.synthesize(input, name, ac.signal)) {
            if (ac.signal.aborted) break;
            controller.enqueue(toPcm16(frame));
          }
          if (!ac.signal.aborted) controller.close();
        } catch (e) {
          if (!ac.signal.aborted) controller.error(e);
        } finally {
          signal.removeEventListener('abort', onAbort);
          release();
        }
      })();
    },
    cancel() {
      ac.abort();
    },
  });
  return new Response(body, { headers: { 'content-type': PCM_CONTENT_TYPE } });
};
