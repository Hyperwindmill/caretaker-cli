# ACP Registry Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provider presets from the official ACP Agent Registry (npx/uvx prefill + managed binary install), agent-level `acpMode` (`session/set_mode`), and the "External agent (ACP)" label everywhere.

**Architecture:** A new `packages/cli/src/acp/` module owns registry fetch/normalize/cache and the binary installer; webviews reach it through two new bridge message pairs (mirroring `fetchModels` → `modelsFetched`) implemented by the web server and the VSCode sidebar hosts; the TUI calls it directly. `acpMode` is a plain `AgentConfig` field the ACP runner applies via `session/set_mode` right after `session/new`/`session/load`, only for interactive-policy runs.

**Tech Stack:** TypeScript ESM, global `fetch` (test hook pattern from `harness/loop.ts`), `tar`/`unzip` CLIs for extraction (no new npm deps), Node built-in test runner via tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-acp-registry-presets-design.md`

## Global Constraints

- Branch: `feature/acp-runner`. The husky pre-commit hook requires a **staged changeset** in every commit on feature branches: each task appends one `- <summary>` bullet line to `.changeset/acp-registry-presets.md` (already committed in b7d5a26) and stages it with the commit. Never use `--no-verify`.
- `pnpm -F @hyperwindmill/caretaker-cli typecheck` and `pnpm -F @hyperwindmill/caretaker-cli test` must pass after every task (`pnpm test` runs via tsx and does NOT type-check).
- Tests touching disk set `process.env.CARETAKER_HOME` at FILE scope, before imports.
- Atomic-write policy for persisted state: tmp + rename (the registry cache included).
- UI label is exactly **"External agent (ACP)"** (spec wording) wherever the provider type is shown.
- All code/comments in English. Never rewrite commits.

## Registry crib sheet (verified 2026-08-25 against the live CDN)

`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` → `{ version, agents: [...], extensions }`, 39 agents. Per agent: `{ id, name, version, description, repository, website, authors, license, distribution, icon }`. `distribution` variants:

- `npx: { package: "name@semver", args?: string[], env?: Record<string,string> }`
- `uvx: { package, args?, env? }`
- `binary: { "<os>-<cpu>": { archive: url, cmd: "./relative/path", args?: string[], env?: Record, sha256?: hex } }` with keys `linux-x86_64`, `linux-aarch64`, `darwin-x86_64`, `darwin-aarch64`, `windows-x86_64`, `windows-aarch64`. Archives: `.tar.gz`, `.tar.bz2`, `.zip`, or a raw executable (sigit). Some agents have BOTH `binary` and `npx` (kilo, sigit) — prefer npx.

Key entries: `claude-acp` (npx `@agentclientprotocol/claude-agent-acp@…`), `codex-acp` (npx), `antigravity-acp` (binary-only, zip), `gemini` (npx `@google/gemini-cli` `--acp`).

SDK types for Task 6 (from `@agentclientprotocol/sdk`): `NewSessionResponse.modes?: SessionModeState | null`, `LoadSessionResponse.modes?: SessionModeState | null`, `SessionModeState = { currentModeId: string, availableModes: Array<{ id: string, name: string, … }> }`, request `'session/set_mode'` params `{ sessionId, modeId }`.

---

### Task 1: Types + registry service

**Files:**
- Modify: `packages/types/src/index.ts` (add `AcpAgentDist`/`AcpAgentPreset`; add `acpMode` to `AgentConfig`)
- Create: `packages/cli/src/acp/registry.ts`
- Test: `packages/cli/src/acp/registry.test.ts`
- Modify: `.changeset/acp-registry-presets.md` (append bullet)

**Interfaces:**
- Produces:
  - `AcpAgentDist = { kind: 'npx' | 'uvx'; command: string; args: string[]; env?: Record<string,string> } | { kind: 'binary'; archive: string; cmd: string; args?: string[]; env?: Record<string,string>; sha256?: string }`
  - `AcpAgentPreset = { id: string; name: string; description: string; version: string; dist: AcpAgentDist | null; selfLoadedContextFiles: string[] }`
  - `AgentConfig.acpMode?: string`
  - `platformKey(platform?, arch?): string`, `normalizeRegistry(raw: unknown, platKey?: string): AcpAgentPreset[]`, `fetchAcpRegistry(now?: number): Promise<AcpAgentPreset[]>`, `REGISTRY_URL`, `__setFetch`/`__resetFetch`

- [ ] **Step 1: Types**

In `packages/types/src/index.ts` add after the `ProviderConfig` block:

```ts
/** One agent from the ACP Agent Registry, normalized for the current
 *  platform. `dist: null` = the agent exists but has no distribution usable
 *  on this platform (shown disabled, never hidden). */
