import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { VoiceConfig, CaretakerConfig } from 'caretaker-types';
import {
  loopbackPort,
  probeBackend,
  probeBackends,
  startBackend,
  stopBackend,
  deleteBackend,
  registerVoiceBackend,
  maybeAutoStartBackend,
  isBackendStartInFlightForTest,
  setVoiceBackendDepsForTest,
  type StartProgress,
  type Target,
} from './voice_backend.js';
import { saveConfig } from '../../store/json.js';

// File-scope only (never inside a describe/test): a per-file isolated store,
// so these tests never touch the developer's real ~/.caretaker.
process.env.CARETAKER_HOME = mkdtempSync(join(tmpdir(), 'ct-voice-backend-'));

afterEach(() => setVoiceBackendDepsForTest(null));

function baseConfig(voice?: CaretakerConfig['voice']): CaretakerConfig {
  return { port: 17777, providers: [], ...(voice ? { voice } : {}) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A tiny local HTTP server that is "ready" from the very first poll, so
 *  tests exercising the full startBackend flow don't wait out the real
 *  readiness/backoff timers. */
async function startReadyServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = req.url ?? '';
    if (req.method === 'GET' && u === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    if (req.method === 'POST' && u.startsWith('/v1/models/')) {
      res.writeHead(201);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

// --- loopbackPort: pure parsing, no server needed -----------------------

test('loopbackPort: recognizes the three loopback hosts and parses an explicit port', () => {
  assert.equal(loopbackPort('http://127.0.0.1:8969/v1'), 8969);
  assert.equal(loopbackPort('http://localhost:8969/v1'), 8969);
  assert.equal(loopbackPort('http://[::1]:8969/v1'), 8969);
});

test('loopbackPort: falls back to the scheme default when no port is given', () => {
  assert.equal(loopbackPort('http://localhost/v1'), 80);
  assert.equal(loopbackPort('https://localhost/v1'), 443);
});

test('loopbackPort: null for a remote host, a LAN IP, or a malformed URL', () => {
  assert.equal(loopbackPort('http://speaches.example.com:8000/v1'), null);
  assert.equal(loopbackPort('http://192.168.1.42:8000/v1'), null);
  assert.equal(loopbackPort('not a url'), null);
});

// --- probeBackend: Docker classification, no daemon needed --------------
// Port 9 (discard) is never listening in these environments, so the
// independent `responding` GET fails fast without a real timeout wait.
const UNREACHABLE_ENDPOINT = 'http://127.0.0.1:9/v1';

test('probeBackend: "absent" from an ENOENT spawn error', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: false, code: 'ENOENT', stderr: '' }),
  });
  const status = await probeBackend(UNREACHABLE_ENDPOINT);
  assert.equal(status.docker, 'absent');
  // Coherent status rather than throwing: no Docker to ask, so absent/false.
  assert.equal(status.container, 'absent');
  assert.equal(status.imagePresent, false);
});

test('probeBackend: "denied" from a permission-denied stderr on the socket', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({
      ok: false,
      stderr:
        'Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
    }),
  });
  const status = await probeBackend(UNREACHABLE_ENDPOINT);
  assert.equal(status.docker, 'denied');
});

test('probeBackend: "down" when the binary ran but `docker info` itself failed', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({
      ok: false,
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    }),
  });
  const status = await probeBackend(UNREACHABLE_ENDPOINT);
  assert.equal(status.docker, 'down');
});

test('probeBackend: "ok" reports real container/image state', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => 'stopped',
    imagePresent: async () => true,
  });
  const status = await probeBackend(UNREACHABLE_ENDPOINT);
  assert.equal(status.docker, 'ok');
  assert.equal(status.container, 'stopped');
  assert.equal(status.imagePresent, true);
  assert.equal(status.port, 9);
});

