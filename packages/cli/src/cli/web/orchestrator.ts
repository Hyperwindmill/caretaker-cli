import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import { decrypt, encrypt } from '../../lib/encryption.js';
import {
  loadLedger,
  loadOrchestrator,
  saveLedger,
  saveOrchestrator,
  type LedgerRecord,
} from '../../store/orchestrator.js';
import { isDocumentedRoute } from './openapi.js';
import {
  endpointUrl,
  MAX_BODY_BYTES,
  mergeConfigSave,
  needsApproval,
  parseMessage,
  PROTOCOL_VERSION,
  recoverLedger,
  summarizeLedger,
  trimLedger,
  validateEndpoint,
  type ConfigInput,
  type RemoteMessage,
} from './orchestrator_core.js';
import { sameHost } from './voice_proxy.js';

export type AppLike = {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
};

export interface CycleDeps {
  app: AppLike;
  fetch: typeof fetch;
  now?: () => Date;
}

export interface OrchestratorStatus {
  state: 'off' | 'registering' | 'connected' | 'error';
  orchestratorName?: string;
  lastPollAt?: string;
  lastError?: string;
}

const OUTBOUND_TIMEOUT_MS = 30_000;

let status: OrchestratorStatus = { state: 'off' };
let registered = false;
let recoveredThisProcess = false;
let ledgerMutex: Promise<void> = Promise.resolve();
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let loopGen = 0;

function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ledgerMutex.then(fn, fn);
  ledgerMutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function cliVersion(): string {
  try {
    return (
      JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
  } catch {
    return '0.0.0';
  }
}

function oneLineError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').trim() || 'Unknown error';
}

async function ensureRecovered(now: Date): Promise<void> {
  if (recoveredThisProcess) return;
  await withLedgerLock(async () => {
    if (recoveredThisProcess) return;
    const records = await loadLedger();
    if (records.some((r) => r.state === 'applying')) {
      await saveLedger(trimLedger(recoverLedger(records, now)));
    }
    recoveredThisProcess = true;
  });
}

function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

function decryptJson(blob: string): unknown {
  return JSON.parse(decrypt(blob));
}

/**
 * Runs one request against the in-process Hono app. Never throws.
 * Refuses (404) when the normalized pathname is not documented in OpenAPI.
 * Response bodies over MAX_BODY_BYTES become 413.
 */
export async function applyMessage(
  app: AppLike,
  msg: RemoteMessage,
): Promise<{ status: number; body: unknown }> {
  let pathname: string;
  try {
    pathname = new URL(msg.path, 'http://x').pathname;
  } catch {
    return { status: 400, body: { error: 'Invalid message path.' } };
  }
  if (!isDocumentedRoute(msg.method, pathname)) {
    return { status: 404, body: { error: 'Route is not documented in OpenAPI.' } };
  }

  const init: RequestInit = { method: msg.method };
  if (msg.body !== undefined && msg.method !== 'GET' && msg.method !== 'HEAD') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(msg.body);
  }

  let res: Response;
  try {
    res = await app.request(msg.path, init);
  } catch (err) {
    return { status: 500, body: { error: oneLineError(err) } };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return { status: 500, body: { error: oneLineError(err) } };
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return { status: 413, body: { error: 'Response body exceeded 1 MB limit.' } };
  }

  if (text === '') {
    return { status: res.status, body: null };
  }
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/**
 * One register-if-needed + poll cycle. Never throws; failures land in status.
 */
