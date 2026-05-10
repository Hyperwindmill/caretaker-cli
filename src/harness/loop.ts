// Agent loop, ported from caretaker server's src/runner/openai_style.ts.
// Stripped of: DB persistence layer (replaced by a callback-based hand-off
// to the session store), MCP dispatch (in-process tools instead), permission
// gate, plugin skills, context files, harness prelude, self-introspection
// tool, image-attachment tool results.
//
// Now supports multi-turn replay: pass `opts.history` (prior persisted
// MessageRecords from the session store) and the loop will reconstruct the
// chat-completions message array via mapMessagesToChat. The new user prompt
// is appended after the replayed history. The caller is responsible for
// persisting the user prompt before calling run(); the loop emits assistant
// and tool messages via `cb.onMessage` as they are produced.

import type { AgentConfig, ProviderConfig } from "../types.js";
import type { AssistantPart, MessageRecord } from "../session/types.js";
import { assistantMessage, toolMessage } from "../session/store.js";
import {
  buildRequestBody,
  readStream,
  type AssistantUsage,
  type ChatMessage,
} from "./provider.js";
import { mapMessagesToChat } from "./history.js";
import {
  type ConfirmGate,
  type ConfirmDecision as ToolConfirmDecision,
  type Tool,
  type ToolContext,
  toOpenAiTool,
} from "./tools/index.js";
import { withHarnessPrelude } from "./prelude.js";
import { formatRuntimeInfoBlock } from "./runtime_info.js";
import { loadContextFiles, formatContextBlock, resolveFileReferences } from "./context_files.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = globalThis.fetch.bind(globalThis);
/** Testing hook — override the fetch used by the runner. */
export function __setFetch(f: FetchLike): void { fetchImpl = f; }
export function __resetFetch(): void { fetchImpl = globalThis.fetch.bind(globalThis); }

export type ConfirmDecision = ToolConfirmDecision;

export interface RunCallbacks {
  /** Streamed assistant text fragments as they arrive. */
  onChunk?: (chunk: string) => void;
  /** Streamed model "thinking" / reasoning fragments (provider-dependent). */
  onThinking?: (text: string) => void;
  /** Fired once per tool invocation, after arguments are fully decoded, before execution. */
  onToolCall?: (id: string, name: string, args: unknown) => void;
  /**
   * Optional gate. When provided, the loop awaits the decision before
   * executing each tool call. `"once"` and `"always"` both proceed (the
   * caller is responsible for remembering "always" across subsequent
   * calls); `"reject"` skips execution and the tool result is the string
   * `Error: rejected by user`. The caller decides which tools to gate —
   * this hook does not consult agent.confirmTools itself.
   */
  confirmTool?: ConfirmGate;
  /** Fired with the textual result of the tool. */
  onToolResult?: (id: string, content: string) => void;
  /** Per-turn usage breakdown from the provider. */
  onUsage?: (usage: AssistantUsage) => void;
  /**
   * Emitted for each persistable MessageRecord produced by the loop:
   * one assistant message per turn (with parts + usage), plus one tool
   * message per dispatched tool call. The new user message is the caller's
   * responsibility — it provided the prompt and should persist it before
   * calling run().
   */
  onMessage?: (msg: MessageRecord) => void | Promise<void>;
}

export interface RunOptions {
  agent: AgentConfig;
  provider: ProviderConfig;
  tools: Tool[];
  prompt: string;
  /** Prior persisted messages (excluding the new user prompt). */
  history?: MessageRecord[];
  signal?: AbortSignal;
  /** Working directory passed to fs/bash tools via ToolContext. Defaults to process.cwd(). */
  workingDir?: string;
  /** Frame counter for `invoke_agent` chains. The top-level user-driven
   *  run leaves this undefined (treated as 0). Each dispatched child
   *  passes parent depth + 1. */
  dispatchDepth?: number;
}

export interface RunResult {
  /** Concatenated assistant text across all turns. */
  text: string;
  /** Number of tool calls executed (across all turns). */
  toolCalls: number;
  /** Cumulative usage across turns (sum of per-turn `usage` chunks). */
  usage: AssistantUsage;
  /** Reason the loop terminated: "done", "max_turns", or "aborted". */
  stop: "done" | "max_turns" | "aborted";
}

