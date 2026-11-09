import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CARETAKER_HOME = mkdtempSync(join(tmpdir(), 'ct-triage-agent-'));

import { ToolRegistry } from '../../../harness/tools/registry.js';
import { registerBuiltins } from '../../../harness/tools/builtin/index.js';
import type { AgentConfig } from '../../../types.js';
import { triageTools } from './email_triage_agent.js';

const registry = new ToolRegistry();
registerBuiltins(registry);

const agentWith = (allowedTools: string[]) => ({ id: 'a1', name: 'A', allowedTools }) as unknown as AgentConfig;

test('triageTools adds email_read to an agent that did not pick it', async () => {
  const tools = await triageTools(agentWith([]), registry);
  assert.equal(tools.filter((t) => t.name === 'mcp__email__email_read').length, 1);
});

test("triageTools keeps the agent's configured tools, email_send included", async () => {
  const tools = await triageTools(agentWith(['mcp__email__*', 'bash']), registry);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('mcp__email__email_send'));
  assert.ok(names.includes('bash'));
  assert.equal(names.filter((n) => n === 'mcp__email__email_read').length, 1);
});
