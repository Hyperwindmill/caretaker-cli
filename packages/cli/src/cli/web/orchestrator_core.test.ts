import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = mkdtempSync(path.join(tmpdir(), 'ct-orch-core-'));
process.env.CARETAKER_HOME = tempHome;

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../../lib/encryption.js';
import type { LedgerRecord, OrchestratorConfig } from '../../store/orchestrator.js';
import {
  validateEndpoint,
  endpointUrl,
  clampPollSeconds,
  parseMessage,
  needsApproval,
  recoverLedger,
  trimLedger,
  mergeConfigSave,
  summarizeLedger,
  LEDGER_SIZE,
  isUndeliveredResult,
} from './orchestrator_core.js';

after(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('orchestrator_core', () => {
  test('validateEndpoint: https anywhere, http only on loopback', () => {
    assert.equal(validateEndpoint('https://orch.example.com/v1'), null);
    for (const ok of ['http://127.0.0.1:4000', 'http://localhost:4000/x', 'http://[::1]:4000']) {
      assert.equal(validateEndpoint(ok), null);
    }
    for (const bad of ['http://orch.example.com', 'ftp://x', 'not a url', 'https://user:pw@orch.example.com']) {
      assert.equal(typeof validateEndpoint(bad), 'string');
    }
  });

  test('endpointUrl keeps a path prefix and survives trailing slashes', () => {
    assert.equal(endpointUrl('https://h/v1/', 'register'), 'https://h/v1/register');
    assert.equal(endpointUrl('https://h', 'poll'), 'https://h/poll');
    assert.equal(endpointUrl('https://h/v1///', 'health'), 'https://h/v1/health');
  });

  test('clampPollSeconds', () => {
    assert.equal(clampPollSeconds(undefined), 15);
    assert.equal(clampPollSeconds('abc'), 15);
    assert.equal(clampPollSeconds(1), 5);
    assert.equal(clampPollSeconds(99999), 3600);
    assert.equal(clampPollSeconds('30'), 30);
  });

  test('parseMessage normalizes the path and refuses what it cannot answer', () => {
    assert.deepEqual(parseMessage({ id: 'm1', method: 'get', path: '/api/projects?x=1' }), {
      id: 'm1',
      method: 'GET',
      path: '/api/projects?x=1',
    });
    assert.equal((parseMessage({ id: 'm2', method: 'GET', path: '/api/projects/../orchestrator' }) as any).path, '/api/orchestrator');
    assert.equal((parseMessage({ id: 'm3', method: 'GET', path: '/api/projects/%2e%2e/access' }) as any).path, '/api/access');
    for (const p of ['//evil.example/api/projects', 'https://evil.example/api/projects', 'api/projects', '', 42]) {
      assert.ok('error' in (parseMessage({ id: 'm4', method: 'GET', path: p }) as any));
    }
    assert.ok('error' in (parseMessage({ id: 'm5', method: 'TRACE', path: '/api/projects' }) as any));
    for (const raw of [null, 'x', {}, { id: '' }, { id: 7, method: 'GET', path: '/api/projects' }]) {
      assert.equal(parseMessage(raw), null);
    }
  });

  test('needsApproval', () => {
    assert.equal(needsApproval('auto', 'POST'), false);
    assert.equal(needsApproval('approve', 'GET'), false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(needsApproval('approve', m), true);
    }
  });

  test('recoverLedger settles an interrupted apply as 500 and never as pending', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    const records: LedgerRecord[] = [
      { id: '1', method: 'POST', path: '/api/projects', body: encrypt('{"a":1}'), receivedAt: '2026-11-24T11:00:00.000Z', state: 'applying', delivered: false },
      { id: '2', method: 'POST', path: '/api/projects', body: encrypt('{"b":2}'), receivedAt: '2026-11-24T11:01:00.000Z', state: 'pending', delivered: false },
      { id: '3', method: 'GET', path: '/api/projects', receivedAt: '2026-11-24T11:02:00.000Z', state: 'done', result: { status: 200 }, resolvedAt: '2026-11-24T11:02:01.000Z', delivered: true },
    ];
    const recovered = recoverLedger(records, now);
    assert.equal(recovered[0].state, 'done');
    assert.equal(recovered[0].body, undefined);
    assert.equal(recovered[0].resolvedAt, now.toISOString());
    assert.equal(recovered[0].result?.status, 500);
    assert.equal(decrypt(recovered[0].result!.body!), '{"error":"Interrupted by a restart; outcome unknown."}');
    assert.deepEqual(recovered[1], records[1]);
    assert.deepEqual(recovered[2], records[2]);
  });

  test('trimLedger never drops pending, applying or undelivered records', () => {
    const records: LedgerRecord[] = [];
    for (let i = 0; i < 600; i++) {
      records.push({
        id: `d-${i}`,
        method: 'GET',
        path: '/api/projects',
        receivedAt: '2026-11-24T10:00:00.000Z',
        state: 'done',
        result: { status: 200 },
        resolvedAt: '2026-11-24T10:00:01.000Z',
        delivered: true,
      });
    }
    records.splice(5, 0, {
      id: 'p-1',
      method: 'POST',
      path: '/api/projects',
      receivedAt: '2026-11-24T10:00:00.000Z',
      state: 'pending',
      delivered: false,
    });
    records.splice(20, 0, {
      id: 'u-1',
      method: 'GET',
      path: '/api/projects',
      receivedAt: '2026-11-24T10:00:00.000Z',
      state: 'done',
      result: { status: 200 },
      delivered: false,
    });
    records.splice(50, 0, {
      id: 'p-2',
      method: 'POST',
      path: '/api/projects',
      receivedAt: '2026-11-24T10:00:00.000Z',
      state: 'pending',
      delivered: false,
    });
    records.splice(100, 0, {
      id: 'u-2',
      method: 'GET',
      path: '/api/projects',
      receivedAt: '2026-11-24T10:00:00.000Z',
      state: 'done',
      result: { status: 200 },
      delivered: false,
    });
    records.splice(200, 0, {
      id: 'p-3',
      method: 'POST',
      path: '/api/projects',
      receivedAt: '2026-11-24T10:00:00.000Z',
      state: 'applying',
      delivered: false,
    });

    const trimmed = trimLedger(records);
    assert.equal(trimmed.length, LEDGER_SIZE);
    const ids = new Set(trimmed.map((r) => r.id));
    for (const keep of ['p-1', 'p-2', 'p-3', 'u-1', 'u-2']) {
      assert.ok(ids.has(keep), `expected ${keep} to be kept`);
    }
    // 500 - 5 = 495 newest delivered records: d-105 .. d-599
    assert.ok(!ids.has('d-104'));
    assert.ok(ids.has('d-105'));
    assert.ok(ids.has('d-599'));
  });

  test('mergeConfigSave: blank token keeps the stored one on the same host', () => {
    const blob = encrypt('secret-token');
    const saved: OrchestratorConfig = {
      enabled: true,
      name: 'ws',
      endpoint: 'https://h/v1',
      token: blob,
      pollSeconds: 15,
      policy: 'approve',
      instanceId: 'uuid-1',
    };
    const res = mergeConfigSave(saved, {
      enabled: true,
      name: 'ws',
      endpoint: 'https://h/v2',
      token: '',
      pollSeconds: 20,
      policy: 'auto',
    });
    assert.ok('config' in res);
    assert.equal(res.config.token, blob);
    assert.equal(res.purgeLedger, false);
  });

  test('mergeConfigSave: a null token removes the stored one on the same host', () => {
    const saved: OrchestratorConfig = {
      enabled: true,
      name: 'ws',
      endpoint: 'https://h/v1',
      token: encrypt('secret-token'),
      pollSeconds: 15,
      policy: 'approve',
      instanceId: 'uuid-1',
    };
    const res = mergeConfigSave(saved, {
      enabled: true,
      name: 'ws',
      endpoint: 'https://h/v1',
      token: null,
      pollSeconds: 15,
      policy: 'approve',
    });
    assert.ok(!('error' in res));
    assert.equal(res.config.token, '');
    assert.equal(res.purgeLedger, false);
  });

  test('mergeConfigSave: a host change drops the stored token and purges the ledger', () => {
    const blob = encrypt('secret-token');
    const saved: OrchestratorConfig = {
      enabled: true,
      name: 'ws',
      endpoint: 'https://h/v1',
      token: blob,
      pollSeconds: 15,
      policy: 'approve',
      instanceId: 'uuid-1',
    };
    const res = mergeConfigSave(saved, {
      enabled: true,
      name: 'ws',
      endpoint: 'https://other/v1',
      token: '',
      pollSeconds: 15,
      policy: 'approve',
    });
    assert.ok('config' in res);
    assert.equal(res.config.token, '');
    assert.equal(res.purgeLedger, true);
  });

  test('mergeConfigSave: a typed token is taken as is; bad endpoint is an error; instanceId never changes', () => {
    const saved: OrchestratorConfig = {
      enabled: false,
      name: '',
      endpoint: 'https://h/v1',
      token: encrypt('old'),
      pollSeconds: 15,
      policy: 'approve',
      instanceId: 'fixed-uuid',
    };
    const bad = mergeConfigSave(saved, {
      enabled: true,
      name: 'n',
      endpoint: 'http://remote.example.com',
      token: 'new-tok',
      pollSeconds: 15,
      policy: 'approve',
    });
    assert.ok('error' in bad);

    const ok = mergeConfigSave(saved, {
      enabled: true,
      name: 'n',
      endpoint: 'https://other/v1',
      token: 'new-tok',
      pollSeconds: 2,
      policy: 'bogus',
    });
    assert.ok('config' in ok);
    assert.equal(ok.config.token, 'new-tok');
    assert.equal(ok.config.instanceId, 'fixed-uuid');
    assert.equal(ok.config.pollSeconds, 5);
    assert.equal(ok.config.policy, 'approve');
    assert.equal(ok.purgeLedger, true);
  });

  test('summarizeLedger: newest first, body only for pending, repositoryToken masked at any depth', () => {
    const records: LedgerRecord[] = [
      {
        id: '1',
        method: 'POST',
        path: '/api/projects',
        body: encrypt(JSON.stringify({ id: 'p1', repositoryToken: 'ghp_top' })),
        receivedAt: '2026-11-24T10:00:00.000Z',
        state: 'done',
        result: { status: 200, body: encrypt('{"ok":true}') },
        resolvedAt: '2026-11-24T10:00:01.000Z',
        delivered: false,
      },
      {
        id: '2',
        method: 'POST',
        path: '/api/projects',
        body: encrypt(JSON.stringify({ id: 'p2', nested: { repositoryToken: 'ghp_nested', items: [{ repositoryToken: 'ghp_arr' }] } })),
        receivedAt: '2026-11-24T10:01:00.000Z',
        state: 'pending',
        delivered: false,
      },
    ];
    const summaries = summarizeLedger(records);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].id, '2');
    assert.deepEqual(summaries[0].body, {
      id: 'p2',
      nested: { repositoryToken: '••••', items: [{ repositoryToken: '••••' }] },
    });
    assert.equal(summaries[1].id, '1');
    assert.equal(summaries[1].body, undefined);
    assert.equal(summaries[1].status, 200);
  });

  test('isUndeliveredResult: only a done, undelivered record with a result', () => {
    const base = { id: 'a', method: 'GET', path: '/api/projects', receivedAt: 't', delivered: false };
    const result = { status: 200, body: 'x' };
    assert.equal(isUndeliveredResult({ ...base, state: 'done', result }), true);
    assert.equal(isUndeliveredResult({ ...base, state: 'pending' }), false);
    assert.equal(isUndeliveredResult({ ...base, state: 'applying' }), false);
    assert.equal(isUndeliveredResult({ ...base, state: 'done', result, delivered: true }), false);
  });
});
