import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-acpreg-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  platformKey,
  normalizeRegistry,
  fetchAcpRegistry,
  __setFetch,
  __resetFetch,
} from './registry.js';
import { dataDir } from '../store/json.js';

const RAW = {
  version: '1.0.0',
  agents: [
    {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '0.70.0',
      description: 'Claude Code over ACP',
      distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.70.0' } },
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      version: '0.56.0',
      description: '',
      distribution: { npx: { package: '@google/gemini-cli@0.56.0', args: ['--acp'] } },
    },
    {
      id: 'antigravity-acp',
      name: 'Google Antigravity',
      version: '1.0.0',
      description: 'Google agent',
      distribution: {
        binary: {
          'linux-x86_64': { archive: 'https://dl.example/agy-linux.zip', cmd: './agy_acp_server.par', args: ['--uid='] },
          'darwin-aarch64': { archive: 'https://dl.example/agy-mac.zip', cmd: './agy_acp_server.par' },
        },
      },
    },
    {
      id: 'kilo',
      name: 'Kilo',
      version: '7.4.23',
      description: 'both dists',
      distribution: {
        binary: { 'linux-x86_64': { archive: 'https://dl.example/kilo.tgz', cmd: './kilo', args: ['acp'] } },
        npx: { package: 'kilo@7.4.23', args: ['acp'] },
      },
    },
    { id: 'uv-agent', name: 'Uv', version: '1', description: '', distribution: { uvx: { package: 'uvpkg@1' } } },
  ],
};

afterEach(__resetFetch);

test('platformKey maps node platform/arch to registry keys', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux-x86_64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-aarch64');
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(platformKey('win32', 'x64'), 'windows-x86_64');
});

test('normalizeRegistry: npx prefixes -y, uvx plain, binary per platform, npx preferred over binary', () => {
  const list = normalizeRegistry(RAW, 'linux-x86_64');
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.deepEqual(byId['claude-acp'].dist, {
    kind: 'npx',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.70.0'],
  });
  assert.deepEqual(byId['gemini'].dist!.args, ['-y', '@google/gemini-cli@0.56.0', '--acp']);
  assert.deepEqual(byId['antigravity-acp'].dist, {
    kind: 'binary',
    archive: 'https://dl.example/agy-linux.zip',
    cmd: './agy_acp_server.par',
    args: ['--uid='],
  });
  assert.equal(byId['kilo'].dist!.kind, 'npx'); // npx preferred: no install needed
  assert.deepEqual(byId['uv-agent'].dist, { kind: 'uvx', command: 'uvx', args: ['uvpkg@1'] });
  // platform without a binary → dist null, entry kept
  const mac = normalizeRegistry(RAW, 'windows-aarch64');
  assert.equal(mac.find((p) => p.id === 'antigravity-acp')!.dist, null);
});

test('normalizeRegistry: selfLoadedContextFiles map for the majors', () => {
  const list = normalizeRegistry(RAW, 'linux-x86_64');
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.deepEqual(byId['claude-acp'].selfLoadedContextFiles, ['CLAUDE.md']);
  assert.deepEqual(byId['gemini'].selfLoadedContextFiles, ['GEMINI.md']);
  assert.deepEqual(byId['kilo'].selfLoadedContextFiles, []);
});

test('fetchAcpRegistry: fetches, caches atomically, serves fresh cache without network', async () => {
  let calls = 0;
  __setFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify(RAW), { status: 200 });
  });
  const t0 = Date.now();
  const first = await fetchAcpRegistry(t0);
  assert.ok(first.length >= 5);
  assert.equal(calls, 1);
  const cached = JSON.parse(await readFile(join(dataDir(), 'cache', 'acp-registry.json'), 'utf8'));
  assert.equal(cached.fetchedAt, t0);
  // within TTL → no second network call
  await fetchAcpRegistry(t0 + 60_000);
  assert.equal(calls, 1);
});

test('fetchAcpRegistry: stale cache is last-good when the network fails', async () => {
  await mkdir(join(dataDir(), 'cache'), { recursive: true });
  await writeFile(
    join(dataDir(), 'cache', 'acp-registry.json'),
    JSON.stringify({ fetchedAt: 0, raw: RAW }),
  );
  __setFetch(async () => {
    throw new Error('offline');
  });
  const list = await fetchAcpRegistry(Date.now()); // cache is way past TTL
  assert.ok(list.find((p) => p.id === 'claude-acp'));
});

test('fetchAcpRegistry: no cache and no network → typed error', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ct-acpreg2-'));
  const prev = process.env.CARETAKER_HOME;
  process.env.CARETAKER_HOME = home;
  __setFetch(async () => {
    throw new Error('offline');
  });
  await assert.rejects(() => fetchAcpRegistry(), /offline/);
  process.env.CARETAKER_HOME = prev;
});
