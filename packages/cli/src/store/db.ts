import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { Store } from '@morphql/store';
import { FolderAdapter } from '@morphql/store/node';

export interface ChecklistItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  order: number;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  workingDir: string;
  agentId: string;
  active: boolean;
}

export interface Task {
  id: number;
  projectId: number;
  title: string;
  objective: string;
  checklist: ChecklistItem[];
  status: 'draft' | 'active' | 'paused' | 'blocked' | 'done';
  blockedReason: string | null;
  noProgressCount: number;
  maxNoProgress: number;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessage {
  id: number;
  taskId: number;
  role: 'user' | 'assistant' | 'tool';
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield';
  content: string;
  toolCallId?: string | null;
  agentId?: string | null;
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

export async function getTaskById(id: number): Promise<Task | null> {
  const db = getDb();
  try {
    const taskRows = (await db.query(`SELECT * FROM tasks WHERE id = ${id}`)) as Task[];
    return taskRows[0] || null;
  } catch (err) {
    return null;
  }
}

export async function saveTask(task: Task): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM tasks WHERE id = ${task.id}`);
  await db.query(`INSERT INTO tasks ${JSON.stringify(task)}`);
}

export async function createTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task> {
  const db = getDb();
  const payload = {
    ...task,
    id: '$auto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.query(`INSERT INTO tasks ${JSON.stringify(payload)}`);
  
  // Retrieve the created task to get its auto-assigned ID
  const allTasks = (await db.query(`SELECT * FROM tasks`)) as Task[];
  const created = allTasks.find(
    (t) => t.projectId === task.projectId && t.title === task.title && t.objective === task.objective
  );
  if (!created) {
    throw new Error('Failed to retrieve newly created task');
  }
  return created;
}

export async function addTaskMessage(msg: Omit<TaskMessage, 'id' | 'createdAt'>): Promise<TaskMessage> {
  const db = getDb();
  const payload = {
    ...msg,
    id: '$auto',
    createdAt: new Date().toISOString(),
  };
  await db.query(`INSERT INTO task_messages ${JSON.stringify(payload)}`);
  
  // Find the inserted message to get its auto-increment ID
  const messages = (await db.query(`SELECT * FROM task_messages WHERE taskId = ${msg.taskId}`)) as TaskMessage[];
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
  const db = getDb();
  const cleaned = content.replace(/'/g, "''").slice(0, 50000);
  if (type) {
    await db.query(`UPDATE task_messages SET content = '${cleaned}', messageType = '${type}' WHERE id = ${id}`);
  } else {
    await db.query(`UPDATE task_messages SET content = '${cleaned}' WHERE id = ${id}`);
  }
}