export async function runCycle(deps: CycleDeps): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  try {
    await ensureRecovered(now);
    const cfg = await loadOrchestrator();

    if (!cfg.enabled) {
      registered = false;
      status = { state: 'off' };
      return;
    }

    const token = cfg.token ? decrypt(cfg.token) : '';
    if (!cfg.endpoint || !token) {
      registered = false;
      status = { state: 'error', lastError: 'Endpoint and token are required.' };
      return;
    }

    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };

    if (!registered) {
      status = {
        state: 'registering',
        ...(status.orchestratorName ? { orchestratorName: status.orchestratorName } : {}),
        ...(status.lastPollAt ? { lastPollAt: status.lastPollAt } : {}),
      };
      const regRes = await deps.fetch(endpointUrl(cfg.endpoint, 'register'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocol: PROTOCOL_VERSION,
          instanceId: cfg.instanceId,
          name: cfg.name,
          version: cliVersion(),
        }),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      if (!regRes.ok) {
        status = { ...status, state: 'error', lastError: `Register failed: HTTP ${regRes.status}` };
        return;
      }
      let regData: unknown;
      try {
        regData = JSON.parse(await regRes.text());
      } catch {
        status = { ...status, state: 'error', lastError: 'Register returned non-JSON response.' };
        return;
      }
      if (!regData || typeof regData !== 'object' || (regData as Record<string, unknown>).ok !== true) {
        status = { ...status, state: 'error', lastError: 'Register response did not confirm ok.' };
        return;
      }
      const orchName =
        typeof (regData as Record<string, unknown>).name === 'string'
          ? ((regData as Record<string, unknown>).name as string)
          : status.orchestratorName;
      registered = true;
      status = {
        state: 'registering',
        ...(orchName !== undefined ? { orchestratorName: orchName } : {}),
        ...(status.lastPollAt ? { lastPollAt: status.lastPollAt } : {}),
      };
    }

    const pendingResults = await withLedgerLock(async () => {
      const records = await loadLedger();
      return records
        .filter((r) => r.state === 'done' && !r.delivered && r.result)
        .map((r) => ({
          id: r.id,
          status: r.result!.status,
          body: r.result!.body !== undefined ? decryptJson(r.result!.body) : null,
        }));
    });

    const pollRes = await deps.fetch(endpointUrl(cfg.endpoint, 'poll'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instanceId: cfg.instanceId,
        results: pendingResults,
      }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });

    if (
      pollRes.status === 401 ||
      pollRes.status === 403 ||
      pollRes.status === 404 ||
      pollRes.status === 409
    ) {
      registered = false;
      status = { ...status, state: 'error', lastError: `Poll rejected: HTTP ${pollRes.status}` };
      return;
    }
    if (!pollRes.ok) {
      status = { ...status, state: 'error', lastError: `Poll failed: HTTP ${pollRes.status}` };
      return;
    }

    let pollData: unknown;
    try {
      pollData = JSON.parse(await pollRes.text());
    } catch {
      status = { ...status, state: 'error', lastError: 'Poll returned non-JSON response.' };
      return;
    }
    if (
      !pollData ||
      typeof pollData !== 'object' ||
      Array.isArray(pollData) ||
      !Array.isArray((pollData as Record<string, unknown>).messages)
    ) {
      status = { ...status, state: 'error', lastError: 'Poll response missing messages array.' };
      return;
    }

    if (pendingResults.length > 0) {
      const deliveredIds = new Set(pendingResults.map((r) => r.id));
      await withLedgerLock(async () => {
        const records = await loadLedger();
        let changed = false;
        for (const r of records) {
          if (deliveredIds.has(r.id) && !r.delivered) {
            r.delivered = true;
            if (r.result) delete r.result.body;
            changed = true;
          }
        }
        if (changed) {
          await saveLedger(trimLedger(records));
        }
      });
    }

    status = {
      state: 'connected',
      ...(status.orchestratorName !== undefined ? { orchestratorName: status.orchestratorName } : {}),
      lastPollAt: now.toISOString(),
    };

    const messages = (pollData as { messages: unknown[] }).messages;
    for (const raw of messages) {
      const parsed = parseMessage(raw);
      if (parsed === null) {
        status = { ...status, lastError: 'The orchestrator sent a message without an id.' };
        continue;
      }

      if ('error' in parsed) {
        await withLedgerLock(async () => {
          const records = await loadLedger();
          if (records.some((r) => r.id === parsed.id)) return;
          records.push({
            id: parsed.id,
            method: '',
            path: '',
            receivedAt: now.toISOString(),
            state: 'done',
            result: { status: 400, body: encryptJson({ error: parsed.error }) },
            resolvedAt: now.toISOString(),
            delivered: false,
          });
          await saveLedger(trimLedger(records));
        });
        continue;
      }

      const pathname = new URL(parsed.path, 'http://x').pathname;
      if (!isDocumentedRoute(parsed.method, pathname)) {
        await withLedgerLock(async () => {
          const records = await loadLedger();
          if (records.some((r) => r.id === parsed.id)) return;
          records.push({
            id: parsed.id,
            method: parsed.method,
            path: parsed.path,
            receivedAt: now.toISOString(),
            state: 'done',
            result: { status: 404, body: encryptJson({ error: 'Route is not documented in OpenAPI.' }) },
            resolvedAt: now.toISOString(),
            delivered: false,
          });
          await saveLedger(trimLedger(records));
        });
        continue;
      }

      if (needsApproval(cfg.policy, parsed.method)) {
        await withLedgerLock(async () => {
          const records = await loadLedger();
          if (records.some((r) => r.id === parsed.id)) return;
          records.push({
            id: parsed.id,
            method: parsed.method,
            path: parsed.path,
            ...(parsed.body !== undefined ? { body: encryptJson(parsed.body) } : {}),
            receivedAt: now.toISOString(),
            state: 'pending',
            delivered: false,
          });
          await saveLedger(trimLedger(records));
        });
        continue;
      }

      const claimed = await withLedgerLock(async () => {
        const records = await loadLedger();
        if (records.some((r) => r.id === parsed.id)) return false;
        records.push({
          id: parsed.id,
          method: parsed.method,
          path: parsed.path,
          ...(parsed.body !== undefined ? { body: encryptJson(parsed.body) } : {}),
          receivedAt: now.toISOString(),
          state: 'applying',
          delivered: false,
        });
        await saveLedger(trimLedger(records));
        return true;
      });
      if (!claimed) continue;

      const applied = await applyMessage(deps.app, parsed);
      const resolvedAt = (deps.now ? deps.now() : new Date()).toISOString();
      await withLedgerLock(async () => {
        const records = await loadLedger();
        const rec = records.find((r) => r.id === parsed.id);
        if (!rec) return;
        delete rec.body;
        rec.state = 'done';
        rec.resolvedAt = resolvedAt;
        rec.result = { status: applied.status, body: encryptJson(applied.body) };
        await saveLedger(trimLedger(records));
      });
    }
  } catch (err) {
    status = { ...status, state: 'error', lastError: oneLineError(err) };
  }
}

