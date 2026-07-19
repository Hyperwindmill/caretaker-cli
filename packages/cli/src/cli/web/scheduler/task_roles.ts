// Role and phase resolution for the autonomous task system.
// The existing task.agentId -> project.agentId -> agents[0] chain IS the
// developer role; planner/reviewer optionally override and degrade onto it.
import { runQuery, Task, TaskMessage } from '../../../store/db.js';
import type { AgentConfig, ProjectConfig } from '../../../types.js';
import type { Tool } from '../../../harness/tools/types.js';

export type TaskRole = 'planner' | 'developer' | 'reviewer';

// Per-invocation wall-clock budget defaults, in seconds. A run is aborted when
// it exceeds the resolved budget — for every provider. claude-code gets a larger
// default because the CLI has no --max-turns equivalent (native runs are also
// turn-bounded by agent.maxTurns), so without a generous backstop a claude-code
// run would stall the heartbeat (and, for reviews, the review gate).
export const DEFAULT_RUN_SECONDS = 120;
export const CLAUDE_CODE_DEFAULT_RUN_SECONDS = 15 * 60;

/** Resolve the per-invocation budget (seconds): task → project → provider default. */
export function resolveMaxRunSeconds(
  task: Pick<Task, 'maxRunSeconds'>,
  project: Pick<ProjectConfig, 'maxRunSeconds'> | null | undefined,
  isClaudeCode: boolean,
): number {
  const configured = task.maxRunSeconds ?? project?.maxRunSeconds;
  if (typeof configured === 'number' && configured > 0) return configured;
  return isClaudeCode ? CLAUDE_CODE_DEFAULT_RUN_SECONDS : DEFAULT_RUN_SECONDS;
}

/**
 * Resolve the docker image for a task's runs. Phase-1: project-level only, so
 * the task arg is accepted (for a future per-task override tier) but unused.
 * This is the single config chokepoint — a later agent-level tier is added here.
 */
export function resolveDockerImage(
  _task: Pick<Task, 'projectId'>,
  project: Pick<ProjectConfig, 'dockerImage'> | null | undefined,
): string | null {
  const img = project?.dockerImage?.trim();
  return img ? img : null;
}

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

export function resolveSddEnabled(
  task: Pick<Task, 'sddEnabled'>,
  project?: Pick<ProjectConfig, 'sddEnabled'> | null,
): boolean {
  return task.sddEnabled ?? project?.sddEnabled ?? false;
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

/** Tools the SDD wrapper applies to: workspace writers that take a `path` arg. */
const SDD_WRAPPED_TOOLS = new Set(['write', 'edit', 'multiedit']);

/** Wrap a writing tool so it only accepts markdown targets. Everything else
 *  about the tool (schema, sandbox, read-before-write guard) is unchanged —
 *  the guard runs before delegation. Guard-rail, not a security boundary. */
function markdownOnly(tool: Tool): Tool {
  return {
    ...tool,
    description: `${tool.description} In this planning phase, only markdown (.md) files are accepted.`,
    execute: async (args, ctx) => {
      const p = (args as { path?: unknown }).path;
      if (typeof p !== 'string' || !p.toLowerCase().endsWith('.md')) {
        return { content: 'Error: planning phase (SDD mode): only markdown (.md) files may be written.' };
      }
      return tool.execute(args, ctx);
    },
  };
}

export function filterPlannerTools(tools: Tool[], sdd = false): Tool[] {
  if (!sdd) return tools.filter((t) => !PLANNER_TOOL_DENYLIST.has(t.name));
  // SDD mode: bash stays out (the actual implementation brake); the file
  // writers survive but only for markdown targets.
  return tools
    .filter((t) => t.name !== 'bash')
    .map((t) => (SDD_WRAPPED_TOOLS.has(t.name) ? markdownOnly(t) : t));
}
