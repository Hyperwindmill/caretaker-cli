// ACP agent process pool. Unlike claude -p (one process per turn + --resume),
// an ACP child is long-lived: spawn → initialize → session/new, then N
// session/prompt calls on the same child. One child per caretaker session
// (poolKey = `${agentId}:${sessionId}`); sessionId-less runs (tasks, sweep,
// headless one-shots) get an ephemeral child killed at end of run.
//
// Handlers are registered once per child at client() construction and route
// through a mutable `binding` the runner sets at turn start — turns on one
// session are serialized by the surfaces, so there is no race.

import { spawn as nodeSpawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Usage,
} from '@agentclientprotocol/sdk';
import type { ProviderConfig } from '../types.js';
import { mergeShellEnv } from './tools/builtin/shell-env.js';

export type TurnBinding = {
  /** null until session/new returns (drop nothing: the first updates can only
   *  belong to our session — one child, one session). */
  acpSessionId: string | null;
  onUpdate: (n: SessionNotification) => void | Promise<void>;
  onPermission: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
};

export type AcpAgentHandle = {
  conn: ClientConnection;
  init: InitializeResponse;
  binding: { current: TurnBinding | null };
  /** ACP session id once created/loaded — reused across turns of this handle. */
  acpSessionId?: string;
  /** Last session-cumulative usage snapshot (per-turn usage is the diff). */
  lastUsage?: Usage;
  kill: () => void;
  lastUsed: number;
};

// ─── connector (test hook, same pattern as claude_code_runner __setSpawn) ──
type Connector = (
  provider: ProviderConfig,
  app: ClientApp,
) => { conn: ClientConnection; kill: () => void };

const defaultConnector: Connector = (provider, app) => {
  if (!provider.command) {
    throw new Error(
      `acp runner: provider "${provider.name}" has no command — set the ACP agent server executable (e.g. npx) in the provider settings`,
    );
  }
  const child = nodeSpawn(provider.command, provider.args ?? [], {
    // Same env policy as the claude-code runner: probed interactive-shell PATH
    // merged WITHOUT scrubbing secrets, so env-based auth survives; provider.env on top.
    env: { ...mergeShellEnv(process.env), ...provider.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + String(d)).slice(-4096);
  });
  child.on('error', (err) => {
    console.warn(`[acp] failed to start "${provider.command}": ${err.message}`);
  });
  child.on('close', (code) => {
    if (code !== 0 && code !== null && stderrTail) {
      console.warn(`[acp] "${provider.command}" exited ${code}: ${stderrTail.trim()}`);
    }
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const conn = app.connect(stream);
  return { conn, kill: () => child.kill('SIGTERM') };
};

let connector: Connector = defaultConnector;
export function __setConnector(fn: Connector): void {
  connector = fn;
}
export function __resetConnector(): void {
  connector = defaultConnector;
}

// ─── pool ───────────────────────────────────────────────────────────────
const pool = new Map<string, AcpAgentHandle>();
const IDLE_TTL_MS = 10 * 60_000;
let reaper: NodeJS.Timeout | null = null;

function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, h] of pool) {
      if (h.binding.current === null && now - h.lastUsed > IDLE_TTL_MS) {
        pool.delete(key);
        h.kill();
        h.conn.close();
      }
    }
  }, 60_000);
  reaper.unref?.();
}

async function createHandle(provider: ProviderConfig): Promise<AcpAgentHandle> {
  const binding: { current: TurnBinding | null } = { current: null };
  const app = client({ name: 'caretaker' })
    .onNotification('session/update', async (ctx) => {
      const b = binding.current;
      if (!b) return;
      if (b.acpSessionId !== null && ctx.params.sessionId !== b.acpSessionId) return;
      await b.onUpdate(ctx.params);
    })
    .onRequest('session/request_permission', async (ctx) => {
      const b = binding.current;
      // No turn in flight: fail-safe cancel (never allow unattended).
      if (!b) return { outcome: { outcome: 'cancelled' as const } };
      return b.onPermission(ctx.params);
    });
  const { conn, kill } = connector(provider, app);
  const init = await conn.agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      // v1 deliberately advertises neither fs nor terminal (see spec):
      // agent-side fs writes the same bind-mounted files; shell confinement
      // under docker is deny-execute + the bridge run_command tool.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'caretaker', version: '1' },
  });
  return { conn, init, binding, kill, lastUsed: Date.now() };
}

export async function acquireAcpAgent(
  provider: ProviderConfig,
  poolKey: string | null,
): Promise<AcpAgentHandle> {
  if (poolKey) {
    const existing = pool.get(poolKey);
    if (existing) {
      if (!existing.conn.signal.aborted) {
        existing.lastUsed = Date.now();
        return existing;
      }
      pool.delete(poolKey); // dead child: recreate below
    }
  }
  const handle = await createHandle(provider);
  if (poolKey) {
    pool.set(poolKey, handle);
    ensureReaper();
    // Self-cleanup when the child dies on its own.
    void handle.conn.closed.then(() => {
      if (pool.get(poolKey) === handle) pool.delete(poolKey);
    });
  }
  return handle;
}

export function releaseAcpAgent(poolKey: string | null, handle: AcpAgentHandle): void {
  handle.lastUsed = Date.now();
  if (!poolKey) {
    handle.kill();
    handle.conn.close();
  }
}

export function __shutdownAcpPool(): void {
  for (const [key, h] of pool) {
    pool.delete(key);
    h.kill();
    h.conn.close();
  }
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}
