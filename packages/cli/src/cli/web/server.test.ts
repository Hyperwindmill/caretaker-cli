import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = mkdtempSync(path.join(tmpdir(), 'ct-server-'));
process.env.CARETAKER_HOME = tempHome;

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.js';
import { addTaskMessage } from '../../store/db.js';

after(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('createApp', () => {
  test('createApp serves the project routes without binding a port', async () => {
    const app = createApp({ webPort: 0, host: '127.0.0.1' });
    const res = await app.request('/api/projects');
    assert.equal(res.status, 200);
  });
});

describe('GET /api/tasks/:id/messages paging', () => {
  const app = createApp({ webPort: 0, host: '127.0.0.1' });
  const get = async (query = '') => {
    const res = await app.request(`/api/tasks/acme-1/messages${query}`);
    return { status: res.status, body: (await res.json()) as any };
  };

  test('after + limit page through the thread oldest first, never mixing tasks', async () => {
    for (let i = 1; i <= 5; i++) {
      await addTaskMessage({ taskId: 'acme-1', role: 'assistant', messageType: 'chat', content: `m${i}` });
      if (i === 2) await addTaskMessage({ taskId: 'other-1', role: 'assistant', messageType: 'chat', content: 'x' });
    }

    const all = await get();
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map((m: any) => m.content), ['m1', 'm2', 'm3', 'm4', 'm5']);

    const pages: string[][] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await get(`?limit=2${cursor === undefined ? '' : `&after=${cursor}`}`);
      assert.equal(page.status, 200);
      if (page.body.length === 0) break;
      pages.push(page.body.map((m: any) => m.content));
      cursor = page.body[page.body.length - 1].id;
    }
    assert.deepEqual(pages, [['m1', 'm2'], ['m3', 'm4'], ['m5']]);

    const tail = await get(`?after=${all.body[1].id}`);
    assert.deepEqual(tail.body.map((m: any) => m.content), ['m3', 'm4', 'm5']);
  });

  test('malformed after or limit is a 400, not a silent full thread', async () => {
    for (const q of ['?after=abc', '?after=-1', '?after=1.5', '?limit=0', '?limit=501', '?limit=x']) {
      assert.equal((await get(q)).status, 400, q);
    }
  });
});
