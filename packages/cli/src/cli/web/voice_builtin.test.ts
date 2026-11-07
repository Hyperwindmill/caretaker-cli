import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-voice-builtin-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { registerVoiceBuiltin } from './voice_builtin.js';
import { __resetFetch, __setCatalogForTest, __setFetch } from '../../voice/pocket/install.js';

afterEach(() => __resetFetch());

const app = new Hono();
registerVoiceBuiltin(app);
const post = (p: string) => app.request(p, { method: 'POST' });

test('unknown language → 400', async () => {
  assert.equal((await post('/api/voice/builtin/install?language=klingon')).status, 400);
  assert.equal((await post('/api/voice/builtin/delete')).status, 400);
});

function stub(release: Promise<void>) {
  const empty = gzipSync(Buffer.alloc(1024));
  const data = Buffer.from('x');
  __setCatalogForTest({
    ortVersion: '9.9.8',
    tarballs: {
      node: { url: 'https://t/node', integrity: 'sha512-' + createHash('sha512').update(empty).digest('base64') },
      common: { url: 'https://t/common', integrity: 'sha512-' + createHash('sha512').update(empty).digest('base64') },
    },
    whisper: { base: { repo: 'o/whisper-base', revision: 'r', files: [{ name: 'onnx/a', sha256: createHash('sha256').update(data).digest('hex'), bytes: 1 }] } } as any,
    languages: { italian: { code: 'it', dir: 'it', nativeVoice: 'alba', files: [{ name: 'a', sha256: createHash('sha256').update(data).digest('hex'), bytes: 1 }] } } as any,
  });
  __setFetch((async (url: any) => {
    await release;
    return new Response(new Uint8Array(String(url).startsWith('https://t/') ? empty : data));
  }) as typeof fetch);
}

test('install streams ndjson ending with done; a concurrent install → 409', async () => {
  let go!: () => void;
  stub(new Promise<void>((r) => (go = r)));
  const first = post('/api/voice/builtin/install?language=italian');
  const res1 = await first;
  const second = await post('/api/voice/builtin/install?language=italian');
  assert.equal(second.status, 409);
  go();
  const lines = (await res1.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).step, 'done');
  assert.equal(lines.at(-1).status.languages[0].installed, true);
  const del = await post('/api/voice/builtin/delete?language=italian');
  assert.equal(del.status, 200);
  assert.equal((await del.json()).languages[0].installed, false);
});

test('stt: bad size, neither, both → 400', async () => {
  assert.equal((await post('/api/voice/builtin/install?stt=huge')).status, 400);
  assert.equal((await post('/api/voice/builtin/install?stt=base&language=italian')).status, 400);
  assert.equal((await post('/api/voice/builtin/delete?stt=huge')).status, 400);
  assert.equal((await post('/api/voice/builtin/delete')).status, 400);
});

test('stt install streams ndjson ending done; a concurrent voice install → 409; delete works', async () => {
  let go!: () => void;
  stub(new Promise<void>((r) => (go = r)));
  const res1 = await post('/api/voice/builtin/install?stt=base');
  assert.equal((await post('/api/voice/builtin/install?language=italian')).status, 409);
  assert.equal((await post('/api/voice/builtin/delete?stt=base')).status, 409);
  go();
  const lines = (await res1.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).step, 'done');
  assert.deepEqual(lines.at(-1).status.stt, [{ id: 'base', installed: true, bytes: 1 }]);
  const del = await post('/api/voice/builtin/delete?stt=base');
  assert.equal(del.status, 200);
  assert.equal((await del.json()).stt[0].installed, false);
});
