// Ported from caretaker server's src/runner/openai_style.ts.
// Only the OpenAI-compatible streaming primitives — no DB, no MCP, no plugins.

import { ThinkTagSplitter } from "./think_tag_splitter.js";

export type AssistantUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

export interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = { type: "image_url"; image_url: { url: string } };
export type UserContentPart = TextContentPart | ImageContentPart;

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAiFunctionTool[];
}

export function buildRequestBody(params: {
  messages: ChatMessage[];
  tools: OpenAiFunctionTool[];
  model: string;
}): ChatCompletionsRequest {
  const body: ChatCompletionsRequest = {
    model: params.model,
    messages: params.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.tools.length > 0) body.tools = params.tools;
  return body;
}

export type SseEvent =
  | { kind: "content"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { kind: "finish"; reason: string }
  | { kind: "usage"; usage: AssistantUsage }
  | { kind: "done" };

/** Parse a single SSE line from an OpenAI-compatible chat completions stream. */
export function parseSseChunk(rawLine: string): SseEvent[] {
  const line = rawLine.trimEnd();
  if (!line) return [];
  if (!line.startsWith("data:")) return [];
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return [{ kind: "done" }];
  if (!payload) return [];

  let obj: any;
  try {
    obj = JSON.parse(payload);
  } catch {
    return [];
  }

  const events: SseEvent[] = [];

  if (obj && typeof obj === "object" && obj.usage && typeof obj.usage === "object") {
    const u = obj.usage;
    const cacheRead =
      typeof u.cache_read_input_tokens === "number"
        ? u.cache_read_input_tokens
        : typeof u.prompt_tokens_details?.cached_tokens === "number"
          ? u.prompt_tokens_details.cached_tokens
          : undefined;
    const cacheWrite =
      typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined;
    const reasoning =
      typeof u.completion_tokens_details?.reasoning_tokens === "number"
        ? u.completion_tokens_details.reasoning_tokens
        : undefined;
    const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
    const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
    const input = Math.max(0, promptTokens - (cacheRead ?? 0) - (cacheWrite ?? 0));
    const usage: AssistantUsage = { input, output: completion };
    if (cacheRead !== undefined) usage.cacheRead = cacheRead;
    if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
    if (reasoning !== undefined) usage.reasoning = reasoning;
    events.push({ kind: "usage", usage });
  }

  const choice = obj?.choices?.[0];
  if (!choice) return events;

  const delta = choice.delta ?? {};

  if (typeof delta.content === "string" && delta.content.length > 0) {
    events.push({ kind: "content", text: delta.content });
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    events.push({ kind: "thinking", text: delta.reasoning_content });
  } else if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
    events.push({ kind: "thinking", text: delta.reasoning });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      events.push({
        kind: "tool_call_delta",
        index: typeof tc.index === "number" ? tc.index : 0,
        id: typeof tc.id === "string" ? tc.id : undefined,
        name: typeof tc?.function?.name === "string" ? tc.function.name : undefined,
        argumentsDelta:
          typeof tc?.function?.arguments === "string" ? tc.function.arguments : undefined,
      });
    }
  }
  if (typeof choice.finish_reason === "string") {
    events.push({ kind: "finish", reason: choice.finish_reason });
  }
  return events;
}

export async function readStream(
  response: Response,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Intercept `content` events to split inline `<think>...</think>` tags into thinking events.
  const splitter = new ThinkTagSplitter();
  const dispatch = (evt: SseEvent) => {
    if (evt.kind === "content") {
      for (const s of splitter.push(evt.text)) onEvent(s);
    } else {
      onEvent(evt);
    }
  };
  let streamErrored = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        for (const evt of parseSseChunk(line)) dispatch(evt);
      }
    }
    if (buf.length > 0) {
      for (const evt of parseSseChunk(buf)) dispatch(evt);
    }
  } catch (err) {
    streamErrored = true;
    throw err;
  } finally {
    if (!streamErrored) {
      for (const s of splitter.flush()) onEvent(s);
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
