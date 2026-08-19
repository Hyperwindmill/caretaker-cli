import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { Store } from '@morphql/store';
import { FolderAdapter } from '@morphql/store/node';
import { loadConfig, saveConfig } from './json.js';

export interface ChecklistItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  order: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  workingDir: string;
  agentId: string;
  active: boolean;
  plannerAgentId?: string | null;
  reviewerAgentId?: string | null;
  planningEnabled?: boolean | null;
  reviewEnabled?: boolean | null;
  sddEnabled?: boolean | null;
}

export interface Task {
  /** `<projectId>-<seq>`. OPAQUE — never parse it; projectId and seq below
   *  are the source of truth. Embedded verbatim in the worktree dir name
   *  (~/.caretaker/worktrees/<id>) and container name (caretaker-task-<id>). */
  id: string;
  projectId: string;
  /** Per-project sequence number; stored, never derived from id. */
  seq: number;
  title: string;
  objective: string;
  checklist: ChecklistItem[];
  status: 'draft' | 'planning' | 'active' | 'reviewing' | 'paused' | 'blocked' | 'done';
  blockedReason: string | null;
  noProgressCount: number;
  maxNoProgress: number;
  lockedAt: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  archived?: boolean;
  agentId?: string | null;
  plannerAgentId?: string | null;
  reviewerAgentId?: string | null;
  planningEnabled?: boolean | null;
  reviewEnabled?: boolean | null;
  sddEnabled?: boolean | null;
  /** Per-invocation wall-clock budget (seconds). Inherits from the project; unset = default. */
  maxRunSeconds?: number | null;
  /** Name of the docker container isolating this task's runs (set when the
   *  project has a dockerImage). Parallel to branch/worktreePath. */
  dockerContainer?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessage {
  id: number;
  taskId: string;
  role: 'user' | 'assistant' | 'tool';
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield' | 'review' | 'plan';
  content: string;
  toolCallId?: string | null;
  agentId?: string | null;
  /** Identity of the agent that produced this message, captured at creation as
   *  `name · model` text (of that moment — survives later agent reconfig/rename). */
  agentLabel?: string | null;
  createdAt: string;
}

export function dataDir(): string {
  return process.env.CARETAKER_HOME ?? join(homedir(), '.caretaker');
}

export function dbStoreDir(): string {
  return join(dataDir(), 'store');
}

let dbInstance: Store | null = null;

export function getDb(): Store {
  if (!dbInstance) {
    const dir = dbStoreDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    dbInstance = new Store(new FolderAdapter(dir, { pretty: true }));
  }
  return dbInstance;
}

let queryQueue: Promise<any> = Promise.resolve();

export function tryNormalizeChecklistStatus(status: any): 'pending' | 'in_progress' | 'done' | 'skipped' | null {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'done') {
    return 'done';
  }
  if (s === 'in_progress' || s === 'progress') {
    return 'in_progress';
  }
  if (s === 'skipped' || s === 'skip') {
    return 'skipped';
  }
  if (s === 'pending') {
    return 'pending';
  }
  return null;
}

/** Ids are validated slugs/composites; anything else never matches a record.
 *  Also keeps quotes/backslashes out of interpolated queries. */
function safeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

export async function runQuery(sql: string): Promise<any> {
  const op = () => getDb().query(sql);
  const resultPromise = queryQueue.then(op);
  queryQueue = resultPromise.catch(() => {});
  return resultPromise;
}

export async function getTaskById(id: string): Promise<Task | null> {
  if (!safeId(id)) return null;
  try {
    const taskRows = (await runQuery(`SELECT * FROM tasks WHERE id = '${id}'`)) as Task[];
    return taskRows[0] || null;
  } catch (err) {
    return null;
  }
}

export async function saveTask(task: Task): Promise<void> {
  await runQuery(`DELETE FROM tasks WHERE id = '${task.id}'`);
  await runQuery(`INSERT INTO tasks ${JSON.stringify(task)}`);
}

export async function createTask(task: Omit<Task, 'id' | 'seq' | 'createdAt' | 'updatedAt'>): Promise<Task> {
  if (!safeId(task.projectId)) throw new Error(`Invalid project id: ${task.projectId}`);
  const config = await loadConfig();
  const project = (config.projects || []).find((p) => p.id === task.projectId);
  const existing = (await runQuery(`SELECT * FROM tasks WHERE projectId = '${task.projectId}'`)) as Task[];
  const seq = Math.max(project?.nextTaskSeq ?? 0, 0, ...existing.map((t) => t.seq ?? 0)) + 1;
  const record: Task = {
    ...task,
    id: `${task.projectId}-${seq}`,
    seq,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await runQuery(`INSERT INTO tasks ${JSON.stringify(record)}`);
  if (project) {
    // ponytail: unlocked read-modify-write on nextTaskSeq; the max() over
    // existing seqs above heals races and stale-config rollbacks. Move the
    // counter into the folder DB behind runQuery's queue if it ever matters.
    project.nextTaskSeq = seq;
    await saveConfig(config);
  }
  return record;
}

export async function addTaskMessage(msg: Omit<TaskMessage, 'id' | 'createdAt'>): Promise<TaskMessage> {
  if (!safeId(msg.taskId)) throw new Error(`Invalid task id: ${msg.taskId}`);
  const payload = {
    ...msg,
    id: '$auto',
    createdAt: new Date().toISOString(),
  };
  await runQuery(`INSERT INTO task_messages ${JSON.stringify(payload)}`);
  
  // Find the inserted message to get its auto-increment ID
  const messages = (await runQuery(`SELECT * FROM task_messages WHERE taskId = '${msg.taskId}'`)) as TaskMessage[];
  const created = messages[messages.length - 1];
  if (!created) {
    throw new Error('Failed to retrieve newly created task message');
  }
  return created;
}

export async function updateTaskMessageContent(
  id: number,
  content: string,
  type?: TaskMessage['messageType']
): Promise<void> {
  const cleaned = content
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .slice(0, 50000);
  if (type) {
    await runQuery(`UPDATE task_messages SET content = '${cleaned}', messageType = '${type}' WHERE id = ${id}`);
  } else {
    await runQuery(`UPDATE task_messages SET content = '${cleaned}' WHERE id = ${id}`);
  }
}

// Permanently delete a task and all of its messages. Used by the delete
// action (real deletion from the store); archiving is a soft flag, not this.
export async function deleteTask(taskId: string): Promise<void> {
  if (!safeId(taskId)) return;
  await runQuery(`DELETE FROM task_messages WHERE taskId = '${taskId}'`);
  await runQuery(`DELETE FROM tasks WHERE id = '${taskId}'`);
}
