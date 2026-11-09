import { loadConfig } from '../../store/json.js';
import type { ServiceConfig } from '../../types.js';
import { HeartbeatStrategy, executeTaskRun } from './scheduler/heartbeat.js';
import { TelegramStrategy } from './scheduler/telegram.js';
import { EmailTriageStrategy, realTriageDeps } from './scheduler/email_triage_agent.js';
import { executeTriageRun } from './scheduler/email_triage.js';
import { activeServiceRun, newRunId } from './scheduler/service_runs.js';
import { runTaskHeartbeatTick } from './scheduler/task_strategy.js';
import { runMemorySweepTick } from './scheduler/memory_sweep.js';

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
  [EmailTriageStrategy.type, EmailTriageStrategy],
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

    // Memory sweep (session digests) — self-gated to at most one run per sweepMinutes.
    await runMemorySweepTick(now).catch((err) => {
      console.error('[scheduler] Memory sweep tick failed:', err);
    });
  } catch (err) {
    console.error('[scheduler] Error evaluating scheduler tasks tick:', err);
  }
}


/** Service types a user can run by hand: the cron-driven ones. */
export function isRunnableService(service: ServiceConfig): boolean {
  return service.type === 'heartbeat' || service.type === 'email_triage';
}

/**
 * Starts a run of a cron-driven service now, regardless of its schedule or
 * enabled flag, and returns its run id. A run already in flight is not
 * duplicated: its id is returned instead, so the caller can follow it.
 */
export function runServiceNow(service: ServiceConfig): string {
  const inFlight = activeServiceRun(service.id);
  if (inFlight) return inFlight;
  const runId = newRunId();
  const run =
    service.type === 'email_triage'
      ? executeTriageRun(service, realTriageDeps, runId)
      : executeTaskRun(service, runId);
  void run.catch((err) => console.error(`[scheduler] Manual run of "${service.name}" failed:`, err));
  return runId;
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
