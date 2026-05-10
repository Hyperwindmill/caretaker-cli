// Tool registry types. The `Tool` shape is provider-agnostic and the loop
// dispatches against it without distinguishing native (in-process) tools
// from adapter-wrapped tools (e.g. an MCP adapter, future). A `Tool` only
// has to declare its OpenAI-function-calling parameters and an `execute`
// that takes parsed args + a runtime context and returns a structured result.

import type { AgentConfig } from "../../types.js";

export type ConfirmDecision = "once" | "always" | "reject";
export type ConfirmGate = (
  id: string,
  name: string,
  args: unknown,
) => Promise<ConfirmDecision>;
//
// ─── Conversion path from caretaker server ───────────────────────────────
// caretaker full hosts tools as MCP HTTP servers (src/mcp/*.ts). Two paths
// to bring them here, each with its own trade-offs:
//
//   Path A — MCP adapter (no rewrite):
//     A future `harness/tools/mcp/adapter.ts` will speak MCP and wrap remote
//     tools as `Tool` instances with names "mcp__<server>__<tool>", matching
//     the server's namespacing convention. Zero rewrite, zero divergence.
//     Heavy/integrated tools (kb, youtrack, gitlab, task) belong here.
//
//   Path B — Native port (in-process):
//     Stable, frequently used tools can be re-implemented as native `Tool`s
//     in `builtin/`. Lower overhead, simpler deploy, but you take on
//     maintenance. Self-contained tools (git, fs, bash) belong here.
//
// The `Tool` interface intentionally hides the distinction — the loop sees
// only `{name, description, parameters, execute}`.

export interface ToolContext {
  /** Aborted when the run is cancelled (Esc) or the chat unmounts. Tools
   *  that spawn subprocesses or open network connections MUST honor it. */
  signal: AbortSignal;
  /** Working directory for fs/bash tools. Defaults to process.cwd(). */
  workingDir: string;
  /** Set of absolute paths read in this run. fs.read populates it; fs.write
   *  consults it for the read-before-write guard so the model cannot blind-
   *  overwrite a file it never inspected. The loop creates a fresh Set per
   *  run; tools mutate it in place. */
  readPaths: Set<string>;
  /** Plugin names active for this run (mirrors AgentConfig.plugins). The
   *  list_skills / read_skill tools consult this to scope what the model can
   *  enumerate or fetch. Optional because most tools never read it; tests
   *  for non-skill tools can omit it. The skill tools treat undefined as []. */
  activePlugins?: string[];
  /** The agent currently executing this tool. `invoke_agent` reads this to
   *  resolve inheritance for the invoked sub-agent (empty fields fall back
   *  to the caller). At the top-level run this is the user's chat agent;
   *  inside a dispatched child it is the child's already-effective config. */
  callerAgent?: AgentConfig;
  /** How many `invoke_agent` frames deep this run is. Top-level = 0; a
   *  dispatched child = 1; etc. The dispatch helper rejects calls past a
   *  small cap to prevent runaway recursion. */
  dispatchDepth?: number;
  /** The chat-side confirm callback. The dispatch helper passes it through
   *  to the child run so the user keeps the gate authority for tool calls
   *  inside the sub-agent too. */
  confirmTool?: ConfirmGate;
}

export interface ToolResult {
  /** Textual content returned to the model as the tool result. */
  content: string;
  // Future: attachments?: Array<{ mime: string; data: Buffer }> for image-returning tools.
}

export interface Tool {
  /** Unique key. Flat for native tools (e.g. "read_file"), namespaced for
   *  adapter-wrapped tools (e.g. "mcp__kb__search"). The name appears in
   *  the agent's allowedTools list and in the model's tool_call payload. */
  name: string;
  description: string;
  /** JSON Schema for the args (OpenAI function-calling shape). */
  parameters: Record<string, unknown>;
  /** Resolves the tool. Throws are caught by the loop and surfaced as
   *  "Error: <msg>" tool results. */
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
  /** Marks tools whose action mutates the system or has side effects
   *  (file write, command exec, network mutation). The harness may surface
   *  a confirm prompt for these in a future iteration; today purely
   *  informational. */
  dangerous?: boolean;
}

export interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Convert a Tool to the OpenAI function-tool entry sent in chat-completions. */
export function toOpenAiTool(tool: Tool): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