/**
 * Approves or rejects a pending ledger message.
 */
export async function resolvePending(
  app: AppLike,
  id: string,
  decision: 'approve' | 'reject',
): Promise<'ok' | 'not_found' | 'not_pending'> {
  const step = await withLedgerLock(async () => {
    const records = await loadLedger();
    const rec = records.find((r) => r.id === id);
    if (!rec) return { status: 'not_found' as const };
    if (rec.state !== 'pending') return { status: 'not_pending' as const };

    if (decision === 'reject') {
      delete rec.body;
      rec.state = 'done';
      rec.resolvedAt = new Date().toISOString();
      rec.result = { status: 403, body: encryptJson({ error: 'Rejected by the user.' }) };
      await saveLedger(trimLedger(records));
      return { status: 'ok' as const };
    }

    rec.state = 'applying';
    const msg: RemoteMessage = {
      id: rec.id,
      method: rec.method,
      path: rec.path,
      ...(rec.body !== undefined ? { body: decryptJson(rec.body) } : {}),
    };
    await saveLedger(trimLedger(records));
    return { status: 'apply' as const, msg };
  });

  if (step.status !== 'apply') return step.status;

  const applied = await applyMessage(app, step.msg);
  const resolvedAt = new Date().toISOString();
  await withLedgerLock(async () => {
    const records = await loadLedger();
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    delete rec.body;
    rec.state = 'done';
    rec.resolvedAt = resolvedAt;
    rec.result = { status: applied.status, body: encryptJson(applied.body) };
    await saveLedger(trimLedger(records));
  });
  return 'ok';
}

export function orchestratorStatus(): OrchestratorStatus {
  return { ...status };
}

/**
 * Test hook and config-save hook: forgets registration, status, and recovery flag.
 */
export function resetOrchestrator(): void {
  registered = false;
  recoveredThisProcess = false;
  status = { state: 'off' };
}