// --- startBackend: readiness + model-pull sequencing --------------------
// A real http server on port 0 — no Docker daemon, no network egress.

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let requestLog: string[];
let modelsCallCount: number;

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = req.url ?? '';
    requestLog.push(`${req.method} ${u}`);
    if (req.method === 'GET' && u === '/v1/models') {
      modelsCallCount += 1;
      // Not ready on the first poll, ready from the second — proves polling.
      if (modelsCallCount < 2) {
        res.writeHead(503);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
      }
      return;
    }
    if (req.method === 'POST' && u.startsWith('/v1/models/')) {
      const id = decodeURIComponent(u.slice('/v1/models/'.length));
      // ttsModel simulates an already-installed model (409), which must
      // still be treated as success.
      res.writeHead(id === 'tts-y' ? 409 : 201);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('startBackend: polls readiness before installing models, using the configured ids; 409 = success', async () => {
  requestLog = [];
  modelsCallCount = 0;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    imagePresent: async () => true, // skip the pull step entirely
    containerState: async () => 'running', // skip run/start entirely
  });

  const voice: VoiceConfig = {
    enabled: true,
    endpoint: `${baseUrl}/v1`,
    sttModel: 'stt-x',
    ttsModel: 'tts-y',
  };

  const progress: StartProgress[] = [];
  for await (const p of startBackend(voice)) progress.push(p);

  assert.equal(progress.at(-1)?.step, 'done');
  assert.ok(progress.some((p) => p.step === 'image'));
  assert.ok(progress.some((p) => p.step === 'run'));
  assert.ok(progress.some((p) => p.step === 'ready' && /responding/i.test(p.message)));

  const modelMessages = progress.filter((p) => p.step === 'models').map((p) => p.message);
  assert.deepEqual(modelMessages, ['Model stt-x ready.', 'Model tts-y ready.']);

  const postPaths = requestLog.filter((r) => r.startsWith('POST'));
  assert.deepEqual(postPaths, ['POST /v1/models/stt-x', 'POST /v1/models/tts-y']);

  // At least one readiness GET must precede the first model POST (a further
  // GET happens afterwards too, computing the terminal status).
  const firstPostIdx = requestLog.findIndex((r) => r.startsWith('POST'));
  const getsBeforePost = requestLog
    .slice(0, firstPostIdx)
    .filter((r) => r === 'GET /v1/models').length;
  assert.ok(getsBeforePost > 0, 'readiness must be polled before any model is installed');
  assert.ok(modelsCallCount >= 2, 'readiness must actually be polled, not just checked once');

  const finalStatus = progress.at(-1)?.status;
  assert.equal(finalStatus?.docker, 'ok');
  assert.equal(finalStatus?.container, 'running');
  assert.equal(finalStatus?.responding, true);
});

test('startBackend: a non-loopback endpoint errors immediately, no docker call attempted', async () => {
  let dockerInfoCalled = false;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ((dockerInfoCalled = true), { ok: true }),
    containerState: async () => 'absent',
    imagePresent: async () => false,
  });

  const voice: VoiceConfig = {
    enabled: true,
    endpoint: 'http://speaches.example.com:8000/v1',
    sttModel: 'stt-x',
  };
  const progress: StartProgress[] = [];
  for await (const p of startBackend(voice)) progress.push(p);

  assert.equal(progress.length, 1);
  assert.equal(progress[0]?.step, 'error');
  assert.match(progress[0]?.message ?? '', /non-loopback/);
  assert.equal(dockerInfoCalled, true, 'status is still probed to answer the terminal line');
});

// --- stopBackend: per-target container name (tests below, near the stop route) ---

// --- registerVoiceBackend: the three routes -------------------------------

test('GET /api/voice/backend probes with the stored endpoint', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => 'stopped',
    imagePresent: async () => true,
  });
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x' }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { stt: { docker: string; container: string; port: number | null }; tts: null };
  assert.equal(body.stt.docker, 'ok');
  assert.equal(body.stt.container, 'stopped');
  assert.equal(body.stt.port, 9);
  assert.equal(body.tts, null);
});

test('GET /api/voice/backend on an unconfigured voice yields a coherent status, not an error', async () => {
  // No Docker daemon needed for this suite: stub it out even on this "not
  // loopback" path, where docker classification still runs before port null
  // short-circuits the rest of the status.
  setVoiceBackendDepsForTest({ dockerInfo: async () => ({ ok: false, code: 'ENOENT', stderr: '' }) });
  await saveConfig(baseConfig()); // no voice at all
  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { stt: { port: number | null }; tts: null };
  assert.equal(body.stt.port, null);
  assert.equal(body.tts, null);
});

test('POST /api/voice/backend/start with voice disabled returns 400 with a plain-text reason', async () => {
  await saveConfig(
    baseConfig({ enabled: false, endpoint: 'http://127.0.0.1:8969/v1', sttModel: 'stt-x' }),
  );
  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/start', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /disabled/i);
});

