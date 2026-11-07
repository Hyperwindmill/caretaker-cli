import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createPocketModel,
  POCKET_VOICES_FILE,
  type OrtModule,
  type OrtTensor,
} from './inference.js';

// A one-layer bundle with tiny shapes, and a fake runtime that scripts the graphs.
const CDIM = 3;
const LDIM = 2;
const SPF = 4; // samples per frame; 50 / 4 = 12.5 frames per second, as the real bundle

function writeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-'));
  const attn = 'transformer.layers.0.self_attn';
  const bundle = {
    schema_version: 3,
    tokenizer_file: 'tokenizer.json',
    temperature: 0.3,
    sampler_decode_steps: 1,
    noise_clamp: null,
    eos_threshold: -4,
    min_frames_before_eos: 2,
    voice_state_includes_bos: true,
    sample_rate: 50,
    samples_per_frame: SPF,
    latent_dim: LDIM,
    conditioning_dim: CDIM,
    max_token_per_chunk: 50,
    model_recommended_frames_after_eos: null,
    replace_characters: {},
    remove_semicolons: false,
    append_terminal_punctuation: true,
    capitalize_first_letter: true,
    pad_with_spaces_for_short_inputs: false,
    flow_lm_state_manifest: [
      {
        module: attn,
        key: 'offset',
        input_name: 'state_0',
        output_name: 'next_state_0',
        shape: [1],
        dtype: 'int64',
        fill: 'zeros',
      },
      {
        module: attn,
        key: 'pad',
        input_name: 'state_1',
        output_name: 'next_state_1',
        shape: [1],
        dtype: 'int64',
        fill: 'zeros',
      },
      {
        module: attn,
        key: 'cache',
        input_name: 'state_2',
        output_name: 'next_state_2',
        shape: [2, 1, 4, 1, 1],
        dtype: 'float32',
        fill: 'zeros',
      },
    ],
    mimi_state_manifest: [
      {
        module: 'decoder.model.0',
        key: 'first',
        input_name: 'state_0',
        output_name: 'next_state_0',
        shape: [1],
        dtype: 'bool',
        fill: 'ones',
      },
    ],
  };
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundle));
  const vocab = [
    ['<unk>', 0],
    ['▁', -1],
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,'.split('').map((c) => [c, -2]),
  ];
  writeFileSync(
    join(dir, 'tokenizer.json'),
    JSON.stringify({ model: { type: 'Unigram', unk_id: 0, byte_fallback: false, vocab } }),
  );
  // One voice: a two-row cache and offset 2.
  const parts: Buffer[] = [Buffer.from('PTVB1'), u32(1), ...str('alba'), u16(2)];
  const cache = Buffer.from(Float32Array.of(1, 2, 3, 4).buffer);
  parts.push(
    ...str(`${attn}/cache`),
    Buffer.from([0, 5]),
    ...[2, 1, 2, 1, 1].map(u32),
    u32(cache.length),
    cache,
  );
  const offset = Buffer.from(BigInt64Array.of(2n).buffer);
  parts.push(...str(`${attn}/offset`), Buffer.from([1, 1]), u32(1), u32(offset.length), offset);
  writeFileSync(join(dir, POCKET_VOICES_FILE), Buffer.concat(parts));
  return dir;
}
function u16(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function str(s: string) {
  return [u16(Buffer.byteLength(s)), Buffer.from(s)];
}

class FakeTensor implements OrtTensor {
  constructor(
    readonly type: string,
    readonly data: any,
    readonly dims: readonly number[],
  ) {}
}

type Log = {
  main: Record<string, OrtTensor>[];
  mimi: Record<string, OrtTensor>[];
  released: string[];
  options: unknown[];
};

// `eosAt`: first generation step whose EOS logit is `eosLogit` (null = never).
function fakeOrt(eosAt: number | null, eosLogit = 5): { ort: OrtModule; log: Log } {
  const log: Log = { main: [], mimi: [], released: [], options: [] };
  const t = (type: string, data: any, dims: number[]) => new FakeTensor(type, data, dims);
  let step = -1;
  const graphs: Record<string, (f: Record<string, any>) => Record<string, OrtTensor>> = {
    'text_conditioner_int8.onnx': (f) => ({
      text_embeddings: t('float32', new Float32Array(f.token_ids.dims[1] * CDIM), [
        1,
        f.token_ids.dims[1],
        CDIM,
      ]),
    }),
    'flow_lm_main_int8.onnx': (f) => {
      log.main.push(f);
      if (f.sequence.dims[1] === 0) step = -1;
      else step++;
      const eos = eosAt !== null && step >= eosAt ? eosLogit : -10;
      return {
        conditioning: t('float32', new Float32Array(CDIM), [1, CDIM]),
        eos_logit: t('float32', Float32Array.of(eos), [1, 1]),
        next_state_0: t('int64', BigInt64Array.of(f.state_0.data[0] + 1n), [1]),
        next_state_1: f.state_1,
        next_state_2: f.state_2,
      };
    },
    'flow_lm_flow_int8.onnx': (f) => ({
      flow_dir: t('float32', new Float32Array(f.x.dims[1]), f.x.dims as number[]),
    }),
    'mimi_decoder_int8.onnx': (f) => {
      log.mimi.push(f);
      const frames = f.latent.dims[1];
      return {
        audio: t('float32', new Float32Array(frames * SPF).fill(log.mimi.length), [
          1,
          1,
          frames * SPF,
        ]),
        next_state_0: t('bool', Uint8Array.of(0), [1]),
      };
    },
  };
  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      async create(path: string, options: unknown) {
        log.options.push(options);
        const name = basename(path);
        return {
          run: async (f: Record<string, OrtTensor>) => graphs[name](f),
          release: async () => void log.released.push(name),
        };
      },
    },
  } as unknown as OrtModule;
  return { ort, log };
}

