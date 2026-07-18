import { randomUUID } from 'node:crypto';
import { getDb, ChecklistItem, Project, Task, TaskMessage, getTaskById, saveTask, createTask, addTaskMessage, deleteTask, tryNormalizeChecklistStatus } from '../../../store/db.js';
import { loadConfig, loadAgents } from '../../../store/json.js';
import type { Tool, ToolResult } from '../types.js';
import { discardWorktree } from '../../../lib/task_git.js';
import { runningTasks } from '../../../cli/web/scheduler/locks.js';
import { resolveReviewEnabled, resolvePlanningEnabled, activationStatus } from '../../../cli/web/scheduler/task_roles.js';

function ok(data: Record<string, unknown> = {}): ToolResult {
  return { content: JSON.stringify({ ok: true, ...data }) };
}

function err(msg: string): ToolResult {
  return { content: JSON.stringify({ error: msg }) };
}

export const getTaskStateTool: Tool = {
  name: 'mcp__task__task_get_state',
  description: 'Get the current state of a task: objective, checklist, recent messages, and project info.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId) || null;

    const messages = (await db.query(`SELECT * FROM task_messages WHERE taskId = ${taskId}`)) as TaskMessage[];
    messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return {
      content: JSON.stringify({
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        objective: task.objective,
        checklist: task.checklist,
        status: task.status,
        archived: !!task.archived,
        blockedReason: task.blockedReason,
        noProgressCount: task.noProgressCount,
        maxNoProgress: task.maxNoProgress,
        agentId: task.agentId || null,
        plannerAgentId: task.plannerAgentId || null,
        reviewerAgentId: task.reviewerAgentId || null,
        planningEnabled: task.planningEnabled ?? null,
        reviewEnabled: task.reviewEnabled ?? null,
        sddEnabled: task.sddEnabled ?? null,
        project: project
          ? {
              name: project.name,
              workingDir: project.workingDir,
            }
          : null,
        recentMessages: messages.slice(-20),
      }),
    };
  },
};

export const updateChecklistItemTool: Tool = {
  name: 'mcp__task__task_update_checklist_item',
  description: 'Update the status of a checklist item.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      item_id: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'] },
    },
    required: ['task_id', 'item_id', 'status'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const itemId = String(args.item_id);
    const statusInput = args.status;

    const status = tryNormalizeChecklistStatus(statusInput);
    if (!status) {
      return err(`Invalid checklist item status "${statusInput}". Allowed values are: pending, in_progress, done, skipped.`);
    }

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    const checklist = (task.checklist || []).map((item) =>
      item.id === itemId ? { ...item, status } : item,
    );

    task.checklist = checklist;
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    return ok();
  },
};

export const updateChecklistTool: Tool = {
  name: 'mcp__task__task_update_checklist',
  description: 'Replace the entire checklist of a task.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      checklist: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'] },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['task_id', 'checklist'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const checklistInput = args.checklist as any[];

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    const checklist: ChecklistItem[] = [];
    for (let idx = 0; idx < checklistInput.length; idx++) {
      const item = checklistInput[idx];
      const status = tryNormalizeChecklistStatus(item.status);
      if (!status) {
        return err(`Invalid checklist item status "${item.status}" for item "${item.text}". Allowed values are: pending, in_progress, done, skipped.`);
      }
      checklist.push({
        id: item.id || randomUUID(),
        text: item.text,
        status,
        order: idx,
      });
    }

    task.checklist = checklist;
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    return ok();
  },
};

export const addMessageTool: Tool = {
  name: 'mcp__task__task_add_message',
  description: 'Add a message to the task thread. Use this to document what you did in this session.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      content: { type: 'string' },
    },
    required: ['task_id', 'content'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const content = String(args.content);

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'chat',
      content,
      agentId: null,
    });

    // Update task updatedAt
    const task = await getTaskById(taskId);
    if (task) {
      task.updatedAt = new Date().toISOString();
      await saveTask(task);
    }

    return ok();
  },
};

