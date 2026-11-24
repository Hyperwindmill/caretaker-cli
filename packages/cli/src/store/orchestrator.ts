import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './json.js';
import { encrypt, isEncrypted } from '../lib/encryption.js';
import { atomicWriteFile } from '../cli/web/scheduler/telegram_window.js';

export type OrchestratorPolicy = 'auto' | 'approve';

export interface OrchestratorConfig {
  enabled: boolean;
  name: string;
  endpoint: string;
  /** Encrypted blob, or '' when none. */
  token: string;
  pollSeconds: number;
  policy: OrchestratorPolicy;
  instanceId: string;
}

export interface LedgerRecord {
  id: string;
  method: string;
  path: string;
  /** encrypt(JSON.stringify(body)); removed when state becomes 'done'. */
  body?: string;
  receivedAt: string;
  state: 'pending' | 'applying' | 'done';
  /** body encrypted the same way; removed on delivery. */
  result?: { status: number; body?: string };
  resolvedAt?: string;
  delivered: boolean;
}

export function orchestratorPath(): string {
  return path.join(dataDir(), 'orchestrator.json');
}

export function orchestratorLedgerPath(): string {
  return path.join(dataDir(), 'orchestrator-ledger.json');
}

async function readRaw(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(orchestratorPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable file -> defaults
  }
  return {};
}

const hasInstanceId = (raw: Record<string, unknown>) =>
  typeof raw.instanceId === 'string' && raw.instanceId.length > 0;

/** The one in-flight instanceId creation: concurrent first loads (the loop and
 *  the settings GET at boot) would otherwise each mint and save their own id. */
let idCreation: Promise<void> | null = null;

/**
 * Loads orchestrator.json with defaults (disabled, '', '', '', 15, 'approve').
 * Generates and persists `instanceId` (randomUUID) when missing.
 * Always returns a fresh object.
 */
export async function loadOrchestrator(): Promise<OrchestratorConfig> {
  let raw = await readRaw();
  if (!hasInstanceId(raw)) {
    idCreation ??= (async () => {
      const again = await readRaw();
      if (!hasInstanceId(again)) await saveOrchestrator(normalize({ ...again, instanceId: randomUUID() }));
    })().finally(() => {
      idCreation = null;
    });
    await idCreation;
    raw = await readRaw();
  }
  return normalize(raw);
}

function normalize(raw: Record<string, unknown>): OrchestratorConfig {
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
    name: typeof raw.name === 'string' ? raw.name : '',
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    token: typeof raw.token === 'string' ? raw.token : '',
    pollSeconds: typeof raw.pollSeconds === 'number' && Number.isFinite(raw.pollSeconds) ? raw.pollSeconds : 15,
    policy: raw.policy === 'auto' || raw.policy === 'approve' ? raw.policy : 'approve',
    instanceId: hasInstanceId(raw) ? (raw.instanceId as string) : '',
  };
}

/**
 * Persists orchestrator.json atomically. Encrypts `token` when it is not
 * already an encrypted blob.
 */
export async function saveOrchestrator(c: OrchestratorConfig): Promise<void> {
  const copy: OrchestratorConfig = { ...c };
  if (copy.token && !isEncrypted(copy.token)) {
    copy.token = encrypt(copy.token);
  }
  const filePath = orchestratorPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, JSON.stringify(copy, null, 2));
}

function isValidLedgerRecord(r: unknown): r is LedgerRecord {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (typeof o.method !== 'string') return false;
  if (typeof o.path !== 'string') return false;
  if (typeof o.receivedAt !== 'string') return false;
  if (o.state !== 'pending' && o.state !== 'applying' && o.state !== 'done') return false;
  if (typeof o.delivered !== 'boolean') return false;
  if (o.body !== undefined && typeof o.body !== 'string') return false;
  if (o.resolvedAt !== undefined && typeof o.resolvedAt !== 'string') return false;
  if (o.result !== undefined) {
    if (!o.result || typeof o.result !== 'object' || Array.isArray(o.result)) return false;
    const res = o.result as Record<string, unknown>;
    if (typeof res.status !== 'number' || !Number.isFinite(res.status)) return false;
    if (res.body !== undefined && typeof res.body !== 'string') return false;
  }
  return true;
}

/**
 * Loads orchestrator-ledger.json. Unreadable or non-array file returns [].
 * Malformed records are dropped.
 */
export async function loadLedger(): Promise<LedgerRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(orchestratorLedgerPath(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidLedgerRecord);
  } catch {
    return [];
  }
}

/**
 * Persists orchestrator-ledger.json atomically.
 */
export async function saveLedger(records: LedgerRecord[]): Promise<void> {
  const filePath = orchestratorLedgerPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, JSON.stringify(records, null, 2));
}
