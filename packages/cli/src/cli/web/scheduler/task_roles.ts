// Role and phase resolution for the autonomous task system.
// The existing task.agentId -> project.agentId -> agents[0] chain IS the
// developer role; planner/reviewer optionally override and degrade onto it.
import { runQuery, Task, TaskMessage } from '../../../store/db.js';
import type { AgentConfig, ProjectConfig } from '../../../types.js';
import type { Tool } from '../../../harness/tools/types.js';

export type TaskRole = 'planner' | 'developer' | 'reviewer';

export function resolveRoleAgent(
  role: TaskRole,
  task: Task,
  project: ProjectConfig | undefined,
  agents: AgentConfig[],
): AgentConfig | undefined {
  const pick = (id?: string | null) => (id ? agents.find((a) => a.id === id) : undefined);
  const developer = pick(task.agentId) || pick(project?.agentId) || agents[0];
  if (role === 'developer') return developer;
  const taskRoleId = role === 'planner' ? task.plannerAgentId : task.reviewerAgentId;
  const projectRoleId = role === 'planner' ? project?.plannerAgentId : project?.reviewerAgentId;
  return pick(taskRoleId) || pick(projectRoleId) || developer;
}

export function resolvePlanningEnabled(
  task: Pick<Task, 'planningEnabled'>,
  project?: Pick<ProjectConfig, 'planningEnabled'> | null,
): boolean {
  return task.planningEnabled ?? project?.planningEnabled ?? true;
}

export function resolveReviewEnabled(
  task: Pick<Task, 'reviewEnabled'>,
  project?: Pick<ProjectConfig, 'reviewEnabled'> | null,
): boolean {
  return task.reviewEnabled ?? project?.reviewEnabled ?? true;
}

/**
 * Where does an (re)activated task go? Planning, unless planning is disabled
 * or a plan message is already on record. Deterministic and derived from the
 * message stream, like review rounds — no stored phase counter.
 */
export async function activationStatus(
  task: Task,
  project: ProjectConfig | undefined,
): Promise<'planning' | 'active'> {
  if (!resolvePlanningEnabled(task, project)) return 'active';
  const messages = (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`)) as TaskMessage[];
  return messages.some((m) => m.messageType === 'plan') ? 'active' : 'planning';
}

/** Builtins the planner must not have: everything that mutates the workspace.
 *  bash is stripped too — it cannot be made read-only, and the planner keeps
 *  read_file/glob/grep for exploration. Same post-filter mechanism as the
 *  reviewer's mcp__task__* strip in task_review.ts. */
export const PLANNER_TOOL_DENYLIST = new Set(['write', 'edit', 'multiedit', 'bash']);

export function filterPlannerTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => !PLANNER_TOOL_DENYLIST.has(t.name));
}
