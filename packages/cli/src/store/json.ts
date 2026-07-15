import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentConfig, CaretakerConfig, McpServersFile, PluginsFile } from '../types.js';
import { encrypt, isEncrypted } from '../lib/encryption.js';

// Path accessors are resolved at call time, not import time, so test runs
// that share a process can switch CARETAKER_HOME between suites.
export function dataDir(): string {
  return process.env.CARETAKER_HOME ?? join(homedir(), '.caretaker');
}
export function configPath(): string {
  return join(dataDir(), 'caretaker.json');
}
export function agentsPath(): string {
  return join(dataDir(), 'agents.json');
}
export function pluginsPath(): string {
  return join(dataDir(), 'plugins.json');
}
export function mcpServersPath(): string {
  return join(dataDir(), 'mcp.json');
}

export const defaultConfig: CaretakerConfig = {
  port: 17777,
  providers: [],
};

/** Returns a fresh empty PluginsFile. Callers that push into the result
 *  must not share mutation with each other — never use a shared const. */
function emptyPluginsFile(): PluginsFile {
  return { sources: [], plugins: [] };
}

async function ensureDataDir(): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[store/json] failed to read or parse ${path}:`, err);
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDataDir();
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await chmod(tmpPath, 0o600);

  // Windows: rename can fail transiently with EACCES/EPERM/EBUSY when the
  // destination is briefly locked by AV/indexer/sync clients. Retry with
  // exponential backoff so we never sacrifice atomicity to a falling-back
  // direct write.
  const maxAttempts = process.platform === 'win32' ? 5 : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(tmpPath, path);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
      if (attempt === maxAttempts || !retryable) break;
      await new Promise((r) => setTimeout(r, 50 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

export async function loadConfig(): Promise<CaretakerConfig> {
  return readJsonOrDefault(configPath(), defaultConfig);
}

export async function saveConfig(c: CaretakerConfig): Promise<void> {
  if (c.scheduler?.tasks) {
    for (const task of c.scheduler.tasks) {
      if (task.type === 'telegram' && task.telegramBotToken) {
        if (!isEncrypted(task.telegramBotToken)) {
          task.telegramBotToken = encrypt(task.telegramBotToken);
        }
      }
    }
  }
  await writeJson(configPath(), c);
}

export async function loadAgents(): Promise<AgentConfig[]> {
  return readJsonOrDefault(agentsPath(), []);
}

export async function saveAgents(a: AgentConfig[]): Promise<void> {
  await writeJson(agentsPath(), a);
}

export async function loadPlugins(): Promise<PluginsFile> {
  const file = await readJsonOrDefault<PluginsFile>(pluginsPath(), emptyPluginsFile());
  // Defensive shallow copy: never hand callers a reference into a default
  // singleton — pushes into file.sources would otherwise persist into the
  // next loadPlugins() return.
  return {
    sources: Array.isArray(file.sources) ? [...file.sources] : [],
    plugins: Array.isArray(file.plugins) ? [...file.plugins] : [],
  };
}

export async function savePlugins(file: PluginsFile): Promise<void> {
  await writeJson(pluginsPath(), file);
}

function emptyMcpServersFile(): McpServersFile {
  return { servers: [] };
}

export async function loadMcpServers(): Promise<McpServersFile> {
  const file = await readJsonOrDefault<McpServersFile>(mcpServersPath(), emptyMcpServersFile());
  // Same defensive copy as loadPlugins — auth headers are sensitive, and
  // handing back a shared reference invites mutation bugs.
  return {
    servers: Array.isArray(file.servers) ? [...file.servers] : [],
  };
}

export async function saveMcpServers(file: McpServersFile): Promise<void> {
  await writeJson(mcpServersPath(), file);
}

let mcpPromiseChain = Promise.resolve();

/**
 * Execute a function within a non-reentrant serialization lock for mcp.json operations.
 * Protects against lost updates when multiple async read-modify-write cycles overlap.
 */
export async function withMcpServersLock<T>(fn: () => Promise<T>): Promise<T> {
  const resultPromise = mcpPromiseChain.then(() => fn());
  mcpPromiseChain = resultPromise.then(
    () => {},
    () => {},
  );
  return resultPromise;
}