test('POST /api/voice/backend/start with no endpoint configured returns 400', async () => {
  await saveConfig(baseConfig({ enabled: true, endpoint: '', sttModel: 'stt-x' }));
  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/start', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no voice endpoint/i);
});

test('POST /api/voice/backend/start streams ndjson progress ending in a done status', async () => {
  const ready = await startReadyServer();
  try {
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      imagePresent: async () => true,
      containerState: async () => 'running',
    });
    await saveConfig(
      baseConfig({ enabled: true, endpoint: `${ready.baseUrl}/v1`, sttModel: '' }),
    );

    const app = new Hono();
    registerVoiceBackend(app);
    const res = await app.request('/api/voice/backend/start', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson');

    const lines = (await res.text())
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as StartProgress);
    assert.ok(lines.length > 0);
    assert.equal(lines.at(-1)?.step, 'done');
    assert.equal(lines.at(-1)?.status?.responding, true);
  } finally {
    await ready.close();
    await waitFor(() => !isBackendStartInFlightForTest());
  }
});

test('POST /api/voice/backend/stop re-probes rather than throwing when there is no container', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => 'absent',
    imagePresent: async () => false,
    stopContainer: async () => {
      throw new Error('Error: No such container: caretaker-speaches');
    },
  });
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x' }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/stop', { method: 'POST' });
  assert.equal(res.status, 200);
  const status = (await res.json()) as { container: string };
  assert.equal(status.container, 'absent');
});

// --- stopBackend: per-target container name -----------------------------

test('stopBackend calls stopContainer with the stt container name by default', async () => {
  const calls: string[] = [];
  setVoiceBackendDepsForTest({ stopContainer: async (name) => void calls.push(name) });
  await stopBackend();
  assert.deepEqual(calls, ['caretaker-speaches']);
});

test('stopBackend calls stopContainer with the tts container name when target=tts', async () => {
  const calls: string[] = [];
  setVoiceBackendDepsForTest({ stopContainer: async (name) => void calls.push(name) });
  await stopBackend('tts');
  assert.deepEqual(calls, ['caretaker-edge-tts']);
});

test('deleteBackend calls removeContainer with the tts container name when target=tts', async () => {
  const calls: string[] = [];
  setVoiceBackendDepsForTest({ removeContainer: async (name) => void calls.push(name) });
  await deleteBackend('tts');
  assert.deepEqual(calls, ['caretaker-edge-tts']);
});

// --- POST /api/voice/backend/delete ---------------------------------------

test('POST /api/voice/backend/delete removes the container and answers with the re-probed status', async () => {
  let removed: string | null = null;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => (removed ? 'absent' : 'running'),
    imagePresent: async () => true,
    removeContainer: async (name) => {
      removed = name;
    },
  });
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x' }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/delete', { method: 'POST' });
  assert.equal(res.status, 200);
  const status = (await res.json()) as { container: string };
  assert.equal(removed, 'caretaker-speaches');
  assert.equal(status.container, 'absent');
});

test('POST /api/voice/backend/delete?target=tts removes the tts container', async () => {
  let removed: string | null = null;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => (removed ? 'absent' : 'running'),
    imagePresent: async () => true,
    removeContainer: async (name) => {
      removed = name;
    },
  });
  await saveConfig(
    baseConfig({
      enabled: true,
      endpoint: 'http://127.0.0.1:9/v1',
      sttModel: 'stt-x',
      ttsEndpoint: 'http://127.0.0.1:10/v1',
      ttsModel: 'tts-1',
    }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/delete?target=tts', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(removed, 'caretaker-edge-tts');
});

test('POST /api/voice/backend/delete re-probes rather than throwing when there is no container', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => 'absent',
    imagePresent: async () => true,
    removeContainer: async () => {
      throw new Error('Error: No such container: caretaker-speaches');
    },
  });
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x' }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/delete', { method: 'POST' });
  assert.equal(res.status, 200);
  const status = (await res.json()) as { container: string };
  assert.equal(status.container, 'absent');
});

