// Live channel for service runs (heartbeat, email triage): the run in flight per
// service, streamed through the task-cycle buffer keyed by run id, so the log
// viewer can follow a run whether it was started by its cron or by hand.
//
// Harness-free on purpose: email_triage.ts imports it and must stay testable
// with plain fakes.
import { randomUUID } from 'node:crypto';

import type { RunCallbacks } from '../../../harness/loop.js';
import type { MessageRecord } from '../../../session/types.js';
import { beginCycleStream, emitCycleEvent } from './cycle_events.js';

/** serviceId → runId of the run in flight. */
const active = new Map<string, string>();

export function newRunId(): string {
  return `run_${randomUUID().slice(0, 8)}`;
}

/** Must be called in the same synchronous block that takes the service's
 *  `runningTasks` lock, so the two can never disagree. */
export function beginServiceRun(serviceId: string, runId: string, prompt: MessageRecord | null): void {
  active.set(serviceId, runId);
  beginCycleStream(runId, prompt);
}

/** Call only after the run's log is persisted: a watcher reloads the run list on `done`. */
export function endServiceRun(serviceId: string, runId: string): void {
  if (active.get(serviceId) === runId) active.delete(serviceId);
  emitCycleEvent(runId, { type: 'done' });
}

export function activeServiceRun(serviceId: string): string | undefined {
  return active.get(serviceId);
}

export function emitServiceRunEvent(runId: string, text: string, type: 'user' | 'chunk'): void {
  emitCycleEvent(runId, { type, text });
}

export function serviceRunCallbacks(
  runId: string,
): Pick<RunCallbacks, 'onChunk' | 'onThinking' | 'onToolCall' | 'onToolResult'> {
  return {
    onChunk: (text) => emitCycleEvent(runId, { type: 'chunk', text }),
    onThinking: (text) => emitCycleEvent(runId, { type: 'thinking', text }),
    onToolCall: (id, name, args) => emitCycleEvent(runId, { type: 'tool_call', id, name, args }),
    onToolResult: (id, content) => emitCycleEvent(runId, { type: 'tool_result', id, content }),
  };
}
