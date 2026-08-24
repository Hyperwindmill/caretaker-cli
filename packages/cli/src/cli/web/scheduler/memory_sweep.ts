// Memory sweep — step 1 of the memory subsystem: a periodic pass over all
// chat sessions maintaining, per session, a cursor (last processed message)
// and a rolling summary produced by a dedicated model. The session_digests
// collection is a regenerable cache: dropping it costs one full re-scan.
// Design: docs/superpowers/specs/2026-08-24-memory-daemon-step1-design.md

import type { CaretakerConfig, ProviderConfig } from '../../../types.js';
import type { MessageRecord } from '../../../session/types.js';

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