test('POST /api/voice/backend/delete answers 409 while a start is in flight', async () => {
  const ready = await startReadyServer();
  let releasePull: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releasePull = resolve;
  });
  let startDrained: Promise<string> | null = null;
  try {
    let removeCalls = 0;
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      containerState: async () => 'absent',
      imagePresent: async () => false, // force the pull path so the start stays in flight
      async *pullImage() {
        yield 'pulling';
        await gate;
      },
      runContainer: async () => {},
      removeContainer: async () => {
        removeCalls += 1;
      },
    });
    await saveConfig(
      baseConfig({ enabled: true, endpoint: `${ready.baseUrl}/v1`, sttModel: 'stt-x' }),
    );

    const app = new Hono();
    registerVoiceBackend(app);
    // Kick off the start and drain its stream in the background so the
    // generator actually runs (Hono streams execute as the body is consumed).
    startDrained = Promise.resolve(
      app.request('/api/voice/backend/start', { method: 'POST' }),
    ).then((r) => r.text());
    await waitFor(() => isBackendStartInFlightForTest());

    const res = await app.request('/api/voice/backend/delete', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(removeCalls, 0);
  } finally {
    // Unconditional: a failed assertion above must not leave the in-flight
    // start parked on the gate, poisoning every later test in the file.
    releasePull();
    if (startDrained) await startDrained;
    await waitFor(() => !isBackendStartInFlightForTest());
    await ready.close();
  }
});

test('POST /api/voice/backend/start twice concurrently only pulls the image once (in-flight guard)', async () => {
  const ready = await startReadyServer();
  try {
    let pullCalls = 0;
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      imagePresent: async () => false, // force the pull path, the realistic race window
      async *pullImage() {
        pullCalls += 1;
        yield 'Pulling fs layer...';
      },
      containerState: async () => 'running', // skip run/start after the (fake) pull
    });
    await saveConfig(
      baseConfig({ enabled: true, endpoint: `${ready.baseUrl}/v1`, sttModel: '' }),
    );

    const app = new Hono();
    registerVoiceBackend(app);

    const [res1, res2] = await Promise.all([
      app.request('/api/voice/backend/start', { method: 'POST' }),
      app.request('/api/voice/backend/start', { method: 'POST' }),
    ]);
    // Reading the bodies drains each stream fully, which is what drives each
    // underlying generator (including its `finally`) to completion.
    const [body1, body2] = await Promise.all([res1.text(), res2.text()]);

    assert.equal(pullCalls, 1, 'exactly one docker pull, whichever request won the race');
    const turnedAway = [body1, body2].filter((b) => /already in progress/.test(b)).length;
    assert.equal(turnedAway, 1, 'exactly one of the two responses is turned away, not queued');
  } finally {
    await ready.close();
    await waitFor(() => !isBackendStartInFlightForTest());
  }
});

// --- maybeAutoStartBackend: opt-in, fire-and-forget, never fatal ----------

test('maybeAutoStartBackend: does nothing when voice is disabled', async () => {
  let dockerInfoCalls = 0;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ((dockerInfoCalls += 1), { ok: true }),
  });
  await saveConfig(
    baseConfig({
      enabled: false,
      endpoint: 'http://127.0.0.1:8969/v1',
      sttModel: 'stt-x',
      autoStartBackend: true,
    }),
  );

  maybeAutoStartBackend();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(dockerInfoCalls, 0);
  assert.equal(isBackendStartInFlightForTest(), false);
});

test('maybeAutoStartBackend: does nothing when autoStartBackend is unset or explicitly false', async () => {
  let dockerInfoCalls = 0;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ((dockerInfoCalls += 1), { ok: true }),
  });

  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:8969/v1', sttModel: 'stt-x' }),
  );
  maybeAutoStartBackend();
  await new Promise((resolve) => setTimeout(resolve, 30));

  await saveConfig(
    baseConfig({
      enabled: true,
      endpoint: 'http://127.0.0.1:8969/v1',
      sttModel: 'stt-x',
      autoStartBackend: false,
    }),
  );
  maybeAutoStartBackend();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(dockerInfoCalls, 0);
});

test('maybeAutoStartBackend: does nothing when the endpoint is not loopback', async () => {
  let dockerInfoCalls = 0;
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ((dockerInfoCalls += 1), { ok: true }),
  });
  await saveConfig(
    baseConfig({
      enabled: true,
      endpoint: 'http://speaches.example.com:8000/v1',
      sttModel: 'stt-x',
      autoStartBackend: true,
    }),
  );

  maybeAutoStartBackend();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(dockerInfoCalls, 0);
});