export type AcpAgentDist =
  | { kind: 'npx' | 'uvx'; command: string; args: string[]; env?: Record<string, string> }
  | {
      kind: 'binary';
      archive: string;
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
      sha256?: string;
    };
export type AcpAgentPreset = {
  id: string;
  name: string;
  description: string;
  version: string;
  dist: AcpAgentDist | null;
  selfLoadedContextFiles: string[];
};
```

In `AgentConfig` (same file), next to `permissionMode`, add:

```ts
  /** acp providers only: pin the agent to one of its own permission modes
   *  (session/set_mode) at session start, e.g. 'acceptEdits' or
   *  'bypassPermissions' for claude-agent-acp. Unknown modes are ignored
   *  with a warning. Autonomous task runs ignore this field. */
  acpMode?: string;
```

- [ ] **Step 2: Write the failing test**

`packages/cli/src/acp/registry.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/acp/registry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `registry.ts`**

```ts
// ACP Agent Registry client: fetch + normalize + disk cache. The registry is
// the census of known ACP agents (spec: 2026-08-25-acp-registry-presets);
// the provider form offers these as presets instead of hand-typed commands.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../store/json.js';
import type { AcpAgentPreset } from '../types.js';

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type FetchLike = (url: string) => Promise<Response>;
let fetchImpl: FetchLike = (url) => fetch(url);
export function __setFetch(f: FetchLike): void {
  fetchImpl = f;
}
export function __resetFetch(): void {
  fetchImpl = (url) => fetch(url);
}

/** What the registry does not know: context files an agent self-loads (the
 *  fabricated context block must skip them — see the ACP runner spec). */
const SELF_LOADED: Record<string, string[]> = {
  'claude-acp': ['CLAUDE.md'],
  'codex-acp': ['AGENTS.md'],
  gemini: ['GEMINI.md'],
};

export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `${os}-${cpu}`;
}

export function normalizeRegistry(raw: unknown, platKey: string = platformKey()): AcpAgentPreset[] {
  const agents = Array.isArray((raw as any)?.agents) ? (raw as any).agents : [];
  const out: AcpAgentPreset[] = [];
  for (const a of agents) {
    if (!a?.id || !a?.name) continue;
    const d = a.distribution ?? {};
    let dist: AcpAgentPreset['dist'] = null;
    if (d.npx?.package) {
      // -y: without it, npx prompts "Ok to proceed?" on stdin on first run,
      // which would corrupt the ACP JSON-RPC handshake on the same pipe.
      dist = {
        kind: 'npx',
        command: 'npx',
        args: ['-y', String(d.npx.package), ...(d.npx.args ?? [])],
        ...(d.npx.env ? { env: d.npx.env } : {}),
      };
    } else if (d.uvx?.package) {
      dist = {
        kind: 'uvx',
        command: 'uvx',
        args: [String(d.uvx.package), ...(d.uvx.args ?? [])],
        ...(d.uvx.env ? { env: d.uvx.env } : {}),
      };
    } else if (d.binary?.[platKey]) {
      const b = d.binary[platKey];
      dist = {
        kind: 'binary',
        archive: String(b.archive),
        cmd: String(b.cmd),
        ...(b.args ? { args: b.args } : {}),
        ...(b.env ? { env: b.env } : {}),
        ...(b.sha256 ? { sha256: String(b.sha256) } : {}),
      };
    }
    out.push({
      id: String(a.id),
      name: String(a.name),
      description: String(a.description ?? ''),
      version: String(a.version ?? ''),
      dist,
      selfLoadedContextFiles: SELF_LOADED[a.id] ?? [],
    });
  }
  return out;
}

function cachePath(): string {
  return join(dataDir(), 'cache', 'acp-registry.json');
}

export async function fetchAcpRegistry(now: number = Date.now()): Promise<AcpAgentPreset[]> {
  let cached: { fetchedAt: number; raw: unknown } | null = null;
  try {
    cached = JSON.parse(await readFile(cachePath(), 'utf8'));
  } catch {
    /* no cache */
  }
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return normalizeRegistry(cached.raw);
  try {
    const res = await fetchImpl(REGISTRY_URL);
    if (!res.ok) throw new Error(`ACP registry fetch failed: HTTP ${res.status}`);
    const raw = await res.json();
    const list = normalizeRegistry(raw); // validate before caching
    await mkdir(join(dataDir(), 'cache'), { recursive: true });
    const tmp = `${cachePath()}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify({ fetchedAt: now, raw }), { mode: 0o600 });
    await rename(tmp, cachePath());
    return list;
  } catch (err) {
    // Last-good: a stale cache beats an error (offline-first).
    if (cached) return normalizeRegistry(cached.raw);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/acp/registry.test.ts && pnpm -F caretaker-types build && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

Append to `.changeset/acp-registry-presets.md` (before the final newline):
`- Registry service: fetch/normalize/cache of the official ACP Agent Registry.`

```bash
git add packages/types/src/index.ts packages/cli/src/acp/registry.ts packages/cli/src/acp/registry.test.ts .changeset/acp-registry-presets.md
git commit -m "feat(acp): registry service — fetch, per-platform normalize, 24h disk cache with last-good"
```

---

### Task 2: Binary installer

**Files:**
- Create: `packages/cli/src/acp/install.ts`
- Test: `packages/cli/src/acp/install.test.ts`
- Modify: `.changeset/acp-registry-presets.md` (append bullet)

**Interfaces:**
- Consumes: `AcpAgentPreset` (Task 1).
- Produces: `type InstalledAcp = { command: string; args: string[]; env?: Record<string, string> }`; `installAcpAgent(preset: AcpAgentPreset, onProgress?: (line: string) => void): Promise<InstalledAcp>`; `__setFetch`/`__resetFetch` (own hook).

- [ ] **Step 1: Write the failing test**

`packages/cli/src/acp/install.test.ts` (builds a real tiny tar.gz fixture with the system `tar`):

```ts
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

const preset = (over: Partial<NonNullable<AcpAgentPreset['dist']>> = {}): AcpAgentPreset => ({
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
    return new Response(archiveBytes, { status: 200 });
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
  __setFetch(async () => new Response(archiveBytes, { status: 200 }));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/acp/install.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `install.ts`**

```ts
// Managed install of binary-distributed ACP agents (spec:
// 2026-08-25-acp-registry-presets). Download → sha256 verify → extract →
// chmod, all into a tmp sibling renamed into place on success, so a failed
// install leaves nothing behind. Idempotent per <id>/<version>: the saved
// provider just points at the resulting absolute path — nothing else in
// caretaker knows the binary is "managed".

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { dataDir } from '../store/json.js';
import type { AcpAgentPreset } from '../types.js';

const exec = promisify(execFile);

type FetchLike = (url: string) => Promise<Response>;
let fetchImpl: FetchLike = (url) => fetch(url);
export function __setFetch(f: FetchLike): void {
  fetchImpl = f;
}
export function __resetFetch(): void {
  fetchImpl = (url) => fetch(url);
}

export type InstalledAcp = { command: string; args: string[]; env?: Record<string, string> };

function isExtractable(name: string): boolean {
  return /\.(tar\.(gz|bz2|xz)|tgz|tbz2|tar|zip)$/i.test(name);
}

async function extract(archive: string, dest: string): Promise<void> {
  if (/\.zip$/i.test(archive) && process.platform === 'linux') {
    // GNU tar has no zip support; macOS and Windows ship bsdtar (which does).
    try {
      await exec('unzip', ['-o', archive, '-d', dest]);
      return;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new Error(
          'unzip is required to extract .zip archives on Linux — install it (e.g. apt install unzip)',
        );
      }
      throw err;
    }
  }
  await exec('tar', ['-xf', archive, '-C', dest]);
}

