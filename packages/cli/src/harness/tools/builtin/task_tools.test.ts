import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '../types.js';

// File-scope CARETAKER_HOME isolation (mutate at file scope, never inside describe).
const CT_HOME = await mkdtemp(join(tmpdir(), 'ct-tasktools-home-'));
process.env.CARETAKER_HOME = CT_HOME;

const { createTask, getTaskById, saveTask, deleteTask, addTaskMessage, runQuery } = await import('../../../store/db.js');
const { completeTaskTool, taskArchiveTool, taskUnarchiveTool, taskDeleteTool, taskSearchTool, taskSetAgentTool, taskCreateTool, submitPlanTool, taskActivateTool, taskUnpauseTool, getTaskStateTool, updateChecklistItemTool, updateChecklistTool } = await import('./task_tools.js');
const { runningTasks } = await import('../../../cli/web/scheduler/locks.js');
const { saveConfig, saveAgents } = await import('../../../store/json.js');

function ctx(): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: '/work',
    readPaths: new Set(),
  };
}

const base = {
  projectId: 1,
  title: 'T',
  objective: 'o',
  checklist: [],
  status: 'active' as const,
  blockedReason: null,
  noProgressCount: 0,
  maxNoProgress: 5,
  lockedAt: null,
};

test('task_complete on a git task (worktree set) -> reviewing', async () => {
  const t = await createTask({ ...base, title: 'Git Task' });
  const gt = await getTaskById(t.id);
  gt!.worktreePath = join(CT_HOME, 'worktrees', 'x');
  gt!.branch = 'caretaker/task-x';
  await saveTask(gt!);

  await completeTaskTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'reviewing');
});

test('task_complete on a non-git task (no worktree) -> done', async () => {
  const t = await createTask({ ...base, title: 'Non-Git Task' });
  await completeTaskTool.execute({ task_id: t.id }, ctx());
  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'done');
});

test('task_archive sets archived=true and pauses active tasks', async () => {
  const t = await createTask({ ...base, title: 'Archive Me' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.archived, true);
  assert.equal(after!.status, 'paused');
});

test('task_archive pauses reviewing tasks', async () => {
  const t = await createTask({ ...base, title: 'Review Archive', status: 'reviewing' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.archived, true);
  assert.equal(after!.status, 'paused');
});

test('task_archive does not change already-paused tasks', async () => {
  const t = await createTask({ ...base, title: 'Paused Archive', status: 'paused' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.archived, true);
  assert.equal(after!.status, 'paused');
});

test('task_unarchive clears archived but does not change status', async () => {
  const t = await createTask({ ...base, title: 'Unarchive Me', status: 'paused' });
  await taskArchiveTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.archived, true);

  await taskUnarchiveTool.execute({ task_id: t.id }, ctx());
  const after = await getTaskById(t.id);
  assert.equal(after!.archived, false);
  assert.equal(after!.status, 'paused');
});

test('task_delete removes the task and its messages from the store', async () => {
  const t = await createTask({ ...base, title: 'Delete Me' });
  await addTaskMessage({ taskId: t.id, role: 'assistant', messageType: 'chat', content: 'hello' });
  await addTaskMessage({ taskId: t.id, role: 'assistant', messageType: 'chat', content: 'world' });

  await taskDeleteTool.execute({ task_id: t.id }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after, null);

  const msgs = await runQuery(`SELECT * FROM task_messages WHERE taskId = ${t.id}`);
  assert.equal(msgs.length, 0);
});

test('task_delete refuses to delete a locked/running task', async () => {
  const t = await createTask({ ...base, title: 'Running Task' });
  const task = await getTaskById(t.id);
  task!.lockedAt = new Date().toISOString();
  await saveTask(task!);

  const result = await taskDeleteTool.execute({ task_id: t.id }, ctx());
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.error);
  assert.ok(parsed.error.includes('running'));

  // Task should still exist
  const after = await getTaskById(t.id);
  assert.ok(after);

  // Clean up lock
  task!.lockedAt = null;
  await saveTask(task!);
});

test('task_delete refuses when runningTasks set even if lockedAt is null', async () => {
  const t = await createTask({ ...base, title: 'In-Mem Locked' });
  const lockKey = `task_db_${t.id}`;
  runningTasks.add(lockKey);

  try {
    const result = await taskDeleteTool.execute({ task_id: t.id }, ctx());
    const parsed = JSON.parse(result.content);
    assert.ok(parsed.error);
    assert.ok(parsed.error.includes('running'));

    const after = await getTaskById(t.id);
    assert.ok(after);
  } finally {
    runningTasks.delete(lockKey);
  }
});

test('task_search excludes archived tasks by default', async () => {
  const t1 = await createTask({ ...base, title: 'Searchable Active', objective: 'find me' });
  const t2 = await createTask({ ...base, title: 'Searchable Archived', objective: 'find me too' });
  await taskArchiveTool.execute({ task_id: t2.id }, ctx());

  // Default search excludes archived
  const result = await taskSearchTool.execute({ query: 'find me' }, ctx());
  const matches = JSON.parse(result.content);
  const ids = matches.map((m: any) => m.id);
  assert.ok(ids.includes(t1.id));
  assert.ok(!ids.includes(t2.id));

  // include_archived=true returns both
  const result2 = await taskSearchTool.execute({ query: 'find me', include_archived: true }, ctx());
  const matches2 = JSON.parse(result2.content);
  const ids2 = matches2.map((m: any) => m.id);
  assert.ok(ids2.includes(t1.id));
  assert.ok(ids2.includes(t2.id));
});

test('task_set_agent assigns an agent to a task', async () => {
  await saveAgents([{ id: 'agent-xyz', name: 'XYZ', systemPrompt: '', provider: 'p', model: 'm', allowedTools: [], maxTurns: 10 }]);
  const t = await createTask({ ...base, title: 'Set Agent Task' });
  assert.equal((await getTaskById(t.id))!.agentId ?? null, null);

  await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'agent-xyz' }, ctx());
  assert.equal((await getTaskById(t.id))!.agentId, 'agent-xyz');
});

