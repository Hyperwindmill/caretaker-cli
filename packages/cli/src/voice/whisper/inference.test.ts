import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrtModule, OrtTensor } from '../pocket/inference.js';
import { N_FRAMES, N_MELS, SAMPLE_RATE } from './features.js';
import {
  createWhisperModel,
  MAX_NEW_TOKENS,
  modelFile,
  splitWindows,
  WHISPER_GRAPHS,
} from './inference.js';

// A miniature model: ten text tokens ('a'..'j' = 0..9), then the specials, numbered as in
// the real export (EOT first, then SOT, languages, task, no-timestamps, timestamps).
const EOT = 10;
const SOT = 11;
const IT = 12;
const EN = 13;
const TRANSCRIBE = 14;
const NO_TS = 15;
const TS = [16, 17, 18, 19];
const VOCAB_SIZE = 20;
const SUPPRESSED = 3; // generation_config.suppress_tokens
const BEGIN_SUPPRESSED = 0; // generation_config.begin_suppress_tokens, with EOT
const HEADS = 2;
const D_MODEL = 4;
const LAYERS = 2;

function writeModel(layout: 'hf' | 'flat'): string {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-'));
  const graphs = layout === 'hf' ? join(dir, 'onnx') : dir;
  mkdirSync(graphs, { recursive: true });
  for (const f of Object.values(WHISPER_GRAPHS)) writeFileSync(join(graphs, f), 'graph');
  const json = (name: string, value: unknown): void =>
    writeFileSync(join(dir, name), JSON.stringify(value));
  json('config.json', { decoder_attention_heads: HEADS, d_model: D_MODEL, decoder_layers: LAYERS });
  json('generation_config.json', {
    decoder_start_token_id: SOT,
    eos_token_id: EOT,
    no_timestamps_token_id: NO_TS,
    lang_to_id: { '<|it|>': IT, '<|en|>': EN },
    task_to_id: { transcribe: TRANSCRIBE, translate: 99 },
    suppress_tokens: [SUPPRESSED],
    begin_suppress_tokens: [BEGIN_SUPPRESSED, EOT],
  });
  const added: Record<string, number> = { '<|endoftext|>': EOT, '<|startoftranscript|>': SOT };
  added['<|it|>'] = IT;
  added['<|en|>'] = EN;
  added['<|transcribe|>'] = TRANSCRIBE;
  added['<|notimestamps|>'] = NO_TS;
  TS.forEach((id, i) => (added[`<|${(i * 0.02).toFixed(2)}|>`] = id));
  json('added_tokens.json', added);
  const vocab: Record<string, number> = { '<|endoftext|>': EOT };
  for (let i = 0; i < 10; i++) vocab[String.fromCharCode(97 + i)] = i;
  json('vocab.json', vocab);
  return dir;
}

class Tensor implements OrtTensor {
  constructor(
    readonly type: string,
    readonly data: unknown,
    readonly dims: readonly number[],
  ) {}
}

type Call = {
  ids: number[];
  cached: boolean;
  past: Record<string, readonly number[]>;
  encoderKey: unknown;
};

// `score(call, n)` gives the logits of the n-th decoder call as {token: value}; every
// other token scores -1. Returns the runtime plus what it saw.
function fakeRuntime(score: (n: number, ids: number[]) => Record<number, number>) {
  const calls: Call[] = [];
  const created: string[] = [];
  const encoderInputs: OrtTensor[] = [];
  let released = 0;
  const ort = {
    Tensor,
    InferenceSession: {
      async create(path: string) {
        created.push(path);
        const isEncoder = path.endsWith(WHISPER_GRAPHS.encoder);
        return {
          async release() {
            released++;
          },
          async run(feeds: Record<string, OrtTensor>) {
            if (isEncoder) {
              encoderInputs.push(feeds.input_features);
              return { last_hidden_state: new Tensor('float32', new Float32Array(4), [1, 2, 2]) };
            }
            const ids = Array.from(feeds.input_ids.data as BigInt64Array, Number);
            const cached = (feeds.use_cache_branch.data as Uint8Array)[0] === 1;
            const past: Record<string, readonly number[]> = {};
            for (const [k, v] of Object.entries(feeds))
              if (k.startsWith('past_key_values.')) past[k] = v.dims;
            calls.push({
              ids,
              cached,
              past,
              encoderKey: feeds['past_key_values.0.encoder.key'].data,
            });
            const logits = new Float32Array(ids.length * VOCAB_SIZE).fill(-1);
            const row = (ids.length - 1) * VOCAB_SIZE;
            for (const [tok, v] of Object.entries(score(calls.length - 1, ids)))
              logits[row + Number(tok)] = v;
            const out: Record<string, OrtTensor> = {
              logits: new Tensor('float32', logits, [1, ids.length, VOCAB_SIZE]),
            };
            const seen = feeds['past_key_values.0.decoder.key'].dims[2] + ids.length;
            for (let l = 0; l < LAYERS; l++) {
              for (const k of ['decoder.key', 'decoder.value']) {
                out[`present.${l}.${k}`] = new Tensor('float32', new Float32Array(0), [
                  1,
                  HEADS,
                  seen,
                  2,
                ]);
              }
              // The cache branch returns a dummy cross-attention cache: it must be ignored.
              for (const k of ['encoder.key', 'encoder.value']) {
                out[`present.${l}.${k}`] = new Tensor('float32', cached ? 'stale' : 'cross', [
                  1,
                  HEADS,
                  3,
                  2,
                ]);
              }
            }
            return out;
          },
        };
      },
    },
  } as unknown as OrtModule;
  return { ort, calls, created, encoderInputs, released: () => released };
}