export async function installAcpAgent(
  preset: AcpAgentPreset,
  onProgress: (line: string) => void = () => {},
): Promise<InstalledAcp> {
  const d = preset.dist;
  if (!d || d.kind !== 'binary') {
    throw new Error(`"${preset.id}" has no binary distribution for this platform`);
  }
  const dir = join(dataDir(), 'acp', preset.id, preset.version || 'latest');
  const command = resolve(dir, d.cmd);
  const result: InstalledAcp = { command, args: d.args ?? [], ...(d.env ? { env: d.env } : {}) };

  if (await stat(command).then(() => true).catch(() => false)) {
    onProgress('already installed');
    return result;
  }

  const tmp = `${dir}.tmp-${process.pid}`;
  try {
    await mkdir(tmp, { recursive: true });
    onProgress(`downloading ${d.archive}`);
    const res = await fetchImpl(d.archive);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const archiveName = basename(new URL(d.archive).pathname);
    const archivePath = join(tmp, archiveName);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(archivePath));

    if (d.sha256) {
      onProgress('verifying checksum');
      const hash = createHash('sha256').update(await readFile(archivePath)).digest('hex');
      if (hash !== d.sha256) throw new Error(`sha256 mismatch: expected ${d.sha256}, got ${hash}`);
    }

    if (isExtractable(archiveName)) {
      onProgress('extracting');
      await extract(archivePath, tmp);
      await rm(archivePath, { force: true });
    } else {
      // Raw executable download (no archive): move it to the cmd path.
      const target = resolve(tmp, d.cmd);
      await mkdir(join(target, '..'), { recursive: true });
      await rename(archivePath, target);
    }

    const cmdInTmp = resolve(tmp, d.cmd);
    if (!(await stat(cmdInTmp).then(() => true).catch(() => false))) {
      throw new Error(`archive did not contain the expected command "${d.cmd}"`);
    }
    await chmod(cmdInTmp, 0o755).catch(() => {}); // no-op semantics on Windows

    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    onProgress('installed');
    return result;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    // Remove the (possibly just-created, empty) id dir if this was the first version.
    await rm(join(dataDir(), 'acp', preset.id), { recursive: true, force: true }).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  }
}
```

Note: the failure-path `rm` of the whole `<id>` dir is correct only because versions are immutable installs; a failed re-install of a NEW version would also delete a working OLD one. Guard it: only remove the id dir when it is empty — replace that line with:

```ts
    await (await import('node:fs/promises')).rmdir(join(dataDir(), 'acp', preset.id)).catch(() => {});
