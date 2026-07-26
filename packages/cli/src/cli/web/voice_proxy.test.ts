import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-voice-proxy-'));

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { registerVoiceProxy, voiceClientConfig, fetchVoiceCatalog } from './voice_proxy.js';
import { saveConfig } from '../../store/json.js';

let server: ReturnType<typeof serve>;
let baseUrl: string;

// A stand-in for the user's speech provider. Records what it was sent.
let upstream: ReturnType<typeof serve>;
let upstreamUrl: string;
let catalogUrl: string;
let plainUrl: string;
let brokenUrl: string;
let lastRequest: { path: string; auth: string | null; model: string | null; body: any } | null = null;
let upstreamStatus = 200;
let upstreamBody: string | Uint8Array = JSON.stringify({ text: 'ciao mondo' });
let upstreamType = 'application/json';

before(async () => {
  const up = new Hono();
  up.post('/v1/audio/transcriptions', async (c) => {
    const form = await c.req.formData();
    lastRequest = {
      path: '/v1/audio/transcriptions',
      auth: c.req.header('authorization') ?? null,
      model: (form.get('model') as string) ?? null,
      body: form.get('file'),
    };
    return c.body(upstreamBody as any, upstreamStatus as any, { 'content-type': upstreamType });
  });
  up.post('/v1/audio/speech', async (c) => {
    const json = await c.req.json();
    lastRequest = {
      path: '/v1/audio/speech',
      auth: c.req.header('authorization') ?? null,
      model: json.model ?? null,
      body: json,
    };
    return c.body(upstreamBody as any, upstreamStatus as any, { 'content-type': upstreamType });
  });
  // Three /v1/models shapes: Speaches (task + per-model voices), a plain
  // OpenAI-compatible endpoint (neither), and a failing one.
  up.get('/catalog/models', (c) =>
    c.json({
      data: [
        {
          id: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
          task: 'text-to-speech',
          voices: [
            { id: 'af_heart', language: 'en-us', gender: 'female' },
            { id: 'if_sara', language: 'it', gender: 'female' },
          ],
        },
        {
          id: 'speaches-ai/piper-it_IT-paola-medium',
          task: 'text-to-speech',
          voices: [{ id: 'paola', language: 'it' }],
        },
        { id: 'Systran/faster-whisper-small', task: 'automatic-speech-recognition' },
      ],
    }),
  );
  up.get('/plain/models', (c) => c.json({ data: [{ id: 'whisper-1' }, { id: 'tts-1' }] }));
  up.get('/broken/models', (c) => c.text('teapot', 418));

  upstream = serve({ fetch: up.fetch, port: 0 });
  const base = `http://127.0.0.1:${(upstream.address() as any).port}`;
  upstreamUrl = `${base}/v1`;
  catalogUrl = `${base}/catalog`;
  plainUrl = `${base}/plain`;
  brokenUrl = `${base}/broken`;

  const app = new Hono();
  registerVoiceProxy(app);
  server = serve({ fetch: app.fetch, port: 0 });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  upstream.close();
});

beforeEach(() => {
  lastRequest = null;
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ text: 'ciao mondo' });
  upstreamType = 'application/json';
});

function audioForm(): FormData {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'turn.webm');
  return form;
}

test('transcribe returns 503 when voice is disabled', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: false, endpoint: upstreamUrl, sttModel: 'whisper' },
  });
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /voice/i);
});

test('transcribe returns 503 when the endpoint is empty', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: '', sttModel: 'whisper' },
  });
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 503);
});

test('transcribe forwards the audio with the model and bearer key', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: upstreamUrl,
      apiKey: 'sk-secret',
      sttModel: 'Systran/faster-whisper-small',
      lang: 'it-IT',
    },
  });
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: 'ciao mondo' });
  assert.equal(lastRequest?.model, 'Systran/faster-whisper-small');
  assert.equal(lastRequest?.auth, 'Bearer sk-secret');
});

