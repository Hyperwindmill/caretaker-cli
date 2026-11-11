import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentConfig, CaretakerConfig, McpServersFile, PluginsFile } from '../types.js';
import { encrypt, isEncrypted } from '../lib/encryption.js';

// Re-exported through the package's `./store` entry point so every surface that
// persists config (web server, VSCode extension) enforces the same rule on
// `projects[].repositoryUrl` before calling saveConfig.
export { validateRepositoryUrl } from '../lib/repo_url.js';
export { validateProjectSlug, validateProjectIds, PROJECT_SLUG_RE } from '../lib/project_slug.js';

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
export function uiStatePath(): string {
  return join(dataDir(), 'ui-state.json');
}
export function apiAccessPath(): string {
  return join(dataDir(), 'api.json');
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
  const cfg = await readJsonOrDefault(configPath(), defaultConfig);
  // Numeric project ids from older versions become their string slugs ("3").
  for (const p of cfg.projects || []) (p as any).id = String(p.id);
  return cfg;
}

export async function saveConfig(c: CaretakerConfig): Promise<void> {
  if (c.scheduler?.tasks) {
    for (const task of c.scheduler.tasks) {
      if (task.type === 'telegram' && task.telegramBotToken) {
        if (!isEncrypted(task.telegramBotToken)) {
          task.telegramBotToken = encrypt(task.telegramBotToken);
        }
      }
      if (task.type === 'email' && task.imapPassword && !isEncrypted(task.imapPassword)) {
        task.imapPassword = encrypt(task.imapPassword);
      }
      if (task.type === 'email' && task.smtpPassword && !isEncrypted(task.smtpPassword)) {
        task.smtpPassword = encrypt(task.smtpPassword);
      }
    }
  }
  for (const project of c.projects || []) {
    if (project.repositoryToken && !isEncrypted(project.repositoryToken)) {
      project.repositoryToken = encrypt(project.repositoryToken);
    }
  }
  if (c.voice?.apiKey && !isEncrypted(c.voice.apiKey)) {
    c.voice.apiKey = encrypt(c.voice.apiKey);
  }
  if (c.voice?.ttsApiKey && !isEncrypted(c.voice.ttsApiKey)) {
    c.voice.ttsApiKey = encrypt(c.voice.ttsApiKey);
  }
  await writeJson(configPath(), c);
}

/** UI preferences that must survive the desktop app, whose per-launch port
 *  gives every launch a fresh origin (and so a fresh localStorage). Kept out of
 *  caretaker.json on purpose: the settings form saves that file whole from the
 *  copy it loaded, which would put back a stale value. */
export interface UiState {
  lastProjectId?: string;
}

export async function loadUiState(): Promise<UiState> {
  return readJsonOrDefault<UiState>(uiStatePath(), {});
}

export async function saveUiState(s: UiState): Promise<void> {
  await writeJson(uiStatePath(), s);
}

/** One API token as stored: the token itself is shown once at creation and
 *  only its SHA-256 is kept. A plain hash is enough because the token is 32
 *  random bytes, not a password. */
export interface ApiTokenRecord {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
}

/** `api.json`: the authenticated API listener's port and its tokens. Kept out
 *  of caretaker.json for the same reason as the UI state — the settings form
 *  saves that file whole from a stale copy — and so the hashes never travel
 *  to the view inside the config. */
export interface ApiAccess {
  /** Unset = the listener is off. */
  port?: number;
  tokens: ApiTokenRecord[];
}

const hashApiToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function loadApiAccess(): Promise<ApiAccess> {
  const raw = await readJsonOrDefault<Partial<ApiAccess>>(apiAccessPath(), {});
  const port = Number.isInteger(raw.port) && raw.port! >= 1 && raw.port! <= 65535 ? raw.port : undefined;
  const tokens = Array.isArray(raw.tokens)
    ? raw.tokens.filter((t) => t && typeof t.id === 'string' && typeof t.hash === 'string')
    : [];
  return port === undefined ? { tokens } : { port, tokens };
}

export async function setApiPort(port: number | null): Promise<void> {
  const { tokens } = await loadApiAccess();
  await writeJson(apiAccessPath(), port === null ? { tokens } : { port, tokens });
}

/** Creates a token and returns it in clear — the only time it exists outside
 *  the caller's hands. */
export async function createApiToken(name: string): Promise<{ token: string; record: ApiTokenRecord }> {
  const access = await loadApiAccess();
  const token = `ctk_${randomBytes(32).toString('base64url')}`;
  const record: ApiTokenRecord = {
    id: randomUUID(),
    name: name.trim() || 'token',
    hash: hashApiToken(token),
    createdAt: new Date().toISOString(),
  };
  access.tokens.push(record);
  await writeJson(apiAccessPath(), access);
  return { token, record };
}

export async function revokeApiToken(id: string): Promise<boolean> {
  const access = await loadApiAccess();
  const tokens = access.tokens.filter((t) => t.id !== id);
  if (tokens.length === access.tokens.length) return false;
  await writeJson(apiAccessPath(), { ...access, tokens });
  return true;
}

export async function verifyApiToken(token: string): Promise<boolean> {
  if (!token) return false;
  const presented = Buffer.from(hashApiToken(token), 'hex');
  const { tokens } = await loadApiAccess();
  let ok = false;
  for (const t of tokens) {
    const stored = Buffer.from(t.hash, 'hex');
    // No early exit: every stored hash is compared, in constant time each.
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) ok = true;
  }
  return ok;
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