export const completeTaskTool: Tool = {
  name: 'mcp__task__task_complete',
  description: 'Mark the task as done. Use when the objective is fully achieved.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      summary: { type: 'string' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const summary = args.summary ? String(args.summary) : '';

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    if (task.status === 'planning') {
      return err(
        `Task ${taskId} is in the planning phase. Submit a plan with task_submit_plan before completing.`,
      );
    }

    // Git-isolated tasks enter review before finalizing — unless the review
    // gate is disabled for this task/project. Non-git tasks always finalize
    // directly (the review is git-diff based, it needs a branch to inspect).
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    const reviewOn = resolveReviewEnabled(task, project);
    task.status = task.worktreePath && reviewOn ? 'reviewing' : 'done';
    task.lockedAt = null;
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    const content = summary ? `Task completed. ${summary}` : 'Task completed.';
    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'system',
      content,
      agentId: null,
    });

    return ok();
  },
};

export const blockTaskTool: Tool = {
  name: 'mcp__task__task_block',
  description: 'Mark the task as blocked. Use when you need human input to continue.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['task_id', 'reason'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const reason = String(args.reason);

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    task.status = 'blocked';
    task.blockedReason = reason;
    task.lockedAt = null;
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'block',
      content: reason,
      agentId: null,
    });

    return ok();
  },
};

export const yieldTaskTool: Tool = {
  name: 'mcp__task__task_yield',
  description: 'Signal end of this invocation without completing the task. Task remains active.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      notes: { type: 'string' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const notes = args.notes ? String(args.notes) : '';

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    task.lockedAt = null;
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    if (notes) {
      await addTaskMessage({
        taskId,
        role: 'assistant',
        messageType: 'system',
        content: `Yield: ${notes}`,
        agentId: null,
      });
    }

    return ok();
  },
};

export const projectListTool: Tool = {
  name: 'mcp__task__project_list',
  description: 'List all available projects with their IDs, names, and working directories. Call this before task_create to pick the correct project_id.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async (): Promise<ToolResult> => {
    const config = await loadConfig();
    const projects = [...(config.projects || [])];
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return { content: JSON.stringify(projects) };
  },
};

export const taskCreateTool: Tool = {
  name: 'mcp__task__task_create',
  description: 'Create a new task in the system.',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'number' },
      title: { type: 'string' },
      objective: { type: 'string' },
      checklist: {
        type: 'array',
        items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      start_active: { type: 'boolean' },
      agent_id: {
        type: 'string',
        description: 'Optional agent ID to assign to this task. If omitted, the project default agent is used.',
      },
      planner_agent_id: { type: 'string', description: 'Optional planner-role agent for this task.' },
      reviewer_agent_id: { type: 'string', description: 'Optional reviewer-role agent for this task.' },
      planning_enabled: { type: 'boolean', description: 'Override the project planning-phase default for this task.' },
      review_enabled: { type: 'boolean', description: 'Override the project review-gate default for this task.' },
      sdd_enabled: { type: 'boolean', description: 'Override the project SDD-mode default for this task (planner may write .md files during planning).' },
    },
    required: ['project_id', 'title', 'objective', 'checklist'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const projectId = Number(args.project_id);
    const title = String(args.title);
    const objective = String(args.objective);
    const checklistInput = args.checklist as any[];
    const startActive = !!args.start_active;
    const agentId = args.agent_id ? String(args.agent_id) : null;
    const plannerAgentId = args.planner_agent_id ? String(args.planner_agent_id) : null;
    const reviewerAgentId = args.reviewer_agent_id ? String(args.reviewer_agent_id) : null;
    const planningEnabled = typeof args.planning_enabled === 'boolean' ? args.planning_enabled : null;
    const reviewEnabled = typeof args.review_enabled === 'boolean' ? args.review_enabled : null;
    const sddEnabled = typeof args.sdd_enabled === 'boolean' ? args.sdd_enabled : null;

    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === projectId);
    if (!project) return err(`Project ${projectId} not found`);

    // Validate that the specified agents exist (if provided).
    const idsToValidate = [agentId, plannerAgentId, reviewerAgentId].filter(Boolean) as string[];
    if (idsToValidate.length > 0) {
      const agents = await loadAgents();
      for (const id of idsToValidate) {
        if (!agents.some((a) => a.id === id)) {
          return err(`Agent "${id}" not found. Available agents: ${agents.map((a) => a.id).join(', ') || '(none)'}`);
        }
      }
    }

    const checklist: ChecklistItem[] = checklistInput.map((item, idx) => ({
      id: randomUUID(),
      text: item.text,
      status: 'pending',
      order: idx,
    }));

    const startStatus = startActive
      ? (resolvePlanningEnabled({ planningEnabled }, project) ? 'planning' : 'active')
      : 'draft';

    const createdTask = await createTask({
      projectId,
      title,
      objective,
      checklist,
      status: startStatus,
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
      agentId,
      plannerAgentId,
      reviewerAgentId,
      planningEnabled,
      reviewEnabled,
      sddEnabled,
    });

    if (startActive) {
      await addTaskMessage({
        taskId: createdTask.id,
        role: 'assistant',
        messageType: 'system',
        content: startStatus === 'planning' ? 'Task created and activated (planning phase).' : 'Task created and activated.',
        agentId: null,
      });
    }

    return ok({ task_id: createdTask.id });
  },
};