test('speak returns 400 when no synthesis model is configured', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: upstreamUrl, sttModel: 'whisper' },
  });
  const res = await fetch(`${baseUrl}/api/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ciao' }),
  });
  assert.equal(res.status, 400);
});

test('speak forwards text, model and voice, and returns the audio bytes', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: upstreamUrl,
      sttModel: 'whisper',
      ttsModel: 'kokoro',
      ttsVoice: 'af_heart',
    },
  });
  upstreamBody = new Uint8Array([0xff, 0xfb, 0x90]);
  upstreamType = 'audio/mpeg';

  const res = await fetch(`${baseUrl}/api/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ciao' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(new Uint8Array(await res.arrayBuffer()).length, 3);
  assert.equal(lastRequest?.body.model, 'kokoro');
  assert.equal(lastRequest?.body.voice, 'af_heart');
  assert.equal(lastRequest?.body.input, 'ciao');
});

test('upstream failures propagate status and body verbatim', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: upstreamUrl, sttModel: 'nonexistent-model' },
  });
  upstreamStatus = 404;
  upstreamBody = JSON.stringify({ error: { message: 'model nonexistent-model not found' } });

  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: audioForm() });
  assert.equal(res.status, 404);
  // Verbatim: a wrong model id must read as the provider's own error, because
  // there is no configuration-validation button in the UI.
  assert.match(await res.text(), /nonexistent-model not found/);
});

test('voiceClientConfig redacts the key and reports capability', () => {
  assert.equal(voiceClientConfig({ port: 3000, providers: [] }), null);

  const full = voiceClientConfig({
    port: 3000,
    providers: [],
    voice: {
      enabled: true,
      endpoint: 'http://x/v1',
      apiKey: 'sk-secret',
      sttModel: 'whisper',
      ttsModel: 'kokoro',
      lang: 'it-IT',
    },
  });
  assert.deepEqual(full, { enabled: true, configured: true, canSpeak: true, lang: 'it-IT' });
  assert.ok(!JSON.stringify(full).includes('sk-secret'));

  const noTts = voiceClientConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: 'http://x/v1', sttModel: 'whisper' },
  });
  assert.equal(noTts?.canSpeak, false);

  const noEndpoint = voiceClientConfig({
    port: 3000,
    providers: [],
    voice: { enabled: true, endpoint: '', sttModel: 'whisper' },
  });
  assert.equal(noEndpoint?.configured, false);
});

// --- Catalogue discovery, so the settings form can offer real choices. ---

test('fetchVoiceCatalog splits by task and scopes voices to their model', async () => {
  const catalog = await fetchVoiceCatalog(catalogUrl);
  assert.deepEqual(catalog.stt, ['Systran/faster-whisper-small']);
  assert.equal(catalog.tts.length, 2);

  const kokoro = catalog.tts.find((m) => m.id.includes('Kokoro'));
  assert.equal(kokoro?.voices.length, 2);
  assert.deepEqual(kokoro?.voices[0], { id: 'af_heart', language: 'en-us', gender: 'female' });

  // Per-model voices are correctly scoped here, unlike the global
  // /v1/audio/voices catalogue which ignores its model_id parameter.
  const piper = catalog.tts.find((m) => m.id.includes('piper'));
  assert.deepEqual(piper?.voices, [{ id: 'paola', language: 'it' }]);
});

test('fetchVoiceCatalog degrades when the endpoint reports no task metadata', async () => {
  const catalog = await fetchVoiceCatalog(plainUrl);
  // A plain OpenAI-compatible /v1/models: every id offered for both, no voices.
  assert.deepEqual(catalog.stt, ['whisper-1', 'tts-1']);
  assert.deepEqual(catalog.tts, [{ id: 'whisper-1', voices: [] }, { id: 'tts-1', voices: [] }]);
});

test('fetchVoiceCatalog surfaces upstream failures', async () => {
  await assert.rejects(() => fetchVoiceCatalog(brokenUrl), /418/);
});
