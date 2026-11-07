import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinPreset, edgePreset, localDefaultsPreset } from './voice_tab_presets.js';
import type { BuiltinVoiceStatus } from './bridge.js';

const status = (loadError?: string): BuiltinVoiceStatus => ({
  runtime: { installed: true, version: '1', loadError },
  languages: [
    { id: 'english', code: 'en', nativeVoice: 'alba', installed: false, bytes: 1 },
    { id: 'italian', code: 'it', nativeVoice: 'alba', installed: true, bytes: 1 },
  ],
  stt: [],
  voices: ['alba', 'jean'],
  defaults: {},
});

test('builtinPreset maps it-IT to italian with its default voice and enables the dictionary', () => {
  assert.deepEqual(builtinPreset('it-IT', status()), {
    ttsEngine: 'builtin',
    ttsLanguage: 'italian',
    ttsVoice: 'alba',
    pronunciationEnabled: true,
  });
});

test('unknown lang falls back to english', () => {
  assert.equal(builtinPreset('xx-XX', status()).ttsLanguage, 'english');
  assert.equal(builtinPreset(undefined, status()).ttsLanguage, 'english');
});

test('edgePreset selects the endpoint engine and disables the dictionary', () => {
  const p = edgePreset();
  assert.equal(p.ttsEngine, 'endpoint');
  assert.equal(p.pronunciationEnabled, false);
  assert.equal(p.ttsEndpoint, 'http://127.0.0.1:5050/v1');
});

test('localDefaultsPreset uses the built-in engine when the runtime can load, Kokoro when status reports loadError', () => {
  const ok = localDefaultsPreset('it', status());
  assert.equal(ok.ttsEngine, 'builtin');
  assert.equal(ok.sttModel, 'Systran/faster-whisper-small');
  const bad = localDefaultsPreset('it', status('no native'));
  assert.equal(bad.ttsEngine, 'endpoint');
  assert.equal(bad.ttsModel, 'speaches-ai/Kokoro-82M-v1.0-ONNX');
  assert.equal(localDefaultsPreset('it', null).ttsEngine, 'endpoint');
});
