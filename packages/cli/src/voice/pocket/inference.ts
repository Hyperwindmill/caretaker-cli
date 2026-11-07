// Own inference loop over one Pocket TTS schema-3 ONNX bundle (four graphs with explicit
// streaming state), following upstream pocket_tts at the bundle's upstream commit:
// tokenizer -> text conditioner -> flow LM main (prompted with the text on top of the
// voice's KV cache) -> per frame: flow step(s) on gaussian noise -> mimi decoder.
// The ONNX runtime is passed in (downloaded at runtime, never a package dependency).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UnigramTokenizer, prepareChunks, type TextPrepConfig } from './tokenizer.js';
import { padInto, parseVoices, type VoiceStates } from './voices.js';

export interface PocketModel {
  readonly sampleRate: number;
  synthesize(text: string, voice: string, signal: AbortSignal): AsyncIterable<Float32Array>;
  close(): Promise<void>;
}

// The slice of onnxruntime-node this module uses.
export interface OrtTensor {
  readonly data: unknown;
  readonly dims: readonly number[];
}
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
export interface OrtModule {
  InferenceSession: {
    create(
      path: string,
      options?: {
        intraOpNumThreads?: number;
        interOpNumThreads?: number;
        executionMode?: 'sequential' | 'parallel';
      },
    ): Promise<OrtSession>;
  };
  Tensor: new (
    type: 'float32' | 'int64' | 'bool',
    data: Float32Array | BigInt64Array | Uint8Array,
    dims: readonly number[],
  ) => OrtTensor;
}

// Not named in bundle.json; these are the bundle's file names (see catalog.ts).
export const POCKET_GRAPHS = {
  textConditioner: 'text_conditioner_int8.onnx',
  flowMain: 'flow_lm_main_int8.onnx',
  flowStep: 'flow_lm_flow_int8.onnx',
  mimi: 'mimi_decoder_int8.onnx',
} as const;
export const POCKET_VOICES_FILE = 'voices.bin';

type StateEntry = {
  module: string;
  key: string;
  input_name: string;
  output_name: string;
  shape: number[];
  dtype: 'float32' | 'int64' | 'bool';
  fill: 'zeros' | 'ones';
};

type BundleJson = TextPrepConfig & {
  schema_version: number;
  tokenizer_file: string;
  temperature: number;
  sampler_decode_steps: number;
  noise_clamp: number | null;
  eos_threshold: number;
  min_frames_before_eos: number;
  voice_state_includes_bos: boolean;
  sample_rate: number;
  samples_per_frame: number;
  latent_dim: number;
  conditioning_dim: number;
  model_recommended_frames_after_eos: number | null;
  flow_lm_state_manifest: StateEntry[];
  mimi_state_manifest: StateEntry[];
};

// upstream TTSModel._TOKENS_PER_SECOND_ESTIMATE / _GEN_SECONDS_PADDING
const TOKENS_PER_SECOND = 3;
const GEN_SECONDS_PADDING = 2;

type Feeds = Record<string, OrtTensor>;

// Latent frames decoded per mimi call. A mimi call has a large fixed cost (it rewrites its
// whole streaming KV cache, measured ~70 ms on the reference machine against ~6 ms per
// extra frame), so decoding one frame at a time runs below real time; 4 frames keep
// generation ahead of playback from the first group on (~1.5x real time there).
export const DEFAULT_FRAMES_PER_DECODE = 4;

