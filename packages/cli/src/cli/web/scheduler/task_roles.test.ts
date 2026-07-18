import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope CARETAKER_HOME isolation (mutate at file scope, never inside describe).
process.env.CARETAKER_HOME = await mkdtemp(join(tmpdir(), 'ct-taskroles-home-'));

const { createTask, addTaskMessage } = await import('../../../store/db.js');
const {
  resolveRoleAgent,
  resolvePlanningEnabled,
  resolveReviewEnabled,
  resolveSddEnabled,
  resolveMaxRunSeconds,
  activationStatus,
  filterPlannerTools,
} = await import('./task_roles.js');
import type { AgentConfig, ProjectConfig } from '../../../types.js';
import type { Task } from '../../../store/db.js';
import type { Tool } from '../../../harness/tools/types.js';

function agent(id: string): AgentConfig {
  return {
    id,
    name: id,
    systemPrompt: 'x',
    provider: 'p',
    model: 'm',
    allowedTools: [],
    maxTurns: 10,
  } as AgentConfig;
}

const AGENTS = [agent('a-default'), agent('a-dev'), agent('a-plan'), agent('a-rev'), agent('a-proj')];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    title: 't',
    objective: 'o',
    checklist: [],
    status: 'draft',
    blockedReason: null,
    noProgressCount: 0,
    maxNoProgress: 5,
    lockedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { id: 1, name: 'p', description: '', workingDir: '/w', agentId: 'a-proj', active: true, ...overrides };
}

test('resolveMaxRunSeconds: task -> project -> provider default', () => {
  // Task overrides everything.
  assert.equal(resolveMaxRunSeconds(makeTask({ maxRunSeconds: 300 }), makeProject({ maxRunSeconds: 200 }), false), 300);
  // Falls back to project.
  assert.equal(resolveMaxRunSeconds(makeTask(), makeProject({ maxRunSeconds: 200 }), false), 200);
  // Neither set -> native default 120, claude-code default 900.
  assert.equal(resolveMaxRunSeconds(makeTask(), makeProject(), false), 120);
  assert.equal(resolveMaxRunSeconds(makeTask(), makeProject(), true), 900);
  // Non-positive/invalid configured values are ignored (fall through to default).
  assert.equal(resolveMaxRunSeconds(makeTask({ maxRunSeconds: 0 }), makeProject(), false), 120);
  assert.equal(resolveMaxRunSeconds(makeTask({ maxRunSeconds: null }), null, true), 900);
});

test('developer chain: task.agentId -> project.agentId -> agents[0]', () => {
  assert.equal(resolveRoleAgent('developer', makeTask({ agentId: 'a-dev' }), makeProject(), AGENTS)!.id, 'a-dev');
  assert.equal(resolveRoleAgent('developer', makeTask(), makeProject(), AGENTS)!.id, 'a-proj');
  assert.equal(resolveRoleAgent('developer', makeTask(), undefined, AGENTS)!.id, 'a-default');
});

test('planner chain: task.plannerAgentId -> project.plannerAgentId -> developer chain', () => {
  assert.equal(
    resolveRoleAgent('planner', makeTask({ plannerAgentId: 'a-plan', agentId: 'a-dev' }), makeProject(), AGENTS)!.id,
    'a-plan',
  );
  assert.equal(
    resolveRoleAgent('planner', makeTask({ agentId: 'a-dev' }), makeProject({ plannerAgentId: 'a-plan' }), AGENTS)!.id,
    'a-plan',
  );
  // No planner anywhere -> developer.
  assert.equal(resolveRoleAgent('planner', makeTask({ agentId: 'a-dev' }), makeProject(), AGENTS)!.id, 'a-dev');
});

test('reviewer chain falls through a deleted agent id to the developer chain', () => {
  assert.equal(
    resolveRoleAgent('reviewer', makeTask({ reviewerAgentId: 'gone', agentId: 'a-dev' }), makeProject(), AGENTS)!.id,
    'a-dev',
  );
  assert.equal(
    resolveRoleAgent('reviewer', makeTask({ reviewerAgentId: 'a-rev' }), makeProject(), AGENTS)!.id,
    'a-rev',
  );
});

