import { test } from "node:test";
import assert from "node:assert/strict";
import { run, __setFetch, __resetFetch } from "./loop.js";
import type { AgentConfig, ProviderConfig } from "../types.js";

const agent: AgentConfig = {
  id: "a1",
  name: "test",
  systemPrompt: "",
  provider: "p",
  model: "m",
  allowedTools: [],
  maxTurns: 5,
};
const provider: ProviderConfig = { name: "p", endpoint: "http://x" };

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const SINGLE_TURN_TEXT = [
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
  'data: [DONE]\n\n',
];

test("loop: happy path emits one assistant message and stop=done", async () => {
  __setFetch(async () => sseResponse(SINGLE_TURN_TEXT));
  try {
    const seen: string[] = [];
    const result = await run(
      { agent, provider, tools: [], prompt: "say hi" },
      { onMessage: async (m) => { seen.push(m.role); } },
    );
    assert.equal(result.stop, "done");
    assert.equal(result.text, "hi");
    assert.deepEqual(seen, ["assistant"]);
  } finally {
    __resetFetch();
  }
});

test("loop: maxTurns=0 means unlimited (does not fall back to 30)", async () => {
  let calls = 0;
  __setFetch(async () => {
    calls++;
    return sseResponse(SINGLE_TURN_TEXT);
  });
  try {
    const result = await run(
      { agent: { ...agent, maxTurns: 0 }, provider, tools: [], prompt: "say hi" },
      {},
    );
    assert.equal(result.stop, "done");
    assert.equal(calls, 1, "single-turn response → one fetch");
  } finally {
    __resetFetch();
  }
});

const TOOL_CALL_TURN = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"do_thing","arguments":"{}"}}]}}]}\n\n',
  'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
  'data: [DONE]\n\n',
];
const FINAL_TURN = [
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
  'data: [DONE]\n\n',
];

function makeFakeTool(opts: { onExec?: () => void } = {}): import("./tools/index.js").Tool {
  return {
    name: "do_thing",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      opts.onExec?.();
      return { content: "executed" };
    },
  };
}

test("loop: confirmTool=reject skips execute and emits 'rejected by user'", async () => {
  let call = 0;
  __setFetch(async () => sseResponse(call++ === 0 ? TOOL_CALL_TURN : FINAL_TURN));
  let executed = false;
  const toolMessages: string[] = [];
  try {
    await run(
      { agent, provider, tools: [makeFakeTool({ onExec: () => { executed = true; } })], prompt: "go" },
      {
        confirmTool: async () => "reject",
        onMessage: async (m) => {
          if (m.role === "tool") toolMessages.push(m.content);
        },
      },
    );
    assert.equal(executed, false, "execute must NOT run after reject");
    assert.deepEqual(toolMessages, ["Error: rejected by user"]);
  } finally {
    __resetFetch();
  }
});

test("loop: confirmTool=once proceeds with execute", async () => {
  let call = 0;
  __setFetch(async () => sseResponse(call++ === 0 ? TOOL_CALL_TURN : FINAL_TURN));
  let executed = false;
  try {
    await run(
      { agent, provider, tools: [makeFakeTool({ onExec: () => { executed = true; } })], prompt: "go" },
      { confirmTool: async () => "once" },
    );
    assert.equal(executed, true, "execute must run after once");
  } finally {
    __resetFetch();
  }
});

test("loop: confirmTool that throws is treated as a reject (fail-safe)", async () => {
  let call = 0;
  __setFetch(async () => sseResponse(call++ === 0 ? TOOL_CALL_TURN : FINAL_TURN));
  let executed = false;
  const toolMessages: string[] = [];
  try {
    await run(
      { agent, provider, tools: [makeFakeTool({ onExec: () => { executed = true; } })], prompt: "go" },
      {
        confirmTool: async () => { throw new Error("ui blew up"); },
        onMessage: async (m) => {
          if (m.role === "tool") toolMessages.push(m.content);
        },
      },
    );
    assert.equal(executed, false, "execute must NOT run when gate throws");
    assert.equal(toolMessages.length, 1);
    assert.match(toolMessages[0]!, /confirm gate threw: ui blew up/);
  } finally {
    __resetFetch();
  }
});

test("loop: no confirmTool callback → tools execute as before", async () => {
  let call = 0;
  __setFetch(async () => sseResponse(call++ === 0 ? TOOL_CALL_TURN : FINAL_TURN));
  let executed = false;
  try {
    await run(
      { agent, provider, tools: [makeFakeTool({ onExec: () => { executed = true; } })], prompt: "go" },
      {},
    );
    assert.equal(executed, true);
  } finally {
    __resetFetch();
  }
});

test("loop: agent.plugins is plumbed to ToolContext.activePlugins (not injected into system prompt)", async () => {
  // The previous behavior — injecting SKILL.md content into the system
  // prompt — has been replaced by the on-demand list_skills/read_skill
  // tools. The loop now exposes agent.plugins via ToolContext.activePlugins
  // and leaves the system prompt clean of skill markup.
  type CapturedBody = { messages?: Array<{ role: string; content: string | null }> };
  let capturedBody: CapturedBody | null = null;
  __setFetch(async (_url, init) => {
    capturedBody = JSON.parse(init.body as string) as CapturedBody;
    return sseResponse(TOOL_CALL_TURN);
  });

  let seenActive: string[] | undefined;
  const probeTool: import("./tools/index.js").Tool = {
    name: "do_thing",
    description: "probe",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      seenActive = ctx.activePlugins;
      return { content: "ok" };
    },
  };

  try {
    // Two-turn flow: tool call, then a final assistant message that ends.
    let call = 0;
    __setFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string) as CapturedBody;
      call++;
      return sseResponse(call === 1 ? TOOL_CALL_TURN : FINAL_TURN);
    });
    await run(
      { agent: { ...agent, plugins: ["my-plugin", "other"] }, provider, tools: [probeTool], prompt: "hi" },
      {},
    );
    assert.deepEqual(seenActive, ["my-plugin", "other"]);
    const body = capturedBody as CapturedBody | null;
    const sys = body?.messages?.find((m) => m.role === "system")?.content ?? "";
    assert.ok(!sys.includes("<skill"), "system prompt must not include skill markup anymore");
  } finally {
    __resetFetch();
  }
});

test("loop: agent.plugins=[] does not change the system prompt", async () => {
  type CapturedBody = { messages?: Array<{ role: string; content: string | null }> };
  let captured: CapturedBody | null = null;
  __setFetch(async (_url, init) => {
    captured = JSON.parse(init.body as string) as CapturedBody;
    return sseResponse(SINGLE_TURN_TEXT);
  });
  try {
    await run({ agent, provider, tools: [], prompt: "hi" }, {});
    const sys = (captured as CapturedBody | null)?.messages?.find((m) => m.role === "system")?.content ?? "";
    assert.ok(!sys.includes("<skill"), "no skill tags expected when plugins is empty");
  } finally {
    __resetFetch();
  }
});

test("loop: onMessage rejection is contained — turn completes, run resolves", async () => {
  __setFetch(async () => sseResponse(SINGLE_TURN_TEXT));
  const origConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await run(
      { agent, provider, tools: [], prompt: "say hi" },
      {
        onMessage: async () => {
          throw new Error("boom");
        },
      },
    );
    assert.equal(result.stop, "done", "loop must NOT propagate persistence errors");
    assert.equal(result.text, "hi");
  } finally {
    console.error = origConsoleError;
    __resetFetch();
  }
});
