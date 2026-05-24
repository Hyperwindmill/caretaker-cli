import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, appendFile } from 'node:fs/promises';

import { dataDir } from '../../../store/json.js';

/**
 * Returns the folder where scheduler logs are cached under ~/.caretaker/scheduler-logs
 */
export function schedulerLogsDir(): string {
  return join(dataDir(), 'scheduler-logs');
}

/**
 * Returns the path to a specific task's JSONL log file
 */
export function schedulerLogPath(taskId: string): string {
  return join(schedulerLogsDir(), `${taskId}.jsonl`);
}

/**
 * Ensures the scheduler logs folder exists
 */
export async function ensureSchedulerLogsDir(): Promise<void> {
  const dir = schedulerLogsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Parses and returns all execution runs for a given task ID, sorted by timestamp descending (newest first).
 */
export async function loadTaskRuns(taskId: string): Promise<any[]> {
  const path = schedulerLogPath(taskId);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n');
    const runs: any[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        runs.push(JSON.parse(trimmed));
      } catch (err) {
        console.warn(`[scheduler/logs] failed to parse line: ${err}`);
      }
    }
    return runs.reverse();
  } catch (err) {
    console.error(`[scheduler/logs] failed to load runs for task ${taskId}:`, err);
    return [];
  }
}

/**
 * Appends a task execution run record to the task's JSONL file.
 */
export async function saveTaskRun(taskId: string, run: any): Promise<void> {
  await ensureSchedulerLogsDir();
  const path = schedulerLogPath(taskId);
  await appendFile(path, JSON.stringify(run) + '\n', { mode: 0o600 });
}