test('task_set_agent clears the override with null', async () => {
  const t = await createTask({ ...base, title: 'Clear Agent Task', agentId: 'agent-abc' });
  assert.equal((await getTaskById(t.id))!.agentId, 'agent-abc');

  await taskSetAgentTool.execute({ task_id: t.id, agent_id: null }, ctx());
  assert.equal((await getTaskById(t.id))!.agentId, null);
});

test('task_set_agent refuses on a running task', async () => {
  const t = await createTask({ ...base, title: 'Running Agent Task' });
  const task = await getTaskById(t.id);
  task!.lockedAt = new Date().toISOString();
  await saveTask(task!);

  try {
    const result = await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'agent-x' }, ctx());
    const parsed = JSON.parse(result.content);
    assert.ok(parsed.error);
    assert.ok(parsed.error.includes('running'));

    // Agent should not have changed
    assert.equal((await getTaskById(t.id))!.agentId ?? null, null);
  } finally {
    task!.lockedAt = null;
    await saveTask(task!);
  }
});

test('task_create stores agentId when provided', async () => {
  // Set up a project in config and an agent in agents.json so task_create can validate.
  await saveConfig({
    port: 3000,
    providers: [],
    projects: [{ id: 1, name: 'Test', description: '', workingDir: '/work', agentId: '', active: true }],
  });
  await saveAgents([{ id: 'agent-special', name: 'Special', systemPrompt: '', provider: 'p', model: 'm', allowedTools: [], maxTurns: 10 }]);

  const result = await taskCreateTool.execute(
    { project_id: 1, title: 'Task With Agent', objective: 'test', checklist: [{ text: 'do it' }], agent_id: 'agent-special' },
    ctx(),
  );
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.ok);
  const task = await getTaskById(parsed.task_id);
  assert.equal(task!.agentId, 'agent-special');
});

test('task_create rejects a non-existent agent_id', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    projects: [{ id: 1, name: 'Test', description: '', workingDir: '/work', agentId: '', active: true }],
  });
  await saveAgents([{ id: 'agent-real', name: 'Real', systemPrompt: '', provider: 'p', model: 'm', allowedTools: [], maxTurns: 10 }]);

  const result = await taskCreateTool.execute(
    { project_id: 1, title: 'Bad Agent', objective: 'test', checklist: [{ text: 'do it' }], agent_id: 'agent-nonexistent' },
    ctx(),
  );
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.error);
  assert.ok(parsed.error.includes('not found'));
});