```

(`rmdir` without recursive fails on non-empty — exactly the guard we want.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/acp/install.test.ts && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

Append bullet to the changeset: `- Binary installer: download + sha256 + extract into ~/.caretaker/acp/<id>/<version>/.`

```bash
git add packages/cli/src/acp/install.ts packages/cli/src/acp/install.test.ts .changeset/acp-registry-presets.md
git commit -m "feat(acp): binary agent installer — checksum-verified, atomic, idempotent per version"
```

---

### Task 3: `./acp` export + bridge messages + both hosts

**Files:**
- Create: `packages/cli/src/acp/index.ts`
- Modify: `packages/cli/package.json` (exports map — mirror the `./mcp` entry style exactly)
- Modify: `packages/webview-ui/src/bridge.ts` (types + `parseViewToHost`)
- Modify: `packages/cli/src/cli/web/server.ts` (ws message handler, next to the `fetchModels` case at ~line 1313)
- Modify: `packages/vscode-extension/src/sidebar.ts` (message handler, next to `fetchModels` at ~line 535)
- Modify: `.changeset/acp-registry-presets.md` (append bullet)

**Interfaces:**
- Consumes: `fetchAcpRegistry` (Task 1), `installAcpAgent` (Task 2), `AcpAgentPreset` (caretaker-types).
- Produces (bridge contract, used by Task 4):
  - ViewToHost: `{ type: 'fetchAcpRegistry' }` and `{ type: 'installAcpAgent'; agentId: string }`
  - HostToView: `{ type: 'acpRegistryFetched'; result: AcpRegistryResult }` with `AcpRegistryResult = { ok: true; agents: AcpAgentPreset[] } | { ok: false; error: string }`; `{ type: 'acpInstallProgress'; agentId: string; line: string }`; `{ type: 'acpInstallResult'; agentId: string; ok: boolean; command?: string; args?: string[]; env?: Record<string, string>; error?: string }`

- [ ] **Step 1: `acp/index.ts` + package export**

```ts
export { fetchAcpRegistry, normalizeRegistry, platformKey, REGISTRY_URL } from './registry.js';
export { installAcpAgent, type InstalledAcp } from './install.js';
```

In `packages/cli/package.json` add to `exports`, mirroring the `./mcp` entry's exact shape (types + import paths under `dist/`):

```json
"./acp": { "types": "./dist/acp/index.d.ts", "import": "./dist/acp/index.js" }
```

(Read the existing `./mcp` entry first and copy its key order/format verbatim.)

- [ ] **Step 2: Bridge types + parse**

In `packages/webview-ui/src/bridge.ts`: import `AcpAgentPreset` from `caretaker-types` (the file already imports other types from there — extend that import). Add next to `ModelsResult`:

```ts
export type AcpRegistryResult =
  | { ok: true; agents: AcpAgentPreset[] }
  | { ok: false; error: string };
```

HostToView union (next to `modelsFetched`):

```ts
  | { type: 'acpRegistryFetched'; result: AcpRegistryResult }
  | { type: 'acpInstallProgress'; agentId: string; line: string }
  | {
      type: 'acpInstallResult';
      agentId: string;
      ok: boolean;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      error?: string;
    }
```

ViewToHost union (next to `fetchModels`):

```ts
  | { type: 'fetchAcpRegistry' }
  | { type: 'installAcpAgent'; agentId: string }
```

`parseViewToHost` cases (same strict style as `fetchModels`):

```ts
    case 'fetchAcpRegistry':
      return { type };
    case 'installAcpAgent':
      return typeof value.agentId === 'string' ? { type, agentId: value.agentId } : null;