async function collect(it: AsyncIterable<Float32Array>): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for await (const f of it) out.push(f);
  return out;
}

test('stops framesAfterEos frames after EOS, decoding in groups and threading state', async () => {
  const { ort, log } = fakeOrt(3);
  const model = await createPocketModel(ort, writeBundle(), { threads: 3, framesPerDecode: 3 });
  assert.equal(model.sampleRate, 50);
  assert.deepEqual(log.options[0], {
    intraOpNumThreads: 3,
    interOpNumThreads: 1,
    executionMode: 'sequential',
  });

  // "ciao" is one word: frames after EOS = 3 + 2, plus 4 extra. EOS at step 3 -> steps 0..11 emitted.
  const frames = await collect(model.synthesize('ciao', 'alba', new AbortController().signal));
  assert.deepEqual(
    frames.map((f) => f.length),
    [3 * SPF, 3 * SPF, 3 * SPF, 3 * SPF],
  );

  // The prompt starts from the voice: offset 2, cache rows padded with zeros per kv slice.
  const prompt = log.main[0];
  assert.equal(prompt.sequence.dims[1], 0);
  assert.deepEqual([...(prompt.state_0.data as BigInt64Array)], [2n]);
  assert.deepEqual([...(prompt.state_2.data as Float32Array)], [1, 2, 0, 0, 3, 4, 0, 0]);
  // Each step feeds the previous step's state and the previous latent; the first is BOS (NaN).
  assert.deepEqual([...(log.main[1].state_0.data as BigInt64Array)], [3n]);
  assert.ok(Number.isNaN((log.main[1].sequence.data as Float32Array)[0]));
  assert.ok(!Number.isNaN((log.main[2].sequence.data as Float32Array)[0]));
  // Mimi starts from the manifest fill and then gets its own previous state back.
  assert.deepEqual([...(log.mimi[0].state_0.data as Uint8Array)], [1]);
  assert.deepEqual([...(log.mimi[1].state_0.data as Uint8Array)], [0]);
  assert.deepEqual(
    log.mimi.map((f) => f.latent.dims),
    [
      [1, 3, LDIM],
      [1, 3, LDIM],
      [1, 3, LDIM],
      [1, 3, LDIM],
    ],
  );

  await model.close();
  assert.equal(log.released.length, 4);
});

test('a marginal EOS crossing (above the bundle threshold, below 0) does not end the chunk', async () => {
  const { ort } = fakeOrt(3, -2);
  const model = await createPocketModel(ort, writeBundle(), { threads: 1, framesPerDecode: 1 });
  const frames = await collect(model.synthesize('ciao', 'alba', new AbortController().signal));
  assert.equal(frames.length, 50); // runs to the max length, like no EOS at all
});

test('without EOS, generation stops at the max length estimate', async () => {
  const { ort } = fakeOrt(null);
  const model = await createPocketModel(ort, writeBundle(), { threads: 1, framesPerDecode: 1 });
  const frames = await collect(model.synthesize('ciao', 'alba', new AbortController().signal));
  // "Ciao." = ▁ C i a o . -> 6 tokens: ceil((6 / 3 + 2) * 12.5) = 50.
  assert.equal(frames.length, 50);
});

test('an abort stops generation after the current group', async () => {
  const { ort, log } = fakeOrt(null);
  const model = await createPocketModel(ort, writeBundle(), { threads: 1, framesPerDecode: 2 });
  const ac = new AbortController();
  const frames: Float32Array[] = [];
  for await (const f of model.synthesize('ciao', 'alba', ac.signal)) {
    frames.push(f);
    ac.abort();
  }
  assert.equal(frames.length, 1);
  assert.equal(log.main.length, 1 + 2);
});

test('an unknown voice is refused', async () => {
  const { ort } = fakeOrt(3);
  const model = await createPocketModel(ort, writeBundle(), { threads: 1 });
  await assert.rejects(
    collect(model.synthesize('ciao', 'nobody', new AbortController().signal)),
    /unknown Pocket voice/,
  );
});
