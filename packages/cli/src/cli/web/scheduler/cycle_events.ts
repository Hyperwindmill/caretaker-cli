// In-process live channel for running task cycles. The cycle recorder emits
// the chat's own stream events keyed by session id; WebSocket watchers attach
// to a running cycle and replay what has happened so far, then follow it.
// Finished cycles are dropped from the map — watchers then load from disk.

import type { MessageRecord } from '../../../session/types.js';

export type CycleEvent =
  | { type: 'chunk'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

interface RunningCycle {
  prompt: MessageRecord;
  /** Every event of the cycle so far, consecutive text coalesced. */
  events: CycleEvent[];
  listeners: Set<(ev: CycleEvent) => void>;
}

const running = new Map<string, RunningCycle>();

export function beginCycleStream(sessionId: string, prompt: MessageRecord): void {
  running.set(sessionId, { prompt, events: [], listeners: new Set() });
}

export function emitCycleEvent(sessionId: string, ev: CycleEvent): void {
  const cycle = running.get(sessionId);
  if (!cycle) return;

  const last = cycle.events[cycle.events.length - 1];
  if (ev.type === 'chunk' && last?.type === 'chunk') {
    cycle.events[cycle.events.length - 1] = { type: 'chunk', text: last.text + ev.text };
  } else if (ev.type === 'thinking' && last?.type === 'thinking') {
    cycle.events[cycle.events.length - 1] = { type: 'thinking', text: last.text + ev.text };
  } else if (ev.type !== 'done' && ev.type !== 'error') {
    cycle.events.push(ev);
  }

  for (const listener of cycle.listeners) listener(ev);

  if (ev.type === 'done' || ev.type === 'error') running.delete(sessionId);
}

/** Attach to a running cycle. Snapshot and attach happen synchronously, so no
 *  event can fall between them. `null` when the cycle is not running. */
export function watchCycleStream(
  sessionId: string,
  listener: (ev: CycleEvent) => void,
): { prompt: MessageRecord; events: CycleEvent[]; unwatch: () => void } | null {
  const cycle = running.get(sessionId);
  if (!cycle) return null;
  cycle.listeners.add(listener);
  return {
    prompt: cycle.prompt,
    events: [...cycle.events],
    unwatch: () => {
      cycle.listeners.delete(listener);
    },
  };
}
