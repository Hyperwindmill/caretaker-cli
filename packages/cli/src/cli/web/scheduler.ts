import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, appendFile } from 'node:fs/promises';

import { loadConfig, dataDir } from '../../store/json.js';
import type { ScheduledTaskConfig } from '../../types.js';
import { HeartbeatStrategy } from './scheduler/heartbeat.js';
import { TelegramStrategy } from './scheduler/telegram.js';

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

/**
 * Parses and evaluates a cron expression string against a given Date.
 * Supports standard syntax fields: minute, hour, day of month, month, day of week.
 * Handles wildcards (*), step levels (e.g. *\/5), ranges (e.g. 1-5), and comma lists (e.g. 1,3,5).
 */
const strategies = new Map<string, any>([
  [HeartbeatStrategy.type, HeartbeatStrategy],
  [TelegramStrategy.type, TelegramStrategy],
]);

/** Task IDs currently being executed — prevents concurrent runs of the same task. */
export const runningTasks = new Set<string>();

/**
 * Evaluates all scheduled tasks and triggers execution loops for matching ones.
 */
export async function runSchedulerTick(): Promise<void> {
  const now = new Date();
  try {
    const config = await loadConfig();
    const tasks = config.scheduler?.tasks || [];
    const enabledTasks = tasks.filter((t) => t.enabled);

    for (const task of enabledTasks) {
      const strategy = strategies.get(task.type);
      if (strategy) {
        await strategy.tick(task, now).catch((err: any) => {
          console.error(`[scheduler] Strategy ${task.type} failed for task "${task.name}":`, err);
        });
      }
    }
  } catch (err) {
    console.error('[scheduler] Error evaluating scheduler tasks tick:', err);
  }
}

let schedulerIntervalRef: NodeJS.Timeout | null = null;

/**
 * Starts the in-process background scheduler loop.
 */
export function startBackgroundScheduler(): void {
  if (schedulerIntervalRef) return;

  console.log('[scheduler] Starting in-process background scheduler daemon...');
  // Check matching jobs every 15 seconds to ensure exact minute matching + telegram ticks
  schedulerIntervalRef = setInterval(() => {
    void runSchedulerTick();
  }, 15000);
}

/**
 * Stops the in-process background scheduler loop.
 */
export function stopBackgroundScheduler(): void {
  if (schedulerIntervalRef) {
    console.log('[scheduler] Stopping in-process background scheduler daemon...');
    clearInterval(schedulerIntervalRef);
    schedulerIntervalRef = null;
  }
}
