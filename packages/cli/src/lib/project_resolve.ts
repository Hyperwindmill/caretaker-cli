// Host-side project resolution — scope ids are never chosen by a model.
// Shared by the memory write path (sweep extraction, via the session agent's
// workingDir) and the read path (recall, via the run's workingDir).
// See docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md
import { isAbsolute, resolve, sep } from 'node:path';
import type { ProjectConfig } from '../types.js';

/** Path-aware prefix match of `dir` against the configured projects'
 *  workingDir. Longest match wins (nested projects). '' = no project. */
export function resolveProjectIdForDir(dir: string, projects: ProjectConfig[]): string {
  if (!dir || !isAbsolute(dir)) return '';
  const target = resolve(dir);
  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    if (!p.workingDir || !isAbsolute(p.workingDir)) continue;
    const projDir = resolve(p.workingDir);
    if (target === projDir || target.startsWith(projDir + sep)) {
      if (!best || projDir.length > best.len) best = { id: p.id, len: projDir.length };
    }
  }
  return best?.id ?? '';
}
