import { decrypt, encrypt } from '../../lib/encryption.js';
import type { LedgerRecord, OrchestratorConfig, OrchestratorPolicy } from '../../store/orchestrator.js';
import { sameHost } from './voice_proxy.js';

export const PROTOCOL_VERSION = 1;
export const MAX_BODY_BYTES = 1_048_576;
export const LEDGER_SIZE = 500;

export interface RemoteMessage {
  id: string;
  method: string;
  path: string;
  body?: unknown;
}

export interface ConfigInput {
  enabled: boolean;
  name: string;
  endpoint: string;
  /** Blank or absent keeps the stored token; `null` removes it. */
  token?: string | null;
  pollSeconds: unknown;
  policy: unknown;
}

export interface MessageSummary {
  id: string;
  method: string;
  path: string;
  receivedAt: string;
  state: LedgerRecord['state'];
  status?: number;
  resolvedAt?: string;
  delivered: boolean;
  /** Present on pending records only; any `repositoryToken` key is masked. */
  body?: unknown;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

/**
 * Validates an orchestrator base URL: `https` anywhere, `http` only on loopback,
 * and never with embedded userinfo. Returns null when valid, or an error string.
 */
export function validateEndpoint(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'Endpoint must be a valid URL.';
  }
  if (url.username || url.password) {
    return 'Endpoint URL must not contain credentials.';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    return isLoopbackHost(url.hostname)
      ? null
      : 'Only https:// endpoints are allowed (http:// is allowed only for localhost, 127.0.0.1, or [::1]).';
  }
  return 'Endpoint must use https:// (or http:// on loopback).';
}

/**
 * Clamps poll interval in seconds to 5..3600, defaulting to 15.
 */
export function clampPollSeconds(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return 15;
  return Math.min(3600, Math.max(5, Math.round(n)));
}

/**
 * Builds `${endpoint without trailing slashes}/${call}`.
 */
export function endpointUrl(endpoint: string, call: 'health' | 'register' | 'poll'): string {
  return `${endpoint.replace(/\/+$/, '')}/${call}`;
}

/**
 * Parses and normalizes an incoming orchestrator message.
 * - `null`: no usable id (drop, not ledgered).
 * - `{ id, error }`: ledger a 400 result.
 * - `RemoteMessage`: `path` rewritten to normalized pathname + query.
 */
export function parseMessage(raw: unknown): RemoteMessage | { id: string; error: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  const id = r.id;

  if (typeof r.method !== 'string') {
    return { id, error: 'Message method must be a string.' };
  }
  const method = r.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { id, error: `Unsupported HTTP method: ${method}` };
  }

  if (typeof r.path !== 'string' || !r.path.startsWith('/') || r.path.startsWith('//')) {
    return { id, error: 'Message path must start with a single /.' };
  }

  let normalized: URL;
  try {
    normalized = new URL(r.path, 'http://x');
  } catch {
    return { id, error: 'Invalid message path.' };
  }
  if (normalized.origin !== 'http://x' || !normalized.pathname.startsWith('/')) {
    return { id, error: 'Invalid message path.' };
  }

  const msg: RemoteMessage = {
    id,
    method,
    path: `${normalized.pathname}${normalized.search}`,
  };
  if ('body' in r && r.body !== undefined) {
    msg.body = r.body;
  }
  return msg;
}

/**
 * True when the policy requires manual approval for this HTTP method.
 */
export function needsApproval(policy: OrchestratorPolicy, method: string): boolean {
  return policy === 'approve' && method.toUpperCase() !== 'GET';
}

/**
 * Boot recovery: every `applying` record becomes `done` with a 500 result
 * and its request body removed.
 */
export function recoverLedger(records: LedgerRecord[], now: Date): LedgerRecord[] {
  const interruptedBody = encrypt(JSON.stringify({ error: 'Interrupted by a restart; outcome unknown.' }));
  const resolvedAt = now.toISOString();
  return records.map((r) => {
    if (r.state !== 'applying') return r;
    const { body: _removed, ...rest } = r;
    return {
      ...rest,
      state: 'done',
      result: { status: 500, body: interruptedBody },
      resolvedAt,
    };
  });
}

/**
 * Keeps every record that is not (done && delivered), then the newest
 * done+delivered ones until the total is LEDGER_SIZE. Order preserved.
 */
export function trimLedger(records: LedgerRecord[]): LedgerRecord[] {
  if (records.length <= LEDGER_SIZE) return records;
  let pinned = 0;
  let deliveredTotal = 0;
  for (const r of records) {
    if (r.state === 'done' && r.delivered) deliveredTotal++;
    else pinned++;
  }
  const keepDelivered = Math.max(0, LEDGER_SIZE - pinned);
  let toDrop = Math.max(0, deliveredTotal - keepDelivered);
  if (toDrop === 0) return records;

  return records.filter((r) => {
    if (r.state === 'done' && r.delivered && toDrop > 0) {
      toDrop--;
      return false;
    }
    return true;
  });
}

/**
 * Applies settings-save rules. A blank token keeps the stored blob unless the
 * endpoint host changed (in which case the token is dropped and `purgeLedger` is true).
 */
export function mergeConfigSave(
  saved: OrchestratorConfig,
  input: ConfigInput,
): { config: OrchestratorConfig; purgeLedger: boolean } | { error: string } {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (endpoint !== '') {
    const err = validateEndpoint(endpoint);
    if (err) return { error: err };
  }

  const hostChanged = saved.endpoint !== endpoint && !sameHost(saved.endpoint, endpoint);
  const typedToken = typeof input.token === 'string' ? input.token.trim() : '';
  const token =
    typedToken !== '' ? typedToken : hostChanged || input.token === null ? '' : saved.token;
  const policy: OrchestratorPolicy =
    input.policy === 'auto' || input.policy === 'approve' ? input.policy : 'approve';

  return {
    config: {
      enabled: Boolean(input.enabled),
      name: typeof input.name === 'string' ? input.name.trim() : '',
      endpoint,
      token,
      pollSeconds: clampPollSeconds(input.pollSeconds),
      policy,
      instanceId: saved.instanceId,
    },
    purgeLedger: hostChanged,
  };
}

function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskSecrets);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'repositoryToken' ? '••••' : maskSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Returns ledger records as view summaries (newest first).
 * Request body is included only for `pending` records, with `repositoryToken` masked.
 */
export function summarizeLedger(records: LedgerRecord[]): MessageSummary[] {
  const out: MessageSummary[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const summary: MessageSummary = {
      id: r.id,
      method: r.method,
      path: r.path,
      receivedAt: r.receivedAt,
      state: r.state,
      ...(r.result ? { status: r.result.status } : {}),
      ...(r.resolvedAt ? { resolvedAt: r.resolvedAt } : {}),
      delivered: r.delivered,
    };
    if (r.state === 'pending' && r.body !== undefined) {
      try {
        summary.body = maskSecrets(JSON.parse(decrypt(r.body)));
      } catch {
        // Ignore unreadable body
      }
    }
    out.push(summary);
  }
  return out;
}

/** A result recorded and not yet acknowledged by a 2xx /poll. */
export function isUndeliveredResult(r: LedgerRecord): boolean {
  return r.state === 'done' && !r.delivered && r.result !== undefined;
}