```

- [ ] **Step 3: Web server host handler**

In `cli/web/server.ts`, in the same ws-message switch as `fetchModels` (mirror how that case sends its reply — same `post`/send function):

```ts
          case 'fetchAcpRegistry':
            try {
              const agents = await fetchAcpRegistry();
              post({ type: 'acpRegistryFetched', result: { ok: true, agents } });
            } catch (err) {
              post({ type: 'acpRegistryFetched', result: { ok: false, error: String(err) } });
            }
            return;
          case 'installAcpAgent':
            try {
              const agents = await fetchAcpRegistry();
              const preset = agents.find((a) => a.id === msg.agentId);
              if (!preset) throw new Error(`unknown ACP agent "${msg.agentId}"`);
              const installed = await installAcpAgent(preset, (line) =>
                post({ type: 'acpInstallProgress', agentId: msg.agentId, line }),
              );
              post({ type: 'acpInstallResult', agentId: msg.agentId, ok: true, ...installed });
            } catch (err) {
              post({ type: 'acpInstallResult', agentId: msg.agentId, ok: false, error: String(err) });
            }
            return;
```

Imports from `'../../acp/index.js'` (relative — same package).

- [ ] **Step 4: VSCode sidebar host handler**

In `vscode-extension/src/sidebar.ts`, same switch as its `fetchModels` case, same two cases, using `this.post(webview, …)` and importing from `'@hyperwindmill/caretaker-cli/acp'`.

- [ ] **Step 5: Verify**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli build && pnpm -F webview-ui test && pnpm -F webview-ui build && pnpm -F caretaker-vscode build`
Expected: PASS (the cli `build` is needed so the extension resolves the new `./acp` export against `dist/`).

- [ ] **Step 6: Commit**

Append bullet: `- Bridge messages + web/VSCode hosts for registry fetch and managed install.`

```bash
git add packages/cli/src/acp/index.ts packages/cli/package.json packages/webview-ui/src/bridge.ts \
  packages/cli/src/cli/web/server.ts packages/vscode-extension/src/sidebar.ts .changeset/acp-registry-presets.md
git commit -m "feat(acp): registry/install bridge messages wired into the web and VSCode hosts"
```

---

### Task 4: ProvidersTab presets UI + label (webview)

**Files:**
- Modify: `packages/webview-ui/src/ProvidersTab.tsx`
- Modify: `packages/webview-ui/src/App.tsx` (route the three new host messages into state passed to ProvidersTab — mirror how `modelsResult` flows to AgentsTab)
- Modify: `.changeset/acp-registry-presets.md` (append bullet)

**Interfaces:**
- Consumes: bridge contract from Task 3.
- Produces: saved `ProviderConfig` records now may carry `selfLoadedContextFiles` (from the preset) — no type change needed (field exists since the runner feature).

- [ ] **Step 1: App plumbing**

In `App.tsx`, add state and message routing (exactly where `modelsFetched` is handled):

```ts
const [acpRegistry, setAcpRegistry] = useState<AcpRegistryResult | null>(null);
const [acpInstall, setAcpInstall] = useState<{ agentId: string; lines: string[]; result?: { ok: boolean; command?: string; args?: string[]; env?: Record<string, string>; error?: string } } | null>(null);
```

```ts
      case 'acpRegistryFetched':
        setAcpRegistry(msg.result);
        break;
      case 'acpInstallProgress':
        setAcpInstall((prev) =>
          prev && prev.agentId === msg.agentId
            ? { ...prev, lines: [...prev.lines, msg.line] }
            : { agentId: msg.agentId, lines: [msg.line] },
        );
        break;
      case 'acpInstallResult':
        setAcpInstall((prev) => ({
          agentId: msg.agentId,
          lines: prev?.agentId === msg.agentId ? prev.lines : [],
          result: { ok: msg.ok, command: msg.command, args: msg.args, env: msg.env, error: msg.error },
        }));
        break;
```

Pass `acpRegistry`, `acpInstall`, and a reset (`setAcpInstall(null)`) down to `ProvidersTab` as props.

- [ ] **Step 2: ProvidersTab**

Changes (current acp form block is the command/args pair added by the runner feature):

1. Label: `<option value="acp">External agent (ACP)</option>` (replaces "ACP agent (external CLI)") and the provider-list row branch becomes `` `External agent (ACP) — ${prov.command ?? ''} ${(prov.args ?? []).join(' ')}`.trim() ``.
2. New state: `const [presetId, setPresetId] = useState('custom');` and `const [selfLoaded, setSelfLoaded] = useState<string[]>([]);` (populated from the chosen preset; loaded from `provider.selfLoadedContextFiles` in `startEdit`).
3. On first render with `type === 'acp'` and `acpRegistry === null`: `postMessage({ type: 'fetchAcpRegistry' })` (a `useEffect` on `[type]`).
4. Above the command/args fields render the Agent select:

```tsx
<div className="form-group">
  <label htmlFor="acp-preset">Agent</label>
  <select
    id="acp-preset"
    value={presetId}
    onChange={(e) => applyPreset(e.target.value)}
  >
    <option value="custom">Custom (manual command)</option>
    {acpRegistry?.ok &&
      acpRegistry.agents.map((a) => (
        <option key={a.id} value={a.id} disabled={a.dist === null}>
          {a.name}
          {a.dist === null ? ' (not available on this platform)' : ''}
        </option>
      ))}
  </select>
  {acpRegistry && !acpRegistry.ok && (
    <p className="form-error">Registry unavailable: {acpRegistry.error} — use Custom.</p>
  )}
</div>
```

5. `applyPreset(id)`: `custom` clears `selfLoaded` and leaves fields; an npx/uvx preset fills `setCommand(preset.dist.command)`, `setArgs(preset.dist.args.join(' '))`, `setSelfLoaded(preset.selfLoadedContextFiles)`; a binary preset clears command/args (they come from the install result) and sets `selfLoaded`.
6. Binary preset selected → render an Install block instead of the manual fields:

```tsx
<div className="form-group">
  <button type="button" className="btn btn--secondary" disabled={installing} onClick={() => { resetAcpInstall(); setInstalling(true); postMessage({ type: 'installAcpAgent', agentId: presetId }); }}>
    {installing ? 'Installing…' : 'Install'}
  </button>
  {acpInstall?.agentId === presetId && (
    <pre className="install-log">{acpInstall.lines.join('\n')}</pre>
  )}
</div>
```

   A `useEffect` on `acpInstall?.result` (matching `agentId === presetId`): on `ok` fill `setCommand(result.command)`, `setArgs((result.args ?? []).join(' '))`, keep env in a ref for save, `setInstalling(false)`; on error show it via `setErrorMsg` and `setInstalling(false)`.
7. Save path for acp additionally persists `...(selfLoaded.length ? { selfLoadedContextFiles: selfLoaded } : {})` and `...(presetEnv ? { env: presetEnv } : {})` (env from the preset or install result; the existing `editingProvider?.env` preservation stays as fallback).

- [ ] **Step 3: Verify**

Run: `pnpm -F webview-ui test && pnpm -F webview-ui build && pnpm -F caretaker-vscode build`
Expected: PASS.

- [ ] **Step 4: Commit**

Append bullet: `- Provider form presets (webview): agent census select, install flow, "External agent (ACP)" label.`

```bash
git add packages/webview-ui/src/ProvidersTab.tsx packages/webview-ui/src/App.tsx .changeset/acp-registry-presets.md
git commit -m "feat(acp): webview provider presets from the registry + managed install flow"
```

---

### Task 5: TUI provider presets + label

**Files:**
- Modify: `packages/cli/src/tui/providers.tsx`
- Modify: `.changeset/acp-registry-presets.md` (append bullet)

**Interfaces:**
- Consumes: `fetchAcpRegistry` directly (`import { fetchAcpRegistry } from '../acp/index.js'`), `AcpAgentPreset`.

- [ ] **Step 1: Labels**

Replace both occurrences of the acp label text (the type-step `SelectInput` item added by the runner feature, and the list/detail rows) with **`External agent (ACP)`**.

- [ ] **Step 2: Preset step**

Add a `preset` FormStep for the acp flavor between `name` and `command`:

- On entering the step, `useEffect` fires `void fetchAcpRegistry().then(setPresets).catch((e) => setPresetError(String(e)))`.
- `SelectInput` items: `[{ label: 'Custom (manual command)', value: 'custom' }, ...presets.map(p => ({ label: p.dist ? (p.dist.kind === 'binary' ? `${p.name} (binary — install from the web GUI, or enter the path manually)` : p.name) : `${p.name} (not available on this platform)`, value: p.id }))]`.
- On select:
  - `custom` or a `dist: null` / binary preset → proceed to the `command` step (binary keeps command empty for a manual path; store the preset's `selfLoadedContextFiles` either way).
  - npx/uvx preset → set `command`/`args` from `dist`, store `selfLoadedContextFiles` and `env`, and skip straight to save (the acp form has no further required steps).
- On registry error → show the error dim and fall through to `command` (manual entry).
- The save path persists `selfLoadedContextFiles`/`env` when present (same optional-spread style the form already uses for `command`).

- [ ] **Step 3: Verify**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 4: Commit**

Append bullet: `- TUI provider presets (npx/uvx prefill; binary presets point at the web installer or manual path).`

```bash
git add packages/cli/src/tui/providers.tsx .changeset/acp-registry-presets.md
git commit -m "feat(acp): TUI provider presets from the registry + External agent (ACP) label"
```

---

### Task 6: `acpMode` — runner + agent forms

**Files:**
- Modify: `packages/cli/src/harness/acp_runner.ts` (apply mode after session/new / session/load)
- Modify: `packages/webview-ui/src/AgentsTab.tsx` (field in the isAcp branch)
- Modify: `packages/cli/src/tui/agents.tsx` (acpMode step for the acp flavor)
- Test: extend `packages/cli/src/harness/acp_runner.test.ts`
- Modify: `.changeset/acp-registry-presets.md` (append bullet)

**Interfaces:**
- Consumes: `AgentConfig.acpMode` (Task 1), SDK `'session/set_mode'` request `{ sessionId, modeId }`, `NewSessionResponse.modes` / `LoadSessionResponse.modes` (`SessionModeState`).

- [ ] **Step 1: Write the failing test**

Append to `acp_runner.test.ts`:

```ts
const MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'bypassPermissions', name: 'Bypass' },
  ],
};

function fakeAgentWithModes() {
  const setModes: string[] = [];
  const app = acpAgent({ name: 'fake' })
    .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', () => ({ sessionId: 'acp-1', modes: MODES }))
    .onRequest('session/set_mode', (ctx: any) => {
      setModes.push(ctx.params.modeId);
      return {};
    })
    .onRequest('session/prompt', async () => ({ stopReason: 'end_turn' }));
  __setConnector((_p, clientApp) => {
    const conn = clientApp.connect(app);
    return { conn, kill: () => conn.close() };
  });
  return { setModes };
}

test('acpMode: set_mode sent when advertised and different from current', async () => {
  const { setModes } = fakeAgentWithModes();
  await runAcp(
    { agent: { ...agentCfg, acpMode: 'bypassPermissions' }, provider, tools: [], prompt: 'x' },
    {},
  );
  assert.deepEqual(setModes, ['bypassPermissions']);
});

test('acpMode: skipped with a warning when not advertised; skipped for task-policy runs', async () => {
  const a = fakeAgentWithModes();
  await runAcp({ agent: { ...agentCfg, acpMode: 'nope' }, provider, tools: [], prompt: 'x' }, {});
  assert.deepEqual(a.setModes, []);

  __shutdownAcpPool();
  const b = fakeAgentWithModes();
  await runAcp(
    {
      agent: { ...agentCfg, acpMode: 'bypassPermissions' },
      provider,
      tools: [],
      prompt: 'x',
      acp: { mode: 'unattended' },
    },
    {},
  );
  assert.deepEqual(b.setModes, []); // task policy is authoritative — acpMode ignored
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/harness/acp_runner.test.ts`
Expected: the two new tests FAIL (set_mode never sent / no such handling).

- [ ] **Step 3: Runner implementation**

In `acp_runner.ts`, inside the `if (!acpSessionId)` session-resolution block, capture the modes from whichever response created the session:

- `session/load` succeeds → `modes = loadRes.modes` (assign the awaited response to a const instead of discarding it).
- `session/new` → `modes = res.modes`.

After `handle.acpSessionId = acpSessionId;` (still inside the block — set once per created/loaded session, never on pooled reuse) add:

```ts
      // Agent-level session mode (AgentConfig.acpMode): pin the agent to one
      // of its OWN permission modes so it stops asking at the source. Only for
      // interactive-policy runs — task runs' policy (unattended/planner/
      // deny-all) stays authoritative. Unknown/unadvertised modes warn and
      // continue: a wrong mode id must never brick the chat.
      const wantMode = agent.acpMode?.trim();
      if (wantMode && (extras.mode ?? 'interactive') === 'interactive') {
        const available = modes?.availableModes.some((m) => m.id === wantMode);
        if (!available) {
          console.warn(
            `[acp] agent "${agent.name}": acpMode "${wantMode}" is not among the agent's advertised modes — ignored`,
          );
        } else if (modes!.currentModeId !== wantMode) {
          try {
            await handle.conn.agent.request('session/set_mode', {
              sessionId: acpSessionId,
              modeId: wantMode,
            });
          } catch (err) {
            console.warn(`[acp] session/set_mode "${wantMode}" failed:`, err);
          }
        }
      }
```

(`modes` typed as `SessionModeState | null | undefined`, imported as a type from the SDK.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/harness/acp_runner.test.ts`
Expected: PASS (all runner tests).

- [ ] **Step 5: AgentsTab field**

State `const [acpMode, setAcpMode] = useState('');` — set in `startEdit` (`agent.acpMode ?? ''`) and cleared in `startCreate`. In the existing `isAcp` branch (the info-note block), add above the note:

```tsx
            <div className="form-group">
              <label htmlFor="agent-acp-mode">Session mode (Optional)</label>
              <input
                id="agent-acp-mode"
                type="text"
                placeholder="e.g. acceptEdits | bypassPermissions (agent-specific)"
                value={acpMode}
                onChange={(e) => setAcpMode(e.target.value)}
              />
              <p style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: '1.4', margin: '4px 0 0' }}>
                Pins the agent to one of its own permission modes at session start (session/set_mode).
                Unknown modes are ignored with a warning; autonomous task runs ignore this.
              </p>
            </div>
```

Save: `...(isAcp && acpMode.trim() ? { acpMode: acpMode.trim() } : {}),` next to the permissionMode spread.

- [ ] **Step 6: TUI agents step**

In `tui/agents.tsx`: add `'acpMode'` to the `FormStep` union; the acp flavor sequence becomes `seq.push('mcpServers', 'workingDir', 'acpMode')` (acpMode is now the terminal step — the workingDir "finalize if last" guard added by the runner feature stays, it just no longer fires for acp). State `const [acpMode, setAcpMode] = useState(initial?.acpMode ?? '');` — persisted in `finalize` as `...(isAcp && acpMode.trim() ? { acpMode: acpMode.trim() } : {}),`. Render block (gated `isAcp`), TextInput with placeholder `optional — e.g. acceptEdits | bypassPermissions`, whose `onSubmit` runs the same finalize call the workingDir terminal branch uses (`finalize(Number.parseInt(maxTurns.trim(), 10) || 30)` style — copy the exact expression from that branch). Detail view: add `<Text>acpMode: {selected.acpMode || '(none)'}</Text>` inside the acp branch.

- [ ] **Step 7: Verify**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test 2>&1 | tail -4 && pnpm -F webview-ui test && pnpm -F webview-ui build`
Expected: PASS.

- [ ] **Step 8: Commit**

Append bullet: `- Agent-level acpMode: session/set_mode at session start for interactive runs.`

```bash
git add packages/cli/src/harness/acp_runner.ts packages/cli/src/harness/acp_runner.test.ts \
  packages/webview-ui/src/AgentsTab.tsx packages/cli/src/tui/agents.tsx .changeset/acp-registry-presets.md
git commit -m "feat(acp): agent-level acpMode via session/set_mode (interactive runs only)"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` (layer-2 ACP paragraph)
- Modify: `README.md` (ACP providers section)
- Modify: `.changeset/acp-registry-presets.md` (append bullet)

- [ ] **Step 1: CLAUDE.md**

Extend the ACP paragraph (after the confirm-gate/notice-heuristic sentences) with, in the same dense style: provider presets come from the official ACP Agent Registry via `acp/registry.ts` (CDN JSON, 24h disk cache at `~/.caretaker/cache/acp-registry.json`, last-good on network failure, per-platform normalization, npx gets `-y` to keep the stdio handshake clean); binary agents are installed by `acp/install.ts` into `~/.caretaker/acp/<id>/<version>/` (sha256-verified, tmp+rename, idempotent; `.zip` on Linux needs `unzip`); the bridge pairs `fetchAcpRegistry`/`acpRegistryFetched` and `installAcpAgent`/`acpInstallProgress`+`acpInstallResult` are served by both the web server and the VSCode sidebar hosts (TUI calls the module directly, no installer there); the provider-type label is "External agent (ACP)"; `AgentConfig.acpMode` pins the agent to one of its own advertised session modes via `session/set_mode` right after session/new-or-load, interactive-policy runs only, warn-and-continue on unknown modes.

- [ ] **Step 2: README**

Rewrite the "ACP agents as providers" section: pick the agent from the census in Settings → Providers (type "External agent (ACP)"); npx-based agents work immediately (Node ≥ 18 required); binary agents get an Install button (Linux `.zip` extraction requires `unzip`); Custom manual command entry remains for anything not in the registry. Keep the auth expectations and Docker caveat paragraphs; add one line about the optional agent Session mode field (`acpMode`).

- [ ] **Step 3: Full verification**

Run: `pnpm build && pnpm test`
Expected: every package builds, every suite passes.

- [ ] **Step 4: Commit**

Append bullet: `- Docs: census workflow in README, architecture notes in CLAUDE.md.`

```bash
git add CLAUDE.md README.md .changeset/acp-registry-presets.md
git commit -m "docs(acp): registry presets, installer, acpMode — architecture + user docs"
```

---

## Out of scope (per spec)

Auto-updating installed binaries, registry icons, live mode picker in chat, uninstall UI, TUI installer.