test('task_set_agent rejects a non-existent agent_id', async () => {
  const t = await createTask({ ...base, title: 'Set Bad Agent' });
  await saveAgents([{ id: 'agent-real', name: 'Real', systemPrompt: '', provider: 'p', model: 'm', allowedTools: [], maxTurns: 10 }]);

  const result = await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'agent-nonexistent' }, ctx());
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.error);
  assert.ok(parsed.error.includes('not found'));
  // Agent should not have changed
  assert.equal((await getTaskById(t.id))!.agentId ?? null, null);
});

test('task_submit_plan on a planning task -> plan message persisted, status active', async () => {
  const t = await createTask({ ...base, title: 'Plan Me', status: 'planning' });
  const res = await submitPlanTool.execute({ task_id: t.id, plan: '1. do X\n2. do Y' }, ctx());
  assert.equal(JSON.parse(res.content).ok, true);

  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'active');
  assert.equal(after!.noProgressCount, 0);

  const msgs = (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${t.id}`)) as any[];
  const plan = msgs.find((m) => m.messageType === 'plan');
  assert.ok(plan);
  assert.equal(plan.content, '1. do X\n2. do Y');
});

test('task_submit_plan outside planning -> error', async () => {
  const t = await createTask({ ...base, title: 'Not Planning' }); // status: active
  const res = await submitPlanTool.execute({ task_id: t.id, plan: 'p' }, ctx());
  assert.ok(JSON.parse(res.content).error.includes('not in planning'));
});

test('task_submit_plan with empty plan -> error', async () => {
  const t = await createTask({ ...base, title: 'Empty Plan', status: 'planning' });
  const res = await submitPlanTool.execute({ task_id: t.id, plan: '   ' }, ctx());
  assert.ok(JSON.parse(res.content).error);
});

test('task_complete in planning -> error pointing to task_submit_plan', async () => {
  const t = await createTask({ ...base, title: 'Planning Complete Guard', status: 'planning' });
  const res = await completeTaskTool.execute({ task_id: t.id }, ctx());
  const parsed = JSON.parse(res.content);
  assert.ok(parsed.error);
  assert.ok(parsed.error.includes('task_submit_plan'));
  assert.equal((await getTaskById(t.id))!.status, 'planning');
});

test('task_complete on a git task with reviewEnabled=false on the task -> done directly', async () => {
  const t = await createTask({ ...base, title: 'Review Off', reviewEnabled: false });
  const gt = await getTaskById(t.id);
  gt!.worktreePath = join(CT_HOME, 'worktrees', 'ro');
  gt!.branch = 'caretaker/task-ro';
  await saveTask(gt!);

  await completeTaskTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.status, 'done');
});

test('task_complete on a git task with reviewEnabled=false on the project -> done directly', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    projects: [{ id: 77, name: 'NoReview', description: '', workingDir: '/w', agentId: 'a', active: true, reviewEnabled: false }],
  } as any);
  const t = await createTask({ ...base, projectId: 77, title: 'Project Review Off' });
  const gt = await getTaskById(t.id);
  gt!.worktreePath = join(CT_HOME, 'worktrees', 'pro');
  gt!.branch = 'caretaker/task-pro';
  await saveTask(gt!);

  await completeTaskTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.status, 'done');
  // Restore a config without projects so earlier-file tests never see project 1.
  await saveConfig({ port: 3000, providers: [] } as any);
});

test('task_activate: draft -> planning by default; -> active when task disables planning', async () => {
  const t1 = await createTask({ ...base, title: 'Activate Plans', status: 'draft' });
  await taskActivateTool.execute({ task_id: t1.id }, ctx());
  assert.equal((await getTaskById(t1.id))!.status, 'planning');

  const t2 = await createTask({ ...base, title: 'Activate No Plan', status: 'draft', planningEnabled: false });
  await taskActivateTool.execute({ task_id: t2.id }, ctx());
  assert.equal((await getTaskById(t2.id))!.status, 'active');
});

test('task_unpause: returns to planning when no plan exists; to active once planned', async () => {
  const t = await createTask({ ...base, title: 'Unpause Phase', status: 'paused' });
  await taskUnpauseTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.status, 'planning');

  const t2 = await createTask({ ...base, title: 'Unpause Planned', status: 'paused' });
  await addTaskMessage({ taskId: t2.id, role: 'assistant', messageType: 'plan', content: 'plan' });
  await taskUnpauseTool.execute({ task_id: t2.id }, ctx());
  assert.equal((await getTaskById(t2.id))!.status, 'active');
});

test('task_create with start_active and default planning -> status planning; role fields persisted', async () => {
  await saveAgents([
    { id: 'a-dev', name: 'a-dev', systemPrompt: 'x', provider: 'p', model: 'm', allowedTools: [], maxTurns: 5 },
    { id: 'a-plan', name: 'a-plan', systemPrompt: 'x', provider: 'p', model: 'm', allowedTools: [], maxTurns: 5 },
  ] as any);
  await saveConfig({
    port: 3000, providers: [],
    projects: [{ id: 9, name: 'RoleProj', description: '', workingDir: '/w', agentId: 'a-dev', active: true }],
  } as any);

  const res = await taskCreateTool.execute(
    {
      project_id: 9, title: 'Roles', objective: 'o', checklist: [{ text: 's1' }],
      start_active: true, agent_id: 'a-dev', planner_agent_id: 'a-plan', review_enabled: false,
    },
    ctx(),
  );
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.ok, true);

  const created = await getTaskById(parsed.task_id);
  assert.equal(created!.status, 'planning');
  assert.equal(created!.plannerAgentId, 'a-plan');
  assert.equal(created!.reviewEnabled, false);
  await saveConfig({ port: 3000, providers: [] } as any);
});

test('task_set_agent with role planner/reviewer sets the role fields', async () => {
  await saveAgents([
    { id: 'a-x', name: 'a-x', systemPrompt: 'x', provider: 'p', model: 'm', allowedTools: [], maxTurns: 5 },
  ] as any);
  const t = await createTask({ ...base, title: 'Set Roles', status: 'paused' });

  await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'a-x', role: 'planner' }, ctx());
  assert.equal((await getTaskById(t.id))!.plannerAgentId, 'a-x');

  await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'a-x', role: 'reviewer' }, ctx());
  assert.equal((await getTaskById(t.id))!.reviewerAgentId, 'a-x');

  // Clear the planner override.
  await taskSetAgentTool.execute({ task_id: t.id, role: 'planner' }, ctx());
  assert.equal((await getTaskById(t.id))!.plannerAgentId, null);
  // Default role still targets the developer field.
  await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'a-x' }, ctx());
  assert.equal((await getTaskById(t.id))!.agentId, 'a-x');
});

test('task_create persists sdd_enabled; task_get_state exposes it', async () => {
  await saveConfig({
    port: 3000, providers: [],
    projects: [{ id: 11, name: 'SddProj', description: '', workingDir: '/w', agentId: 'a', active: true }],
  } as any);
  const res = await taskCreateTool.execute(
    { project_id: 11, title: 'Sdd', objective: 'o', checklist: [], sdd_enabled: true },
    ctx(),
  );
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.ok, true);
  assert.equal((await getTaskById(parsed.task_id))!.sddEnabled, true);

  const state = JSON.parse((await getTaskStateTool.execute({ task_id: parsed.task_id }, ctx())).content);
  assert.equal(state.sddEnabled, true);
  await saveConfig({ port: 3000, providers: [] } as any);
});

test('updateChecklistItemTool and updateChecklistTool return error on invalid status', async () => {
  const t = await createTask({
    ...base,
    title: 'Validation test task',
    checklist: [{ id: '1', text: 'Item 1', status: 'pending', order: 0 }],
  });

  // Invalid single item update status
  const res1 = await updateChecklistItemTool.execute({ task_id: t.id, item_id: '1', status: 'invalid-status' }, ctx());
  const parsed1 = JSON.parse(res1.content);
  assert.ok(parsed1.error);
  assert.ok(parsed1.error.includes('Invalid checklist item status'));

  // Valid single item update status (should pass)
  const res2 = await updateChecklistItemTool.execute({ task_id: t.id, item_id: '1', status: 'completed' }, ctx());
  const parsed2 = JSON.parse(res2.content);
  assert.ok(parsed2.ok);
  const after2 = await getTaskById(t.id);
  assert.equal(after2!.checklist[0]!.status, 'done');

  // Invalid multiple checklist update status
  const res3 = await updateChecklistTool.execute({
    task_id: t.id,
    checklist: [
      { id: '1', text: 'Item 1', status: 'done' },
      { id: '2', text: 'Item 2', status: 'wrong-status' },
    ],
  }, ctx());
  const parsed3 = JSON.parse(res3.content);
  assert.ok(parsed3.error);
  assert.ok(parsed3.error.includes('Invalid checklist item status'));
});

test.after(async () => {
  await rm(CT_HOME, { recursive: true, force: true });
});
