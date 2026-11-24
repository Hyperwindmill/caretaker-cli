import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = mkdtempSync(path.join(tmpdir(), 'ct-server-'));
process.env.CARETAKER_HOME = tempHome;

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.js';

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
