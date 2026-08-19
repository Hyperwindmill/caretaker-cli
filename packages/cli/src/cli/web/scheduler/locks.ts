/**
 * Shared in-process locks across scheduler strategies.
 *
 * Heartbeat uses plain task IDs as keys; Telegram uses compound `${taskId}:${chatId}`
 * keys so concurrent chats can progress while serialising per-chat.
 */
export const runningTasks = new Set<string>();

/**
 * AbortControllers for in-flight task heartbeat runs, keyed by task id. Lets a
 * Pause (or block) action abort the running agent mid-cycle instead of waiting
 * for the current cycle to burn through its turns — the whole point of Pause
 * when an agent has gone off the rails.
 */
export const runningTaskControllers = new Map<string, AbortController>();

/** Abort the in-flight run for a task, if one is registered. Returns whether it fired. */
export function abortRunningTask(taskId: string): boolean {
  const ctrl = runningTaskControllers.get(taskId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

/**
 * Project ids with a repository sync (clone/pull) in flight — shared between
 * the heartbeat's pre-worktree sync and POST /api/projects/:id/sync so the
 * two can never race a clone. Derived state only; never persisted.
 */
export const syncingProjects = new Set<string>();