export const taskSearchTool: Tool = {
  name: 'mcp__task__task_search',
  description:
    'Search tasks by query matching title or objective. By default archived tasks are excluded; set include_archived to true to search them too.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
      include_archived: { type: 'boolean' },
    },
    required: ['query'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const query = String(args.query).toLowerCase();
    const limit = args.limit ? Number(args.limit) : 5;
    const includeArchived = args.include_archived === true;

    const allTasks = (await db.query(`SELECT * FROM tasks`)) as Task[];
    const filtered = includeArchived ? allTasks : allTasks.filter((t) => !t.archived);
    const matches = filtered.filter(
      (t) =>
        t.title.toLowerCase().includes(query) ||
        t.objective.toLowerCase().includes(query),
    );

    matches.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return { content: JSON.stringify(matches.slice(0, limit)) };
  },
};

export const taskUnblockTool: Tool = {
  name: 'mcp__task__task_unblock',
  description: 'Unblock a blocked task.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      message: { type: 'string' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const message = args.message ? String(args.message) : '';

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    if (task.status !== 'blocked') return err(`Task ${taskId} is not blocked.`);

    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    task.status = await activationStatus(task, project);
    task.blockedReason = null;
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    const content = message ? `Task unblocked: ${message}` : 'Task unblocked.';
    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'system',
      content,
      agentId: null,
    });

    return ok();
  },
};

export const taskActivateTool: Tool = {
  name: 'mcp__task__task_activate',
  description: 'Activate a draft task.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    if (task.status !== 'draft') return err(`Task ${taskId} is not a draft.`);

    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    task.status = await activationStatus(task, project);
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'system',
      content: task.status === 'planning' ? 'Task activated (planning phase).' : 'Task activated.',
      agentId: null,
    });

    return ok();
  },
};

export const taskUnpauseTool: Tool = {
  name: 'mcp__task__task_unpause',
  description: 'Resume a paused task.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      message: { type: 'string' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const taskId = Number(args.task_id);
    const message = args.message ? String(args.message) : '';

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    if (task.status !== 'paused') return err(`Task ${taskId} is not paused.`);

    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    task.status = await activationStatus(task, project);
    task.noProgressCount = 0; // reset progress cap on manual unpause
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    const content = message ? `Task unpaused: ${message}` : 'Task unpaused.';
    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'system',
      content,
      agentId: null,
    });

    return ok();
  },
};

export const taskDiscardWorktreeTool: Tool = {
  name: 'mcp__task__task_discard_worktree',
  description:
    'Commit any pending changes on the task branch, then remove its git worktree (the branch is kept). Use to clean up a task worktree manually when a task is done or abandoned.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);
    if (!task.worktreePath) return err(`Task ${taskId} has no active worktree`);

    await discardWorktree(task.worktreePath, task.title);
    task.worktreePath = null;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return ok({ branch: task.branch });
  },
};