export async function createPocketModel(
  ort: OrtModule,
  bundleDir: string,
  opts: { threads: number; framesPerDecode?: number },
): Promise<PocketModel> {
  const bundle = JSON.parse(await readFile(join(bundleDir, 'bundle.json'), 'utf8')) as BundleJson;
  if (bundle.schema_version !== 3)
    throw new Error(`unsupported Pocket bundle schema ${bundle.schema_version}`);
  if (!bundle.voice_state_includes_bos)
    throw new Error('Pocket bundle voices without BOS are not supported');
  const tokenizer = new UnigramTokenizer(
    JSON.parse(await readFile(join(bundleDir, bundle.tokenizer_file), 'utf8')),
  );
  const voices = parseVoices(await readFile(join(bundleDir, POCKET_VOICES_FILE)));

  const sessionOptions = {
    intraOpNumThreads: Math.max(1, opts.threads),
    interOpNumThreads: 1,
    executionMode: 'sequential' as const,
  };
  const sessions: OrtSession[] = [];
  try {
    for (const file of Object.values(POCKET_GRAPHS)) {
      sessions.push(await ort.InferenceSession.create(join(bundleDir, file), sessionOptions));
    }
  } catch (err) {
    await Promise.allSettled(sessions.map((s) => s.release()));
    throw err;
  }
  const [textConditioner, flowMain, flowStep, mimi] = sessions;
  const framesPerDecode = Math.max(1, opts.framesPerDecode ?? DEFAULT_FRAMES_PER_DECODE);
  return new Model(
    ort,
    bundle,
    tokenizer,
    voices,
    { textConditioner, flowMain, flowStep, mimi },
    framesPerDecode,
  );
}

class Model implements PocketModel {
  readonly sampleRate: number;
  // The padded flow state of the last voice used (~50 MB each, so only one is kept).
  private voiceFeeds: { voice: string; feeds: Feeds } | null = null;
  private readonly mimiInitial: Feeds;
  private closed = false;

  constructor(
    private readonly ort: OrtModule,
    private readonly bundle: BundleJson,
    private readonly tokenizer: UnigramTokenizer,
    private readonly voices: VoiceStates,
    private readonly s: Record<keyof typeof POCKET_GRAPHS, OrtSession>,
    private readonly framesPerDecode: number,
  ) {
    this.sampleRate = bundle.sample_rate;
    this.mimiInitial = Object.fromEntries(
      bundle.mimi_state_manifest.map((e) => [e.input_name, this.filled(e)]),
    );
  }

