import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isNewer,
  getLatestRelease,
  findPathCliVersion,
  runCliUpdate,
  __resetUpdateCacheForTests,
} from './update_check.js';

const RELEASES_URL = 'https://api.github.com/repos/Hyperwindmill/caretaker-cli/releases/latest';
const HTML_URL = 'https://github.com/Hyperwindmill/caretaker-cli/releases/tag/v0.38.0';

beforeEach(() => __resetUpdateCacheForTests());

test('isNewer compares X.Y.Z numerically and rejects odd tags', () => {
  assert.equal(isNewer('0.38.0', '0.37.0'), true);
  assert.equal(isNewer('v0.38.0', '0.37.0'), true);
  assert.equal(isNewer('0.37.0', '0.38.0'), false);
  assert.equal(isNewer('0.37.0', '0.37.0'), false);
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('0.38.0-beta.1', '0.37.0'), false);
  assert.equal(isNewer('nightly', '0.37.0'), false);
});

function stubFetch(respond: () => Promise<Response>) {
  const calls: string[] = [];
  const fn = (async (url: any) => {
    calls.push(String(url));
    return respond();
  }) as typeof fetch;
  return { fn, calls };
}

const ok = () =>
  Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.38.0', html_url: HTML_URL }), { status: 200 }));

test('getLatestRelease reads tag_name and html_url from the latest published release', async () => {
  const { fn, calls } = stubFetch(ok);
  assert.deepEqual(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), { version: '0.38.0', url: HTML_URL });
  assert.deepEqual(calls, [RELEASES_URL]);
});

test('fetch failure → null', async () => {
  const { fn } = stubFetch(() => Promise.reject(new Error('offline')));
  assert.equal(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), null);
});

test('non-2xx (rate limit) → null', async () => {
  const { fn } = stubFetch(() => Promise.resolve(new Response('{}', { status: 403 })));
  assert.equal(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), null);
});

test('body without tag_name → null', async () => {
  const { fn } = stubFetch(() => Promise.resolve(new Response(JSON.stringify({ html_url: HTML_URL }))));
  assert.equal(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), null);
});

test('success is cached for 6 h', async () => {
  const { fn, calls } = stubFetch(ok);
  await getLatestRelease({ fetchImpl: fn, now: () => 0 });
  await getLatestRelease({ fetchImpl: fn, now: () => 6 * 3600_000 });
  assert.equal(calls.length, 1);
  await getLatestRelease({ fetchImpl: fn, now: () => 6 * 3600_000 + 1 });
  assert.equal(calls.length, 2);
});

test('failure is cached for 15 min only', async () => {
  const { fn, calls } = stubFetch(() => Promise.reject(new Error('offline')));
  await getLatestRelease({ fetchImpl: fn, now: () => 0 });
  await getLatestRelease({ fetchImpl: fn, now: () => 15 * 60_000 });
  assert.equal(calls.length, 1);
  await getLatestRelease({ fetchImpl: fn, now: () => 15 * 60_000 + 1 });
  assert.equal(calls.length, 2);
});

// ── Task 2: PATH CLI version + npm update runner ──────────────────────────

const root = mkdtempSync(path.join(os.tmpdir(), 'ct-update-check-'));
const PKG = '@hyperwindmill/caretaker-cli';

/** nvm/npm layout: <prefix>/bin/caretaker-cli → ../lib/node_modules/<pkg>/dist/index.js */
function unixInstall(name: string, version: string, pkgName = PKG): string {
  const prefix = path.join(root, name);
  const pkgDir = path.join(prefix, 'lib', 'node_modules', ...pkgName.split('/'));
  mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version }));
  writeFileSync(path.join(pkgDir, 'dist', 'index.js'), '');
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  symlinkSync(path.join(pkgDir, 'dist', 'index.js'), path.join(prefix, 'bin', 'caretaker-cli'));
  return path.join(prefix, 'bin');
}

test('findPathCliVersion follows the bin symlink to the package', async () => {
  const bin = unixInstall('a', '0.36.0');
  assert.equal(await findPathCliVersion({ PATH: bin }, 'linux'), '0.36.0');
});

test('findPathCliVersion reads the Windows npm shim layout', async () => {
  const dir = path.join(root, 'win', 'npm');
  mkdirSync(path.join(dir, 'node_modules', '@hyperwindmill', 'caretaker-cli'), { recursive: true });
  writeFileSync(path.join(dir, 'caretaker-cli.cmd'), '@echo off');
  writeFileSync(
    path.join(dir, 'node_modules', '@hyperwindmill', 'caretaker-cli', 'package.json'),
    JSON.stringify({ name: PKG, version: '0.35.0' }),
  );
  assert.equal(await findPathCliVersion({ PATH: dir }, 'win32'), '0.35.0');
});

test('findPathCliVersion reads the package path out of a pnpm shell shim', async () => {
  const home = path.join(root, 'pnpm');
  const pkgDir = path.join(home, 'global', 'v11', 'abc', 'node_modules', '@hyperwindmill', 'caretaker-cli');
  mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version: '0.34.0' }));
  mkdirSync(path.join(home, 'bin'), { recursive: true });
  writeFileSync(
    path.join(home, 'bin', 'caretaker-cli'),
    '#!/bin/sh\nbasedir=$(dirname "$0")\n' +
      'exec node  "$basedir/../global/v11/abc/node_modules/@hyperwindmill/caretaker-cli/dist/index.js" "$@"\n',
  );
  assert.equal(await findPathCliVersion({ PATH: path.join(home, 'bin') }, 'linux'), '0.34.0');
});

test('findPathCliVersion: first PATH hit wins', async () => {
  const first = unixInstall('b1', '0.36.0');
  const second = unixInstall('b2', '0.37.0');
  assert.equal(await findPathCliVersion({ PATH: [first, second].join(path.delimiter) }, 'linux'), '0.36.0');
});

test('findPathCliVersion: foreign package or empty PATH → null', async () => {
  const bin = unixInstall('c', '1.0.0', 'other');
  assert.equal(await findPathCliVersion({ PATH: bin }, 'linux'), null);
  assert.equal(await findPathCliVersion({ PATH: '' }, 'linux'), null);
  assert.equal(await findPathCliVersion({}, 'linux'), null);
});

test('runCliUpdate runs the fixed npm command and reports success', async () => {
  const calls: any[] = [];
  const r = await runCliUpdate({
    exec: async (cmd, args, o) => {
      calls.push({ cmd, args, timeout: o.timeout });
      return { stdout: 'added 1 package', stderr: '' };
    },
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /added 1 package/);
  assert.deepEqual(calls, [
    { cmd: 'npm', args: ['i', '-g', '@hyperwindmill/caretaker-cli@latest'], timeout: 300_000 },
  ]);
});

test('runCliUpdate: EACCES → ok false with stderr', async () => {
  const r = await runCliUpdate({
    exec: async () => {
      throw Object.assign(new Error('Command failed'), { code: 'EACCES', stdout: '', stderr: 'permission denied' });
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.output, /permission denied/);
});

test('runCliUpdate: npm missing → ok false, readable', async () => {
  const r = await runCliUpdate({
    exec: async () => {
      throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.output, /npm not found/);
});

test('runCliUpdate keeps only the last 4000 chars of output', async () => {
  const r = await runCliUpdate({ exec: async () => ({ stdout: 'x'.repeat(5000) + 'END', stderr: '' }) });
  assert.equal(r.output.length, 4000);
  assert.ok(r.output.endsWith('END'));
});
