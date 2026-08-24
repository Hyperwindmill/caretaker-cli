import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaretakerConfig, ProviderConfig } from '../../../types.js';
import type { MessageRecord } from '../../../session/types.js';
import { sessionsRoot, readSession } from '../../../session/store.js';
import { loadConfig } from '../../../store/json.js';
import {
  deleteSessionDigest,
  listSessionDigests,
  saveSessionDigest,
  type SessionDigest,
} from '../../../store/db.js';

export const DEFAULT_SWEEP_MINUTES = 5;
export const DEFAULT_MIN_NEW_MESSAGES = 4;
export const MAX_CALLS_PER_SWEEP = 10;
export const MAX_CHUNK_CHARS = 20_000;
export const MAX_TOOL_RESULT_CHARS = 500;
export const MAX_SUMMARY_CHARS = 4_000;

export interface ResolvedMemoryConfig {
  provider: ProviderConfig;
  model: string;
  sweepMinutes: number;
  minNewMessages: number;
}

/** null = subsystem off (unset/incomplete config, unknown provider, or a
 *  claude-code provider — no HTTP endpoint for fresh calls). */
export function resolveMemoryConfig(config: CaretakerConfig): ResolvedMemoryConfig | null {
  const m = config.memory;
  if (!m?.provider || !m.model) return null;
  const provider = (config.providers || []).find((p) => p.name === m.provider);
  if (!provider || provider.type === 'claude-code') return null;
  return {
    provider,
    model: m.model,
    sweepMinutes: m.sweepMinutes ?? DEFAULT_SWEEP_MINUTES,
    minNewMessages: m.minNewMessages ?? DEFAULT_MIN_NEW_MESSAGES,
  };
}

/** One role-labelled line per message. Thinking parts are dropped (never fed
 *  to the memory model); tool results are hard-truncated — they are the
 *  largest strings in a session and carry the least durable meaning. */
export function formatMessage(m: MessageRecord): string {
  if (m.role === 'tool') {
    const body =
      m.content.length > MAX_TOOL_RESULT_CHARS
        ? m.content.slice(0, MAX_TOOL_RESULT_CHARS) + '…'
        : m.content;
    return `[tool result] ${body}`;
  }
  if (m.role === 'assistant' && m.parts?.length) {
    const parts: string[] = [];
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim()) parts.push(p.text);
      else if (p.type === 'tool_use') parts.push(`[calls tool: ${p.name}]`);
    }
    return `assistant: ${parts.join('\n')}`;
  }
  return `${m.role}: ${m.content}`;
}

/** Index of the cursor message; -1 when lastMessageId is '' or not found
 *  (both mean: process from the beginning). */
export function locateCursor(messages: MessageRecord[], lastMessageId: string): number {
  if (!lastMessageId) return -1;
  return messages.findIndex((m) => m.id === lastMessageId);
}

/** Consecutive chunks whose formatted text stays under MAX_CHUNK_CHARS. A
 *  single oversized message becomes its own chunk with its text truncated —
 *  the cursor must always be able to advance past it. */
export function chunkMessages(
  messages: MessageRecord[]
): Array<{ messages: MessageRecord[]; text: string }> {
  const chunks: Array<{ messages: MessageRecord[]; text: string }> = [];
  let cur: MessageRecord[] = [];
  let curTexts: string[] = [];
  let curLen = 0;
  for (const m of messages) {
    let t = formatMessage(m);
    if (t.length > MAX_CHUNK_CHARS) t = t.slice(0, MAX_CHUNK_CHARS) + '…';
    if (curLen + t.length > MAX_CHUNK_CHARS && cur.length > 0) {
      chunks.push({ messages: cur, text: curTexts.join('\n') });
      cur = [];
      curTexts = [];
      curLen = 0;
    }
    cur.push(m);
    curTexts.push(t);
    curLen += t.length + 1;
  }
  if (cur.length > 0) chunks.push({ messages: cur, text: curTexts.join('\n') });
  return chunks;
}

const SUMMARIZE_INSTRUCTION =
  'You maintain a rolling summary of a conversation between a user and an AI agent. ' +
  'Integrate the NEW MESSAGES into the PREVIOUS SUMMARY and rewrite it as ONE standalone summary. ' +
  'Keep durable facts, decisions, preferences, constraints, and open threads; drop pleasantries and dead ends. ' +
  'Plain text, at most 300 words. Reply with only the summary.';

/** null = failure (network, non-OK, empty/malformed response). The caller
 *  leaves the cursor where it was; the next sweep retries. Best-effort, the
 *  same contract as titling (harness/title.ts). */
export type SummarizeFn = (prevSummary: string, chunkText: string) => Promise<string | null>;

export function buildSummarizePrompt(prevSummary: string, chunkText: string): string {
  return [
    SUMMARIZE_INSTRUCTION,
    '',
    'PREVIOUS SUMMARY:',
    prevSummary.trim() || '(none)',
    '',
    'NEW MESSAGES:',
    chunkText,
  ].join('\n');
}

