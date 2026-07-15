import { loadConfig } from '../../store/json.js';
import { HeartbeatStrategy } from './scheduler/heartbeat.js';
import { TelegramStrategy } from './scheduler/telegram.js';
import { runTaskHeartbeatTick } from './scheduler/task_strategy.js';

// Re-exported for backwards compatibility with existing consumers (server.ts, tests).
export {
  schedulerLogsDir,
  schedulerLogPath,
  ensureSchedulerLogsDir,
  loadTaskRuns,
  saveTaskRun,
} from './scheduler/logs.js';
export { runningTasks } from './scheduler/locks.js';

const strategies = new Map<string, any>([
  [HeartbeatStrategy.type, HeartbeatStrategy],
  [TelegramStrategy.type, TelegramStrategy],
]);

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

    // Run the autonomous task heartbeat loop
    await runTaskHeartbeatTick(now).catch((err) => {
      console.error('[scheduler] Autonomous Task Heartbeat Tick failed:', err);
    });
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
