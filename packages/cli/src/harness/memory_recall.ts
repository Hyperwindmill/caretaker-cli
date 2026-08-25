// Read path of the memory subsystem (step 3): host-side lexical recall.
// No model in the loop by design — matching is programmatic, synchronous,
// free; the memory agent's read-side role (digestion) is a future step.
// Pure matcher/formatter first; buildMemoriesBlock at the bottom is the one
// I/O wrapper both runners (native loop, claude-code) call per turn.
// See docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md
import type { Memory } from '../store/db.js';
import { listMemories } from '../store/db.js';
import { loadConfig } from '../store/json.js';
import { resolveProjectIdForDir } from '../lib/project_resolve.js';

export const RECALL_TOP_K = 5;
export const MIN_KEYWORD_LENGTH = 3;
const IMPORTANCE_WEIGHT: Record<Memory['importance'], number> = {
  low: 0.5,
  normal: 1,
  high: 2,
};

/** Inverted lexical match — no query tokenization: a stored keyword matches
 *  when the lowercased prompt contains it (multi-word keywords work free).
 *  score = matched × importanceWeight × (1 + log2(1 + recallCount)):
 *  acquired strength weighs in — much-recalled memories surface more easily.
 *  Ties: lastRecalledAt desc, then createdAt desc. Top-K, score > 0 only. */
export function matchMemories(prompt: string, memories: Memory[]): Memory[] {
  const text = prompt.toLowerCase();
  const scored: Array<{ m: Memory; score: number }> = [];
  for (const m of memories) {
    let matched = 0;
    for (const k of m.keywords) {
      const kw = k.trim().toLowerCase();
      if (kw.length >= MIN_KEYWORD_LENGTH && text.includes(kw)) matched++;
    }
    if (matched === 0) continue;
    const score =
      matched * IMPORTANCE_WEIGHT[m.importance] * (1 + Math.log2(1 + (m.recallCount ?? 0)));
    scored.push({ m, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.m.lastRecalledAt ?? '').localeCompare(a.m.lastRecalledAt ?? '') ||
      b.m.createdAt.localeCompare(a.m.createdAt)
  );
  return scored.slice(0, RECALL_TOP_K).map((s) => s.m);
}

/** The prelude block. Titles only, never bodies: the explicit memory_read
 *  IS the recall event that feeds acquired strength — a system that always
 *  injects bodies never learns what mattered. '' when no matches. */
export function formatMemoriesBlock(matches: Memory[]): string {
  if (matches.length === 0) return '';
  return [
    '<memories>',
    'Stored memories that may be relevant to the current message:',
    ...matches.map((m) => `- ${m.id} — ${m.title} (${m.kind}, ${m.importance})`),
    'To read their full content, call the memory_read tool with the ids (when available).',
    '</memories>',
  ].join('\n');
}

/** One-stop per-turn recall: gate on MemoryConfig (present = read path on,
 *  same gate as the sweep), resolve the project from the run's workingDir,
 *  match global + project memories, format. Never throws — recall must
 *  never break a chat turn.
 *  `explicitProjectId` overrides dir resolution: task cycles run in a
 *  worktree (or managed repo dir) that never prefix-matches the project's
 *  workingDir, but the caller knows the project from the task record —
 *  still host-side, never the model's choice. */
export async function buildMemoriesBlock(
  prompt: string,
  workingDir: string,
  explicitProjectId?: string
): Promise<string> {
  try {
    const config = await loadConfig();
    if (!config.memory) return '';
    const projectId =
      explicitProjectId ?? resolveProjectIdForDir(workingDir, config.projects ?? []);
    const candidates = (await listMemories()).filter(
      (m) => m.projectId === '' || m.projectId === projectId
    );
    return formatMemoriesBlock(matchMemories(prompt, candidates));
  } catch {
    return '';
  }
}
