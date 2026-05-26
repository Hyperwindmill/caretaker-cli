import { randomUUID } from 'node:crypto';
import { getDb, ChecklistItem, Project, Task, TaskMessage, getTaskById, saveTask, createTask, addTaskMessage } from '../../../store/db.js';
import { loadConfig } from '../../../store/json.js';
import type { Tool, ToolResult } from '../types.js';

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
        blockedReason: task.blockedReason,
        noProgressCount: task.noProgressCount,
        maxNoProgress: task.maxNoProgress,
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
    const status = args.status as any;

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

    const checklist: ChecklistItem[] = checklistInput.map((item, idx) => ({
      id: item.id || randomUUID(),
      text: item.text,
      status: item.status,
      order: idx,
    }));

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

    task.status = 'done';
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

    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === projectId);
    if (!project) return err(`Project ${projectId} not found`);

    const checklist: ChecklistItem[] = checklistInput.map((item, idx) => ({
      id: randomUUID(),
      text: item.text,
      status: 'pending',
      order: idx,
    }));

    const createdTask = await createTask({
      projectId,
      title,
      objective,
      checklist,
      status: startActive ? 'active' : 'draft',
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
    });

    if (startActive) {
      await addTaskMessage({
        taskId: createdTask.id,
        role: 'assistant',
        messageType: 'system',
        content: 'Task created and activated.',
        agentId: null,
      });
    }

    return ok({ task_id: createdTask.id });
  },
};

export const taskSearchTool: Tool = {
  name: 'mcp__task__task_search',
  description: 'Search tasks by query matching title or objective.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const db = getDb();
    const query = String(args.query).toLowerCase();
    const limit = args.limit ? Number(args.limit) : 5;

    const allTasks = (await db.query(`SELECT * FROM tasks`)) as Task[];
    const matches = allTasks.filter(
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

    task.status = 'active';
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

    task.status = 'active';
    task.updatedAt = new Date().toISOString();

    await saveTask(task);

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'system',
      content: 'Task activated.',
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

    task.status = 'active';
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