export function makeSummarizer(resolved: ResolvedMemoryConfig): SummarizeFn {
  return async (prevSummary, chunkText) => {
    const baseUrl = resolved.provider.endpoint.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.provider.apiKey) headers.Authorization = `Bearer ${resolved.provider.apiKey}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolved.model,
          stream: false,
          messages: [{ role: 'user', content: buildSummarizePrompt(prevSummary, chunkText) }],
        }),
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      const raw = json?.choices?.[0]?.message?.content?.trim();
      if (!raw) return null;
      return raw.length > MAX_SUMMARY_CHARS ? raw.slice(0, MAX_SUMMARY_CHARS) + '…' : raw;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface SweepResult {
  scanned: number;
  summarized: number;
  calls: number;
  budgetSkipped: number;
}

/** One full pass over every session on disk. Sessions written by any surface
 *  are picked up — the sweep reads shared state, it is not wired per surface.
 *  Failures are per-session and best-effort: warn, skip, retry next sweep. */
export async function sweepMemory(
  resolved: ResolvedMemoryConfig,
  summarize: SummarizeFn
): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, summarized: 0, calls: 0, budgetSkipped: 0 };
  const root = sessionsRoot();
  let agentIds: string[] = [];
  try {
    agentIds = await readdir(root);
  } catch {
    return result; // no sessions dir yet — nothing to do
  }
  const digests = new Map((await listSessionDigests()).map((d) => [d.id, d]));
  const seen = new Set<string>();

  for (const agentId of agentIds) {
    let files: string[] = [];
    try {
      files = (await readdir(join(root, agentId))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue; // stray non-directory entry
    }
    for (const file of files) {
      const sessionId = file.slice(0, -'.jsonl'.length);
      seen.add(sessionId);
      const digest = digests.get(sessionId) ?? null;
      const path = join(root, agentId, file);

      // mtime gate: scannedAt is only ever written when the digest was fully
      // caught up (see invariant below), so mtime < scannedAt ⇒ nothing new.
      try {
        const st = await stat(path);
        if (digest && st.mtime.getTime() < new Date(digest.scannedAt).getTime()) continue;
      } catch {
        continue; // vanished between readdir and stat; cleanup pass handles the digest
      }

      // Captured BEFORE the read: an append racing the read keeps
      // mtime ≥ scannedAt, so the session is re-read next sweep.
      const scannedAt = new Date().toISOString();
      let session: Awaited<ReturnType<typeof readSession>>;
      try {
        session = await readSession(agentId, sessionId);
      } catch (err) {
        console.warn(`[memory] failed to read session ${sessionId}:`, err);
        continue;
      }
      result.scanned++;

      let record: SessionDigest = digest ?? {
        id: sessionId,
        agentId,
        lastMessageId: '',
        messageCount: 0,
        summary: '',
        model: '',
        scannedAt: '',
        updatedAt: '',
      };
      const idx = locateCursor(session.messages, record.lastMessageId);
      if (record.lastMessageId && idx === -1) {
        // Cursor lost (rewritten/truncated file): restart from message zero.
        record = { ...record, lastMessageId: '', messageCount: 0, summary: '', model: '' };
      }
      const fresh = session.messages.slice(idx + 1);

      if (fresh.length < resolved.minNewMessages) {
        // Debounce: arm the mtime gate and wait for the next append.
        await saveSessionDigest({ ...record, agentId, scannedAt });
        continue;
      }

      // INVARIANT: per-chunk saves keep the OLD scannedAt. The new one is
      // only persisted when every chunk succeeded — a budget stop or model
      // failure must leave the session mtime-gate-open for the next sweep.
      let caughtUp = true;
      for (const chunk of chunkMessages(fresh)) {
        if (result.calls >= MAX_CALLS_PER_SWEEP) {
          result.budgetSkipped++;
          caughtUp = false;
          break;
        }
        result.calls++;
        const summary = await summarize(record.summary, chunk.text);
        if (summary === null) {
          caughtUp = false;
          break; // cursor stays; next sweep retries
        }
        const last = chunk.messages[chunk.messages.length - 1]!;
        record = {
          ...record,
          agentId,
          lastMessageId: last.id,
          messageCount: record.messageCount + chunk.messages.length,
          summary,
          model: resolved.model,
        };
        await saveSessionDigest(record); // crash loses at most one chunk
        result.summarized++;
      }
      if (caughtUp) {
        await saveSessionDigest({ ...record, agentId, scannedAt });
      }
    }
  }

  // Regenerable-cache hygiene: drop digests whose session no longer exists.
  for (const [id] of digests) {
    if (!seen.has(id)) await deleteSessionDigest(id);
  }
  return result;
}

let lastSweepStartedAt = 0;
let sweepInFlight = false;
let warnedUnusable = false;

/** The scheduler-facing entry: called every 15 s tick, does work at most once
 *  per sweepMinutes, never overlapping. `summarizeOverride` is test-only. */
export async function runMemorySweepTick(
  now: Date,
  summarizeOverride?: SummarizeFn
): Promise<void> {
  const config = await loadConfig();
  if (!config.memory) return; // subsystem off — zero cost
  const resolved = resolveMemoryConfig(config);
  if (!resolved) {
    if (!warnedUnusable) {
      warnedUnusable = true;
      console.warn(
        '[memory] memory config is set but unusable (unknown provider, claude-code provider, or missing model) — sweeps disabled until fixed'
      );
    }
    return;
  }
  warnedUnusable = false;
  if (sweepInFlight) return;
  if (now.getTime() - lastSweepStartedAt < resolved.sweepMinutes * 60_000) return;
  lastSweepStartedAt = now.getTime();
  sweepInFlight = true;
  try {
    const res = await sweepMemory(resolved, summarizeOverride ?? makeSummarizer(resolved));
    if (res.calls > 0 || res.budgetSkipped > 0) {
      console.log(
        `[memory] sweep: scanned=${res.scanned} calls=${res.calls} summarized=${res.summarized} budget-skipped=${res.budgetSkipped}`
      );
    }
  } catch (err) {
    console.error('[memory] sweep failed:', err);
  } finally {
    sweepInFlight = false;
  }
}

export const __memorySweepTesting = {
  reset(): void {
    lastSweepStartedAt = 0;
    sweepInFlight = false;
    warnedUnusable = false;
  },
};




