// Update notice: is a newer Caretaker release published? See
// docs/superpowers/specs/2026-11-25-update-notice-design.md.
// Never throws, never logs: a failed check is simply "no notice".

import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { commandEnv, probeShellEnv } from '../harness/tools/builtin/shell-env.js';

const PKG_NAME = '@hyperwindmill/caretaker-cli';
export type PackageManager = 'npm' | 'pnpm';

/** The CLI found on PATH: its version and the package manager that installed it. */
export interface InstalledCli {
  version: string;
  manager: PackageManager;
}

const UPDATE_ARGS: Record<PackageManager, string[]> = {
  npm: ['i', '-g', `${PKG_NAME}@latest`],
  pnpm: ['add', '-g', `${PKG_NAME}@latest`],
};

export function updateCommand(manager: PackageManager): string {
  return [manager, ...UPDATE_ARGS[manager]].join(' ');
}

/** Which manager owns an install, from where its package lives: pnpm's global
 *  dir (`…/pnpm/global/<v>/…`) or its `.pnpm` store; anything else is npm. */
export function managerForPath(pkgPath: string): PackageManager {
  // ponytail: a custom pnpm `global-dir` outside a `pnpm` folder reads as npm.
  return /[\\/](\.pnpm|pnpm[\\/]global)[\\/]/i.test(pkgPath) ? 'pnpm' : 'npm';
}
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 4000;

const RELEASES_URL = 'https://api.github.com/repos/Hyperwindmill/caretaker-cli/releases/latest';
const FETCH_TIMEOUT_MS = 5_000;
const SUCCESS_TTL_MS = 6 * 3600_000;
const FAILURE_TTL_MS = 15 * 60_000;

/** `X.Y.Z` with an optional leading `v`; anything else (pre-releases included) → null. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export interface LatestRelease {
  /** Without the leading `v`. */
  version: string;
  url: string;
}

let cache: { at: number; value: LatestRelease | null } | null = null;

export function __resetUpdateCacheForTests(): void {
  cache = null;
}

async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<LatestRelease | null> {
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'caretaker-cli' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null;
    const parsed = parseVersion(body.tag_name);
    return parsed ? { version: parsed.join('.'), url: body.html_url } : null;
  } catch {
    return null;
  }
}

/** Latest published release (drafts and pre-releases are invisible to the
 *  endpoint). Cached in-process: 6 h on success, 15 min on failure. */
export async function getLatestRelease(
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<LatestRelease | null> {
  const now = (opts.now ?? Date.now)();
  if (cache) {
    const ttl = cache.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (now - cache.at <= ttl) return cache.value;
  }
  const value = await fetchLatestRelease(opts.fetchImpl ?? fetch);
  cache = { at: now, value };
  return value;
}

async function readPkgVersion(file: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(file, 'utf8')) as { name?: unknown; version?: unknown };
    return pkg.name === PKG_NAME && typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** package.json named by a cmd-shim script (pnpm on every OS, npm's .cmd on
 *  Windows): the first path ending in node_modules/@hyperwindmill/caretaker-cli,
 *  with the shim's own-dir variable (`$basedir`, `%dp0%`, …) bound to `dir`. */
async function shimPackageJson(bin: string, dir: string): Promise<string | null> {
  let text: string;
  try {
    const buf = await readFile(bin);
    if (buf.length > 64 * 1024) return null; // a real binary, not a shim
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  // pnpm writes the absolute target as a comment; prefer it when present.
  const target = /^# cmd-shim-target=(.+)$/m.exec(text);
  if (target) return path.join(path.dirname(target[1].trim()), '..', 'package.json');
  // No `:`/`;` in the match: a NODE_PATH line (older pnpm) is a path *list*.
  const m = /([^"'\s:;]*node_modules[\\/]@hyperwindmill[\\/]caretaker-cli)[\\/]/.exec(text);
  if (!m) return null;
  const rel = m[1].replace(/^(\$basedir_win|\$basedir|%~?dp0%?)/, dir).replace(/\\/g, '/');
  return path.join(path.resolve(dir, rel), 'package.json');
}

/** The `caretaker-cli` the shell would run: version (from that install's
 *  package.json) and owning package manager. Never executes the binary:
 *  `caretaker-cli --version` would fire index.ts's boot side-effects. */
export async function findPathCli(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<InstalledCli | null> {
  const names = platform === 'win32' ? ['caretaker-cli.cmd', 'caretaker-cli'] : ['caretaker-cli'];
  // Windows spells it `Path`, and a copied env keeps the original casing.
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const bin = path.join(dir, name);
      try {
        await access(bin);
      } catch {
        continue;
      }
      const candidates: string[] = [];
      try {
        // npm/pnpm/nvm: the bin is a symlink to <pkg>/dist/index.js
        candidates.push(path.join(path.dirname(await realpath(bin)), '..', 'package.json'));
      } catch {
        /* dangling link — try the shim layout */
      }
      // pnpm / Windows npm: a script shim naming <…>/node_modules/<pkg>/dist/index.js
      const fromShim = await shimPackageJson(bin, dir);
      if (fromShim) candidates.push(fromShim);
      // Windows npm: <prefix>\caretaker-cli.cmd next to <prefix>\node_modules\<pkg>
      candidates.push(path.join(dir, 'node_modules', '@hyperwindmill', 'caretaker-cli', 'package.json'));
      for (const c of candidates) {
        const v = await readPkgVersion(c);
        if (v) return { version: v, manager: managerForPath(c) };
      }
      // ponytail: binary shims (volta) don't resolve to the package; no command shown for them.
      return null; // first PATH hit wins, like the shell
    }
  }
  return null;
}

export type ExecLike = (
  cmd: string,
  args: string[],
  o: { env: NodeJS.ProcessEnv; timeout: number; shell: boolean; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const tail = (s: string) => s.slice(-OUTPUT_TAIL);

/** Runs updateCommand(manager). Never throws: a failure is `{ ok: false, output }`. */
export async function runCliUpdate(
  opts: { manager?: PackageManager; exec?: ExecLike } = {},
): Promise<{ ok: boolean; output: string }> {
  const manager = opts.manager ?? 'npm';
  const exec = opts.exec ?? (promisify(execFile) as unknown as ExecLike);
  try {
    const { stdout, stderr } = await exec(manager, UPDATE_ARGS[manager], {
      env: commandEnv(),
      timeout: UPDATE_TIMEOUT_MS,
      // npm/pnpm are .cmd shims on Windows; the argv is fixed, so the shell sees no user input.
      shell: process.platform === 'win32',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: tail(`${stdout}${stderr}`) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') return { ok: false, output: `${manager} not found on PATH` };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    return { ok: false, output: tail(out || String(e.message ?? err)) };
  }
}

/** findPathCli on the command env, after the shell-env probe (cached)
 *  has merged version-manager bins into PATH — without it the desktop's
 *  first scan can run on an unprobed PATH and miss nvm/pnpm installs. */
export async function findInstalledCli(probe: () => Promise<unknown> = probeShellEnv): Promise<InstalledCli | null> {
  await probe().catch(() => {});
  return findPathCli(commandEnv());
}
