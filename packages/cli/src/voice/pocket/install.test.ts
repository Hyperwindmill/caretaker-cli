import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-voice-install-'));

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  __resetFetch, __setCatalogForTest, __setFetch, builtinVoiceStatus, bundleDir,
  deleteBuiltinStt, deleteBuiltinVoice, installBuiltinStt, installBuiltinVoice, runtimeDir, runtimeEntry, whisperDir,
} from './install.js';

function tarEntry(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h[156] = 48;
  h.write('ustar\0', 257);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tgz = (files: Record<string, string>) =>
  gzipSync(Buffer.concat([...Object.entries(files).map(([n, d]) => tarEntry(n, Buffer.from(d))), Buffer.alloc(1024)]));
const sha512 = (b: Buffer) => 'sha512-' + createHash('sha512').update(b).digest('base64');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const plat = `${process.platform}/${process.arch}`;
const nodeTgz = tgz({
  'package/package.json': '{}',
  'package/dist/index.js': 'x',
  'package/lib/index.ts': 'skip',
  [`package/bin/napi-v6/${plat}/onnxruntime_binding.node`]: 'bin',
  'package/bin/napi-v6/other/arch/onnxruntime_binding.node': 'other',
});
const commonTgz = tgz({ 'package/package.json': '{}', 'package/dist/cjs/index.js': 'c' });
const fileA = Buffer.from('alpha');
const fileB = Buffer.from('beta');
const fileC = Buffer.from('gamma');

let calls: string[] = [];
function setup(opts: { brokenBundle?: boolean; brokenRuntime?: boolean; missing?: string } = {}) {
  const files = (dir: string) => [
    { name: 'a.bin', sha256: sha256(fileA), bytes: fileA.length },
    { name: 'b.bin', sha256: opts.brokenBundle ? '0'.repeat(64) : sha256(fileB), bytes: fileB.length },
  ].map((f) => ({ ...f, name: f.name }));
  __setCatalogForTest({
    ortVersion: '9.9.9', revision: 'rev', baseUrl: 'https://hf.test/resolve',
    tarballs: {
      node: { url: 'https://npm.test/node.tgz', integrity: opts.brokenRuntime ? sha512(Buffer.from('no')) : sha512(nodeTgz) },
      common: { url: 'https://npm.test/common.tgz', integrity: sha512(commonTgz) },
    },
    languages: {
      italian: { code: 'it', dir: 'it', nativeVoice: 'alba', files: files('it') },
      french: { code: 'fr', dir: 'fr', nativeVoice: 'alba', files: [{ name: 'c.bin', sha256: sha256(fileC), bytes: fileC.length }] },
    } as any,
    whisper: {
      tiny: { repo: 'o/whisper-tiny', revision: 'wrev', files: [
        { name: 'onnx/enc.onnx', sha256: sha256(fileA), bytes: fileA.length },
        { name: 'vocab.json', sha256: sha256(fileB), bytes: fileB.length },
      ] },
      base: { repo: 'o/whisper-base', revision: 'wrev', files: [{ name: 'onnx/enc.onnx', sha256: sha256(fileC), bytes: fileC.length }] },
    } as any,
    whisperBaseUrl: 'https://hf.test',
  });
  __setFetch((async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (opts.missing && u.includes(opts.missing)) return new Response('nope', { status: 404 });
    const body: Buffer | undefined =
      u.endsWith('node.tgz') ? nodeTgz : u.endsWith('common.tgz') ? commonTgz
      : u.endsWith('a.bin') || u.endsWith('whisper-tiny/resolve/wrev/onnx/enc.onnx') ? fileA : u.endsWith('whisper-base/resolve/wrev/onnx/enc.onnx') ? fileC : u.endsWith('vocab.json') ? fileB : u.endsWith('a.bin') ? fileA : u.endsWith('b.bin') ? fileB : u.endsWith('c.bin') ? fileC : undefined;
    return body ? new Response(new Uint8Array(body)) : new Response('', { status: 404 });
  }) as typeof fetch);
}
const run = async (lang: any) => { const ev: any[] = []; for await (const e of installBuiltinVoice(lang)) ev.push(e); return ev; };

beforeEach(() => { calls = [] });
afterEach(async () => { __resetFetch(); const { rm } = await import('node:fs/promises'); await rm(path.join(process.env.CARETAKER_HOME!, 'voice'), { recursive: true, force: true }); });

test('installs runtime once and the bundle; second run downloads nothing', async () => {
  setup();
  const ev = await run('italian');
  assert.equal(ev.at(-1)!.step, 'done');
  assert.equal(calls.length, 4);
  assert.ok(existsSync(runtimeEntry()));
  assert.ok(existsSync(path.join(bundleDir('italian'), 'b.bin')));
  const before = calls.length;
  await run('italian');
  assert.equal(calls.length, before);
  const st = await builtinVoiceStatus();
  assert.equal(st.runtime.installed, true);
  assert.equal(st.languages.find((l) => l.id === 'italian')!.installed, true);
  assert.equal(st.languages.find((l) => l.id === 'french')!.installed, false);
});

