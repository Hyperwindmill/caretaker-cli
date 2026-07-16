import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;

describe('database store', () => {
  let db: typeof import('./db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-db-test-'));
    process.env.CARETAKER_HOME = testHome;
    db = await import('./db.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  it('correctly creates task and retrieves it by id', async () => {
    const task = await db.createTask({
      projectId: 1,
      title: 'Test Task',
      objective: 'Verify DB works',
      checklist: [],
      status: 'active',
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
    });

    assert.equal(typeof task.id, 'number');
    assert.equal(task.title, 'Test Task');

    const retrieved = await db.getTaskById(task.id);
    assert.ok(retrieved);
    assert.equal(retrieved.id, task.id);
    assert.equal(retrieved.objective, 'Verify DB works');
  });

  it('saves task updates', async () => {
    const task = await db.createTask({
      projectId: 1,
      title: 'Update Task',
      objective: 'Initial objective',
      checklist: [],
      status: 'active',
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
    });

    task.objective = 'Updated objective';
    task.status = 'paused';
    await db.saveTask(task);

    const retrieved = await db.getTaskById(task.id);
    assert.ok(retrieved);
    assert.equal(retrieved.objective, 'Updated objective');
    assert.equal(retrieved.status, 'paused');
  });

  it('adds task messages and updates their content with complex characters', async () => {
    const task = await db.createTask({
      projectId: 2,
      title: 'Task for Messages',
      objective: 'Message test',
      checklist: [],
      status: 'active',
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
    });

    const msg = await db.addTaskMessage({
      taskId: task.id,
      role: 'assistant',
      messageType: 'chat',
      content: 'Initial message content',
    });

    assert.equal(typeof msg.id, 'number');
    assert.equal(msg.content, 'Initial message content');

    // Test complex string with newlines, backslashes, quotes, and unicode.
    // In morphql 0.1.44 this should be stored and retrieved perfectly.
    const complexContent = 'Line 1\nLine 2: containing single \'quotes\'\nLine 3: and \\backslashes\\ and emojis 🚀\n';
    await db.updateTaskMessageContent(msg.id, complexContent, 'heartbeat');

    // Retrieve from DB to verify content
    const rows = await db.runQuery(`SELECT * FROM task_messages WHERE id = ${msg.id}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, complexContent);
    assert.equal(rows[0].messageType, 'heartbeat');
  });

  it('supports multi-expression WHERE queries', async () => {
    const task = await db.createTask({
      projectId: 3,
      title: 'Multi Where Task',
      objective: 'Test multiple where clauses',
      checklist: [],
      status: 'active',
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: '2026-05-27T00:00:00Z',
    });

    // Run query with AND
    const taskRows = (await db.runQuery(
      `SELECT * FROM tasks WHERE status = 'active' AND lockedAt IS NOT NULL`
    )) as typeof task[];

    assert.ok(taskRows.length >= 1);
    const found = taskRows.find((t) => t.id === task.id);
    assert.ok(found);
    assert.equal(found.title, 'Multi Where Task');
  });

  it('permanently deletes a task and its messages', async () => {
    const task = await db.createTask({
      projectId: 4,
      title: 'Delete Task',
      objective: 'To be deleted',
      checklist: [],
      status: 'active',
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
    });

    await db.addTaskMessage({
      taskId: task.id,
      role: 'assistant',
      messageType: 'chat',
      content: 'message 1',
    });
    await db.addTaskMessage({
      taskId: task.id,
      role: 'assistant',
      messageType: 'chat',
      content: 'message 2',
    });

    // Verify task and messages exist
    assert.ok(await db.getTaskById(task.id));
    const msgsBefore = await db.runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`);
    assert.equal(msgsBefore.length, 2);

    // Delete
    await db.deleteTask(task.id);

    // Task should be gone
    assert.equal(await db.getTaskById(task.id), null);

    // Messages should be gone
    const msgsAfter = await db.runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`);
    assert.equal(msgsAfter.length, 0);
  });

  it('saves and retrieves the archived flag', async () => {
    const task = await db.createTask({
      projectId: 5,
      title: 'Archive Flag Task',
      objective: 'Test archived flag persistence',
      checklist: [],
      status: 'active',
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
    });

    // Archived defaults to undefined/falsy for new tasks
    const before = await db.getTaskById(task.id);
    assert.ok(!before!.archived);

    // Set archived = true and save
    before!.archived = true;
    await db.saveTask(before!);

    const after = await db.getTaskById(task.id);
    assert.equal(after!.archived, true);

    // Set archived = false and save
    after!.archived = false;
    await db.saveTask(after!);

    const final = await db.getTaskById(task.id);
    assert.equal(final!.archived, false);
  });
});
