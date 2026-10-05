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
