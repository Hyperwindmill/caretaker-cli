// Own inference loop over a Whisper ONNX export (HF/optimum layout): 16 kHz audio ->
// log-mel (features.ts) -> encoder over the fixed 30 s window -> greedy decoding on the
// merged decoder with KV cache (`use_cache_branch`) -> GPT-2 byte decoding (decoder.ts).
// The ONNX runtime is passed in (downloaded at runtime, never a package dependency).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrtModule, OrtSession, OrtTensor } from '../pocket/inference.js';
import { byteDecode, parseVocab } from './decoder.js';
import { logMel, N_FRAMES, N_MELS, N_SAMPLES, SAMPLE_RATE } from './features.js';

export interface WhisperModel {
  // One window of at most 30 s of 16 kHz mono audio (split longer audio with
  // splitWindows). `lang` is a Whisper language code; null or unknown auto-detects.
  transcribe(audio: Float32Array, lang: string | null, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

// int8 encoder + q4 decoder: the int8 decoder is ~2.5x slower per token on CPUs without
// VNNI, encoder speed is the same across variants (spike measurements).
export const WHISPER_GRAPHS = {
  encoder: 'encoder_model_quantized.onnx',
  decoder: 'decoder_model_merged_q4.onnx',
} as const;
export const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'added_tokens.json',
  'vocab.json',
] as const;

// Half the decoder's 448 positions, as openai-whisper / HF generate.
export const MAX_NEW_TOKENS = 224;

// Peak amplitude below which a window is silence (-60 dBFS): Whisper hallucinates on
// silence ("Thanks for watching"), so it is never fed to the model.
const SILENCE_PEAK = 1e-3;

const WINDOW_SECONDS = 30;
const CUT_SEARCH_SECONDS = 5;
const CUT_SPAN_SECONDS = 0.5;

// A model directory holds the HF layout (graphs under onnx/) or everything flat.
export function modelFile(dir: string, name: string): string {
  for (const path of [join(dir, 'onnx', name), join(dir, name)]) if (existsSync(path)) return path;
  throw new Error(`Whisper model file ${name} is missing in ${dir}`);
}

type GenerationConfig = {
  decoder_start_token_id: number;
  eos_token_id: number;
  no_timestamps_token_id: number;
  lang_to_id: Record<string, number>;
  task_to_id: { transcribe: number };
  suppress_tokens?: number[];
  begin_suppress_tokens?: number[];
};
type ModelConfig = { decoder_attention_heads: number; d_model: number; decoder_layers: number };

type Feeds = Record<string, OrtTensor>;

const readJson = async <T>(dir: string, name: string): Promise<T> =>
  JSON.parse(await readFile(modelFile(dir, name), 'utf8')) as T;

export async function createWhisperModel(
  ort: OrtModule,
  dir: string,
  opts: { threads: number },
): Promise<WhisperModel> {
  const config = await readJson<ModelConfig>(dir, 'config.json');
  const gen = await readJson<GenerationConfig>(dir, 'generation_config.json');
  const added = await readJson<Record<string, number>>(dir, 'added_tokens.json');
  const vocab = parseVocab(
    await readJson<Record<string, number>>(dir, 'vocab.json'),
    Object.values(added),
  );

  const sessionOptions = {
    intraOpNumThreads: Math.max(1, opts.threads),
    interOpNumThreads: 1,
    executionMode: 'sequential' as const,
  };
  const encoder = await ort.InferenceSession.create(
    modelFile(dir, WHISPER_GRAPHS.encoder),
    sessionOptions,
  );
  let decoder: OrtSession;
  try {
    decoder = await ort.InferenceSession.create(
      modelFile(dir, WHISPER_GRAPHS.decoder),
      sessionOptions,
    );
  } catch (err) {
    await encoder.release().catch(() => {});
    throw err;
  }
  return new Model(ort, config, gen, Object.values(added), vocab, encoder, decoder);
}

class Model implements WhisperModel {
  private closed = false;
  // Suppression masks (1 = never emitted), sized from the first logits seen.
  private masks: { any: Uint8Array; first: Uint8Array } | null = null;

  constructor(
    private readonly ort: OrtModule,
    private readonly config: ModelConfig,
    private readonly gen: GenerationConfig,
    private readonly specialIds: number[],
    private readonly vocab: ReadonlyMap<number, string>,
    private readonly encoder: OrtSession,
    private readonly decoder: OrtSession,
  ) {}

