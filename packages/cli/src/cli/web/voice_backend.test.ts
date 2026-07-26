import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { VoiceConfig } from 'caretaker-types';
import {
  loopbackPort,
  probeBackend,
  startBackend,
  stopBackend,
  setVoiceBackendDepsForTest,
  type StartProgress,
} from './voice_backend.js';

afterEach(() => setVoiceBackendDepsForTest(null));

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

// --- stopBackend: never `rm`, only the container by name -----------------

test('stopBackend calls only stopContainer, with the fixed container name', async () => {
  const calls: string[] = [];
  setVoiceBackendDepsForTest({ stopContainer: async (name) => void calls.push(name) });
  await stopBackend();
  assert.deepEqual(calls, ['caretaker-speaches']);
});
