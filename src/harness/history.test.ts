import { test } from "node:test";
import assert from "node:assert/strict";
import { mapMessagesToChat } from "./history.js";
import type { MessageRecord } from "../session/types.js";

const baseTs = "2026-05-09T00:00:00.000Z";

function user(content: string, id = "u1"): MessageRecord {
  return { v: 1, type: "message", id, role: "user", content, createdAt: baseTs };
}

function assistantWithParts(parts: MessageRecord["parts"], id = "a1"): MessageRecord {
  return {
    v: 1,
    type: "message",
    id,
    role: "assistant",
    content: parts!
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join(""),
    parts,
    createdAt: baseTs,
  };
}

function assistantLegacy(content: string, id = "a1"): MessageRecord {
  return { v: 1, type: "message", id, role: "assistant", content, createdAt: baseTs };
}

function tool(toolCallId: string, content: string, id = "t1"): MessageRecord {
  return { v: 1, type: "message", id, role: "tool", toolCallId, content, createdAt: baseTs };
}

test("user message passes through", () => {
  const out = mapMessagesToChat([user("hi")]);
  assert.deepEqual(out, [{ role: "user", content: "hi" }]);
});

test("assistant with text-only parts → role:assistant content=textConcat", () => {
  const out = mapMessagesToChat([
    assistantWithParts([
      { type: "thinking", text: "think" },
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]),
  ]);
  assert.deepEqual(out, [{ role: "assistant", content: "hello world" }]);
});

test("assistant with tool_use parts → tool_calls populated", () => {
  const out = mapMessagesToChat([
    assistantWithParts([
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "tc1", name: "ls", args: { path: "/" } },
    ]),
  ]);
  assert.equal(out.length, 1);
  const msg = out[0]! as { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  assert.equal(msg.role, "assistant");
  assert.equal(msg.content, "let me check");
  assert.equal(msg.tool_calls?.length, 1);
  assert.equal(msg.tool_calls![0]!.id, "tc1");
  assert.equal(msg.tool_calls![0]!.function.name, "ls");
  assert.equal(msg.tool_calls![0]!.function.arguments, '{"path":"/"}');
});

test("assistant with only tool_use parts → content=null", () => {
  const out = mapMessagesToChat([
    assistantWithParts([{ type: "tool_use", id: "tc1", name: "ls", args: {} }]),
  ]);
  const msg = out[0]! as { content: string | null };
  assert.equal(msg.content, null);
});

test("legacy assistant without parts → content passes through", () => {
  const out = mapMessagesToChat([assistantLegacy("plain string")]);
  assert.deepEqual(out, [{ role: "assistant", content: "plain string" }]);
});

test("tool message with matching id is emitted", () => {
  const out = mapMessagesToChat([
    assistantWithParts([{ type: "tool_use", id: "tc1", name: "ls", args: {} }]),
    tool("tc1", "result"),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { role: "tool", tool_call_id: "tc1", content: "result" });
});

test("orphan tool message (no matching prior tool_use) is dropped", () => {
  const out = mapMessagesToChat([
    user("hi"),
    tool("tc-orphan", "ignored"),
  ]);
  assert.equal(out.length, 1, "orphan dropped");
  assert.equal((out[0]! as { role: string }).role, "user");
});

test("end-to-end: user → assistant(tool_use) → tool → assistant(text)", () => {
  const session: MessageRecord[] = [
    user("what's in /?", "u1"),
    assistantWithParts(
      [
        { type: "thinking", text: "I should ls" },
        { type: "tool_use", id: "tc1", name: "ls", args: { path: "/" } },
      ],
      "a1",
    ),
    tool("tc1", "bin etc home", "t1"),
    assistantWithParts([{ type: "text", text: "It contains bin, etc, home." }], "a2"),
  ];

  const out = mapMessagesToChat(session);
  assert.equal(out.length, 4);
  assert.equal((out[0]! as { role: string }).role, "user");
  assert.equal((out[1]! as { role: string }).role, "assistant");
  assert.equal((out[2]! as { role: string }).role, "tool");
  assert.equal((out[3]! as { role: string }).role, "assistant");
  // Final assistant turn has no tool_calls field.
  assert.equal((out[3]! as { tool_calls?: unknown[] }).tool_calls, undefined);
});