test('maybeAutoStartBackend: triggers a start when enabled + autoStartBackend + a loopback endpoint', async () => {
  const ready = await startReadyServer();
  try {
    let imagePresentCalls = 0;
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      imagePresent: async () => ((imagePresentCalls += 1), true),
      containerState: async () => 'running',
    });
    await saveConfig(
      baseConfig({
        enabled: true,
        endpoint: `${ready.baseUrl}/v1`,
        sttModel: '',
        autoStartBackend: true,
      }),
    );

    maybeAutoStartBackend();
    await waitFor(() => imagePresentCalls > 0);
    await waitFor(() => !isBackendStartInFlightForTest());
    assert.ok(imagePresentCalls >= 2, 'the flow ran to completion (image step + terminal status)');
  } finally {
    await ready.close();
  }
});

// --- Task 3: two-container backend — target parameterization -------------

test('GET /api/voice/backend reports both targets when ttsEndpoint is set', async () => {
  const containerNames: string[] = [];
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async (name) => {
      containerNames.push(name);
      return 'absent';
    },
    imagePresent: async () => false,
  });
  await saveConfig(
    baseConfig({
      enabled: true,
      endpoint: 'http://127.0.0.1:9/v1',
      sttModel: 'stt-x',
      ttsEndpoint: 'http://127.0.0.1:10/v1',
      ttsModel: 'tts-1',
    }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    stt: { port: number | null; container: string };
    tts: { port: number | null; container: string } | null;
  };
  assert.equal(body.stt.port, 9);
  assert.equal(body.tts?.port, 10);
  // Both container names were queried.
  assert.ok(containerNames.includes('caretaker-speaches'));
  assert.ok(containerNames.includes('caretaker-edge-tts'));
});

test('GET /api/voice/backend reports tts: null with no ttsEndpoint', async () => {
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => 'absent',
    imagePresent: async () => false,
  });
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x' }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend');
  const body = (await res.json()) as { tts: null };
  assert.equal(body.tts, null);
});

test('start?target=tts runs the edge-tts image and skips model install', async () => {
  const ready = await startReadyServer();
  const ttsReady = await startReadyServer();
  try {
    const runArgs: string[] = [];
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      imagePresent: async () => true,
      containerState: async () => 'running',
      runContainer: async (args) => {
        runArgs.push(...args);
      },
    });
    await saveConfig(
      baseConfig({
        enabled: true,
        endpoint: `${ready.baseUrl}/v1`,
        sttModel: 'stt-x',
        ttsEndpoint: `${ttsReady.baseUrl}/v1`,
        ttsModel: 'tts-1',
      }),
    );

    const ttsPort = loopbackPort(`${ttsReady.baseUrl}/v1`);
    assert.ok(ttsPort != null);

    const app = new Hono();
    registerVoiceBackend(app);
    const res = await app.request('/api/voice/backend/start?target=tts', { method: 'POST' });
    assert.equal(res.status, 200);
    const lines = (await res.text())
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as StartProgress);
    assert.equal(lines.at(-1)?.step, 'done');

    // The run args include the edge-tts container name and image, the
    // TTS port, the auth-off env, and NO HuggingFace volume.
    assert.ok(runArgs.includes('caretaker-edge-tts'), 'uses the edge-tts container name');
    assert.ok(runArgs.includes('travisvn/openai-edge-tts:latest'), 'uses the edge-tts image');
    assert.ok(
      runArgs.some((a) => a === `127.0.0.1:${ttsPort}:5050`),
      'publishes on the TTS port → internal 5050',
    );
    assert.ok(runArgs.includes('REQUIRE_API_KEY=False'), 'disables auth');
    assert.ok(!runArgs.includes('caretaker-hf-hub-cache'), 'no HF volume for edge-tts');

    // edge-tts has no model-install step: no 'models' step in the progress.
    assert.ok(
      !lines.some((p) => p.step === 'models'),
      'edge-tts skips the model-install step',
    );
  } finally {
    await ready.close();
    await ttsReady.close();
    // Give the Hono stream's finally block a tick to release the guard.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await waitFor(() => !isBackendStartInFlightForTest('tts'));
  }
});

