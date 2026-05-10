// Enumerate every configured agent — including the caller itself, so the
// model can see the full roster (e.g. to introspect its own peers).
// Self-invocation is still rejected at dispatch time by the guard inside
// `invoke_agent`, so listing self does NOT enable a recursion vulnerability.
// Managed-by-plugin rows are flagged so the model can decide whether to
// dispatch a vendor-supplied specialist.

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
    'List every configured agent (including yourself). Each entry has ' +
    '`name`, `model`, `provider`, and `managed` (true when the agent comes ' +
    'from a plugin). Use the `name` field with `invoke_agent` to delegate ' +
    'a one-shot task to another agent — note that invoking yourself is ' +
    'rejected at dispatch time.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args) {
    const all = await loadAgents();
    const summaries: AgentSummary[] = all.map((a) => ({
      name: a.name,
      model: a.model,
      provider: a.provider,
      managed: !!a.pluginId,
    }));
    if (summaries.length === 0) return { content: 'No agents configured.' };
    return { content: JSON.stringify(summaries, null, 2) };
  },
};
