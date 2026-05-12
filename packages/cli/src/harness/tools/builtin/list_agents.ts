// Enumerate other agents the caller can invoke. Returns one entry per
// configured AgentConfig except the caller itself (no self-recursion at
// the surface). Managed-by-plugin rows are flagged so the model can
// decide whether to dispatch a vendor-supplied specialist.

import type { Tool } from '../types.js';
import { loadAgents } from '../../../store/json.js';

interface AgentSummary {
  name: string;
  model: string;
  provider: string;
  managed: boolean;
}

export const listAgentsTool: Tool = {
  name: 'list_agents',
  description:
    'List the other agents available for sub-agent dispatch. Returns one ' +
    'entry per agent (excluding yourself) with `name`, `model`, `provider`, ' +
    'and `managed` (true when the agent comes from a plugin). Use the ' +
    '`name` field with `invoke_agent` to delegate a one-shot task.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, ctx) {
    const all = await loadAgents();
    const callerId = ctx.callerAgent?.id;
    const summaries: AgentSummary[] = all
      .filter((a) => a.id !== callerId)
      .map((a) => ({
        name: a.name,
        model: a.model,
        provider: a.provider,
        managed: !!a.pluginId,
      }));
    if (summaries.length === 0) return { content: 'No other agents available.' };
    return { content: JSON.stringify(summaries, null, 2) };
  },
};
