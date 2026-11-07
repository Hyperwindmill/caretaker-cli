import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../types.js';

// File-scope CARETAKER_HOME isolation (mutate at file scope, never inside describe).
const CT_HOME = mkdtempSync(join(tmpdir(), 'ct-setws-'));
process.env.CARETAKER_HOME = CT_HOME;

const { saveConfig } = await import('../../../store/json.js');
const { createSession, readSession } = await import('../../../session/store.js');
const { setWorkspaceTool } = await import('./set_workspace.js');

const p1Dir = join(CT_HOME, 'p1');
mkdirSync(p1Dir);
const missingDir = join(CT_HOME, 'does-not-exist');

await saveConfig({
  port: 3000,
  providers: [],
  projects: [
    { id: 'p1', name: 'Project One', description: '', workingDir: p1Dir, agentId: '', active: true },
    { id: 'p-missing', name: 'Gone', description: '', workingDir: missingDir, agentId: '', active: true },
  ],
} as any);

const session = await createSession({ agentId: 'a1', title: 't' });

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: '/elsewhere',
    readPaths: new Set(),
    sessionId: session.id,
    callerAgent: { id: 'a1' } as any,
    ...over,
  };
}

test('switches ctx.workingDir in place and persists on the session meta', async () => {
  const c = ctx();
  const res = await setWorkspaceTool.execute({ project_id: 'p1' }, c);
  assert.equal(c.workingDir, p1Dir);
  const meta = (await readSession('a1', session.id)).meta;
  assert.equal(meta.workingDir, p1Dir);
  assert.equal(meta.projectId, 'p1');
  assert.match(res.content, /Project One/);
  assert.match(res.content, /next turn/);
});

test('unknown project id errors and leaves ctx untouched', async () => {
  const c = ctx();
  const res = await setWorkspaceTool.execute({ project_id: 'nope' }, c);
  assert.match(res.content, /^Error:/);
  assert.equal(c.workingDir, '/elsewhere');
});

test('project dir missing on disk errors and leaves ctx untouched', async () => {
  const c = ctx();
  const res = await setWorkspaceTool.execute({ project_id: 'p-missing' }, c);
  assert.match(res.content, /^Error:/);
  assert.ok(res.content.includes(missingDir));
  assert.equal(c.workingDir, '/elsewhere');
});

test('no session errors and leaves ctx untouched', async () => {
  const c = ctx({ sessionId: undefined });
  const res = await setWorkspaceTool.execute({ project_id: 'p1' }, c);
  assert.match(res.content, /^Error:.*session/);
  assert.equal(c.workingDir, '/elsewhere');
});

test('agent_default restores ctx.workingDir and clears the override', async () => {
  const s2 = await createSession({ agentId: 'a1', title: 't2' });
  const c = ctx({ sessionId: s2.id, callerAgent: { id: 'a1', workingDir: '/agent/own' } as any });
  await setWorkspaceTool.execute({ project_id: 'p1' }, c);
  assert.equal(c.workingDir, p1Dir);
  const res = await setWorkspaceTool.execute({ agent_default: true }, c);
  assert.doesNotMatch(res.content, /^Error:/);
  assert.equal(c.workingDir, '/agent/own');
  const meta = (await readSession('a1', s2.id)).meta;
  assert.equal(meta.workingDir, undefined);
  assert.equal(meta.projectId, undefined);
  const { sessionRunScope } = await import('../../../cli/web/session_scope.js');
  assert.deepEqual(sessionRunScope(meta, '/agent/own'), { workingDir: '/agent/own' });
});

test('both or neither of project_id / agent_default is an error', async () => {
  for (const args of [{ project_id: 'p1', agent_default: true }, {}]) {
    const c = ctx();
    const res = await setWorkspaceTool.execute(args, c);
    assert.match(res.content, /^Error:.*exactly one/);
    assert.equal(c.workingDir, '/elsewhere');
  }
});

test('agent_default with no agent workingDir errors', async () => {
  const c = ctx();
  const res = await setWorkspaceTool.execute({ agent_default: true }, c);
  assert.match(res.content, /^Error:/);
  assert.equal(c.workingDir, '/elsewhere');
});