export const taskArchiveTool: Tool = {
  name: 'mcp__task__task_archive',
  description:
    'Archive a task. Archived tasks are hidden from the default task list and excluded from the scheduler heartbeat, but remain in the store and can be unarchived.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    task.archived = true;
    // An archived task stops running: pause it so the heartbeat won't pick it up.
    if (task.status === 'active' || task.status === 'reviewing') {
      task.status = 'paused';
    }
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'system',
      content: 'Task archived.',
      agentId: null,
    });

    return ok();
  },
};

export const taskUnarchiveTool: Tool = {
  name: 'mcp__task__task_unarchive',
  description:
    'Unarchive a previously archived task, making it visible in the default task list again. The task status is not changed — use task_activate or task_unpause to resume work.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    task.archived = false;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'system',
      content: 'Task unarchived.',
      agentId: null,
    });

    return ok();
  },
};

export const taskDeleteTool: Tool = {
  name: 'mcp__task__task_delete',
  description:
    'Permanently delete a task and all of its messages from the store. This is irreversible. If the task has an active git worktree, it is discarded first (branch kept).',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    // Guard against deleting a task that is currently being processed by the
    // scheduler heartbeat. The heartbeat holds an in-process lock and a DB
    // lockedAt timestamp; deleting mid-run would cause the finally block to
    // resurrect the task as a zombie via saveTask.
    const lockKey = `task_db_${taskId}`;
    if (task.lockedAt || runningTasks.has(lockKey)) {
      return err(`Task ${taskId} is currently running (locked). Wait for it to finish or pause it first.`);
    }

    // Clean up any active worktree before deleting the task record.
    if (task.worktreePath) {
      try {
        await discardWorktree(task.worktreePath, task.title);
      } catch {
        // Best-effort: proceed with deletion even if worktree cleanup fails.
      }
    }

    await deleteTask(taskId);
    return ok();
  },
};

export const taskSetAgentTool: Tool = {
  name: 'mcp__task__task_set_agent',
  description:
    'Assign a specific agent to a task role, overriding the project default. role: developer (default, the main task agent), planner, or reviewer. Pass null or omit agent_id to clear the override and fall back to the project default.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      agent_id: { type: 'string', description: 'The agent ID to assign, or null to clear the override.' },
      role: {
        type: 'string',
        enum: ['developer', 'planner', 'reviewer'],
        description: 'Which role to assign. Defaults to developer (the main task agent).',
      },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const agentId = args.agent_id != null ? String(args.agent_id) : null;
    const role = args.role === 'planner' || args.role === 'reviewer' ? args.role : 'developer';

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    // Guard against reassigning a task that is currently running.
    const lockKey = `task_db_${taskId}`;
    if (task.lockedAt || runningTasks.has(lockKey)) {
      return err(`Task ${taskId} is currently running. Wait for it to finish or pause it first.`);
    }

    // Validate that the specified agent exists (if provided and non-null).
    if (agentId) {
      const agents = await loadAgents();
      if (!agents.some((a) => a.id === agentId)) {
        return err(`Agent "${agentId}" not found. Available agents: ${agents.map((a) => a.id).join(', ') || '(none)'}`);
      }
    }

    if (role === 'planner') task.plannerAgentId = agentId;
    else if (role === 'reviewer') task.reviewerAgentId = agentId;
    else task.agentId = agentId;

    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return ok({ role, agentId });
  },
};

export const submitPlanTool: Tool = {
  name: 'mcp__task__task_submit_plan',
  description:
    'Submit the implementation plan for a task in the planning phase and start execution. Persists the plan to the task thread and transitions the task from planning to active. Only valid while the task status is "planning".',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      plan: { type: 'string', description: 'The full implementation plan, markdown.' },
    },
    required: ['task_id', 'plan'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const plan = String(args.plan ?? '').trim();
    if (!plan) return err('Plan must not be empty.');

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);
    if (task.status !== 'planning') {
      return err(`Task ${taskId} is not in planning (status: ${task.status}).`);
    }

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'plan',
      content: plan,
      agentId: null,
    });

    task.status = 'active';
    task.noProgressCount = 0;
    task.lockedAt = null;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return ok({ status: 'active' });
  },
};
