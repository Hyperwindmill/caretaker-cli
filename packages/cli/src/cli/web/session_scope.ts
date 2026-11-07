import type { SessionMetaRecord } from '../../session/types.js';

/** Working dir + memory scope for one chat turn. The `set_workspace` override
 *  on the session meta wins over the agent's own workingDir and brings its
 *  projectId along (passed explicitly: a managed clone's blank
 *  `projects[].workingDir` never prefix-matches, so dir-based resolution
 *  would degrade the turn to global-only memories). */
export function sessionRunScope(
  meta: Pick<SessionMetaRecord, 'workingDir' | 'projectId'> | undefined,
  agentWorkingDir: string,
): { workingDir: string; memoryProjectId?: string } {
  if (meta?.workingDir) {
    return meta.projectId
      ? { workingDir: meta.workingDir, memoryProjectId: meta.projectId }
      : { workingDir: meta.workingDir };
  }
  return { workingDir: agentWorkingDir };
}
