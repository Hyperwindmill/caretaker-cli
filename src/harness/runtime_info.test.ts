import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRuntimeInfoBlock } from "./runtime_info.js";

test("runtime_info: emits a <runtime-info>…</runtime-info> tag with all fields", () => {
  const out = formatRuntimeInfoBlock({
    agentName: "code-reviewer",
    model: "claude-opus-4-7",
    provider: "anthropic",
    workingDir: "/home/me/project",
  });
  assert.match(out, /^<runtime-info>\n/);
  assert.match(out, /\n<\/runtime-info>$/);
  assert.match(out, /agent_name: code-reviewer/);
  assert.match(out, /model: claude-opus-4-7/);
  assert.match(out, /provider: anthropic/);
  assert.match(out, /working_dir: \/home\/me\/project/);
});

test("runtime_info: empty primitives surface as readable placeholders", () => {
  const out = formatRuntimeInfoBlock({
    agentName: "",
    model: "",
    provider: "",
    workingDir: "/",
  });
  assert.match(out, /agent_name: \(unnamed\)/);
  assert.match(out, /model: \(unset\)/);
  assert.match(out, /provider: \(unset\)/);
});