  async *synthesize(text: string, voice: string, signal: AbortSignal): AsyncIterable<Float32Array> {
    if (this.closed) throw new Error('Pocket model is closed');
    const voiceState = this.voiceState(voice);
    for (const chunk of prepareChunks(text, this.tokenizer, this.bundle)) {
      if (signal.aborted) return;
      const framesAfterEos = this.bundle.model_recommended_frames_after_eos ?? chunk.framesAfterEos;
      for await (const frame of this.chunk(chunk.tokenIds, voiceState, framesAfterEos, signal)) {
        yield frame;
        if (signal.aborted) return;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(Object.values(this.s).map((s) => s.release()));
  }

  // One chunk, from the voice's own state (upstream copy_state=True). ORT never writes
  // into its inputs, so the cached voice tensors are reused as is.
  private async *chunk(
    ids: number[],
    voiceState: Feeds,
    framesAfterEos: number,
    signal: AbortSignal,
  ): AsyncIterable<Float32Array> {
    const { ort, bundle } = this;
    const ldim = bundle.latent_dim;
    const tokens = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const { text_embeddings } = await this.s.textConditioner.run({ token_ids: tokens });

    // Prompt the text into the KV cache; the outputs other than the state are unused.
    let out = await this.s.flowMain.run({
      sequence: new ort.Tensor('float32', new Float32Array(0), [1, 0, ldim]),
      text_embeddings,
      ...voiceState,
    });
    let flowState = nextState(out, bundle.flow_lm_state_manifest);
    let mimiState = this.mimiInitial;

    const noText = new ort.Tensor('float32', new Float32Array(0), [1, 0, bundle.conditioning_dim]);
    // NaN means BOS: the graph swaps in its learned BOS latent.
    let sequence = new ort.Tensor('float32', new Float32Array(ldim).fill(NaN), [1, 1, ldim]);
    const maxGen = Math.ceil(
      (ids.length / TOKENS_PER_SECOND + GEN_SECONDS_PADDING) *
        (bundle.sample_rate / bundle.samples_per_frame),
    );
    let eosStep: number | null = null;
    const pending: Float32Array[] = [];
    const decode = async (): Promise<Float32Array> => {
      const latents = new Float32Array(pending.length * ldim);
      pending.forEach((l, i) => latents.set(l, i * ldim));
      const latent = new ort.Tensor('float32', latents, [1, pending.length, ldim]);
      pending.length = 0;
      const decoded = await this.s.mimi.run({ latent, ...mimiState });
      mimiState = nextState(decoded, bundle.mimi_state_manifest);
      return decoded.audio.data as Float32Array;
    };
    for (let step = 0; step < maxGen; step++) {
      if (signal.aborted) return;
      out = await this.s.flowMain.run({ sequence, text_embeddings: noText, ...flowState });
      flowState = nextState(out, bundle.flow_lm_state_manifest);
      const eosLogit = out.eos_logit.data as Float32Array;
      if (
        eosStep === null &&
        step >= bundle.min_frames_before_eos &&
        eosLogit[eosLogit.length - 1] > bundle.eos_threshold
      ) {
        eosStep = step;
      }
      // This step's latent is not emitted.
      if (eosStep !== null && step >= eosStep + framesAfterEos) break;

      const latent = await this.sampleLatent(out.conditioning);
      sequence = new ort.Tensor('float32', latent, [1, 1, ldim]);
      pending.push(latent);
      if (pending.length >= this.framesPerDecode) yield await decode();
    }
    if (pending.length > 0 && !signal.aborted) yield await decode();
  }

  // lsd_decode over the flow net, starting from gaussian noise (std sqrt(temperature)).
  private async sampleLatent(conditioning: OrtTensor): Promise<Float32Array> {
    const { ort, bundle } = this;
    const dim = bundle.conditioning_dim;
    const all = conditioning.data as Float32Array;
    // upstream keeps the last position only.
    const c = new ort.Tensor('float32', all.subarray(all.length - dim), [1, dim]);
    const x = gaussian(bundle.latent_dim, Math.sqrt(bundle.temperature), bundle.noise_clamp);
    const steps = bundle.sampler_decode_steps;
    for (let i = 0; i < steps; i++) {
      const { flow_dir } = await this.s.flowStep.run({
        c,
        s: new ort.Tensor('float32', Float32Array.of(i / steps), [1, 1]),
        t: new ort.Tensor('float32', Float32Array.of((i + 1) / steps), [1, 1]),
        x: new ort.Tensor('float32', x.slice(), [1, bundle.latent_dim]),
      });
      const dir = flow_dir.data as Float32Array;
      for (let k = 0; k < x.length; k++) x[k] += dir[k] / steps;
    }
    return x;
  }

  private voiceState(voice: string): Feeds {
    if (this.voiceFeeds?.voice === voice) return this.voiceFeeds.feeds;
    const tensors = this.voices.get(voice);
    if (!tensors) throw new Error(`unknown Pocket voice "${voice}"`);
    const feeds: Feeds = {};
    for (const e of this.bundle.flow_lm_state_manifest) {
      const t = tensors.get(`${e.module}/${e.key}`);
      feeds[e.input_name] = t
        ? new this.ort.Tensor(e.dtype, padInto(t, e.shape), e.shape)
        : this.filled(e);
    }
    this.voiceFeeds = { voice, feeds };
    return feeds;
  }

  private filled(e: StateEntry): OrtTensor {
    const n = e.shape.reduce((a, b) => a * b, 1);
    const one = e.fill === 'ones';
    const data =
      e.dtype === 'float32'
        ? new Float32Array(n).fill(one ? 1 : 0)
        : e.dtype === 'int64'
          ? new BigInt64Array(n).fill(one ? 1n : 0n)
          : new Uint8Array(n).fill(one ? 1 : 0);
    return new this.ort.Tensor(e.dtype, data, e.shape);
  }
}

function nextState(out: Record<string, OrtTensor>, manifest: StateEntry[]): Feeds {
  const feeds: Feeds = {};
  for (const e of manifest) {
    const t = out[e.output_name];
    if (!t) throw new Error(`graph output ${e.output_name} is missing`);
    feeds[e.input_name] = t;
  }
  return feeds;
}

// Box-Muller; a clamp resamples out-of-range draws (torch trunc_normal_ semantics).
function gaussian(n: number, std: number, clamp: number | null): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v: number;
    do {
      const u = 1 - Math.random();
      v = std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
    } while (clamp !== null && Math.abs(v) > clamp);
    out[i] = v;
  }
  return out;
}