export async function run(opts: RunOptions, cb: RunCallbacks = {}): Promise<RunResult> {
  const { agent, provider, tools, prompt } = opts;
  const baseUrl = provider.endpoint.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/v1/chat/completions`;
  // 0 → unlimited; >0 → that cap; anything else (negative / NaN) → 30 fallback.
  const maxTurns =
    agent.maxTurns === 0 ? Infinity : agent.maxTurns > 0 ? agent.maxTurns : 30;

  const openAiTools = tools.map(toOpenAiTool);
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  // Tool execution context: signal defaults to a never-aborting one so tools
  // that always check `ctx.signal.aborted` work even when the caller passed
  // no signal.
  const toolCtx: ToolContext = {
    signal: opts.signal ?? new AbortController().signal,
    workingDir: opts.workingDir ?? process.cwd(),
    readPaths: new Set(),
    activePlugins: agent.plugins ?? [],
    callerAgent: agent,
    dispatchDepth: opts.dispatchDepth ?? 0,
    confirmTool: cb.confirmTool,
  };

  // System prompt assembly, applied unconditionally (the prelude and
  // context-files block are harness-level concerns, not tied to which tools
  // the agent has active right now):
  //   1. Resolve @<file> refs in the agent's prompt
  //   2. Prepend AGENTS.md / CLAUDE.md / GEMINI.md walk-up + globals
  //   3. Prepend the harness prelude
  let effectiveSystemPrompt = await resolveFileReferences(
    agent.systemPrompt ?? "",
    toolCtx.workingDir,
  );
  const ctxEntries = await loadContextFiles(toolCtx.workingDir);
  const ctxBlock = formatContextBlock(ctxEntries);
  const withCtx = ctxBlock
    ? `${ctxBlock}\n\n${effectiveSystemPrompt}`.trim()
    : effectiveSystemPrompt;
  effectiveSystemPrompt = withHarnessPrelude(withCtx);

  // Per-run identity block — static facts (name, model, provider,
  // working_dir) the agent should know without spending a tool call.
  // Live token usage / context-window % stays in `get_agent_context`.
  const runtimeBlock = formatRuntimeInfoBlock({
    agentName: agent.name,
    model: agent.model,
    provider: agent.provider,
    workingDir: toolCtx.workingDir,
  });
  effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${runtimeBlock}`.trim();

  // Plugin skills are no longer injected here. Agents with active plugins
  // get the `list_skills` / `read_skill` tools (added by resolveAgentTools
  // at the call site) and pull the SKILL.md content on demand.

  const chat: ChatMessage[] = [];
  if (effectiveSystemPrompt) chat.push({ role: "system", content: effectiveSystemPrompt });
  if (opts.history && opts.history.length > 0) {
    for (const m of mapMessagesToChat(opts.history)) chat.push(m);
  }
  chat.push({ role: "user", content: prompt });

  let fullText = "";
  let totalToolCalls = 0;
  const cumulative: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  // Shared object — the loop mutates `lastTurn` and `cumulative` in place
  // each turn, and `get_agent_context` reads from this same reference at
  // tool execution time so it always sees the latest values.
  const liveUsage: { lastTurn?: AssistantUsage; cumulative: AssistantUsage } = {
    lastTurn: undefined,
    cumulative,
  };
  toolCtx.liveUsage = liveUsage;

  const safeEmit = async (msg: MessageRecord): Promise<void> => {
    try {
      await cb.onMessage?.(msg);
    } catch (err) {
      // Persistence is best-effort within a turn. The model has already
      // produced output and tools have already run; aborting now would
      // diverge model state from on-disk state worse than logging and
      // continuing.
      console.error("[loop] onMessage handler threw:", err);
    }
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) return { text: fullText, toolCalls: totalToolCalls, usage: cumulative, stop: "aborted" };

    const body = buildRequestBody({ messages: chat, tools: openAiTools, model: agent.model });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;

    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!response.ok) {
      const errText = (await response.text().catch(() => "")).slice(0, 8192);
      throw new Error(`provider ${provider.name} returned ${response.status}: ${errText}`);
    }

    let assistantText = "";
    const assistantParts: AssistantPart[] = [];
    let turnUsage: AssistantUsage | undefined;
    const pending = new Map<number, { id: string; name: string; args: string }>();

    // Merge consecutive same-kind streamed deltas into a single part. This
    // keeps the persisted shape compact and round-trips cleanly through
    // mapMessagesToChat.
    const pushTextPart = (text: string) => {
      if (text.length === 0) return;
      const last = assistantParts[assistantParts.length - 1];
      if (last && last.type === "text") last.text += text;
      else assistantParts.push({ type: "text", text });
    };
    const pushThinkingPart = (text: string) => {
      if (text.length === 0) return;
      const last = assistantParts[assistantParts.length - 1];
      if (last && last.type === "thinking") last.text += text;
      else assistantParts.push({ type: "thinking", text });
    };

    await readStream(response, (evt) => {
      switch (evt.kind) {
        case "content":
          assistantText += evt.text;
          fullText += evt.text;
          cb.onChunk?.(evt.text);
          pushTextPart(evt.text);
          break;
        case "thinking":
          cb.onThinking?.(evt.text);
          pushThinkingPart(evt.text);
          break;
        case "tool_call_delta": {
          const rec = pending.get(evt.index) ?? { id: "", name: "", args: "" };
          if (evt.id) rec.id = evt.id;
          if (evt.name) rec.name = evt.name;
          if (evt.argumentsDelta) rec.args += evt.argumentsDelta;
          pending.set(evt.index, rec);
          break;
        }
        case "usage":
          turnUsage = evt.usage;
          liveUsage.lastTurn = evt.usage;
          cb.onUsage?.(evt.usage);
          cumulative.input += evt.usage.input;
          cumulative.output += evt.usage.output;
          cumulative.cacheRead = (cumulative.cacheRead ?? 0) + (evt.usage.cacheRead ?? 0);
          cumulative.cacheWrite = (cumulative.cacheWrite ?? 0) + (evt.usage.cacheWrite ?? 0);
          cumulative.reasoning = (cumulative.reasoning ?? 0) + (evt.usage.reasoning ?? 0);
          break;
        case "finish":
        case "done":
          break;
      }
    });

    if (opts.signal?.aborted) return { text: fullText, toolCalls: totalToolCalls, usage: cumulative, stop: "aborted" };

    // Build the model-facing assistant ChatMessage and the persistable
    // assistant MessageRecord in one pass: tool_use parts mirror the
    // tool_calls array on the chat-completions payload.
    const toolCalls =
      pending.size > 0
        ? [...pending.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, rec]) => ({
              id: rec.id,
              type: "function" as const,
              function: { name: rec.name, arguments: rec.args },
            }))
        : [];

    for (const tc of toolCalls) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsedArgs = {};
      }
      assistantParts.push({ type: "tool_use", id: tc.id, name: tc.function.name, args: parsedArgs });
    }

    // Persist the assistant turn (parts + usage). Caller serializes via the
    // session store; we await so writes are ordered.
    const assistantMsg = assistantMessage(assistantParts, turnUsage);
    await safeEmit(assistantMsg);

    // Mirror the assistant turn into the chat-completions array for the next iteration.
    chat.push({
      role: "assistant",
      content: assistantText.length > 0 ? assistantText : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      return { text: fullText, toolCalls: totalToolCalls, usage: cumulative, stop: "done" };
    }

    for (const tc of toolCalls) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsedArgs = {};
      }
      cb.onToolCall?.(tc.id, tc.function.name, parsedArgs);
      totalToolCalls++;

      let content = "";
      const t = toolByName.get(tc.function.name);
      if (!t) {
        content = `Error: unknown tool "${tc.function.name}"`;
      } else {
        let gateOutcome: "proceed" | "reject" | string = "proceed";
        if (cb.confirmTool) {
          try {
            const decision = await cb.confirmTool(tc.id, tc.function.name, parsedArgs);
            gateOutcome = decision === "reject" ? "reject" : "proceed";
          } catch (err) {
            // Treat a thrown gate as a rejection so a buggy UI can never
            // silently auto-approve. The tool message records why.
            gateOutcome = `Error: confirm gate threw: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (gateOutcome === "proceed") {
          try {
            const result = await t.execute(parsedArgs, toolCtx);
            content = result.content;
          } catch (err) {
            content = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else if (gateOutcome === "reject") {
          content = "Error: rejected by user";
        } else {
          content = gateOutcome;
        }
      }

      // Persist the tool turn.
      const toolMsg = toolMessage(tc.id, content);
      await safeEmit(toolMsg);

      chat.push({ role: "tool", tool_call_id: tc.id, content });
      cb.onToolResult?.(tc.id, content);
    }
  }

  return { text: fullText, toolCalls: totalToolCalls, usage: cumulative, stop: "max_turns" };
}
