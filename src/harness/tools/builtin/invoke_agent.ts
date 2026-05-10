// Dispatch a one-shot task to another configured agent. Looks up the
// invoked agent by name in agents.json, applies field-level inheritance
// from the caller, runs `harness/loop.run` for the child, and returns the
// child's final assistant text as the tool result.
//
// Guards: rejects self-invocation and dispatch beyond MAX_DISPATCH_DEPTH.
// Errors during the child run (provider failure, missing config, abort)
// surface as `Error: <msg>` so the parent loop continues without crashing.

import type { Tool } from "../types.js";
import { loadAgents } from "../../../store/json.js";

// dispatchAgent is lazy-imported to break a static-import cycle:
//   instance.ts → builtin/index.ts → invoke_agent.ts → agents/dispatch.ts
//     → harness/tools/instance.js (singleton)  ← back to start
// At call time the modules are fully initialized, so the dynamic import is
// safe and adds one cache lookup per invocation (negligible).

export const invokeAgentTool: Tool = {
  name: "invoke_agent",
  description:
    "Invoke another agent one-shot with a task. Use `list_agents` first " +
    "to see available names. The invoked agent runs with its own system " +
    "prompt; runtime fields it left empty (model, provider, allowedTools, " +
    "plugins, mcpServers, workingDir) inherit from you. Returns the " +
    "agent's final assistant text. There is no shared history — each " +
    "invocation starts fresh.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "AgentConfig.name from list_agents (e.g. 'security-auditor' or 'code-modernization/legacy-analyst').",
      },
      task: {
        type: "string",
        description: "What you want the invoked agent to do. This becomes its only user message.",
      },
    },
    required: ["name", "task"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { name?: unknown; task?: unknown };
    if (typeof a.name !== "string" || !a.name.trim()) {
      return { content: "Error: name must be a non-empty string" };
    }
    if (typeof a.task !== "string" || !a.task.trim()) {
      return { content: "Error: task must be a non-empty string" };
    }

    const all = await loadAgents();
    const invoked = all.find((x) => x.name === a.name);
    if (!invoked) {
      return { content: `Error: agent "${a.name}" not found` };
    }

    const { dispatchAgent } = await import("../../../agents/dispatch.js");
    const result = await dispatchAgent({ invoked, task: a.task, ctx });
    if (result.guardError) {
      return { content: `Error: ${result.guardError}` };
    }
    if (result.stop === "aborted") {
      return { content: "Error: invocation aborted" };
    }
    if (result.stop === "max_turns") {
      return {
        content: result.text
          ? `${result.text}\n\n(invocation hit max_turns without a clean stop)`
          : "Error: invocation hit max_turns without producing output",
      };
    }
    return { content: result.text };
  },
};
