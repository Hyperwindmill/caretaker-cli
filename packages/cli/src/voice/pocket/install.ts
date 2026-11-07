// On-demand installer for the built-in voice: the ONNX runtime (npm registry tarballs,
// never a package dependency, never `postinstall`) and the per-language Pocket bundles
// (Hugging Face, pinned revision). Every install goes through a tmp sibling dir + rename
// and leaves nothing behind on failure.
//
// Runtime layout (what `runtimeEntry()` points into):
//   <runtimeDir>/node_modules/onnxruntime-node/{package.json, dist/, bin/napi-v6/<platform>/<arch>/}
//   <runtimeDir>/node_modules/onnxruntime-common/...
// so `require('onnxruntime-common')` from the binding resolves by plain node resolution.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { PronunciationEntry } from 'caretaker-types';
import { dataDir } from '../../store/json.js';
import { DEFAULT_PRONUNCIATION } from '../pronunciation.js';
import {
  ORT_TARBALLS,
  ORT_VERSION,
  POCKET_BASE_URL,
  POCKET_LANGUAGES,
  POCKET_REVISION,
  POCKET_VOICES,
  type PocketLanguage,
} from './catalog.js';

// Mirrors webview-ui/src/bridge.ts (the CLI cannot import the view's source).
export type BuiltinVoiceStatus = {
  runtime: { installed: boolean; version: string; loadError?: string };
  languages: Array<{ id: string; code: string; nativeVoice: string; installed: boolean; bytes: number }>;
  voices: string[];
  defaults: Record<string, PronunciationEntry[]>;
};
export type BuiltinInstallProgress =
  | { step: 'runtime' | 'bundle'; file: string; received: number; total: number }
  | { step: 'done'; status: BuiltinVoiceStatus }
  | { step: 'error'; message: string };

type Catalog = {
  languages: typeof POCKET_LANGUAGES;
  tarballs: typeof ORT_TARBALLS;
  ortVersion: string;
  revision: string;
  baseUrl: string;
};
const REAL_CATALOG: Catalog = {
  languages: POCKET_LANGUAGES,
  tarballs: ORT_TARBALLS,
  ortVersion: ORT_VERSION,
  revision: POCKET_REVISION,
  baseUrl: POCKET_BASE_URL,
};
let cat: Catalog = REAL_CATALOG;
export function __setCatalogForTest(c: Partial<Catalog>): void {
  cat = { ...REAL_CATALOG, ...c };
}
let doFetch: typeof fetch = (i, init) => fetch(i, init);
export function __setFetch(f: typeof fetch): void {
  doFetch = f;
}
export function __resetFetch(): void {
  doFetch = (i, init) => fetch(i, init);
  cat = REAL_CATALOG;
}

const runtimeRoot = () => join(dataDir(), 'voice', 'runtime', 'onnxruntime');
export function runtimeDir(): string {
  return join(runtimeRoot(), cat.ortVersion);
}
/** Absolute path of onnxruntime-node's entry file, for `createRequire(...)`. */
export function runtimeEntry(): string {
  return join(runtimeDir(), 'node_modules', 'onnxruntime-node', 'dist', 'index.js');
}
export function bundleDir(lang: PocketLanguage): string {
  return join(dataDir(), 'voice', 'pocket', cat.languages[lang].dir, cat.revision);
}

const tmpName = (p: string) => `${p}.tmp-${process.pid}`;

// ---------------------------------------------------------------- download

type Progress = { received: number; total: number };

/** Streams `url` to `dest`, verifying the digest. `expected` is a sha256 hex string or an
 *  npm `sha512-<base64>` integrity string. Removes `dest` and throws on any failure. */