test('start?target=tts is not blocked by an in-flight stt start (per-target guard)', async () => {
  const sttReady = await startReadyServer();
  const ttsReady = await startReadyServer();
  try {
    let releaseSttPull: () => void = () => {};
    const sttGate = new Promise<void>((resolve) => {
      releaseSttPull = resolve;
    });
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      imagePresent: async (image) => image !== 'ghcr.io/speaches-ai/speaches:latest-cpu', // stt not present → pull, tts present
      async *pullImage(image) {
        if (image === 'ghcr.io/speaches-ai/speaches:latest-cpu') {
          yield 'pulling stt';
          await sttGate;
        }
      },
      containerState: async () => 'running',
    });
    await saveConfig(
      baseConfig({
        enabled: true,
        endpoint: `${sttReady.baseUrl}/v1`,
        sttModel: '',
        ttsEndpoint: `${ttsReady.baseUrl}/v1`,
        ttsModel: 'tts-1',
      }),
    );

    const app = new Hono();
    registerVoiceBackend(app);

    // Start the STT pull (blocks on the gate).
    const sttDrain = app.request('/api/voice/backend/start', { method: 'POST' }).then((r) => r.text());
    await waitFor(() => isBackendStartInFlightForTest('stt'));

    // Start the TTS backend — it should proceed even though the STT start is in flight.
    const ttsRes = await app.request('/api/voice/backend/start?target=tts', { method: 'POST' });
    assert.equal(ttsRes.status, 200);
    const ttsLines = (await ttsRes.text())
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as StartProgress);
    assert.equal(ttsLines.at(-1)?.step, 'done', 'tts start completed while stt was in flight');

    // Clean up the gated STT start.
    releaseSttPull();
    await sttDrain;
    // Give the Hono stream's finally block a tick to release the guard.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await waitFor(() => !isBackendStartInFlightForTest('stt'));
    await waitFor(() => !isBackendStartInFlightForTest('tts'));
  } finally {
    await sttReady.close();
    await ttsReady.close();
  }
});

test('POST /api/voice/backend/stop?target=tts acts on the tts container', async () => {
  const calls: string[] = [];
  setVoiceBackendDepsForTest({
    dockerInfo: async () => ({ ok: true }),
    containerState: async () => 'absent',
    imagePresent: async () => false,
    stopContainer: async (name) => void calls.push(name),
  });
  await saveConfig(
    baseConfig({
      enabled: true,
      endpoint: 'http://127.0.0.1:9/v1',
      sttModel: 'stt-x',
      ttsEndpoint: 'http://127.0.0.1:10/v1',
      ttsModel: 'tts-1',
    }),
  );

  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/stop?target=tts', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['caretaker-edge-tts']);
});

test('POST /api/voice/backend/start?target=tts returns 400 when ttsEndpoint is unset', async () => {
  await saveConfig(
    baseConfig({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', sttModel: 'stt-x', ttsModel: 'tts-1' }),
  );
  const app = new Hono();
  registerVoiceBackend(app);
  const res = await app.request('/api/voice/backend/start?target=tts', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no separate tts endpoint/i);
});

test('POST /api/voice/backend/delete?target=tts answers 409 while tts start is in flight', async () => {
  const ttsReady = await startReadyServer();
  let releasePull: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releasePull = resolve;
  });
  let startDrained: Promise<string> | null = null;
  try {
    let removeCalls = 0;
    setVoiceBackendDepsForTest({
      dockerInfo: async () => ({ ok: true }),
      containerState: async () => 'absent',
      imagePresent: async () => false,
      async *pullImage() {
        yield 'pulling';
        await gate;
      },
      runContainer: async () => {},
      removeContainer: async () => {
        removeCalls += 1;
      },
    });
    await saveConfig(
      baseConfig({
        enabled: true,
        endpoint: 'http://127.0.0.1:9/v1',
        sttModel: 'stt-x',
        ttsEndpoint: `${ttsReady.baseUrl}/v1`,
        ttsModel: 'tts-1',
      }),
    );

    const app = new Hono();
    registerVoiceBackend(app);
    startDrained = Promise.resolve(
      app.request('/api/voice/backend/start?target=tts', { method: 'POST' }),
    ).then((r) => r.text());
    await waitFor(() => isBackendStartInFlightForTest('tts'));

    const res = await app.request('/api/voice/backend/delete?target=tts', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(removeCalls, 0);
  } finally {
    releasePull();
    if (startDrained) await startDrained;
    // Give the Hono stream's finally block a tick to release the guard.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await waitFor(() => !isBackendStartInFlightForTest('tts'));
    await ttsReady.close();
  }
});
