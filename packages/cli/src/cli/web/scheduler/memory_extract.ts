// Pure helpers for the sweep's combined summarize+extract call: prompt
// assembly, defensive JSON parsing, entry validation, dedup-block formatting,
// and host-side project resolution. No harness or store imports (types only)
// so everything here is unit-testable without CARETAKER_HOME.
// See docs/superpowers/specs/2026-08-24-memory-daemon-step2-extraction-design.md
import { resolveProjectIdForDir } from '../../../lib/project_resolve.js';
import type { AgentConfig, ProjectConfig } from '../../../types.js';

export const MAX_DEDUP_CHARS = 4000;
export const MAX_MEMORIES_PER_CALL = 5;
export const MAX_MEMORY_TITLE_CHARS = 200;
export const MAX_MEMORY_BODY_CHARS = 2000;
export const MAX_MEMORY_KEYWORDS = 10;

/** One validated memory candidate out of the model. `level` is the model's
 *  only scope verb — the host maps it to a concrete projectId. */
export interface ExtractedMemory {
  level: 'project' | 'global';
  kind: 'fact' | 'episode';
  importance: 'low' | 'normal' | 'high';
  title: string;
  body: string;
  keywords: string[];
}

export interface CombinedResult {
  summary: string;
  memories: ExtractedMemory[];
}

/** Everything the combined call needs; assembled by the sweep per chunk. */
export interface SummarizeContext {
  prevSummary: string;
  chunkText: string;
  /** Preformatted "existing memories" lines (formatDedupBlock), '' when none. */
  dedupBlock: string;
  /** Whether a project is resolved for this session — gates the level choice. */
  hasProject: boolean;
}

const LEVEL_PROJECT =
  '"level": "project" for facts about this specific project, "global" for facts about the user or their machine/environment that hold everywhere.';
const LEVEL_GLOBAL_ONLY = '"level": always "global" (no project is in scope).';

export function buildCombinedPrompt(ctx: SummarizeContext): string {
  return [
    'You maintain a rolling summary of a conversation between a user and an AI agent, and you extract durable memories from it.',
    '',
    'Reply with ONLY a JSON object, no code fences, in this exact shape:',
    '{"summary": "<updated rolling summary>", "memories": [{"level": "...", "kind": "...", "importance": "...", "title": "...", "body": "...", "keywords": ["..."]}]}',
    '',
    'SUMMARY: integrate the NEW MESSAGES into the PREVIOUS SUMMARY and rewrite it as one standalone plain-text summary, at most 300 words. Keep durable facts, decisions, preferences, constraints, and open threads; drop pleasantries and dead ends.',
    '',
    `MEMORIES: at most ${MAX_MEMORIES_PER_CALL} facts worth remembering beyond this conversation, using the summary as context. Only NEW information — never re-emit anything under EXISTING MEMORIES. Most chunks contain nothing durable: an empty array is the normal answer. Fields:`,
    `- ${ctx.hasProject ? LEVEL_PROJECT : LEVEL_GLOBAL_ONLY}`,
    '- "kind": "fact" (timeless knowledge: conventions, preferences, constraints, decisions) or "episode" (a dated event: something that happened).',
    '- "importance": judge it from the TONE of the conversation. "high" only when the user marked it explicitly ("remember this", "never again"), was emphatic or frustrated, or corrected a mistake; "normal" for ordinary facts and decisions; "low" for incidental context.',
    `- "title": short and searchable. "body": the fact itself, self-contained markdown. "keywords": up to ${MAX_MEMORY_KEYWORDS} lowercase search words.`,
    '',
    'EXISTING MEMORIES (do not re-emit):',
    ctx.dedupBlock || '(none)',
    '',
    'PREVIOUS SUMMARY:',
    ctx.prevSummary.trim() || '(none)',
    '',
    'NEW MESSAGES:',
    ctx.chunkText,
  ].join('\n');
}

/** Outermost-braces JSON extraction (also strips fences/prose for free).
 *  null = failed chunk: the caller leaves the cursor, next sweep retries.
 *  Deliberately NO raw-text-as-summary fallback — it would poison the digest. */
export function parseCombinedResponse(text: string): { summary: string; memories: unknown } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj?.summary !== 'string' || !obj.summary.trim()) return null;
  return { summary: obj.summary.trim(), memories: obj.memories };
}

/** Host-side gate on model output: drop entries without title/body, coerce
 *  invalid enums to fact/normal, degrade project→global when no project is
 *  in scope, cap count and field sizes. Extraction is best-effort — a bad
 *  entry is dropped, never a failed chunk. */
export function validateMemories(raw: unknown, hasProject: boolean): ExtractedMemory[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedMemory[] = [];
  for (const e of raw as any[]) {
    if (out.length >= MAX_MEMORIES_PER_CALL) break;
    if (typeof e?.title !== 'string' || !e.title.trim()) continue;
    if (typeof e?.body !== 'string' || !e.body.trim()) continue;
    const keywords = Array.isArray(e.keywords)
      ? e.keywords
          .filter((k: unknown): k is string => typeof k === 'string' && k.trim() !== '')
          .map((k: string) => k.trim())
          .slice(0, MAX_MEMORY_KEYWORDS)
      : [];
    out.push({
      level: e.level === 'project' && hasProject ? 'project' : 'global',
      kind: e.kind === 'episode' ? 'episode' : 'fact',
      importance: e.importance === 'low' || e.importance === 'high' ? e.importance : 'normal',
      title: e.title.trim().slice(0, MAX_MEMORY_TITLE_CHARS),
      body: e.body.trim().slice(0, MAX_MEMORY_BODY_CHARS),
      keywords,
    });
  }
  return out;
}

/** One line per existing memory (newest first — caller sorts), stopping
 *  before MAX_DEDUP_CHARS. Titles + keywords only, never bodies. */
export function formatDedupBlock(entries: Array<{ title: string; keywords: string[] }>): string {
  const lines: string[] = [];
  let len = 0;
  for (const e of entries) {
    const line = e.keywords.length ? `- ${e.title} [${e.keywords.join(', ')}]` : `- ${e.title}`;
    if (len + line.length + 1 > MAX_DEDUP_CHARS) break;
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n');
}

/** Host-side project resolution (scope ids are never chosen by a model):
 *  the session agent's workingDir prefix-matched, path-aware, against the
 *  configured projects' workingDir. Longest match wins (nested projects).
 *  '' = no project in scope → global-only extraction.
 *  Delegates to lib/project_resolve.ts — shared with the read path. */
export function resolveProjectId(
  sessionAgentId: string,
  agents: AgentConfig[],
  projects: ProjectConfig[]
): string {
  const dir = agents.find((a) => a.id === sessionAgentId)?.workingDir;
  return dir ? resolveProjectIdForDir(dir, projects) : '';
}
