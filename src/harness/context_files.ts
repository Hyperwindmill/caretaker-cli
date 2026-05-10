import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Inject standard AI-agent context files into the system prompt.
 *
 * Walks up from the agent's workingDir looking for AGENTS.md, CLAUDE.md,
 * GEMINI.md (per-file first match wins). Also reads global ~/.claude/CLAUDE.md
 * and ~/.config/opencode/AGENTS.md if present.
 *
 * Each file is wrapped with a `Instructions from: <abspath>` header so the
 * model knows where the rules came from.
 *
 * Caps:
 *  - per-file max 100 KB (silently skipped if larger)
 *  - total max 250 KB (further files dropped once budget hit)
 */

const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;

const PER_FILE_MAX = 100 * 1024;
const TOTAL_MAX = 250 * 1024;

export interface ContextEntry {
  path: string;
  content: string;
}

async function readIfExistsAndSmall(p: string): Promise<string | null> {
  try {
    const st = await stat(p);
    if (!st.isFile()) return null;
    if (st.size > PER_FILE_MAX) return null;
    return await readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

async function walkUpFor(name: string, startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, name);
    const content = await readIfExistsAndSmall(candidate);
    if (content !== null) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function globalCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.config', 'opencode', 'AGENTS.md'),
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.caretaker', 'AGENTS.md'),
  ];
}

/** Discover and read context files for a given workingDir. */
export async function loadContextFiles(workingDir: string): Promise<ContextEntry[]> {
  const out: ContextEntry[] = [];
  let total = 0;

  const push = async (p: string) => {
    if (total >= TOTAL_MAX) return;
    const content = await readIfExistsAndSmall(p);
    if (content === null) return;
    if (total + content.length > TOTAL_MAX) return;
    out.push({ path: p, content });
    total += content.length;
  };

  // Project-level: walk up from workingDir for each name; first hit per name wins.
  for (const name of CONTEXT_FILES) {
    const found = await walkUpFor(name, workingDir);
    if (found) await push(found);
  }

  // Global fallbacks.
  for (const candidate of globalCandidates()) {
    await push(candidate);
  }

  return out;
}

/** Format the loaded context entries as a single string block for the system prompt. */
export function formatContextBlock(entries: ContextEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => `<context-file path="${e.path}">\n${e.content}\n</context-file>`)
    .join('\n\n');
}

// ─── @<file> reference resolution ──────────────────────────────────────

/**
 * Resolve `@<path>` references embedded in a system prompt.
 *
 * Syntax: `@path/to/file` or `@./relative/path` — the path is resolved
 * relative to the agent's working directory (or CWD if none is set).
 *
 * Each reference is replaced inline with the file content wrapped in
 * `<context-file>` tags. If a referenced file does not exist or exceeds
 * PER_FILE_MAX, the reference is replaced with a graceful fallback message
 * instead of causing an error.
 *
 * Nested @-references inside resolved files are NOT expanded (single pass).
 */
export async function resolveFileReferences(text: string, workingDir: string): Promise<string> {
  // Match @path — must start with /, ./, or ~ for an absolute/relative path.
  // This avoids false positives on email addresses, mentions, etc.
  const re = /@((?:\.\/|\/|~)[^\s@]+)/g;
  const matches = [...text.matchAll(re)];

  if (matches.length === 0) return text;

  // Deduplicate paths to avoid reading the same file multiple times.
  const uniquePaths = [...new Set(matches.map((m) => m[1]))];
  const resolved = new Map<string, string>();

  for (const rawPath of uniquePaths) {
    const expanded = rawPath.startsWith('~') ? path.join(os.homedir(), rawPath.slice(1)) : rawPath;
    const absPath = path.resolve(workingDir, expanded);

    const content = await readIfExistsAndSmall(absPath);
    if (content !== null) {
      resolved.set(rawPath, `<context-file path="${absPath}">\n${content}\n</context-file>`);
    } else {
      resolved.set(rawPath, `<!-- file not found or too large: ${absPath} -->`);
    }
  }

  // Replace all occurrences (including duplicates) in a single pass.
  return text.replace(re, (_, p: string) => resolved.get(p) ?? '');
}
