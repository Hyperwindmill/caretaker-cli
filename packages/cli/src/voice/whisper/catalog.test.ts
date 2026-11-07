import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WHISPER_SIZE, WHISPER_MODELS, WHISPER_SAMPLE_RATE } from './catalog.js';

const FILES = [
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_q4.onnx',
  'vocab.json',
  'added_tokens.json',
  'generation_config.json',
  'preprocessor_config.json',
  'config.json',
];

test('every size pins a commit and exactly the seven files with sha256 and size', () => {
  for (const [size, m] of Object.entries(WHISPER_MODELS)) {
    assert.equal(m.repo, `onnx-community/whisper-${size}`);
    assert.match(m.revision, /^[0-9a-f]{40}$/, size);
    assert.deepEqual(m.files.map((f) => f.name).sort(), [...FILES].sort(), size);
    for (const f of m.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${size}/${f.name}`);
      assert.ok(f.bytes > 0, `${size}/${f.name}`);
    }
  }
});

test('three sizes, base is the default, 16 kHz', () => {
  assert.deepEqual(Object.keys(WHISPER_MODELS).sort(), ['base', 'small', 'tiny']);
  assert.equal(DEFAULT_WHISPER_SIZE, 'base');
  assert.equal(WHISPER_SAMPLE_RATE, 16000);
});
