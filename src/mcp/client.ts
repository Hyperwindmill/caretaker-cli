// MCP client pool: lazy-connect, kept-alive, single-process singleton.
// Connections are keyed by server id. The first call to `getClient(id)`
// resolves the McpServerConfig from mcp.json, opens the configured transport,
// and caches the live Client instance. Subsequent calls hit the cache.
//
// Failure mode: a connect error is surfaced once to the caller and recorded
// on the server row (lastConnectError) so the TUI can display it. The cache
// does NOT memoize failures — the next call retries (e.g. after the server
// is restarted).
//
// Cleanup: closeAll() walks the cache and closes every live client, used by
// the boot script's exit handler.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decrypt, isEncrypted } from '../lib/encryption.js';
import { loadMcpServers, saveMcpServers } from '../store/json.js';
import { pluginAbsoluteRoot } from '../plugins/loader.js';
import type { McpServerConfig } from '../types.js';

interface PoolEntry {
  client: Client;
  close: () => Promise<void>;
}

const pool = new Map<string, PoolEntry>();
const inflight = new Map<string, Promise<Client>>();

// Test seam: when set, the pool delegates to this function instead of
// calling openClient(). Tests pass in pre-built Client + close pairs (often
// driven by InMemoryTransport from the SDK) so the caching/error logic can
// be exercised without spawning real subprocesses or HTTP servers.
type ConnectOverride = (server: McpServerConfig) => Promise<PoolEntry>;
let connectOverride: ConnectOverride | undefined;
export function __setConnectOverride(fn: ConnectOverride | undefined): void {
  connectOverride = fn;
}

function decryptHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isEncrypted(v) ? decrypt(v) : v;
  }
  return out;
}

/**
 * Expand `${VAR}` placeholders in a single string. `${CLAUDE_PLUGIN_ROOT}`
 * resolves to the owning plugin's absolute root (when known); other names
 * resolve from `process.env`. Unknown placeholders are left literal so the
 * spawned MCP server can detect and report them.
 */
function expandPlaceholders(value: string, pluginRoot: string | null): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name: string) => {
    if (name === 'CLAUDE_PLUGIN_ROOT') return pluginRoot ?? match;
    const envValue = process.env[name];
    return envValue !== undefined ? envValue : match;
  });
}

function expandStrings(value: string | undefined, pluginRoot: string | null): string | undefined {
  return value === undefined ? undefined : expandPlaceholders(value, pluginRoot);
}

function expandArray(value: string[] | undefined, pluginRoot: string | null): string[] | undefined {
  return value?.map((s) => expandPlaceholders(s, pluginRoot));
}

function expandRecord(
  value: Record<string, string> | undefined,
  pluginRoot: string | null,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) out[k] = expandPlaceholders(v, pluginRoot);
  return out;
}

async function recordConnectResult(id: string, error: string | null): Promise<void> {
  // Best-effort persistence — the connect already succeeded or failed at the
  // pool level, and a failed mcp.json write should not turn a working
  // connection into a broken one.
  try {
    const file = await loadMcpServers();
    const srv = file.servers.find((s) => s.id === id);
    if (!srv) return;
    srv.lastConnectedAt = new Date().toISOString();
    srv.lastConnectError = error;
    await saveMcpServers(file);
  } catch (err) {
    console.error(`[mcp pool] failed to persist connect result for ${id}:`, err);
  }
}

async function openClient(server: McpServerConfig): Promise<PoolEntry> {
  const client = new Client({ name: 'caretaker-cli', version: '1.0.0' }, { capabilities: {} });

  // Resolve the plugin's absolute root once (only managed rows need it; user
  // rows pass null and unknown placeholders stay literal).
  const pluginRoot = server.pluginId ? await pluginAbsoluteRoot(server.pluginId) : null;

  if (server.transport === 'stdio') {
    if (!server.command) {
      throw new Error(`MCP server "${server.name}" (stdio) is missing "command"`);
    }
    const transport = new StdioClientTransport({
      command: expandPlaceholders(server.command, pluginRoot),
      args: expandArray(server.args, pluginRoot) ?? [],
      env: expandRecord(server.env, pluginRoot),
      stderr: 'pipe',
    });
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await client.close().catch(() => {});
      },
    };
  }

  if (server.transport === 'http') {
    if (!server.url) {
      throw new Error(`MCP server "${server.name}" (http) is missing "url"`);
    }
    const decrypted = decryptHeaders(server.headers);
    const headers = expandRecord(decrypted, pluginRoot) ?? {};
    const url = expandStrings(server.url, pluginRoot)!;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
    });
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await client.close().catch(() => {});
      },
    };
  }

  throw new Error(`Unknown MCP transport: ${(server as { transport: string }).transport}`);
}

/**
 * Resolve a connected MCP Client for the given server id. Reuses a pooled
 * connection when available; otherwise resolves the McpServerConfig from
 * mcp.json and opens a fresh transport. Concurrent callers for the same id
 * share the same in-flight connect promise.
 *
 * Throws when the server id is unknown, disabled, or the transport fails to
 * open. The error message is recorded on the server row.
 */
export async function getClient(id: string): Promise<Client> {
  const cached = pool.get(id);
  if (cached) return cached.client;

  const existing = inflight.get(id);
  if (existing) return existing;

  const promise = (async () => {
    const file = await loadMcpServers();
    const server = file.servers.find((s) => s.id === id);
    if (!server) throw new Error(`MCP server ${id} not found`);
    if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled`);

    try {
      const entry = await (connectOverride ?? openClient)(server);
      pool.set(id, entry);
      await recordConnectResult(id, null);
      return entry.client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordConnectResult(id, msg);
      throw err;
    }
  })().finally(() => inflight.delete(id));

  inflight.set(id, promise);
  return promise;
}

/** Close one connection by id. No-op if not connected. */
export async function closeClient(id: string): Promise<void> {
  const entry = pool.get(id);
  if (!entry) return;
  pool.delete(id);
  await entry.close();
}

/** Close every pooled connection. Used by the boot exit handler. Errors are
 *  swallowed — we are tearing down regardless. */
export async function closeAll(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(entries.map((e) => e.close().catch(() => {})));
}

/** Test hook: drop the pool without closing (the test owns the lifecycle). */
export function __resetPool(): void {
  pool.clear();
  inflight.clear();
}

/** Test hook: expose the placeholder expander so tests can verify the
 *  exact substitution rules without spinning up a transport. */
export function __expandForTests(value: string, pluginRoot: string | null): string {
  return expandPlaceholders(value, pluginRoot);
}
