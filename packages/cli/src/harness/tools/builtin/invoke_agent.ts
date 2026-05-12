// Dispatch a one-shot task to another agent and return its final assistant
// text. Two modes:
//
//   1. Named — `invoke_agent({name, task})` looks up the agent in
//      agents.json and dispatches it with field-level inheritance applied
//      to its empty runtime fields. Self-invocation is rejected: an agent
//      with a fixed identity/goal in its systemPrompt would just spin on
//      its own goal again.
//
//   2. Anonymous — `invoke_agent({task})` (no `name`) spins up an
//      ephemeral generic agent that inherits provider, model, allowedTools,
//      plugins, mcpServers, workingDir, confirmTools from the caller and
//      has NO systemPrompt of its own. The task becomes the only user
//      message. Useful for delegating speculative subtasks without
//      polluting the parent's history and without dragging the parent's
//      identity along. Bounded by the standard dispatch-depth cap.
//
// Errors during the child run (provider failure, missing config, abort,
// guard) surface as `Error: <msg>` so the parent loop continues.

import { randomUUID } from 'node:crypto';
import type { Tool } from '../types.js';
import { loadAgents } from '../../../store/json.js';
import type { AgentConfig } from '../../../types.js';

// dispatchAgent is lazy-imported to break a static-import cycle:
//   instance.ts → builtin/index.ts → invoke_agent.ts → agents/dispatch.ts
//     → harness/tools/instance.js (singleton)  ← back to start
// At call time the modules are fully initialized, so the dynamic import is
// safe and adds one cache lookup per invocation (negligible).

function buildAnonymousAgent(callerMaxTurns: number): AgentConfig {
  // Empty everywhere — every meaningful field gets filled in by
  // effectiveAgent's inheritance rule from ctx.callerAgent. The fresh
  // UUID guarantees the self-invocation guard cannot misfire.
  return {
    id: randomUUID(),
    name: '(anonymous)',
    systemPrompt: '',
    provider: '',
    model: '',
    allowedTools: [],
    // maxTurns isn't inherited; pick something sensible. The caller's
    // own cap is a fine upper bound for a one-shot subtask.
    maxTurns: callerMaxTurns,
  };
}

export const invokeAgentTool: Tool = {
  name: 'invoke_agent',
  description:
    'Invoke another agent one-shot with a task. Two modes: ' +
    '(1) pass `name` (from list_agents) to dispatch a configured agent — ' +
    'runtime fields it left empty inherit from you, but its systemPrompt ' +
    'is its own (so use this when you want a specific identity/goal). ' +
    '(2) omit `name` to spin up an ANONYMOUS sub-agent that inherits ' +
    'provider/model/tools/plugins/mcpServers/workingDir from you and has ' +
    'no systemPrompt — the task IS the prompt. Useful for speculative ' +
    'subtasks you want isolated from your own history. There is never ' +
    'shared history; each invocation starts fresh.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          "Optional. AgentConfig.name from list_agents (e.g. 'security-auditor' or " +
          "'code-modernization/legacy-analyst'). Omit to dispatch an anonymous sub-agent.",
      },
      task: {
        type: 'string',
        description: 'What you want the invoked agent to do. This becomes its only user message.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { name?: unknown; task?: unknown };
    if (typeof a.task !== 'string' || !a.task.trim()) {
      return { content: 'Error: task must be a non-empty string' };
    }

    let invoked: AgentConfig;
    if (a.name === undefined || (typeof a.name === 'string' && a.name.trim() === '')) {
      invoked = buildAnonymousAgent(ctx.callerAgent?.maxTurns ?? 30);
    } else if (typeof a.name === 'string') {
      const all = await loadAgents();
      const found = all.find((x) => x.name === a.name);
      if (!found) return { content: `Error: agent "${a.name}" not found` };
      invoked = found;
    } else {
      return { content: 'Error: name must be a string when provided' };
    }

    const { dispatchAgent } = await import('../../../agents/dispatch.js');
    const result = await dispatchAgent({ invoked, task: a.task, ctx });
    if (result.guardError) {
      return { content: `Error: ${result.guardError}` };
    }
    if (result.stop === 'aborted') {
      return { content: 'Error: invocation aborted' };
    }
    if (result.stop === 'max_turns') {
      return {
        content: result.text
          ? `${result.text}\n\n(invocation hit max_turns without a clean stop)`
          : 'Error: invocation hit max_turns without producing output',
      };
    }
    return { content: result.text };
  },
};
