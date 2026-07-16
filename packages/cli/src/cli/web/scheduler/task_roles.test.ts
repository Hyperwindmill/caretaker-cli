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
