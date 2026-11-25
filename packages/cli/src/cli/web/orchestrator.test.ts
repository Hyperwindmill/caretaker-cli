import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = mkdtempSync(path.join(tmpdir(), 'ct-orch-client-'));
process.env.CARETAKER_HOME = tempHome;

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  loadLedger,
  loadOrchestrator,
  saveLedger,
  saveOrchestrator,
  type OrchestratorConfig,
} from '../../store/orchestrator.js';
import { MAX_BODY_BYTES } from './orchestrator_core.js';
import {
  applyMessage,
  runCycle,
  resolvePending,
  orchestratorStatus,
  resetOrchestrator,
  resetOrchestratorForTests,
  startOrchestrator,
  stopOrchestrator,
  registerOrchestrator,
  EARLY_POLL_MS,
} from './orchestrator.js';

after(() => {
  stopOrchestrator();
  rmSync(tempHome, { recursive: true, force: true });
});

async function seedConfig(overrides: Partial<OrchestratorConfig> = {}): Promise<OrchestratorConfig> {
  const base = await loadOrchestrator();
  const cfg: OrchestratorConfig = {
    ...base,
    enabled: true,
    name: 'ws',
    endpoint: 'https://orch.example.com/v1',
    token: 'tok-123',
    pollSeconds: 15,
    policy: 'auto',
    ...overrides,
  };
  await saveOrchestrator(cfg);
  return loadOrchestrator();
}

