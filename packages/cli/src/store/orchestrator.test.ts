import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = mkdtempSync(path.join(tmpdir(), 'ct-orch-store-'));
process.env.CARETAKER_HOME = tempHome;

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt } from '../lib/encryption.js';
import {
  orchestratorPath,
  orchestratorLedgerPath,
  loadOrchestrator,
  saveOrchestrator,
  loadLedger,
  saveLedger,
  type LedgerRecord,
} from './orchestrator.js';

after(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('store/orchestrator', () => {
  test('loadOrchestrator returns defaults with persistent instanceId and fresh object references', async () => {
    const first = await loadOrchestrator();
    assert.equal(first.enabled, false);
    assert.equal(first.name, '');
    assert.equal(first.endpoint, '');
    assert.equal(first.token, '');
    assert.equal(first.pollSeconds, 15);
    assert.equal(first.policy, 'approve');
    assert.match(first.instanceId, /^[0-9a-f-]{36}$/i);

    const second = await loadOrchestrator();
    assert.equal(second.instanceId, first.instanceId);
    assert.notEqual(second, first);
  });

  test('concurrent first loads agree on one instanceId, the one on disk', async () => {
    rmSync(orchestratorPath(), { force: true });
    const loads = await Promise.all(Array.from({ length: 5 }, () => loadOrchestrator()));
    const ids = new Set(loads.map((c) => c.instanceId));
    assert.equal(ids.size, 1);
    const onDisk = JSON.parse(readFileSync(orchestratorPath(), 'utf8')).instanceId;
    assert.equal(loads[0].instanceId, onDisk);
  });

  test('saveOrchestrator encrypts clear token on disk and decrypts on read', async () => {
    const cfg = await loadOrchestrator();
    cfg.enabled = true;
    cfg.endpoint = 'https://orch.example.com';
    cfg.token = 'my-clear-token-123';
    await saveOrchestrator(cfg);

    const raw = readFileSync(orchestratorPath(), 'utf8');
    assert.equal(raw.includes('my-clear-token-123'), false);

    const loaded = await loadOrchestrator();
    assert.equal(decrypt(loaded.token), 'my-clear-token-123');
  });

  test('loadLedger returns [] on missing or non-array file and round-trips records', async () => {
    assert.deepEqual(await loadLedger(), []);

    writeFileSync(orchestratorLedgerPath(), '{"not":"an array"}', 'utf8');
    assert.deepEqual(await loadLedger(), []);

    const records: LedgerRecord[] = [
      {
        id: 'm1',
        method: 'GET',
        path: '/api/projects',
        receivedAt: '2026-11-24T12:00:00.000Z',
        state: 'done',
        result: { status: 200 },
        resolvedAt: '2026-11-24T12:00:01.000Z',
        delivered: true,
      },
      {
        id: 'm2',
        method: 'POST',
        path: '/api/projects',
        receivedAt: '2026-11-24T12:01:00.000Z',
        state: 'pending',
        delivered: false,
      },
    ];
    await saveLedger(records);
    assert.deepEqual(await loadLedger(), records);
  });
});
