import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-acpinst-'));

import { test, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { installAcpAgent, __setFetch, __resetFetch } from './install.js';
import { dataDir } from '../store/json.js';
import type { AcpAgentPreset } from '../types.js';

let archiveBytes: Buffer;
let archiveSha: string;

before(() => {
  const src = mkdtempSync(path.join(os.tmpdir(), 'ct-acpfix-'));
  mkdirSync(join(src, 'bin'), { recursive: true });
  writeFileSync(join(src, 'bin', 'fake-agent'), '#!/bin/sh\necho hi\n', { mode: 0o644 });
  const tarPath = join(src, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', src, 'bin']);
  archiveBytes = readFileSync(tarPath);
  archiveSha = createHash('sha256').update(archiveBytes).digest('hex');
});

const preset = (
  over: Partial<Extract<NonNullable<AcpAgentPreset['dist']>, { kind: 'binary' }>> = {},
): AcpAgentPreset => ({
  id: 'fake-agent',
  name: 'Fake',
  description: '',
  version: '1.2.3',
  dist: {
    kind: 'binary',
    archive: 'https://dl.example/fake.tar.gz',
    cmd: './bin/fake-agent',
    args: ['acp'],
    ...over,
  },
  selfLoadedContextFiles: [],
});

afterEach(__resetFetch);

test('downloads, verifies sha256, extracts, chmods, and is idempotent', async () => {
  let downloads = 0;
  __setFetch(async () => {
    downloads += 1;
    return new Response(new Uint8Array(archiveBytes), { status: 200 });
  });
  const lines: string[] = [];
  const installed = await installAcpAgent(preset({ sha256: archiveSha }), (l) => lines.push(l));
  const expectedCmd = join(dataDir(), 'acp', 'fake-agent', '1.2.3', 'bin', 'fake-agent');
  assert.equal(installed.command, expectedCmd);
  assert.deepEqual(installed.args, ['acp']);
  assert.ok(existsSync(expectedCmd));
  // executable bit set (POSIX)
  if (process.platform !== 'win32') {
    const mode = (await import('node:fs/promises')).stat(expectedCmd).then((s) => s.mode & 0o111);
    assert.notEqual(await mode, 0);
  }
  assert.ok(lines.some((l) => /downloading/.test(l)));
  // idempotent: second call short-circuits without a download
  await installAcpAgent(preset({ sha256: archiveSha }));
  assert.equal(downloads, 1);
});

test('sha256 mismatch fails and leaves nothing behind', async () => {
  __setFetch(async () => new Response(new Uint8Array(archiveBytes), { status: 200 }));
  const bad = preset({ sha256: '0'.repeat(64) });
  bad.id = 'bad-agent';
  await assert.rejects(() => installAcpAgent(bad), /sha256 mismatch/);
  assert.ok(!existsSync(join(dataDir(), 'acp', 'bad-agent')));
});

test('non-binary preset is rejected', async () => {
  const p = preset();
  p.dist = { kind: 'npx', command: 'npx', args: ['x'] };
  await assert.rejects(() => installAcpAgent(p), /no binary distribution/);
});

test('download failure surfaces the HTTP status', async () => {
  __setFetch(async () => new Response('nope', { status: 404 }));
  const p = preset();
  p.id = 'missing-agent';
  await assert.rejects(() => installAcpAgent(p), /HTTP 404/);
});
