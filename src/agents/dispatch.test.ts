import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { __setFetch, __resetFetch } from "../harness/loop.js";
import { effectiveAgent, dispatchAgent } from "./dispatch.js";
import type { AgentConfig, CaretakerConfig } from "../types.js";
import type { ToolContext } from "../harness/tools/types.js";

let testHome: string;

function agent(over: Partial<AgentConfig>): AgentConfig {
  return {
    id: randomUUID(),
    name: "a",
    systemPrompt: "",
    provider: "",
    model: "",
    allowedTools: [],
    maxTurns: 5,
    ...over,
  };
}

function ctx(callerAgent: AgentConfig | undefined, depth = 0): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: process.cwd(),
    readPaths: new Set(),
    callerAgent,
    dispatchDepth: depth,
  };
}

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

const SINGLE_TURN = (text: string) => [
  `data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`,
  'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
  "data: [DONE]\n\n",
];

describe("effectiveAgent (inheritance)", () => {
  it("returns invoked unchanged when caller is undefined", () => {
    const inv = agent({ provider: "p", model: "m", allowedTools: ["t"] });
    assert.deepEqual(effectiveAgent(inv, undefined), inv);
  });

  it("inherits empty primitive fields from the caller", () => {
    const caller = agent({
      provider: "anthropic",
      model: "opus",
      allowedTools: ["read_file"],
      workingDir: "/tmp",
    });
    const invoked = agent({
      // empty everywhere — must inherit all of the above
      provider: "",
      model: "",
      allowedTools: [],
      workingDir: "",
    });
    const eff = effectiveAgent(invoked, caller);
    assert.equal(eff.provider, "anthropic");
    assert.equal(eff.model, "opus");
    assert.deepEqual(eff.allowedTools, ["read_file"]);
    assert.equal(eff.workingDir, "/tmp");
  });

  it("does NOT inherit a field the invoked agent set explicitly (sandbox)", () => {
    const caller = agent({ provider: "p1", model: "m1", allowedTools: ["a", "b", "c"] });
    const invoked = agent({ provider: "p2", model: "m2", allowedTools: ["only-x"] });
    const eff = effectiveAgent(invoked, caller);
    assert.equal(eff.provider, "p2");
    assert.equal(eff.model, "m2");
    assert.deepEqual(eff.allowedTools, ["only-x"]);
  });

  it("inherits optional array fields when invoked has them empty/undefined", () => {
    const caller = agent({
      plugins: ["sp"],
      mcpServers: ["m1"],
      confirmTools: ["bash"],
    });
    const invoked = agent({});
    const eff = effectiveAgent(invoked, caller);
    assert.deepEqual(eff.plugins, ["sp"]);
    assert.deepEqual(eff.mcpServers, ["m1"]);
    assert.deepEqual(eff.confirmTools, ["bash"]);
  });

  it("never inherits systemPrompt — that's the point of dispatch", () => {
    const caller = agent({ systemPrompt: "I am the parent." });
    const invoked = agent({ systemPrompt: "I am the child." });
    assert.equal(effectiveAgent(invoked, caller).systemPrompt, "I am the child.");
    // Even when the child's is empty, we don't replace it — it's its identity.
    const blankChild = agent({ systemPrompt: "" });
    assert.equal(effectiveAgent(blankChild, caller).systemPrompt, "");
  });
});

describe("dispatchAgent", () => {
  let store: typeof import("../store/json.js");

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), "caretaker-dispatch-"));
    process.env.CARETAKER_HOME = testHome;
    store = await import("../store/json.js");
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
    __resetFetch();
  });

  beforeEach(async () => {
    await rm(store.configPath(), { force: true });
    await rm(store.agentsPath(), { force: true });
  });

  async function seedConfig(): Promise<void> {
    const cfg: CaretakerConfig = {
      port: 17777,
      providers: [{ name: "anthropic", endpoint: "http://x" }],
    };
    await store.saveConfig(cfg);
  }

  it("rejects self-invocation", async () => {
    await seedConfig();
    const a = agent({ id: "same", provider: "anthropic", model: "m" });
    const out = await dispatchAgent({ invoked: a, task: "go", ctx: ctx(a) });
    assert.match(out.guardError ?? "", /cannot invoke itself/);
  });

  it("rejects when dispatch depth exceeds the cap", async () => {
    await seedConfig();
    const caller = agent({ provider: "anthropic", model: "m" });
    const target = agent({ provider: "anthropic", model: "m" });
    const out = await dispatchAgent({
      invoked: target,
      task: "go",
      ctx: ctx(caller, 5), // already at the cap; +1 → exceeds
    });
    assert.match(out.guardError ?? "", /dispatch depth exceeded/);
  });

  it("returns a guard error when no provider can be resolved", async () => {
    await seedConfig();
    const caller = agent({ provider: "" });
    const target = agent({ provider: "" }); // empty + caller empty → no provider
    const out = await dispatchAgent({ invoked: target, task: "go", ctx: ctx(caller) });
    assert.match(out.guardError ?? "", /no provider/);
  });

  it("runs the invoked agent one-shot and returns its assistant text", async () => {
    await seedConfig();
    __setFetch(async () => sseResponse(SINGLE_TURN("done from child")));
    const caller = agent({ provider: "anthropic", model: "opus" });
    const target = agent({ provider: "", model: "" }); // inherits both
    const out = await dispatchAgent({ invoked: target, task: "report status", ctx: ctx(caller) });
    assert.equal(out.guardError, undefined);
    assert.equal(out.stop, "done");
    assert.equal(out.text, "done from child");
  });

  it("inherits provider+model from caller in the actual run", async () => {
    await seedConfig();
    let body: { model?: string } | undefined;
    __setFetch(async (_url, init) => {
      body = JSON.parse(init.body as string) as { model?: string };
      return sseResponse(SINGLE_TURN("ok"));
    });
    const caller = agent({ provider: "anthropic", model: "claude-opus-4-7" });
    const target = agent({ provider: "", model: "" });
    await dispatchAgent({ invoked: target, task: "x", ctx: ctx(caller) });
    assert.equal(body?.model, "claude-opus-4-7", "child must hit the API with caller's model");
  });

  it("propagates abort signal to the child run", async () => {
    await seedConfig();
    __setFetch(async (_url, init) => {
      // The fetch-level abort surfaces as a rejected promise; the loop
      // catches it. The signal is on init.signal — verify it's the same
      // controller we passed via ctx.
      if (init.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return sseResponse(SINGLE_TURN("late"));
    });
    const ac = new AbortController();
    ac.abort();
    const caller = agent({ provider: "anthropic", model: "m" });
    const target = agent({});
    const result = await dispatchAgent({
      invoked: target,
      task: "go",
      ctx: { ...ctx(caller), signal: ac.signal },
    }).catch((err) => ({ thrown: err as Error }));
    // Either the loop returns stop="aborted" (preferred) or the fetch
    // throws and dispatch surfaces it. Both are acceptable; we just want
    // execution to NOT have produced a normal "done".
    if ("thrown" in result) {
      assert.match(result.thrown.message, /abort/i);
    } else {
      assert.notEqual(result.stop, "done");
    }
  });
});
