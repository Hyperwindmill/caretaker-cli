import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-whisper-engine-'));

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { VoiceConfig } from 'caretaker-types';
import { runtimeEntry, whisperDir } from '../pocket/install.js';
import type { WhisperModel } from './inference.js';
import type { WhisperSize } from './catalog.js';
import { releaseWhisperModels, setWhisperLoaderForTest, transcribeBuiltin } from './engine.js';

const voice = (o: Partial<VoiceConfig> = {}) =>
  ({ enabled: true, endpoint: '', sttModel: '', sttEngine: 'builtin', lang: 'it-IT', ...o }) as VoiceConfig;
const sig = () => new AbortController().signal;

function install({ runtime = true, sizes = ['base'] as WhisperSize[] } = {}) {
  rmSync(path.join(process.env.CARETAKER_HOME!, 'voice'), { recursive: true, force: true });
  if (runtime) {
    mkdirSync(path.dirname(runtimeEntry()), { recursive: true });
    writeFileSync(runtimeEntry(), '');
  }
  for (const s of sizes) mkdirSync(whisperDir(s), { recursive: true });
}

function fakeModel(log: string[], name = 'm'): WhisperModel {
  return {
    async transcribe(audio, lang) {
      log.push(`start ${name} ${audio.length} ${lang}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${name}`);
      return `w${audio.length}`;
    },
    async close() {
      log.push(`close ${name}`);
    },
  };
}

beforeEach(async () => {
  await releaseWhisperModels();
  setWhisperLoaderForTest(null);
});

test('missing runtime → 409 naming the runtime; missing model → 409 naming the size', async () => {
  install({ runtime: false });
  let res = await transcribeBuiltin(voice(), new Float32Array(16000), sig());
  assert.equal(res.status, 409);
  assert.match(await res.text(), /runtime/i);
  install({ sizes: [] });
  res = await transcribeBuiltin(voice(), new Float32Array(16000), sig());
  assert.equal(res.status, 409);
  assert.match(await res.text(), /base/);
});

test('returns { text } with the language subtag', async () => {
  install();
  const log: string[] = [];
  setWhisperLoaderForTest(async () => fakeModel(log));
  const res = await transcribeBuiltin(voice(), new Float32Array(16000), sig());
  assert.deepEqual(await res.json(), { text: 'w16000' });
  assert.equal(log[0], 'start m 16000 it');
});

test('no language configured → null (auto-detect)', async () => {
  install();
  const log: string[] = [];
  setWhisperLoaderForTest(async () => fakeModel(log));
  await transcribeBuiltin(voice({ lang: undefined }), new Float32Array(160), sig());
  assert.equal(log[0], 'start m 160 null');
});

test('concurrent calls are serialized', async () => {
  install();
  const log: string[] = [];
  setWhisperLoaderForTest(async () => fakeModel(log));
  await Promise.all([
    transcribeBuiltin(voice(), new Float32Array(1), sig()),
    transcribeBuiltin(voice(), new Float32Array(2), sig()),
  ]);
  assert.deepEqual(log, ['start m 1 it', 'end m', 'start m 2 it', 'end m']);
});

test('model loads once per size; a size switch releases the previous one', async () => {
  install({ sizes: ['base', 'tiny'] });
  const log: string[] = [];
  let loads = 0;
  setWhisperLoaderForTest(async (size) => (loads++, fakeModel(log, size)));
  await transcribeBuiltin(voice(), new Float32Array(1), sig());
  await transcribeBuiltin(voice(), new Float32Array(1), sig());
  assert.equal(loads, 1);
  await transcribeBuiltin(voice({ sttBuiltinModel: 'tiny' }), new Float32Array(1), sig());
  assert.equal(loads, 2);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(log.includes('close base'));
});

test('audio over 30 s is transcribed window by window, in order, and joined', async () => {
  install();
  const log: string[] = [];
  setWhisperLoaderForTest(async () => fakeModel(log));
  const res = await transcribeBuiltin(voice(), new Float32Array(16000 * 70), sig());
  const { text } = (await res.json()) as { text: string };
  const starts = log.filter((l) => l.startsWith('start'));
  assert.equal(starts.length, 3);
  const lengths = starts.map((l) => Number(l.split(' ')[2]));
  assert.equal(lengths.reduce((a, b) => a + b, 0), 16000 * 70);
  assert.equal(text, lengths.map((n) => `w${n}`).join(' '));
});
