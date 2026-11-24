import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = mkdtempSync(path.join(tmpdir(), 'ct-orch-e2e-'));
process.env.CARETAKER_HOME = tempHome;

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.js';
import { createDemoOrchestrator } from '../orchestrator_demo.js';
import { addTaskMessage } from '../../store/db.js';
import {
  loadOrchestrator,
  saveLedger,
  saveOrchestrator,
  type OrchestratorPolicy,
} from '../../store/orchestrator.js';
import {
  orchestratorStatus,
  resetOrchestrator,
  resetOrchestratorForTests,
  resolvePending,
  runCycle,
  stopOrchestrator,
} from './orchestrator.js';

after(() => {
  stopOrchestrator();
  rmSync(tempHome, { recursive: true, force: true });
});

async function setupConfig(policy: OrchestratorPolicy, token = 't'): Promise<string> {
  const cfg = await loadOrchestrator();
  cfg.enabled = true;
  cfg.name = 'E2E Workstation';
  cfg.endpoint = 'http://127.0.0.1:4000';
  cfg.token = token;
  cfg.policy = policy;
  await saveOrchestrator(cfg);
  return cfg.instanceId;
}

describe('orchestrator e2e', () => {
  beforeEach(async () => {
    stopOrchestrator();
    resetOrchestratorForTests();
    await saveLedger([]);
  });

  test('register, then create a project and a task end to end', async () => {
    const app = createApp({ webPort: 0, host: '127.0.0.1' });
    const demo = createDemoOrchestrator({ token: 't', name: 'Demo' });
    const deps = {
      app,
      fetch: ((url, init) => demo.app.request(String(url), init)) as typeof fetch,
    };

    const instanceId = await setupConfig('auto');
    await runCycle(deps);
    assert.equal(demo.instances().length, 1);
    assert.equal(demo.instances()[0].instanceId, instanceId);
    assert.equal(demo.instances()[0].name, 'E2E Workstation');

    demo.enqueue(instanceId, {
      method: 'POST',
      path: '/api/projects',
      body: { id: 'e2e-proj', name: 'E2E Project' },
    });
    await runCycle(deps);
    await runCycle(deps);
    const projRes = demo.results(instanceId);
    assert.equal(projRes.length, 1);
    assert.equal(projRes[0].status, 200);

    const taskMsgId = demo.enqueue(instanceId, {
      method: 'POST',
      path: '/api/projects/e2e-proj/tasks',
      body: { title: 'Remote Task', objective: 'Do something' },
    });
    await runCycle(deps);
    await runCycle(deps);
    const taskResult = demo.results(instanceId).find((r) => r.id === taskMsgId);
    assert.ok(taskResult);
    assert.equal(taskResult.status, 200);
    const createdTaskId = (taskResult.body as any).task.id;
    assert.ok(createdTaskId);

    const listRes = await app.request('/api/projects/e2e-proj/tasks');
    assert.equal(listRes.status, 200);
    const tasks = (await listRes.json()) as any[];
    assert.ok(tasks.some((t) => t.id === createdTaskId));
  });

  test('an orchestrator reads a task thread in pages through the channel', async () => {
    const app = createApp({ webPort: 0, host: '127.0.0.1' });
    const demo = createDemoOrchestrator({ token: 't', name: 'Demo' });
    const deps = {
      app,
      fetch: ((url, init) => demo.app.request(String(url), init)) as typeof fetch,
    };
    const instanceId = await setupConfig('approve'); // GETs apply without approval
    for (let i = 1; i <= 3; i++) {
      await addTaskMessage({ taskId: 'paged-1', role: 'assistant', messageType: 'chat', content: `n${i}` });
    }

    const first = demo.enqueue(instanceId, { method: 'GET', path: '/api/tasks/paged-1/messages?limit=2' });
    await runCycle(deps);
    await runCycle(deps);
    const page1 = demo.results(instanceId).find((r) => r.id === first)!;
    assert.equal(page1.status, 200);
    assert.deepEqual((page1.body as any[]).map((m) => m.content), ['n1', 'n2']);

    const lastId = (page1.body as any[])[1].id;
    const second = demo.enqueue(instanceId, {
      method: 'GET',
      path: `/api/tasks/paged-1/messages?limit=2&after=${lastId}`,
    });
    await runCycle(deps);
    await runCycle(deps);
    const page2 = demo.results(instanceId).find((r) => r.id === second)!;
    assert.deepEqual((page2.body as any[]).map((m) => m.content), ['n3']);
  });

  test('a message the orchestrator keeps offering is applied once', async () => {
    const app = createApp({ webPort: 0, host: '127.0.0.1' });
    const demo = createDemoOrchestrator({ token: 't', name: 'Demo' });
    const deps = {
      app,
      fetch: ((url, init) => demo.app.request(String(url), init)) as typeof fetch,
    };

    const instanceId = await setupConfig('approve');
    await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'once-proj', name: 'Once' }),
    });

    const msgId = demo.enqueue(instanceId, {
      method: 'POST',
      path: '/api/projects/once-proj/tasks',
      body: { title: 'Only Once', objective: 'Deduped' },
    });

    await runCycle(deps);
    await runCycle(deps);
    await runCycle(deps);
    assert.equal(await resolvePending(app, msgId, 'approve'), 'ok');
    await runCycle(deps);

    const listRes = await app.request('/api/projects/once-proj/tasks');
    const tasks = (await listRes.json()) as any[];
    assert.equal(tasks.length, 1);
  });

  test('approve policy: nothing is created before the click; reject comes back as 403', async () => {
    const app = createApp({ webPort: 0, host: '127.0.0.1' });
    const demo = createDemoOrchestrator({ token: 't', name: 'Demo' });
    const deps = {
      app,
      fetch: ((url, init) => demo.app.request(String(url), init)) as typeof fetch,
    };

    const instanceId = await setupConfig('approve');
    const msgId = demo.enqueue(instanceId, {
      method: 'POST',
      path: '/api/projects',
      body: { id: 'rejected-proj', name: 'Rejected' },
    });

    await runCycle(deps);
    const before = (await (await app.request('/api/projects')).json()) as any[];
    assert.equal(before.some((p) => p.id === 'rejected-proj'), false);

    assert.equal(await resolvePending(app, msgId, 'reject'), 'ok');
    await runCycle(deps);

    const results = demo.results(instanceId);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, msgId);
    assert.equal(results[0].status, 403);

    const afterReject = (await (await app.request('/api/projects')).json()) as any[];
    assert.equal(afterReject.some((p) => p.id === 'rejected-proj'), false);
  });

  test('a disallowed path comes back 404 and leaves no trace', async () => {
    const app = createApp({ webPort: 0, host: '127.0.0.1' });
    const demo = createDemoOrchestrator({ token: 't', name: 'Demo' });
    const deps = {
      app,
      fetch: ((url, init) => demo.app.request(String(url), init)) as typeof fetch,
    };

    const instanceId = await setupConfig('auto');
    const m1 = demo.enqueue(instanceId, { method: 'GET', path: '/api/fs/list?path=/' });
    const m2 = demo.enqueue(instanceId, { method: 'POST', path: '/api/projects/../access/tokens' });

    await runCycle(deps);
    await runCycle(deps);
    const results = demo.results(instanceId);
    assert.equal(results.find((r) => r.id === m1)?.status, 404);
    assert.equal(results.find((r) => r.id === m2)?.status, 404);
  });

  test('a wrong token leaves the status in error and the app healthy', async () => {
    const app = createApp({ webPort: 0, host: '127.0.0.1' });
    const demo = createDemoOrchestrator({ token: 't', name: 'Demo' });
    const deps = {
      app,
      fetch: ((url, init) => demo.app.request(String(url), init)) as typeof fetch,
    };

    await setupConfig('auto', 'wrong');
    await runCycle(deps);
    assert.equal(orchestratorStatus().state, 'error');
    const res = await app.request('/api/projects');
    assert.equal(res.status, 200);
  });

  test('test connection returns the demo name and registers nothing', async () => {
    const demo = createDemoOrchestrator({ token: 't', name: 'Demo' });
    const fetchImpl = ((url, init) => demo.app.request(String(url), init)) as typeof fetch;
    const app = createApp({ webPort: 0, host: '127.0.0.1' }, fetchImpl);

    const res = await app.request('/api/orchestrator/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'http://127.0.0.1:4000', token: 't' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: 'Demo', protocol: 1 });
    assert.deepEqual(demo.instances(), []);
  });
});
