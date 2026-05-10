// Live self-introspection: returns the agent's identity (also surfaced in
// the <runtime-info> block of the system prompt, but cheap to repeat
// here) plus the current run's token usage. The numbers come from
// ctx.liveUsage, which the loop mutates in place each turn — so the value
// the model sees here is always the latest, not a snapshot from when the
// run started. `contextWindow` is resolved from the models.dev registry
// (populated lazily at boot); `percent` is computed from the cumulative
// total. Both stay null when the model is unknown to the registry.

import type { Tool } from '../types.js';
import { resolveContextWindow } from '../../model_limits.js';

function totalOf(
  u:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        reasoning?: number;
      }
    | undefined,
): number {
  if (!u) return 0;
  return (
    (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.reasoning ?? 0)
  );
}

export const getAgentContextTool: Tool = {
  name: 'get_agent_context',
  description:
    "Return live information about this run: the agent's identity (name, " +
    'model, provider, working directory) and token usage so far ' +
    '(last turn breakdown + cumulative across the run). Static identity is ' +
    'also visible in the <runtime-info> block of your system prompt — ' +
    'prefer reading that for non-live questions. Call this tool only when ' +
    'you need fresh token-usage numbers.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, ctx) {
    const agent = ctx.callerAgent;
    const usage = ctx.liveUsage;
    const cumulative = usage?.cumulative ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    };
    const lastTurn = usage?.lastTurn ?? null;
    const cumulativeTotal = totalOf(cumulative);
    const contextWindow = agent?.model ? resolveContextWindow(agent.model) : null;
    const percent =
      contextWindow && cumulativeTotal > 0
        ? Math.round((cumulativeTotal / contextWindow) * 100)
        : null;

    const payload = {
      agent: {
        name: agent?.name ?? null,
        model: agent?.model ?? null,
        provider: agent?.provider ?? null,
      },
      workingDir: ctx.workingDir,
      usage: {
        lastTurn: lastTurn
          ? {
              input: lastTurn.input ?? 0,
              output: lastTurn.output ?? 0,
              cacheRead: lastTurn.cacheRead ?? 0,
              cacheWrite: lastTurn.cacheWrite ?? 0,
              reasoning: lastTurn.reasoning ?? 0,
              total: totalOf(lastTurn),
            }
          : null,
        cumulative: {
          input: cumulative.input ?? 0,
          output: cumulative.output ?? 0,
          cacheRead: cumulative.cacheRead ?? 0,
          cacheWrite: cumulative.cacheWrite ?? 0,
          reasoning: cumulative.reasoning ?? 0,
          total: cumulativeTotal,
        },
        contextWindow,
        percent,
      },
    };
    return { content: JSON.stringify(payload, null, 2) };
  },
};
