import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-update-routes-'));

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { registerUpdate, type UpdateDeps } from './update_routes.js';

const home = process.env.CARETAKER_HOME!;
const uiStateFile = path.join(home, 'ui-state.json');
const configFile = path.join(home, 'caretaker.json');
const URL_0380 = 'https://github.com/Hyperwindmill/caretaker-cli/releases/tag/v0.38.0';

beforeEach(() => {
  writeFileSync(configFile, JSON.stringify({ port: 3000, providers: [] }));
  writeFileSync(uiStateFile, '{}');
});

function makeApp(over: Partial<UpdateDeps> = {}) {
  const calls = { getLatest: 0, findCli: 0 };
  const deps: Partial<UpdateDeps> = {
    current: () => '0.37.0',
    getLatest: async () => {
      calls.getLatest++;
      return { version: '0.38.0', url: URL_0380 };
    },
    findCli: async () => {
      calls.findCli++;
      return '0.36.0';
    },
    runUpdate: async () => ({ ok: true, output: '' }),
    ...over,
  };
  const app = new Hono();
  registerUpdate(app, deps);
  return { app, calls };
}

const getStatus = async (app: Hono) => (await app.request('/api/update')).json() as Promise<any>;

test('GET /api/update: app and PATH CLI both behind', async () => {
  const { app } = makeApp();
  const s = await getStatus(app);
  assert.equal(s.current, '0.37.0');
  assert.equal(s.latest, '0.38.0');
  assert.equal(s.url, URL_0380);
  assert.equal(s.appOutdated, true);
  assert.equal(s.cliVersion, '0.36.0');
  assert.equal(s.cliOutdated, true);
});

test('GET /api/update: check failed → no latest, nothing outdated', async () => {
  const { app } = makeApp({ getLatest: async () => null });
  const s = await getStatus(app);
  assert.equal(s.latest, undefined);
  assert.equal(s.appOutdated, false);
  assert.equal(s.cliOutdated, false);
});

test('GET /api/update: no CLI on PATH → no cliVersion', async () => {
  const { app } = makeApp({ findCli: async () => null });
  const s = await getStatus(app);
  assert.equal(s.cliVersion, undefined);
  assert.equal(s.cliOutdated, false);
  assert.equal(s.appOutdated, true);
});

test('GET /api/update: updateCheck false → no network, no PATH scan', async () => {
  writeFileSync(configFile, JSON.stringify({ port: 3000, providers: [], updateCheck: false }));
  const { app, calls } = makeApp();
  const s = await getStatus(app);
  assert.deepEqual(calls, { getLatest: 0, findCli: 0 });
  assert.equal(s.current, '0.37.0');
  assert.equal(s.appOutdated, false);
  assert.equal(s.cliOutdated, false);
});

test('POST /api/update/dismiss keeps the other ui-state keys', async () => {
  writeFileSync(uiStateFile, JSON.stringify({ lastProjectId: 'p1' }));
  const { app } = makeApp();
  const res = await app.request('/api/update/dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.38.0' }),
  });
  assert.equal(res.status, 204);
  assert.deepEqual(JSON.parse(readFileSync(uiStateFile, 'utf8')), {
    lastProjectId: 'p1',
    dismissedUpdateVersion: '0.38.0',
  });
  assert.equal((await getStatus(app)).dismissedVersion, '0.38.0');
});

test('POST /api/update/dismiss without a version → 400', async () => {
  const { app } = makeApp();
  const res = await app.request('/api/update/dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 400);
});

test('POST /api/update/cli: npm failure is a 200 with ok false', async () => {
  const { app } = makeApp({ runUpdate: async () => ({ ok: false, output: 'EACCES' }) });
  const res = await app.request('/api/update/cli', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.ok, false);
  assert.equal(body.output, 'EACCES');
  assert.equal(body.cliOutdated, true);
});

test('POST /api/update/cli: re-reads the PATH CLI after npm', async () => {
  let cli = '0.36.0';
  const { app } = makeApp({
    findCli: async () => cli,
    runUpdate: async () => {
      cli = '0.38.0';
      return { ok: true, output: 'added 1 package' };
    },
  });
  const body = (await (await app.request('/api/update/cli', { method: 'POST' })).json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.cliVersion, '0.38.0');
  assert.equal(body.cliOutdated, false);
});

test('POST /api/update/cli: second click while running → 409', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { app } = makeApp({
    runUpdate: async () => {
      await gate;
      return { ok: true, output: '' };
    },
  });
  const first = app.request('/api/update/cli', { method: 'POST' });
  await new Promise((r) => setImmediate(r));
  const second = await app.request('/api/update/cli', { method: 'POST' });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
});
