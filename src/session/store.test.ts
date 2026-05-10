import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The store module reads CARETAKER_HOME at import time, so override BEFORE the
// dynamic import below. Each test gets its own temp dir to avoid cross-test
// pollution.
async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'caretaker-test-'));
  process.env.CARETAKER_HOME = dir;
  // Bust the module cache so dataDir is recomputed for this test.
  const mod = await import(`./store.js?cb=${Date.now()}`);
  return { dir, mod: mod as typeof import('./store.js') };
}

test('createSession + readSession round-trip', async () => {
  const { mod } = await freshStore();
  const meta = await mod.createSession({ agentId: 'agent-a', title: 'first chat' });
  assert.equal(meta.title, 'first chat');
  assert.equal(meta.agentId, 'agent-a');
  assert.equal(meta.type, 'session_meta');
  assert.equal(meta.v, 1);

  const session = await mod.readSession('agent-a', meta.id);
  assert.deepEqual(session.meta, meta);
  assert.deepEqual(session.messages, []);
});

test('createSession refuses to overwrite an existing id', async () => {
  const { mod } = await freshStore();
  const meta = await mod.createSession({ agentId: 'agent-a', title: 'x', id: 'fixed' });
  await assert.rejects(
    mod.createSession({ agentId: 'agent-a', title: 'y', id: 'fixed' }),
    /EEXIST/,
  );
  const session = await mod.readSession(meta.agentId, meta.id);
  assert.equal(session.meta.title, 'x');
});

test('appendMessage persists user/assistant/tool messages in order', async () => {
  const { mod } = await freshStore();
  const meta = await mod.createSession({ agentId: 'agent-a', title: 't' });

  const u = mod.userMessage('hi');
  const a = mod.assistantMessage(
    [
      { type: 'thinking', text: 'let me think' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tc1', name: 'noop', args: {} },
    ],
    { input: 5, output: 3 },
  );
  const t = mod.toolMessage('tc1', 'ok');

  await mod.appendMessage(meta, u);
  await mod.appendMessage(meta, a);
  await mod.appendMessage(meta, t);

  const session = await mod.readSession(meta.agentId, meta.id);
  assert.equal(session.messages.length, 3);
  assert.equal(session.messages[0]!.role, 'user');
  assert.equal(session.messages[1]!.role, 'assistant');
  assert.equal(session.messages[2]!.role, 'tool');

  // Assistant content is textConcat(parts) — only "text" parts contribute.
  assert.equal(session.messages[1]!.content, 'hello');
  assert.deepEqual(session.messages[1]!.usage, { input: 5, output: 3 });
  assert.equal(session.messages[1]!.parts!.length, 3);

  assert.equal(session.messages[2]!.toolCallId, 'tc1');
  assert.equal(session.messages[2]!.content, 'ok');
});

test('assistantMessage with no text parts produces empty content', async () => {
  const { mod } = await freshStore();
  const a = mod.assistantMessage([{ type: 'tool_use', id: 'x', name: 'n', args: {} }]);
  assert.equal(a.content, '');
});

test('readSession skips a corrupted line and warns', async () => {
  const { mod } = await freshStore();
  const meta = await mod.createSession({ agentId: 'agent-a', title: 't' });
  await mod.appendMessage(meta, mod.userMessage('hi'));

  // Inject a partial/corrupted line as if a crash happened mid-write.
  const path = mod.__forTesting.sessionPath(meta.agentId, meta.id);
  await appendFile(path, '{"v":1,"type":"message","role":"user"\n');
  await mod.appendMessage(meta, mod.userMessage('after-corruption'));

  const warnings: unknown[] = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const session = await mod.readSession(meta.agentId, meta.id);
    assert.equal(session.messages.length, 2, 'valid messages preserved');
    assert.equal(session.messages[1]!.content, 'after-corruption');
  } finally {
    console.warn = origWarn;
  }
});

test('readSession honors the latest meta record (append-based retitle)', async () => {
  const { mod } = await freshStore();
  const meta = await mod.createSession({ agentId: 'agent-a', title: 'old' });
  // Append a fresh meta line as a "lazy" retitle (instead of rewrite).
  const path = mod.__forTesting.sessionPath(meta.agentId, meta.id);
  await appendFile(path, JSON.stringify({ ...meta, title: 'new' }) + '\n');

  const session = await mod.readSession(meta.agentId, meta.id);
  assert.equal(session.meta.title, 'new');
});

test('updateTitle rewrites first meta atomically', async () => {
  const { mod } = await freshStore();
  const meta = await mod.createSession({ agentId: 'agent-a', title: 'old' });
  await mod.appendMessage(meta, mod.userMessage('hi'));
  await mod.appendMessage(meta, mod.assistantMessage([{ type: 'text', text: 'yo' }]));

  const updated = await mod.updateTitle(meta, 'renamed');
  assert.equal(updated.title, 'renamed');
  assert.equal(updated.id, meta.id);

  // First line is now the new meta; messages are preserved.
  const path = mod.__forTesting.sessionPath(meta.agentId, meta.id);
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  const firstMeta = JSON.parse(lines[0]!);
  assert.equal(firstMeta.title, 'renamed');
  assert.equal(lines.length, 3);

  const session = await mod.readSession(meta.agentId, meta.id);
  assert.equal(session.meta.title, 'renamed');
  assert.equal(session.messages.length, 2);
});

test('listForAgent returns latest-mtime first', async () => {
  const { mod } = await freshStore();
  const a = await mod.createSession({ agentId: 'agent-a', title: 'alpha' });
  await new Promise((r) => setTimeout(r, 15));
  const b = await mod.createSession({ agentId: 'agent-a', title: 'beta' });
  await new Promise((r) => setTimeout(r, 15));
  await mod.appendMessage(a, mod.userMessage('touch')); // bumps mtime of `a`

  const list = await mod.listForAgent('agent-a');
  assert.equal(list.length, 2);
  assert.equal(list[0]!.meta.id, a.id, 'most recently appended is first');
  assert.equal(list[1]!.meta.id, b.id);
});

test('listForAgent for an unknown agent returns []', async () => {
  const { mod } = await freshStore();
  const list = await mod.listForAgent('ghost');
  assert.deepEqual(list, []);
});

test('deleteSession removes the file', async () => {
  const { mod } = await freshStore();
  const meta = await mod.createSession({ agentId: 'agent-a', title: 't' });
  const path = mod.__forTesting.sessionPath(meta.agentId, meta.id);

  await mod.deleteSession(meta.agentId, meta.id);
  await assert.rejects(readFile(path, 'utf8'), /ENOENT/);
  // Idempotent: second delete doesn't throw.
  await mod.deleteSession(meta.agentId, meta.id);
});

test('readSession throws when no meta is present', async () => {
  const { mod, dir } = await freshStore();
  // Hand-craft a malformed file with no meta line.
  const path = join(dir, 'sessions', 'agent-x', 'ghost.jsonl');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'sessions', 'agent-x'), { recursive: true });
  await writeFile(
    path,
    '{"v":1,"type":"message","id":"u","role":"user","content":"orphan","createdAt":"now"}\n',
  );

  await assert.rejects(mod.readSession('agent-x', 'ghost'), /no meta record/);
});
