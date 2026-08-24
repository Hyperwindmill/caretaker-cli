import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfig, CaretakerConfig, ProjectConfig, ProviderConfig } from '../../../types.js';
import type { MessageRecord } from '../../../session/types.js';
import { sessionsRoot, readSession, dataDir } from '../../../session/store.js';
import { loadConfig, loadAgents } from '../../../store/json.js';
import { run } from '../../../harness/loop.js';
import {
  deleteSessionDigest,
  listMemories,
  listSessionDigests,
  saveMemory,
  saveSessionDigest,
  type Memory,
  type SessionDigest,
} from '../../../store/db.js';
import {
  buildCombinedPrompt,
  formatDedupBlock,
  parseCombinedResponse,
  resolveProjectId,
  validateMemories,
  type CombinedResult,
  type SummarizeContext,
} from './memory_extract.js';

export const DEFAULT_SWEEP_MINUTES = 5;
export const DEFAULT_MIN_NEW_MESSAGES = 4;
export const MAX_CALLS_PER_SWEEP = 10;
export const MAX_CHUNK_CHARS = 20_000;
export const MAX_TOOL_RESULT_CHARS = 500;
export const MAX_SUMMARY_CHARS = 4_000;
export const SUMMARIZE_TIMEOUT_MS = 120_000;

export interface ResolvedMemoryConfig {
  agent: AgentConfig;
  provider: ProviderConfig;
  sweepMinutes: number;
  minNewMessages: number;
  /** Full lists, for per-session project resolution (the session's agent is
   *  a different agent than the memory agent). */
  agents: AgentConfig[];
  projects: ProjectConfig[];
}

/** null = subsystem off (unset config, deleted agent, or the agent's provider
 *  no longer exists). Any provider type works — the summarize call launches
 *  through the harness loop, which already dispatches claude-code. */
export function resolveMemoryConfig(
  config: CaretakerConfig,
  agents: AgentConfig[]
): ResolvedMemoryConfig | null {
  const m = config.memory;
  if (!m?.agentId) return null;
  const agent = agents.find((a) => a.id === m.agentId);
  if (!agent) return null;
  const provider = (config.providers || []).find((p) => p.name === agent.provider);
  if (!provider) return null;
  return {
    agent,
    provider,
    sweepMinutes: m.sweepMinutes ?? DEFAULT_SWEEP_MINUTES,
    minNewMessages: m.minNewMessages ?? DEFAULT_MIN_NEW_MESSAGES,
    agents,
    projects: config.projects ?? [],
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

/** null = failure (network, non-OK, empty or non-JSON response). The caller
 *  leaves the cursor where it was; the next sweep retries. Best-effort, the
 *  same contract as titling (harness/title.ts). */
export type SummarizeFn = (ctx: SummarizeContext) => Promise<CombinedResult | null>;

/** The summarize call launches through the harness loop with the memory
 *  agent's identity: every provider type works (claude-code spawns a one-shot
 *  `claude -p`, no session persisted), and the agent's systemPrompt shapes
 *  the summaries. Always a fresh conversation — never the agent's sessions.
 *  `tools: []` plus `dontAsk` (auto-denies every claude-side tool call) keep
 *  it pure text generation; workingDir is pinned to CARETAKER_HOME so the
 *  project AGENTS.md walk stays out of the prompt. */
export function makeSummarizer(resolved: ResolvedMemoryConfig): SummarizeFn {
  return async (ctx) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SUMMARIZE_TIMEOUT_MS);
    try {
      const result = await run({
        agent: resolved.agent,
        provider: resolved.provider,
        tools: [],
        prompt: buildCombinedPrompt(ctx),
        signal: ac.signal,
        workingDir: dataDir(),
        claudeCode: { permissionMode: 'dontAsk' },
      });
      if (result.stop !== 'done') return null;
      const parsed = parseCombinedResponse(result.text);
      if (!parsed) return null;
      const summary =
        parsed.summary.length > MAX_SUMMARY_CHARS
          ? parsed.summary.slice(0, MAX_SUMMARY_CHARS) + '…'
          : parsed.summary;
      return { summary, memories: validateMemories(parsed.memories, ctx.hasProject) };
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
  memories: number;
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
  const result: SweepResult = { scanned: 0, summarized: 0, memories: 0, calls: 0, budgetSkipped: 0 };
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
      // The whole per-session body is guarded: a digest save that throws (a
      // hand-copied file whose name fails safeId, a store write error) must
      // cost only that session this sweep — never the sessions after it.
      try {
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

        // Scope + dedup context, once per session. `dedup` is mutated as new
        // memories are saved so the NEXT chunk of this session sees them too;
        // across sessions the fresh listMemories() covers it.
        const projectId = resolveProjectId(agentId, resolved.agents, resolved.projects);
        const dedup: Array<{ title: string; keywords: string[] }> = (await listMemories())
          .filter((m) => m.projectId === '' || m.projectId === projectId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
          const res = await summarize({
            prevSummary: record.summary,
            chunkText: chunk.text,
            dedupBlock: formatDedupBlock(dedup),
            hasProject: projectId !== '',
          });
          if (res === null) {
            caughtUp = false;
            break; // cursor stays; next sweep retries
          }
          // Memories BEFORE the digest record: a crash between the two
          // re-extracts this chunk next sweep, but the titles just saved are
          // then in the dedup block, so the model omits them — duplicates
          // with a dedup guard beat silent loss.
          for (const em of res.memories) {
            const memory: Memory = {
              id: randomUUID(),
              projectId: em.level === 'project' && projectId ? projectId : '',
              kind: em.kind,
              importance: em.importance,
              title: em.title,
              body: em.body,
              keywords: em.keywords,
              sourceSessionId: sessionId,
              sourceAgentId: agentId,
              model: resolved.agent.model,
              createdAt: new Date().toISOString(),
            };
            await saveMemory(memory);
            result.memories++;
            dedup.unshift({ title: memory.title, keywords: memory.keywords });
          }
          const last = chunk.messages[chunk.messages.length - 1]!;
          record = {
            ...record,
            agentId,
            lastMessageId: last.id,
            messageCount: record.messageCount + chunk.messages.length,
            summary: res.summary,
            model: resolved.agent.model,
          };
          await saveSessionDigest(record); // crash loses at most one chunk
          result.summarized++;
        }
        if (caughtUp) {
          await saveSessionDigest({ ...record, agentId, scannedAt });
        }
      } catch (err) {
        console.warn(`[memory] sweep of session ${sessionId} failed:`, err);
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
  const resolved = resolveMemoryConfig(config, await loadAgents());
  if (!resolved) {
    if (!warnedUnusable) {
      warnedUnusable = true;
      console.warn(
        "[memory] memory config is set but unusable (deleted agent, or the agent's provider no longer exists) — sweeps disabled until fixed"
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
        `[memory] sweep: scanned=${res.scanned} calls=${res.calls} summarized=${res.summarized} memories=${res.memories} budget-skipped=${res.budgetSkipped}`
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