export function stopOrchestrator(): void {
  loopGen++;
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

/**
 * (Re)starts the self-rescheduling poll loop from the saved config.
 * Runs recoverLedger once per process before the first cycle.
 */
export function startOrchestrator(app: AppLike, fetchImpl: typeof fetch = fetch): void {
  stopOrchestrator();
  const gen = loopGen;

  const tick = async () => {
    if (gen !== loopGen) return;
    try {
      await ensureRecovered(new Date());
      await runCycle({ app, fetch: fetchImpl });
    } catch (err) {
      console.error('[orchestrator]', err);
    }
    if (gen !== loopGen) return;

    let delayMs = 15_000;
    try {
      const cfg = await loadOrchestrator();
      if (!cfg.enabled) return;
      delayMs = cfg.pollSeconds * 1000;
    } catch (err) {
      console.error('[orchestrator]', err);
    }
    if (gen !== loopGen) return;
    loopTimer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  void tick();
}

async function buildView() {
  const cfg = await loadOrchestrator();
  const ledger = await loadLedger();
  return {
    config: {
      enabled: cfg.enabled,
      name: cfg.name,
      endpoint: cfg.endpoint,
      hasToken: Boolean(cfg.token),
      pollSeconds: cfg.pollSeconds,
      policy: cfg.policy,
      instanceId: cfg.instanceId,
    },
    status: orchestratorStatus(),
    pending: ledger.filter((r) => r.state === 'pending').length,
    messages: summarizeLedger(ledger),
  };
}

export function registerOrchestrator(app: Hono, fetchImpl: typeof fetch = fetch): void {
  app.get('/api/orchestrator', async (c) => {
    return c.json(await buildView());
  });

  app.put('/api/orchestrator', async (c) => {
    let body: ConfigInput;
    try {
      body = (await c.req.json()) as ConfigInput;
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400);
    }
    const saved = await loadOrchestrator();
    const merged = mergeConfigSave(saved, body);
    if ('error' in merged) {
      return c.json({ error: merged.error }, 400);
    }
    await saveOrchestrator(merged.config);
    if (merged.purgeLedger) {
      await withLedgerLock(() => saveLedger([]));
    }
    resetOrchestrator();
    startOrchestrator(app, fetchImpl);
    return c.json(await buildView());
  });

  app.post('/api/orchestrator/test', async (c) => {
    let body: { endpoint?: unknown; token?: unknown };
    try {
      body = (await c.req.json()) as { endpoint?: unknown; token?: unknown };
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body.' });
    }
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      return c.json({ ok: false, error: 'Endpoint is required.' });
    }
    const endpointErr = validateEndpoint(endpoint);
    if (endpointErr) {
      return c.json({ ok: false, error: endpointErr });
    }

    const saved = await loadOrchestrator();
    const typedToken = typeof body.token === 'string' ? body.token.trim() : '';
    let token = '';
    if (typedToken) {
      token = typedToken;
    } else if (sameHost(saved.endpoint, endpoint) && saved.token) {
      try {
        token = decrypt(saved.token);
      } catch {
        token = '';
      }
    }
    if (!token) {
      return c.json({ ok: false, error: 'Token is required.' });
    }

    try {
      const res = await fetchImpl(endpointUrl(endpoint, 'health'), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      if (!res.ok) {
        return c.json({ ok: false, error: `HTTP ${res.status}` });
      }
      const data = JSON.parse(await res.text()) as Record<string, unknown>;
      if (data.protocol !== PROTOCOL_VERSION) {
        return c.json({
          ok: false,
          protocol: data.protocol,
          error: `Protocol mismatch: orchestrator reported ${String(data.protocol)}, expected ${PROTOCOL_VERSION}.`,
        });
      }
      return c.json({
        ok: true,
        name: typeof data.name === 'string' ? data.name : '',
        protocol: PROTOCOL_VERSION,
      });
    } catch (err) {
      return c.json({ ok: false, error: oneLineError(err) });
    }
  });

  app.post('/api/orchestrator/messages/:id/approve', async (c) => {
    const result = await resolvePending(app, c.req.param('id'), 'approve');
    if (result === 'not_found') return c.json({ error: 'Message not found.' }, 404);
    if (result === 'not_pending') return c.json({ error: 'Message is not pending.' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/orchestrator/messages/:id/reject', async (c) => {
    const result = await resolvePending(app, c.req.param('id'), 'reject');
    if (result === 'not_found') return c.json({ error: 'Message not found.' }, 404);
    if (result === 'not_pending') return c.json({ error: 'Message is not pending.' }, 409);
    return c.json({ ok: true });
  });
}
