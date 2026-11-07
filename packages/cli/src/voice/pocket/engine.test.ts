import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-voice-engine-'));

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { VoiceConfig } from 'caretaker-types';
import { bundleDir, runtimeEntry, runtimeDir } from './install.js';
import type { PocketModel } from './inference.js';
import { loadOnnxRuntime, releasePocketModels, runtimeLoadError, setModelLoaderForTest, speakBuiltin } from './engine.js';

const voice = { enabled: true, endpoint: '', sttModel: '', ttsEngine: 'builtin', ttsLanguage: 'italian' } as VoiceConfig;

function installFakes({ runtime = true, bundle = true } = {}) {
  rmSync(path.join(process.env.CARETAKER_HOME!, 'voice'), { recursive: true, force: true });
  if (runtime) {
    mkdirSync(path.dirname(runtimeEntry()), { recursive: true });
    writeFileSync(runtimeEntry(), 'throw new Error("broken binding")');
  }
  if (bundle) mkdirSync(bundleDir('italian'), { recursive: true });
}

function fakeModel(frames: Float32Array[], log: string[] = []): PocketModel {
  return {
    sampleRate: 24000,
    async *synthesize(text, _voice, signal) {
      log.push(`start ${text}`);
      try {
        for (const f of frames) {
          await new Promise((r) => setTimeout(r, 5));
          if (signal.aborted) return;
          yield f;
        }
      } finally {
        log.push(`end ${text}`);
      }
    },
    async close() {},
  };
}

beforeEach(async () => {
  await releasePocketModels();
  setModelLoaderForTest(null);
});

test('missing runtime → 409 naming the runtime; missing bundle → 409 naming the language', async () => {
  installFakes({ runtime: false });
  let res = await speakBuiltin(voice, 'ciao', new AbortController().signal);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /runtime/i);
  installFakes({ bundle: false });
  res = await speakBuiltin(voice, 'ciao', new AbortController().signal);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /italian/i);
});

test('streams int16 LE PCM with the pcm content type', async () => {
  installFakes();
  setModelLoaderForTest(async () => fakeModel([new Float32Array([0.5]), new Float32Array([-1])]));
  const res = await speakBuiltin(voice, 'ciao', new AbortController().signal);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/pcm;rate=24000;channels=1');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x00, 0x40, 0x00, 0x80]);
});

test('two concurrent syntheses on one language both complete, serialized', async () => {
  installFakes();
  const log: string[] = [];
  setModelLoaderForTest(async () => fakeModel([new Float32Array([0]), new Float32Array([0])], log));
  const [a, b] = await Promise.all([
    speakBuiltin(voice, 'a', new AbortController().signal).then((r) => r.arrayBuffer()),
    speakBuiltin(voice, 'b', new AbortController().signal).then((r) => r.arrayBuffer()),
  ]);
  assert.equal(a.byteLength, 4);
  assert.equal(b.byteLength, 4);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
});

test('client abort stops generation', async () => {
  installFakes();
  const log: string[] = [];
  setModelLoaderForTest(async () => fakeModel(Array.from({ length: 50 }, () => new Float32Array([0])), log));
  const ac = new AbortController();
  const res = await speakBuiltin(voice, 'x', ac.signal);
  const reader = res.body!.getReader();
  await reader.read();
  ac.abort();
  await reader.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(log, ['start x', 'end x']);
});

test('model loads once per language across requests', async () => {
  installFakes();
  let loads = 0;
  setModelLoaderForTest(async () => (loads++, fakeModel([new Float32Array([0])])));
  for (let i = 0; i < 3; i++) await (await speakBuiltin(voice, 'x', new AbortController().signal)).arrayBuffer();
  assert.equal(loads, 1);
});

test('runtime load failure is reported as loadError', () => {
  installFakes();
  assert.throws(() => loadOnnxRuntime(), /could not be loaded/);
  assert.match(runtimeLoadError() ?? '', /broken binding/);
  assert.ok(runtimeDir());
});

test('an installed runtime that cannot load answers a readable 500', async () => {
  installFakes();
  const res = await speakBuiltin(voice, 'ciao', new AbortController().signal);
  assert.equal(res.status, 500);
  assert.match(await res.text(), /could not be loaded: broken binding/);
});
