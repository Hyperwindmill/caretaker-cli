// Pure state for the desktop assistant activation (`assistantActivate`, sent
// by the Electron main process). Kept out of App.tsx so the ordering rule is
// unit-testable: when the assistant agent is not the selected one, nothing
// opens until the server acks the switch with `agentSelected` — otherwise a
// short spoken prompt could be sent while the previous agent is still current.

export type Activation = { agentId: string; step: 'awaiting-agent' | 'open' | 'mic' } | null;

export function beginActivation(
  agentId: string,
  selectedAgentId: string | null,
  knownAgentIds: readonly string[],
): Activation {
  if (!knownAgentIds.includes(agentId)) return null;
  return { agentId, step: agentId === selectedAgentId ? 'open' : 'awaiting-agent' };
}

export function onAgentSelected(a: Activation, agentId: string): Activation {
  if (a && a.step === 'awaiting-agent' && a.agentId === agentId) return { agentId, step: 'open' };
  return a;
}