test('flags: task overrides project; both unset -> true; missing project -> true', () => {
  assert.equal(resolvePlanningEnabled(makeTask(), makeProject()), true);
  assert.equal(resolvePlanningEnabled(makeTask(), undefined), true);
  assert.equal(resolvePlanningEnabled(makeTask({ planningEnabled: false }), makeProject()), false);
  assert.equal(resolvePlanningEnabled(makeTask(), makeProject({ planningEnabled: false })), false);
  assert.equal(resolvePlanningEnabled(makeTask({ planningEnabled: true }), makeProject({ planningEnabled: false })), true);
  assert.equal(resolveReviewEnabled(makeTask({ reviewEnabled: false }), makeProject()), false);
  assert.equal(resolveReviewEnabled(makeTask(), makeProject({ reviewEnabled: false })), false);
  assert.equal(resolveReviewEnabled(makeTask(), makeProject()), true);
});

test('activationStatus: planning when enabled and no plan message; active once a plan exists or when disabled', async () => {
  const t1 = await createTask({
    projectId: 1, title: 'no plan yet', objective: 'o', checklist: [], status: 'draft',
    blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null,
  });
  assert.equal(await activationStatus(t1, makeProject()), 'planning');

  await addTaskMessage({ taskId: t1.id, role: 'assistant', messageType: 'plan', content: 'the plan' });
  assert.equal(await activationStatus(t1, makeProject()), 'active');

  const t2 = await createTask({
    projectId: 1, title: 'planning off', objective: 'o', checklist: [], status: 'draft',
    blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null, planningEnabled: false,
  });
  assert.equal(await activationStatus(t2, makeProject()), 'active');
});

test('filterPlannerTools strips write/edit/multiedit/bash and keeps the rest', () => {
  const mk = (name: string): Tool => ({ name, description: '', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: '' }) });
  const tools = ['read_file', 'glob', 'grep', 'write', 'edit', 'multiedit', 'bash', 'mcp__task__task_get_state'].map(mk);
  const filtered = filterPlannerTools(tools).map((t) => t.name);
  assert.deepEqual(filtered, ['read_file', 'glob', 'grep', 'mcp__task__task_get_state']);
});

test('resolveSddEnabled: task overrides project; default is OFF', () => {
  assert.equal(resolveSddEnabled(makeTask(), makeProject()), false);
  assert.equal(resolveSddEnabled(makeTask(), undefined), false);
  assert.equal(resolveSddEnabled(makeTask({ sddEnabled: true }), makeProject()), true);
  assert.equal(resolveSddEnabled(makeTask(), makeProject({ sddEnabled: true })), true);
  assert.equal(resolveSddEnabled(makeTask({ sddEnabled: false }), makeProject({ sddEnabled: true })), false);
});

test('filterPlannerTools with sdd: bash stripped, write/edit/multiedit wrapped md-only', async () => {
  const calls: string[] = [];
  const mk = (name: string): Tool => ({
    name,
    description: 'd',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      calls.push(name);
      return { content: 'ok' };
    },
  });
  const tools = filterPlannerTools(['write', 'edit', 'multiedit', 'bash', 'read_file'].map(mk), true);
  assert.deepEqual(tools.map((t) => t.name), ['write', 'edit', 'multiedit', 'read_file']);

  const ctx = { signal: new AbortController().signal, workingDir: '/w', readPaths: new Set<string>() } as any;
  const write = tools.find((t) => t.name === 'write')!;

  // Non-md path: denied without invoking the wrapped tool.
  const denied = await write.execute({ path: 'src/a.ts', content: 'x' }, ctx);
  assert.equal(denied.content, 'Error: planning phase (SDD mode): only markdown (.md) files may be written.');
  assert.deepEqual(calls, []);

  // Nested md path delegates; extension check is case-insensitive.
  const ok1 = await write.execute({ path: 'docs/specs/plan.md', content: 'x' }, ctx);
  assert.equal(ok1.content, 'ok');
  const edit = tools.find((t) => t.name === 'edit')!;
  const ok2 = await edit.execute({ path: 'SPEC.MD', oldString: 'a', newString: 'b' }, ctx);
  assert.equal(ok2.content, 'ok');
  assert.deepEqual(calls, ['write', 'edit']);

  // Missing/invalid path arg is denied too.
  const noPath = await write.execute({ content: 'x' }, ctx);
  assert.ok(noPath.content.startsWith('Error:'));
});

test('filterPlannerTools without sdd still strips all four (regression)', () => {
  const mk = (name: string): Tool => ({ name, description: '', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: '' }) });
  const filtered = filterPlannerTools(['write', 'edit', 'multiedit', 'bash', 'grep'].map(mk));
  assert.deepEqual(filtered.map((t) => t.name), ['grep']);
});