const speech = (seconds = 1): Float32Array => {
  const a = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < a.length; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE);
  return a;
};
const never = new AbortController().signal;
const script = (tokens: number[]) => (n: number) => ({ [tokens[n] ?? EOT]: 5 });

test('a known language forces <|sot|><|lang|><|transcribe|><|notimestamps|>', async () => {
  const rt = fakeRuntime(script([1, 2, EOT]));
  const model = await createWhisperModel(rt.ort, writeModel('hf'), { threads: 2 });
  assert.equal(await model.transcribe(speech(), 'it', never), 'bc');
  assert.deepEqual(rt.encoderInputs[0].dims, [1, N_MELS, N_FRAMES]);
  assert.deepEqual(
    rt.calls.map((c) => [c.ids, c.cached]),
    [
      [[SOT, IT, TRANSCRIBE, NO_TS], false],
      [[1], true],
      [[2], true],
    ],
  );
  // Step 0 gets empty past tensors [1, heads, 0, headDim] for every layer and kind.
  assert.equal(Object.keys(rt.calls[0].past).length, LAYERS * 4);
  for (const dims of Object.values(rt.calls[0].past))
    assert.deepEqual(dims, [1, HEADS, 0, D_MODEL / HEADS]);
  // Later steps carry the self-attention cache and keep the step-0 cross-attention cache.
  assert.deepEqual(rt.calls[2].past['past_key_values.1.decoder.key'], [1, HEADS, 5, 2]);
  assert.equal(rt.calls[2].encoderKey, 'cross');
  // A regional tag uses its primary subtag.
  const rt2 = fakeRuntime(script([EOT]));
  const m2 = await createWhisperModel(rt2.ort, writeModel('hf'), { threads: 1 });
  await m2.transcribe(speech(), 'en-US', never);
  assert.deepEqual(rt2.calls[0].ids, [SOT, EN, TRANSCRIBE, NO_TS]);
});

test('no or an unknown language picks the argmax language token after SOT', async () => {
  for (const lang of [null, 'xx']) {
    // Step 0 favours a text token overall, but only language tokens compete.
    const rt = fakeRuntime((n) => (n === 0 ? { 2: 9, [IT]: 1, [EN]: 3 } : script([4, EOT])(n - 1)));
    const model = await createWhisperModel(rt.ort, writeModel('hf'), { threads: 1 });
    assert.equal(await model.transcribe(speech(), lang, never), 'e');
    assert.deepEqual(
      rt.calls.map((c) => [c.ids, c.cached]),
      [
        [[SOT], false],
        [[SOT, EN, TRANSCRIBE, NO_TS], false],
        [[4], true],
      ],
    );
  }
});

test('stops at EOT and at the token cap', async () => {
  const rt = fakeRuntime(() => ({ 5: 1 }));
  const model = await createWhisperModel(rt.ort, writeModel('hf'), { threads: 1 });
  assert.equal(await model.transcribe(speech(), 'it', never), 'f'.repeat(MAX_NEW_TOKENS));
  assert.equal(rt.calls.length, MAX_NEW_TOKENS);
  assert.equal(MAX_NEW_TOKENS, 224);
});