  async transcribe(audio: Float32Array, lang: string | null, signal: AbortSignal): Promise<string> {
    if (this.closed) throw new Error('Whisper model is closed');
    if (audio.length > N_SAMPLES)
      throw new Error('Whisper window longer than 30 s; split it with splitWindows');
    signal.throwIfAborted();
    if (peak(audio) < SILENCE_PEAK) return '';

    const { ort, gen } = this;
    const features = new ort.Tensor('float32', logMel(audio), [1, N_MELS, N_FRAMES]);
    const { last_hidden_state: hidden } = await this.encoder.run({ input_features: features });
    signal.throwIfAborted();

    const tail = [gen.task_to_id.transcribe, gen.no_timestamps_token_id];
    let langId = lang ? gen.lang_to_id[`<|${lang.toLowerCase().split(/[-_]/)[0]}|>`] : undefined;
    if (langId === undefined) {
      // Auto-detect: the language token Whisper itself would emit after SOT, in a pass of
      // its own like faster-whisper. Continuing that pass with the rest of the prompt on
      // the cache branch was measured to change the transcript.
      const logits = await this.pass(hidden)([gen.decoder_start_token_id]);
      langId = argmaxOf(logits, Object.values(gen.lang_to_id));
      signal.throwIfAborted();
    }

    const step = this.pass(hidden);
    let feed = [gen.decoder_start_token_id, langId, ...tail];
    const tokens: number[] = [];
    for (let n = 0; n < MAX_NEW_TOKENS; n++) {
      signal.throwIfAborted();
      const logits = await step(feed);
      const masks = this.suppression(logits.length);
      const token = argmaxUnmasked(logits, n === 0 ? masks.first : masks.any);
      if (token === gen.eos_token_id || token < 0) break;
      tokens.push(token);
      feed = [token];
    }
    return byteDecode(tokens, this.vocab).trim();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.encoder.release(), this.decoder.release()]);
  }

  // A decoding pass: each call returns the logits of the last position for `ids` and
  // advances the pass's own KV cache.
  private pass(hidden: OrtTensor): (ids: number[]) => Promise<Float32Array> {
    const { ort } = this;
    const past = this.emptyPast();
    let cached = false;
    return async (ids) => {
      const out = await this.decoder.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        encoder_hidden_states: hidden,
        use_cache_branch: new ort.Tensor('bool', Uint8Array.of(cached ? 1 : 0), [1]),
        ...past,
      });
      for (let l = 0; l < this.config.decoder_layers; l++) {
        for (const kind of ['decoder.key', 'decoder.value']) {
          past[`past_key_values.${l}.${kind}`] = output(out, `present.${l}.${kind}`);
        }
        // The cross-attention cache is computed by the no-cache branch only; the cache
        // branch passes it through.
        if (!cached) {
          for (const kind of ['encoder.key', 'encoder.value']) {
            past[`past_key_values.${l}.${kind}`] = output(out, `present.${l}.${kind}`);
          }
        }
      }
      cached = true;
      const logits = output(out, 'logits');
      const size = logits.dims[2];
      const data = logits.data as Float32Array;
      return data.subarray(data.length - size);
    };
  }

  // Step 0 runs the no-cache branch, which still requires the past inputs: empty
  // [1, heads, 0, headDim] tensors.
  private emptyPast(): Feeds {
    const { decoder_attention_heads: heads, d_model, decoder_layers } = this.config;
    const empty = new this.ort.Tensor('float32', new Float32Array(0), [
      1,
      heads,
      0,
      d_model / heads,
    ]);
    const past: Feeds = {};
    for (let l = 0; l < decoder_layers; l++) {
      for (const kind of ['decoder.key', 'decoder.value', 'encoder.key', 'encoder.value']) {
        past[`past_key_values.${l}.${kind}`] = empty;
      }
    }
    return past;
  }

  // Special tokens (timestamps, languages, tasks: everything in added_tokens.json but
  // EOT) and generation_config's suppress_tokens; the first sampled token also excludes
  // begin_suppress_tokens (a leading space, EOT).
  private suppression(size: number): { any: Uint8Array; first: Uint8Array } {
    if (this.masks?.any.length === size) return this.masks;
    const any = new Uint8Array(size);
    const set = (mask: Uint8Array, ids: Iterable<number>): void => {
      for (const id of ids) if (id >= 0 && id < size) mask[id] = 1;
    };
    set(any, this.specialIds);
    set(any, this.gen.suppress_tokens ?? []);
    any[this.gen.eos_token_id] = 0;
    const first = any.slice();
    set(first, this.gen.begin_suppress_tokens ?? []);
    this.masks = { any, first };
    return this.masks;
  }
}

function output(out: Record<string, OrtTensor>, name: string): OrtTensor {
  const t = out[name];
  if (!t) throw new Error(`Whisper decoder output ${name} is missing`);
  return t;
}

function peak(audio: Float32Array): number {
  let max = 0;
  for (const v of audio) {
    const a = Math.abs(v);
    if (a > max) max = a;
  }
  return max;
}

function argmaxUnmasked(logits: Float32Array, mask: Uint8Array): number {
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (mask[i] || !(logits[i] > bestValue)) continue;
    bestValue = logits[i];
    best = i;
  }
  return best;
}

function argmaxOf(logits: Float32Array, ids: number[]): number {
  let best = ids[0];
  for (const id of ids) if (logits[id] > logits[best]) best = id;
  return best;
}

// Splits audio longer than 30 s into consecutive windows of at most 30 s, each cut in
// the middle of the quietest 0.5 s within its last 5 s, so a cut rarely lands mid-word.
// The windows are views on `audio` and cover every sample, in order.
export function splitWindows(audio: Float32Array, rate: number = SAMPLE_RATE): Float32Array[] {
  const max = Math.floor(WINDOW_SECONDS * rate);
  const span = Math.max(1, Math.round(CUT_SPAN_SECONDS * rate));
  const search = Math.round(CUT_SEARCH_SECONDS * rate);
  const windows: Float32Array[] = [];
  let start = 0;
  while (audio.length - start > max) {
    // Candidate spans [s, s + span) with s + span <= start + max.
    const from = start + max - search;
    const to = start + max - span;
    let energy = 0;
    for (let i = from; i < from + span; i++) energy += audio[i] * audio[i];
    let best = from;
    let bestEnergy = energy;
    for (let s = from + 1; s <= to; s++) {
      energy += audio[s + span - 1] * audio[s + span - 1] - audio[s - 1] * audio[s - 1];
      if (energy < bestEnergy - 1e-9) {
        bestEnergy = energy;
        best = s;
      }
    }
    const cut = best + Math.floor(span / 2);
    windows.push(audio.subarray(start, cut));
    start = cut;
  }
  windows.push(audio.subarray(start));
  return windows;
}
