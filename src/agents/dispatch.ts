// Sub-agent dispatch: an agent in the loop can invoke another configured
// agent as a one-shot tool. The invoked agent runs in a re-entry of
// `harness/loop.run` with its own (effective) AgentConfig. Empty runtime
// fields on the invoked agent inherit from the caller — see
// `effectiveAgent` below for the exact rule. The final assistant text is
// returned to the caller as a Tool result string.

import { run as runLoop } from "../harness/loop.js";
import { resolveAgentTools } from "../harness/tools/index.js";
import { tools as registry } from "../harness/tools/instance.js";
import { loadConfig } from "../store/json.js";
import type { Tool, ToolContext } from "../harness/tools/types.js";
import type { AgentConfig } from "../types.js";

const MAX_DISPATCH_DEPTH = 5;

/**
 * Compute the effective AgentConfig the invoked agent will run as. Empty
 * runtime fields fall back to the caller's; the systemPrompt is always the
 * invoked agent's own (overriding it would defeat the point of dispatch).
 *
 * Inheritance is per-invocation only — the result is never persisted back
 * into agents.json. `maxTurns` is intentionally NOT inherited; the invoked
 * agent's value (or the AgentConfig default) is fine.
 */
export function effectiveAgent(invoked: AgentConfig, caller: AgentConfig | undefined): AgentConfig {
  if (!caller) return invoked;
  const inheritArr = <T>(child: T[] | undefined, parent: T[] | undefined): T[] | undefined =>
    child !== undefined && child.length > 0 ? child : parent;
  return {
    ...invoked,
    provider: invoked.provider || caller.provider,
    model: invoked.model || caller.model,
    allowedTools: invoked.allowedTools.length > 0 ? invoked.allowedTools : caller.allowedTools,
    confirmTools: inheritArr(invoked.confirmTools, caller.confirmTools),
    plugins: inheritArr(invoked.plugins, caller.plugins),
    mcpServers: inheritArr(invoked.mcpServers, caller.mcpServers),
    workingDir: invoked.workingDir || caller.workingDir,
  };
}

export interface DispatchResult {
  /** Final assistant text the invoked agent produced. Empty string when the
   *  child finished without text (e.g. tool-loop ran out of turns). */
  text: string;
  /** "done" | "max_turns" | "aborted" — mirrors loop.RunResult.stop. */
  stop: "done" | "max_turns" | "aborted";
  /** True when the child halted because of the recursion / self-invoke
   *  guard. The caller renders this as `Error: ...` in the tool result. */
  guardError?: string;
}

export interface DispatchOptions {
  invoked: AgentConfig;
  task: string;
  ctx: ToolContext;
}

/**
 * Run the invoked agent one-shot with the task as its only user message
 * and return its final assistant text. No history is replayed — the child
 * starts fresh. The parent's confirm gate and abort signal are inherited
 * via ToolContext so the user keeps authority over the child's tool calls.
 */
export async function dispatchAgent(opts: DispatchOptions): Promise<DispatchResult> {
  const caller = opts.ctx.callerAgent;

  if (caller && caller.id === opts.invoked.id) {
    return { text: "", stop: "done", guardError: "agent cannot invoke itself" };
  }

  const depth = (opts.ctx.dispatchDepth ?? 0) + 1;
  if (depth > MAX_DISPATCH_DEPTH) {
    return { text: "", stop: "done", guardError: `dispatch depth exceeded (${MAX_DISPATCH_DEPTH})` };
  }

  const effective = effectiveAgent(opts.invoked, caller);

  if (!effective.provider) {
    return { text: "", stop: "done", guardError: "invoked agent has no provider and the caller does not either" };
  }

  let providers;
  try {
    providers = (await loadConfig()).providers;
  } catch (err) {
    return { text: "", stop: "done", guardError: `failed to load providers: ${err instanceof Error ? err.message : String(err)}` };
  }
  const provider = providers.find((p) => p.name === effective.provider);
  if (!provider) {
    return { text: "", stop: "done", guardError: `provider "${effective.provider}" is not configured` };
  }

  let tools: Tool[];
  try {
    tools = await resolveAgentTools(effective, registry);
  } catch (err) {
    return { text: "", stop: "done", guardError: `failed to resolve tools: ${err instanceof Error ? err.message : String(err)}` };
  }

  const result = await runLoop(
    {
      agent: effective,
      provider,
      tools,
      prompt: opts.task,
      // No history — sub-agent invocation is one-shot.
      signal: opts.ctx.signal,
      workingDir: effective.workingDir ?? opts.ctx.workingDir,
      dispatchDepth: depth,
    },
    {
      // Pass the parent's confirm gate down so the user still gates child
      // tool calls.
      confirmTool: opts.ctx.confirmTool,
    },
  );

  return { text: result.text, stop: result.stop };
}