test('timestamps, specials and suppress_tokens are never emitted; the first token skips begin_suppress', async () => {
  const rt = fakeRuntime((n): Record<number, number> =>
    n === 0
      ? { [EOT]: 9, [BEGIN_SUPPRESSED]: 8, [TS[1]]: 7, [SOT]: 6, [SUPPRESSED]: 5, 6: 1 }
      : n === 1
        ? { [TS[0]]: 9, [IT]: 8, [NO_TS]: 7, [BEGIN_SUPPRESSED]: 2 }
        : { [EOT]: 1 },
  );
  const model = await createWhisperModel(rt.ort, writeModel('hf'), { threads: 1 });
  assert.equal(await model.transcribe(speech(), 'it', never), 'ga');
});

test('silence never reaches the model', async () => {
  // A decoder that would answer with words if it ran.
  const rt = fakeRuntime(() => ({ 2: 1 }));
  const model = await createWhisperModel(rt.ort, writeModel('hf'), { threads: 1 });
  assert.equal(await model.transcribe(new Float32Array(0.2 * SAMPLE_RATE), 'it', never), '');
  assert.equal(await model.transcribe(new Float32Array(0), null, never), '');
  assert.equal(rt.encoderInputs.length, 0);
  assert.equal(rt.calls.length, 0);
});

test('a window over 30 s is refused, an aborted call rejects, close releases both graphs', async () => {
  const rt = fakeRuntime(() => ({ 1: 1 }));
  const model = await createWhisperModel(rt.ort, writeModel('flat'), { threads: 1 });
  await assert.rejects(model.transcribe(speech(30.5), 'it', never), /30 s/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(model.transcribe(speech(), 'it', ac.signal));
  await model.close();
  assert.equal(rt.released(), 2);
  await assert.rejects(model.transcribe(speech(), 'it', never), /closed/);
});

test('model files resolve under onnx/ first, then flat', () => {
  const hf = writeModel('hf');
  assert.equal(modelFile(hf, WHISPER_GRAPHS.encoder), join(hf, 'onnx', WHISPER_GRAPHS.encoder));
  assert.equal(modelFile(hf, 'vocab.json'), join(hf, 'vocab.json'));
  const flat = writeModel('flat');
  assert.equal(modelFile(flat, WHISPER_GRAPHS.decoder), join(flat, WHISPER_GRAPHS.decoder));
  assert.throws(() => modelFile(flat, 'nope.onnx'), /nope\.onnx is missing/);
});

test('a missing graph fails the load and releases what was created', async () => {
  const dir = writeModel('hf');
  const rt = fakeRuntime(() => ({}));
  const ort = {
    ...rt.ort,
    InferenceSession: {
      create: async (path: string) => {
        if (path.endsWith(WHISPER_GRAPHS.decoder)) throw new Error('bad graph');
        return rt.ort.InferenceSession.create(path);
      },
    },
  } as OrtModule;
  await assert.rejects(createWhisperModel(ort, dir, { threads: 1 }), /bad graph/);
  assert.equal(rt.released(), 1);
});

// Deterministic non-silent signal.
function noise(seconds: number, rate: number): Float32Array {
  const a = new Float32Array(Math.round(seconds * rate));
  let s = 1;
  for (let i = 0; i < a.length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    a[i] = 0.1 + (s / 2147483648) * 0.4;
  }
  return a;
}

test('splitWindows leaves audio up to 30 s whole', () => {
  const a = noise(30, 1000);
  const w = splitWindows(a, 1000);
  assert.equal(w.length, 1);
  assert.equal(w[0].length, a.length);
});

test('splitWindows splits 70 s into three windows of at most 30 s covering every sample', () => {
  const rate = 1000;
  const a = noise(70, rate);
  // A planted pause at 27.0..27.5 s: the first cut goes in its middle.
  a.fill(0, 27_000, 27_500);
  const w = splitWindows(a, rate);
  assert.equal(w.length, 3);
  assert.equal(w[0].length, 27_250);
  let offset = 0;
  for (const win of w) {
    assert.ok(win.length <= 30 * rate);
    assert.equal(win.byteOffset, a.byteOffset + offset * 4); // contiguous views, in order
    offset += win.length;
  }
  assert.equal(offset, a.length);
  // Without a pause the cut still lands within the last 5 s.
  const plain = splitWindows(noise(70, rate), rate);
  assert.ok(plain[0].length >= 25 * rate && plain[0].length <= 30 * rate);
});
