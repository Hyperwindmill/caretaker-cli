import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: must be set before importing anything that resolves CARETAKER_HOME.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-voice-cfg-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig, configPath } from './json.js';
import { isEncrypted, decrypt } from '../lib/encryption.js';

test('saveConfig encrypts voice.apiKey at rest and loadConfig round-trips the block', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: 'http://127.0.0.1:8000/v1',
      apiKey: 'sk-plaintext-secret',
      sttModel: 'Systran/faster-whisper-small',
      ttsModel: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
      ttsVoice: 'af_heart',
    },
  });

  const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  assert.ok(isEncrypted(raw.voice.apiKey), 'key must be encrypted on disk');
  assert.notEqual(raw.voice.apiKey, 'sk-plaintext-secret');
  assert.equal(decrypt(raw.voice.apiKey), 'sk-plaintext-secret');

  const loaded = await loadConfig();
  assert.equal(loaded.voice?.enabled, true);
  assert.equal(loaded.voice?.sttModel, 'Systran/faster-whisper-small');
});

test('saveConfig does not double-encrypt an already-encrypted key', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: 'http://x/v1', apiKey: 'sk-abc', sttModel: 'm' },
  });
  const once = JSON.parse(readFileSync(configPath(), 'utf8')).voice.apiKey;

  // Re-save the already-encrypted value, as the settings round-trip does.
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: 'http://x/v1', apiKey: once, sttModel: 'm' },
  });
  const twice = JSON.parse(readFileSync(configPath(), 'utf8')).voice.apiKey;
  assert.equal(decrypt(twice), 'sk-abc');
});

test('saveConfig leaves a config with no voice block untouched', async () => {
  await saveConfig({ port: 3000, providers: [] });
  const loaded = await loadConfig();
  assert.equal(loaded.voice, undefined);
});