test('keeps only the current platform binary from the runtime tarball', async () => {
  setup();
  await run('italian');
  const nm = path.join(runtimeDir(), 'node_modules', 'onnxruntime-node');
  assert.ok(existsSync(path.join(nm, 'bin', 'napi-v6', ...plat.split('/'), 'onnxruntime_binding.node')));
  assert.ok(!existsSync(path.join(nm, 'bin', 'napi-v6', 'other')));
  assert.ok(!existsSync(path.join(nm, 'lib')));
  assert.ok(existsSync(path.join(runtimeDir(), 'node_modules', 'onnxruntime-common', 'dist', 'cjs', 'index.js')));
});

test('sha256 mismatch on a bundle file fails with the file name and leaves no bundle dir', async () => {
  setup({ brokenBundle: true });
  const ev = await run('italian');
  const last: any = ev.at(-1);
  assert.equal(last.step, 'error');
  assert.match(last.message, /b\.bin/);
  assert.ok(!existsSync(bundleDir('italian')));
  assert.ok(!existsSync(bundleDir('italian') + `.tmp-${process.pid}`));
});

test('integrity mismatch on the runtime tarball fails and leaves no runtime dir', async () => {
  setup({ brokenRuntime: true });
  const last: any = (await run('italian')).at(-1);
  assert.equal(last.step, 'error');
  assert.match(last.message, /onnxruntime-node/);
  assert.ok(!existsSync(runtimeDir()));
  assert.ok(!existsSync(runtimeDir() + `.tmp-${process.pid}`));
});

test('HTTP 404 surfaces the status and URL', async () => {
  setup({ missing: 'a.bin' });
  const last: any = (await run('italian')).at(-1);
  assert.equal(last.step, 'error');
  assert.match(last.message, /404.*a\.bin/);
});

test('delete keeps a runtime that is loaded in-process', async () => {
  setup();
  await run('italian');
  await deleteBuiltinVoice('italian', { keepRuntime: true });
  assert.ok(!existsSync(bundleDir('italian')));
  assert.ok(existsSync(runtimeEntry()));
});

test('delete keeps the runtime while another bundle remains, removes it with the last', async () => {
  setup();
  await run('italian');
  await run('french');
  await deleteBuiltinVoice('italian');
  assert.ok(!existsSync(bundleDir('italian')));
  assert.ok(existsSync(runtimeEntry()));
  await deleteBuiltinVoice('french');
  assert.ok(!existsSync(runtimeDir()));
});

const runStt = async (size: any) => { const ev: any[] = []; for await (const e of installBuiltinStt(size)) ev.push(e); return ev; };

test('installs a Whisper model keeping onnx/, the runtime once, status lists stt', async () => {
  setup();
  const ev = await runStt('tiny');
  assert.equal(ev.at(-1)!.step, 'done');
  assert.ok(ev.some((e) => e.step === 'model'));
  assert.ok(whisperDir('tiny').endsWith(path.join('voice', 'whisper', 'tiny', 'wrev')));
  assert.ok(existsSync(path.join(whisperDir('tiny'), 'onnx', 'enc.onnx')));
  assert.ok(existsSync(path.join(whisperDir('tiny'), 'vocab.json')));
  assert.ok(existsSync(runtimeEntry()));
  const rt = calls.filter((u) => u.includes('npm.test')).length;
  assert.equal(rt, 2);
  await runStt('base');
  assert.equal(calls.filter((u) => u.includes('npm.test')).length, rt);
  const st = await builtinVoiceStatus();
  assert.deepEqual(st.stt.map((m) => [m.id, m.installed]), [['tiny', true], ['base', true]]);
});

test('Whisper sha mismatch names the file and leaves no model dir', async () => {
  setup({ missing: 'vocab.json' });
  const last: any = (await runStt('tiny')).at(-1);
  assert.equal(last.step, 'error');
  assert.match(last.message, /vocab\.json/);
  assert.ok(!existsSync(whisperDir('tiny')));
  assert.ok(!existsSync(whisperDir('tiny') + `.tmp-${process.pid}`));
});

test('runtime outlives the last Pocket bundle while a Whisper model remains, and the reverse', async () => {
  setup();
  await run('italian');
  await runStt('tiny');
  await deleteBuiltinVoice('italian');
  assert.ok(existsSync(runtimeEntry()));
  await run('italian');
  await deleteBuiltinStt('tiny');
  assert.ok(!existsSync(whisperDir('tiny')));
  assert.ok(existsSync(runtimeEntry()));
  await deleteBuiltinVoice('italian');
  assert.ok(!existsSync(runtimeDir()));
});

test('deleting the last Whisper model removes the runtime unless keepRuntime', async () => {
  setup();
  await runStt('tiny');
  await deleteBuiltinStt('tiny', { keepRuntime: true });
  assert.ok(existsSync(runtimeEntry()));
  await deleteBuiltinStt('tiny');
  assert.ok(!existsSync(runtimeDir()));
});