async function* download(
  url: string,
  dest: string,
  expected: string,
  label: string,
  knownBytes: number,
): AsyncGenerator<Progress> {
  const [algo, want, enc] = expected.startsWith('sha512-')
    ? (['sha512', expected.slice(7), 'base64'] as const)
    : (['sha256', expected, 'hex'] as const);
  await mkdir(dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  const failed = new Promise<never>((_, rej) => out.once('error', rej));
  failed.catch(() => {});
  try {
    const res = await doFetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get('content-length')) || knownBytes;
    const hash = createHash(algo);
    let received = 0;
    let lastYield = 0;
    yield { received, total };
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await Promise.race([new Promise<void>((r) => out.once('drain', () => r())), failed]);
      if (received - lastYield >= 1 << 20) {
        lastYield = received;
        yield { received, total };
      }
    }
    await Promise.race([new Promise<void>((r) => out.end(r)), failed]);
    if (hash.digest(enc) !== want) throw new Error(`Integrity check failed for ${label}`);
    yield { received, total: received };
  } catch (e) {
    out.destroy();
    await rm(dest, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------- tar

/** Minimal ustar reader: extracts the regular files `accept` wants (names already stripped
 *  of the leading `package/`) under `dest`. Applies pax `path` and GNU long-name entries. */
async function untar(
  src: AsyncIterable<Buffer>,
  dest: string,
  accept: (rel: string) => boolean,
): Promise<void> {
  const it = src[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  const fill = async (n: number): Promise<boolean> => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = Buffer.concat([buf, r.value]);
    }
    return true;
  };
  const str = (b: Buffer, o: number, l: number) => {
    const s = b.subarray(o, o + l);
    const z = s.indexOf(0);
    return s.subarray(0, z < 0 ? l : z).toString('utf8');
  };
  const skip = async (n: number) => {
    while (n > 0) {
      if (!(await fill(1))) throw new Error('Truncated tar archive');
      const t = Math.min(n, buf.length);
      buf = buf.subarray(t);
      n -= t;
    }
  };
  const root = resolve(dest) + sep;
  let longName: string | null = null;
  for (;;) {
    if (!(await fill(512))) return;
    const h = buf.subarray(0, 512);
    buf = buf.subarray(512);
    if (h.every((x) => x === 0)) return;
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const pad = (512 - (size % 512)) % 512;
    if (type === 'x' || type === 'L') {
      if (!(await fill(size))) throw new Error('Truncated tar archive');
      const body = buf.subarray(0, size).toString('utf8');
      buf = buf.subarray(size);
      await skip(pad);
      if (type === 'L') longName = body.replace(/\0.*$/s, '');
      else {
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body);
        if (m) longName = m[1];
      }
      continue;
    }
    let name = longName ?? [str(h, 345, 155), str(h, 0, 100)].filter(Boolean).join('/');
    longName = null;
    name = name.replace(/^package\//, '');
    const wanted = (type === '0' || type === '7') && accept(name);
    if (!wanted) {
      await skip(size + pad);
      continue;
    }
    const target = resolve(dest, name);
    if (!target.startsWith(root)) throw new Error(`Unsafe path in archive: ${name}`);
    await mkdir(dirname(target), { recursive: true });
    const out = createWriteStream(target);
    const failed = new Promise<never>((_, rej) => out.once('error', rej));
    failed.catch(() => {});
    let left = size;
    while (left > 0) {
      if (!(await fill(1))) throw new Error('Truncated tar archive');
      const t = Math.min(left, buf.length);
      const chunk = buf.subarray(0, t);
      buf = buf.subarray(t);
      left -= t;
      if (!out.write(chunk)) await Promise.race([new Promise<void>((r) => out.once('drain', () => r())), failed]);
    }
    await Promise.race([new Promise<void>((r) => out.end(r)), failed]);
    await skip(pad);
  }
}

async function extractTgz(file: string, dest: string, accept: (rel: string) => boolean) {
  const gz = createReadStream(file).pipe(createGunzip());
  await untar(gz as unknown as AsyncIterable<Buffer>, dest, accept);
}

// ---------------------------------------------------------------- install

async function* installRuntime(): AsyncGenerator<BuiltinInstallProgress> {
  if (existsSync(runtimeEntry())) return;
  const dir = runtimeDir();
  const tmp = tmpName(dir);
  await rm(tmp, { recursive: true, force: true });
  try {
    const bin = `bin/napi-v6/${process.platform}/${process.arch}/`;
    const parts = [
      { key: 'node' as const, pkg: 'onnxruntime-node', accept: (r: string) => r === 'package.json' || r.startsWith('dist/') || r.startsWith(bin) },
      { key: 'common' as const, pkg: 'onnxruntime-common', accept: (r: string) => r === 'package.json' || r.startsWith('dist/') },
    ];
    for (const p of parts) {
      const t = cat.tarballs[p.key];
      const tgz = join(tmp, `${p.pkg}.tgz`);
      for await (const g of download(t.url, tgz, t.integrity, p.pkg, 0)) {
        yield { step: 'runtime', file: p.pkg, ...g };
      }
      await extractTgz(tgz, join(tmp, 'node_modules', p.pkg), p.accept);
      await rm(tgz, { force: true });
    }
    await mkdir(dirname(dir), { recursive: true });
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

async function* installBundle(lang: PocketLanguage): AsyncGenerator<BuiltinInstallProgress> {
  const dir = bundleDir(lang);
  if (existsSync(dir)) return;
  const spec = cat.languages[lang];
  const tmp = tmpName(dir);
  await rm(tmp, { recursive: true, force: true });
  try {
    for (const f of spec.files) {
      const url = `${cat.baseUrl}/${cat.revision}/${spec.dir}/${f.name}`;
      for await (const g of download(url, join(tmp, f.name), f.sha256, f.name, f.bytes)) {
        yield { step: 'bundle', file: f.name, ...g };
      }
    }
    await rename(tmp, dir);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

export async function* installBuiltinVoice(lang: PocketLanguage): AsyncGenerator<BuiltinInstallProgress> {
  try {
    if (!cat.languages[lang]) throw new Error(`Unknown language: ${lang}`);
    yield* installRuntime();
    yield* installBundle(lang);
    yield { step: 'done', status: await builtinVoiceStatus() };
  } catch (e) {
    yield { step: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

async function anyBundleInstalled(): Promise<boolean> {
  return (Object.keys(cat.languages) as PocketLanguage[]).some((l) => existsSync(bundleDir(l)));
}

/** Removes the language's bundle(s); removes the runtime too once no bundle remains,
 *  unless `keepRuntime` (the native binding is loaded in this process: Windows refuses
 *  to delete it, and a half-deleted runtime would break reinstalling). */
export async function deleteBuiltinVoice(lang: PocketLanguage, opts: { keepRuntime?: boolean } = {}): Promise<void> {
  await rm(dirname(bundleDir(lang)), { recursive: true, force: true });
  if (!opts.keepRuntime && !(await anyBundleInstalled())) await rm(runtimeRoot(), { recursive: true, force: true });
}

export async function builtinVoiceStatus(): Promise<BuiltinVoiceStatus> {
  const defaults: BuiltinVoiceStatus['defaults'] = {};
  for (const [code, entries] of Object.entries(DEFAULT_PRONUNCIATION)) {
    defaults[code] = entries.map((e) => ({ ...e }));
  }
  return {
    runtime: { installed: existsSync(runtimeEntry()), version: cat.ortVersion },
    languages: (Object.entries(cat.languages) as [PocketLanguage, (typeof POCKET_LANGUAGES)[PocketLanguage]][]).map(
      ([id, s]) => ({
        id,
        code: s.code,
        nativeVoice: s.nativeVoice,
        installed: existsSync(bundleDir(id)),
        bytes: s.files.reduce((n, f) => n + f.bytes, 0),
      }),
    ),
    voices: [...POCKET_VOICES],
    defaults,
  };
}