function makeStubApp(handler?: (reqPath: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { path: string; method: string; body?: string }[] = [];
  const app = {
    async request(reqPath: string, init?: RequestInit): Promise<Response> {
      calls.push({
        path: reqPath,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (handler) return handler(reqPath, init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return { app, calls };
}

function makeScriptedFetch(responses: Array<Response | Error>) {
  const requests: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      body,
    });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch to ${url}`);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('orchestrator client', () => {
  beforeEach(async () => {
    stopOrchestrator();
    resetOrchestratorForTests();
    await saveLedger([]);
  });

  test('disabled: no outbound call, state off', async () => {
    await seedConfig({ enabled: false });
    const { app } = makeStubApp();
    const { fetch, requests } = makeScriptedFetch([]);
    await runCycle({ app, fetch });
    assert.equal(requests.length, 0);
    assert.equal(orchestratorStatus().state, 'off');
  });

  test('enabled without endpoint or token: state error, no outbound call', async () => {
    await seedConfig({ enabled: true, endpoint: '', token: '' });
    const { app } = makeStubApp();
    const { fetch, requests } = makeScriptedFetch([]);
    await runCycle({ app, fetch });
    assert.equal(requests.length, 0);
    assert.equal(orchestratorStatus().state, 'error');
    assert.equal(orchestratorStatus().lastError, 'Endpoint and token are required.');

    await seedConfig({ enabled: true, endpoint: 'https://orch.example.com', token: '' });
    await runCycle({ app, fetch });
    assert.equal(requests.length, 0);
    assert.equal(orchestratorStatus().state, 'error');
    assert.equal(orchestratorStatus().lastError, 'Endpoint and token are required.');
  });

  test('registers once, then polls; the orchestrator name reaches the status', async () => {
    await seedConfig();
    const { app } = makeStubApp();
    const { fetch, requests } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Acme Orchestrator' }),
      jsonRes({ messages: [] }),
      jsonRes({ messages: [] }),
    ]);

    assert.equal(await runCycle({ app, fetch }), true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://orch.example.com/v1/register');
    assert.equal(requests[0].auth, 'Bearer tok-123');
    assert.equal(requests[1].url, 'https://orch.example.com/v1/poll');

    const st = orchestratorStatus();
    assert.equal(st.state, 'connected');
    assert.equal(st.orchestratorName, 'Acme Orchestrator');
    assert.ok(st.lastPollAt);

    await runCycle({ app, fetch });
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, 'https://orch.example.com/v1/poll');
  });

  test('auto policy: a POST is applied and its result rides the next poll, then is not resent', async () => {
    await seedConfig({ policy: 'auto' });
    const { app, calls } = makeStubApp(() => jsonRes({ created: true }, 200));
    const { fetch, requests } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [{ id: 'm1', method: 'POST', path: '/api/projects', body: { id: 'p1' } }] }),
      jsonRes({ messages: [] }),
      jsonRes({ messages: [] }),
    ]);

    await runCycle({ app, fetch });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/projects');

    await runCycle({ app, fetch });
    assert.deepEqual((requests[2].body as any).results, [
      { id: 'm1', status: 200, body: { created: true } },
    ]);

    await runCycle({ app, fetch });
    assert.deepEqual((requests[3].body as any).results, []);
  });

  test('a re-offered message id is applied once', async () => {
    await seedConfig({ policy: 'auto' });
    const { app, calls } = makeStubApp();
    const msg = { id: 'dup-1', method: 'GET', path: '/api/projects' };
    const { fetch } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [msg] }),
      jsonRes({ messages: [msg] }),
    ]);

    await runCycle({ app, fetch });
    await runCycle({ app, fetch });
    assert.equal(calls.length, 1);
  });

  test('approve policy: GET applied at once, POST held as pending; approve applies it; reject yields 403', async () => {
    await seedConfig({ policy: 'approve' });
    const { app, calls } = makeStubApp();
    const { fetch, requests } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({
        messages: [
          { id: 'g1', method: 'GET', path: '/api/projects' },
          { id: 'p1', method: 'POST', path: '/api/projects', body: { id: 'a' } },
          { id: 'p2', method: 'POST', path: '/api/projects', body: { id: 'b' } },
        ],
      }),
      jsonRes({ messages: [] }),
    ]);

    await runCycle({ app, fetch });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');

    assert.equal(await resolvePending(app, 'p1', 'approve'), 'ok');
    assert.equal(calls.length, 2);
    assert.equal(await resolvePending(app, 'p2', 'reject'), 'ok');
    assert.equal(calls.length, 2);

    await runCycle({ app, fetch });
    const results = (requests[2].body as any).results as any[];
    const byId = new Map(results.map((r) => [r.id, r]));
    assert.equal(byId.get('g1').status, 200);
    assert.equal(byId.get('p1').status, 200);
    assert.equal(byId.get('p2').status, 403);
    assert.deepEqual(byId.get('p2').body, { error: 'Rejected by the user.' });
  });

  test('switching approve -> auto leaves what is already pending in the inbox; only new messages auto-apply', async () => {
    await seedConfig({ policy: 'approve' });
    const { app, calls } = makeStubApp();
    const { fetch } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [{ id: 'old-p', method: 'POST', path: '/api/projects', body: { id: 'a' } }] }),
      jsonRes({ messages: [{ id: 'old-p', method: 'POST', path: '/api/projects', body: { id: 'a' } }, { id: 'new-p', method: 'POST', path: '/api/projects', body: { id: 'b' } }] }),
    ]);

    await runCycle({ app, fetch });
    assert.equal(calls.length, 0);

    await seedConfig({ policy: 'auto' });
    await runCycle({ app, fetch });
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].body!).id, 'b');

    const ledger = await loadLedger();
    assert.equal(ledger.find((r) => r.id === 'old-p')?.state, 'pending');
  });

  test('approving twice concurrently applies once and the second answers not_pending', async () => {
    await seedConfig({ policy: 'approve' });
    let resolveApp!: () => void;
    const gate = new Promise<void>((r) => { resolveApp = r; });
    const { app, calls } = makeStubApp(async () => {
      await gate;
      return jsonRes({ ok: true });
    });
    const { fetch } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [{ id: 'race-1', method: 'POST', path: '/api/projects', body: { id: 'a' } }] }),
    ]);

    await runCycle({ app, fetch });
    const p1 = resolvePending(app, 'race-1', 'approve');
    const p2 = resolvePending(app, 'race-1', 'approve');
    resolveApp();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual([r1, r2].sort(), ['not_pending', 'ok']);
    assert.equal(calls.length, 1);
  });

  test('an undocumented or path-tricked message gets 404 and the app is never called', async () => {
    await seedConfig({ policy: 'auto' });
    const { app, calls } = makeStubApp();
    const { fetch, requests } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({
        messages: [
          { id: 'bad-1', method: 'GET', path: '/api/fs/list' },
          { id: 'bad-2', method: 'GET', path: '/api/projects/../orchestrator' },
          { id: 'bad-3', method: 'GET', path: '/api/projects/%2e%2e/access' },
          { id: 'bad-4', method: 'GET', path: '//evil.example/api/projects' },
        ],
      }),
      jsonRes({ messages: [] }),
    ]);

    await runCycle({ app, fetch });
    assert.equal(calls.length, 0);

    await runCycle({ app, fetch });
    const results = (requests[2].body as any).results as any[];
    assert.equal(results.length, 4);
    assert.equal(results.find((r) => r.id === 'bad-1').status, 404);
    assert.equal(results.find((r) => r.id === 'bad-2').status, 404);
    assert.equal(results.find((r) => r.id === 'bad-3').status, 404);
    assert.equal(results.find((r) => r.id === 'bad-4').status, 400);
  });

  test('a message without id is dropped and reported in lastError', async () => {
    await seedConfig();
    const { app } = makeStubApp();
    const { fetch } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [{ method: 'GET', path: '/api/projects' }] }),
    ]);

    await runCycle({ app, fetch });
    assert.equal(orchestratorStatus().state, 'connected');
    assert.equal(orchestratorStatus().lastError, 'The orchestrator sent a message without an id.');
  });

  test('poll 401 drops the registration; the next cycle registers again', async () => {
    await seedConfig();
    const { app } = makeStubApp();
    const { fetch, requests } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ error: 'unknown' }, 401),
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [] }),
    ]);

    await runCycle({ app, fetch });
    assert.equal(orchestratorStatus().state, 'error');

    await runCycle({ app, fetch });
    assert.equal(requests[2].url, 'https://orch.example.com/v1/register');
    assert.equal(orchestratorStatus().state, 'connected');
  });

  test('a 200 HTML body, and messages not being an array, set lastError and apply nothing; the next cycle still runs', async () => {
    await seedConfig();
    const { app, calls } = makeStubApp();
    const { fetch } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      new Response('<html><body>Login</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      jsonRes({ messages: 'not-an-array' }),
      jsonRes({ messages: [{ id: 'ok-1', method: 'GET', path: '/api/projects' }] }),
    ]);

    await runCycle({ app, fetch });
    assert.equal(orchestratorStatus().state, 'error');
    assert.ok(orchestratorStatus().lastError);
    assert.equal(calls.length, 0);

    await runCycle({ app, fetch });
    assert.equal(orchestratorStatus().state, 'error');
    assert.ok(orchestratorStatus().lastError);
    assert.equal(calls.length, 0);

    await runCycle({ app, fetch });
    assert.equal(orchestratorStatus().state, 'connected');
    assert.equal(calls.length, 1);
  });

  test('fetch rejecting (network down) sets state error and keeps results undelivered', async () => {
    await seedConfig();
    const { app } = makeStubApp();
    const { fetch } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [{ id: 'm1', method: 'GET', path: '/api/projects' }] }),
      new Error('ECONNREFUSED'),
    ]);

    assert.equal(await runCycle({ app, fetch }), true);
    assert.equal(await runCycle({ app, fetch }), false);
    assert.equal(orchestratorStatus().state, 'error');
    assert.match(orchestratorStatus().lastError ?? '', /ECONNREFUSED/);

    const ledger = await loadLedger();
    assert.equal(ledger[0].delivered, false);
  });

  test('applyMessage: over-cap response -> 413; JSON parsed, non-JSON returned as text; an app that throws -> 500', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const { app: bigApp } = makeStubApp(() => new Response(big, { status: 200 }));
    const rBig = await applyMessage(bigApp, { id: '1', method: 'GET', path: '/api/projects' });
    assert.equal(rBig.status, 413);

    const { app: jsonApp } = makeStubApp(() => jsonRes({ a: 1 }, 201));
    const rJson = await applyMessage(jsonApp, { id: '2', method: 'GET', path: '/api/projects' });
    assert.equal(rJson.status, 201);
    assert.deepEqual(rJson.body, { a: 1 });

    const { app: textApp } = makeStubApp(() => new Response('plain text', { status: 200 }));
    const rText = await applyMessage(textApp, { id: '3', method: 'GET', path: '/api/projects' });
    assert.equal(rText.status, 200);
    assert.equal(rText.body, 'plain text');

    const { app: throwApp } = makeStubApp(() => { throw new Error('boom'); });
    const rThrow = await applyMessage(throwApp, { id: '4', method: 'GET', path: '/api/projects' });
    assert.equal(rThrow.status, 500);
    assert.deepEqual(rThrow.body, { error: 'boom' });
  });

  test('recovery: a ledger left with an applying record yields a 500 result and no second apply', async () => {
    await seedConfig({ policy: 'auto' });
    await saveLedger([
      {
        id: 'stuck-1',
        method: 'POST',
        path: '/api/projects',
        receivedAt: '2026-11-24T11:00:00.000Z',
        state: 'applying',
        delivered: false,
      },
    ]);
    const { app, calls } = makeStubApp();
    const { fetch, requests } = makeScriptedFetch([
      jsonRes({ ok: true, name: 'Orch' }),
      jsonRes({ messages: [{ id: 'stuck-1', method: 'POST', path: '/api/projects' }] }),
    ]);

    startOrchestrator(app, fetch);
    // Give the immediate first cycle a moment, then stop the loop cleanly
    await new Promise((r) => setTimeout(r, 50));
    stopOrchestrator();

    assert.equal(calls.length, 0);
    assert.equal(requests.length, 2);
    const results = (requests[1].body as any).results as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'stuck-1');
    assert.equal(results[0].status, 500);
  });

  test('a config save while an approved message is applying delivers its real result, not a 500', async () => {
    await seedConfig({ policy: 'approve' });
    await saveLedger([
      {
        id: 'm1',
        method: 'POST',
        path: '/api/projects',
        receivedAt: '2026-11-24T11:00:00.000Z',
        state: 'pending',
        delivered: false,
      },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app } = makeStubApp(async () => {
      await gate;
      return jsonRes({ ok: true });
    });
    const delivered: { id: string; status: number }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/register')) return jsonRes({ ok: true, name: 'Orch' });
      delivered.push(...(JSON.parse(String(init?.body)).results as { id: string; status: number }[]));
      return jsonRes({ messages: [] });
    }) as typeof fetch;

    await runCycle({ app, fetch: fetchImpl }); // first cycle: boot recovery done
    const approving = resolvePending(app, 'm1', 'approve');
    await new Promise((r) => setTimeout(r, 20));
    resetOrchestrator(); // what PUT /api/orchestrator does
    await runCycle({ app, fetch: fetchImpl });
    release();
    assert.equal(await approving, 'ok');
    await runCycle({ app, fetch: fetchImpl });

    assert.deepEqual(
      delivered.map((r) => [r.id, r.status]),
      [['m1', 200]],
    );
  });

  test('a cycle started under the old config files nothing after a save, and cycles never overlap', async () => {
    await seedConfig({ policy: 'auto', endpoint: 'https://old.example.com/v1' });
    const { app, calls } = makeStubApp();
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((r) => (releasePoll = r));
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/register')) return jsonRes({ ok: true, name: 'Orch' });
      if (url.startsWith('https://old.example.com')) {
        await pollGate;
        return jsonRes({ messages: [{ id: 'old-msg', method: 'POST', path: '/api/projects', body: {} }] });
      }
      return jsonRes({ messages: [] });
    }) as typeof fetch;

    const oldCycle = runCycle({ app, fetch: fetchImpl });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(urls, ['https://old.example.com/v1/register', 'https://old.example.com/v1/poll']);

    // A save switching orchestrator, in the order PUT /api/orchestrator does it.
    resetOrchestrator();
    await seedConfig({ policy: 'auto', endpoint: 'https://new.example.com/v1' });
    await saveLedger([]);
    const newCycle = runCycle({ app, fetch: fetchImpl });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(urls.length, 2, 'the new cycle waits for the old one');

    releasePoll();
    await oldCycle;
    await newCycle;

    assert.equal(calls.length, 0, 'the old orchestrator message was not applied');
    assert.deepEqual(await loadLedger(), []);
    assert.deepEqual(urls.slice(2), ['https://new.example.com/v1/register', 'https://new.example.com/v1/poll']);
    assert.equal(orchestratorStatus().state, 'connected');
  });

  test('routes: GET never returns the token; hasToken reflects it', async () => {
    await seedConfig({ token: 'secret-abc' });
    const app = new Hono();
    registerOrchestrator(app);
    const res = await app.request('/api/orchestrator');
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.config.hasToken, true);
    assert.equal(body.config.token, undefined);
    assert.equal(JSON.stringify(body).includes('secret-abc'), false);
  });

  test('routes: PUT rejects http on a non-loopback host with 400', async () => {
    await seedConfig();
    const app = new Hono();
    registerOrchestrator(app);
    const res = await app.request('/api/orchestrator', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        name: 'ws',
        endpoint: 'http://remote.example.com/v1',
        token: 't',
        pollSeconds: 15,
        policy: 'approve',
      }),
    });
    assert.equal(res.status, 400);
    stopOrchestrator();
  });

  test('routes: PUT with a changed host and no token clears the token and the ledger', async () => {
    await seedConfig({ endpoint: 'https://a.example.com/v1', token: 'tok-a', enabled: false });
    await saveLedger([
      {
        id: 'old-1',
        method: 'GET',
        path: '/api/projects',
        receivedAt: '2026-11-24T11:00:00.000Z',
        state: 'done',
        result: { status: 200 },
        delivered: true,
      },
    ]);
    const app = new Hono();
    registerOrchestrator(app);
    const res = await app.request('/api/orchestrator', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        name: 'ws',
        endpoint: 'https://b.example.com/v1',
        token: '',
        pollSeconds: 15,
        policy: 'approve',
      }),
    });
    stopOrchestrator();
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.config.hasToken, false);
    assert.deepEqual(body.messages, []);
  });

  test('routes: test connection reports the orchestrator name; protocol 2 is a failure; never calls register', async () => {
    await seedConfig();
    const { fetch, requests } = makeScriptedFetch([
      jsonRes({ ok: true, protocol: 1, name: 'Demo' }),
      jsonRes({ ok: true, protocol: 2, name: 'Future' }),
    ]);
    const app = new Hono();
    registerOrchestrator(app, fetch);

    const r1 = await app.request('/api/orchestrator/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://orch.example.com/v1', token: 't1' }),
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, name: 'Demo', protocol: 1 });

    const r2 = await app.request('/api/orchestrator/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://orch.example.com/v1', token: 't1' }),
    });
    assert.equal(r2.status, 200);
    const b2 = (await r2.json()) as any;
    assert.equal(b2.ok, false);
    assert.match(b2.error, /2/);
    assert.match(b2.error, /1/);

    assert.equal(requests.every((r) => r.url.endsWith('/health')), true);
  });

  test('routes: approve/reject 404 unknown id, 409 not pending', async () => {
    await seedConfig();
    await saveLedger([
      {
        id: 'done-1',
        method: 'GET',
        path: '/api/projects',
        receivedAt: '2026-11-24T11:00:00.000Z',
        state: 'done',
        result: { status: 200 },
        delivered: true,
      },
    ]);
    const app = new Hono();
    registerOrchestrator(app);

    const r404 = await app.request('/api/orchestrator/messages/missing/approve', { method: 'POST' });
    assert.equal(r404.status, 404);

    const r409 = await app.request('/api/orchestrator/messages/done-1/reject', { method: 'POST' });
    assert.equal(r409.status, 409);
  });
});

describe('orchestrator loop cadence', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const getMsg = (id: string) => ({ id, method: 'GET', path: '/api/projects' });
  const postMsg = (id: string) => ({ id, method: 'POST', path: '/api/projects', body: { id } });

  /** Fetch stub: /register ok, /poll answered by `onPoll(n, body)` (n = 1-based). */
  function loopFetch(onPoll: (n: number, body: any) => Response | Promise<Response>) {
    const polls: any[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/register')) return jsonRes({ ok: true, name: 'Orch' });
      const body = JSON.parse(String(init?.body));
      polls.push(body);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await onPoll(polls.length, body);
      } finally {
        inFlight--;
      }
    }) as typeof fetch;
    return { fetch: fetchImpl, polls, maxInFlight: () => maxInFlight };
  }

  async function waitFor(cond: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(10);
    assert.ok(cond(), 'condition not met in time');
  }

  beforeEach(async () => {
    stopOrchestrator();
    resetOrchestratorForTests();
    await saveLedger([]);
  });

  test('early poll delivers the result at once, then returns to the interval', async () => {
    await seedConfig({ policy: 'auto', pollSeconds: 3600 });
    const { app } = makeStubApp();
    const f = loopFetch((n) => jsonRes({ messages: n === 1 ? [getMsg('g1')] : [] }));
    startOrchestrator(app, f.fetch);
    await sleep(EARLY_POLL_MS * 4);
    assert.equal(f.polls.length, 2);
    assert.equal(f.polls[1].results.length, 1);
    assert.equal(f.polls[1].results[0].id, 'g1');
    await sleep(EARLY_POLL_MS * 4);
    assert.equal(f.polls.length, 2);
    stopOrchestrator();
  });

  test('a message left pending never triggers the early poll', async () => {
    await seedConfig({ policy: 'approve', pollSeconds: 3600 });
    const { app } = makeStubApp();
    const f = loopFetch((n) => jsonRes({ messages: n === 1 ? [postMsg('p1')] : [] }));
    startOrchestrator(app, f.fetch);
    await sleep(EARLY_POLL_MS * 4);
    assert.equal(f.polls.length, 1);
    assert.equal((await loadLedger())[0].state, 'pending');
    stopOrchestrator();
  });

  test('a failed cycle waits the interval even with results waiting', async () => {
    for (const fail of [() => { throw new Error('down'); }, () => jsonRes({ error: 'x' }, 500)]) {
      stopOrchestrator();
      resetOrchestratorForTests();
      await saveLedger([]);
      await seedConfig({ policy: 'auto', pollSeconds: 3600 });
      const { app } = makeStubApp();
      const f = loopFetch((n) => (n === 1 ? jsonRes({ messages: [getMsg('g1')] }) : fail()));
      startOrchestrator(app, f.fetch);
      await sleep(EARLY_POLL_MS * 4);
      assert.equal(f.polls.length, 2); // the early poll, which failed; no third
      assert.equal(orchestratorStatus().state, 'error');
      assert.equal((await loadLedger())[0].delivered, false);
      stopOrchestrator();
    }
  });

  test('approve and reject bring the next poll forward', async () => {
    await seedConfig({ policy: 'approve', pollSeconds: 3600 });
    const { app } = makeStubApp();
    const f = loopFetch((n) => jsonRes({ messages: n === 1 ? [postMsg('p1'), postMsg('p2')] : [] }));
    startOrchestrator(app, f.fetch);
    await sleep(EARLY_POLL_MS * 2);
    assert.equal(f.polls.length, 1);

    assert.equal(await resolvePending(app, 'p1', 'approve'), 'ok');
    await sleep(EARLY_POLL_MS * 4);
    assert.equal(f.polls.length, 2);
    assert.deepEqual(f.polls[1].results.map((r: any) => [r.id, r.status]), [['p1', 200]]);

    assert.equal(await resolvePending(app, 'p2', 'reject'), 'ok');
    await sleep(EARLY_POLL_MS * 4);
    assert.equal(f.polls.length, 3);
    assert.deepEqual(f.polls[2].results.map((r: any) => [r.id, r.status]), [['p2', 403]]);
    stopOrchestrator();
  });

  test('a wake during a running cycle sets the flag only: a follow-up poll, never two at once', async () => {
    await seedConfig({ policy: 'approve', pollSeconds: 3600 });
    const { app } = makeStubApp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = loopFetch(async (n) => {
      if (n === 1) return jsonRes({ messages: [postMsg('p1'), postMsg('p2')] });
      if (n === 2) await gate;
      return jsonRes({ messages: [] });
    });
    startOrchestrator(app, f.fetch);
    await waitFor(() => f.polls.length === 1);
    await sleep(EARLY_POLL_MS / 5); // let cycle 1 reach its timer

    await resolvePending(app, 'p1', 'approve');
    await waitFor(() => f.polls.length === 2); // poll 2 is now held on the gate
    await resolvePending(app, 'p2', 'approve');
    release();
    await sleep(EARLY_POLL_MS * 4);

    assert.equal(f.polls.length, 3);
    assert.deepEqual(f.polls[2].results.map((r: any) => r.id), ['p2']);
    assert.equal(f.maxInFlight(), 1);
    stopOrchestrator();
  });

  test('stop retires the loop; a later wake schedules nothing', async () => {
    await seedConfig({ policy: 'auto', pollSeconds: 3600 });
    const { app } = makeStubApp();
    let seq = 0;
    const f = loopFetch(() => jsonRes({ messages: [getMsg(`g${++seq}`)] }));
    startOrchestrator(app, f.fetch);
    await sleep(EARLY_POLL_MS * 3);
    stopOrchestrator();
    resetOrchestrator();
    const count = f.polls.length;
    assert.ok(count >= 2);
    await sleep(EARLY_POLL_MS * 4);
    assert.equal(f.polls.length, count);

    await saveLedger([
      {
        id: 'late',
        method: 'POST',
        path: '/api/projects',
        receivedAt: '2026-11-25T11:00:00.000Z',
        state: 'pending',
        delivered: false,
      } as any,
    ]);
    assert.equal(await resolvePending(app, 'late', 'reject'), 'ok');
    await sleep(EARLY_POLL_MS * 4);
    assert.equal(f.polls.length, count);
  });
});
