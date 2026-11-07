// Pure state for the desktop assistant activation (`assistantActivate`, sent
// by the Electron main process). Kept out of App.tsx so the ordering rules are
// unit-testable:
// - the gate is the agent the *server* confirmed (`agentSelected`), never the
//   one the client shows — a failed or still-resolving switch leaves the
//   server on the previous agent, and a spoken prompt must not reach it;
// - a request that arrives before the agent list (first launch with
//   `--assistant`) waits as `pending` instead of being dropped.

export type Activation = { agentId: string; step: 'awaiting-agent' | 'open' | 'mic' } | null;

/** Returns `current` itself (same object) when nothing changes, so the caller
 *  can tell a repeated press apart from a new switch and not re-post. */
export function beginActivation(
  agentId: string,
  confirmedAgentId: string | null,
  knownAgentIds: readonly string[],
  current: Activation,
): Activation {
  if (!knownAgentIds.includes(agentId)) return current;
  if (current?.step === 'awaiting-agent' && current.agentId === agentId) return current;
  return { agentId, step: agentId === confirmedAgentId ? 'open' : 'awaiting-agent' };
}

export function onAgentSelected(a: Activation, agentId: string): Activation {
  if (a && a.step === 'awaiting-agent' && a.agentId === agentId) return { agentId, step: 'open' };
  return a;
}

/** The server refused the switch (e.g. missing provider): drop the wait. */
export function onSelectFailed(a: Activation): Activation {
  return a?.step === 'awaiting-agent' ? null : a;
}

export function resolvePending(
  pendingId: string | null,
  confirmedAgentId: string | null,
  knownAgentIds: readonly string[],
  current: Activation,
): { activation: Activation; pending: string | null } {
  if (!pendingId) return { activation: current, pending: null };
  if (knownAgentIds.length === 0) return { activation: current, pending: pendingId };
  return { activation: beginActivation(pendingId, confirmedAgentId, knownAgentIds, current), pending: null };
}
