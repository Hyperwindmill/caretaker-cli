import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCompactItems } from './compactGroups.js';

test('groupCompactItems: empty input yields no groups', () => {
  assert.deepEqual(groupCompactItems([]), []);
});

test('groupCompactItems: a single non-tool item is a standalone single group', () => {
  const items = [{ kind: 'user' }];
  const g = groupCompactItems(items);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0], { kind: 'single', key: 0, item: { kind: 'user' } });
});

test('groupCompactItems: a single tool item becomes a one-element tool-row', () => {
  const items = [{ kind: 'tool' }];
  const g = groupCompactItems(items);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.kind, 'tool-row');
  assert.equal((g[0] as { kind: 'tool-row'; items: { kind: string }[] }).items.length, 1);
  assert.equal(g[0]!.key, 0);
});

test('groupCompactItems: consecutive tool items collapse into one tool-row', () => {
  const items = [{ kind: 'tool' }, { kind: 'tool' }, { kind: 'tool' }];
  const g = groupCompactItems(items);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.kind, 'tool-row');
  assert.equal((g[0] as { kind: 'tool-row'; items: { kind: string }[] }).items.length, 3);
  assert.equal(g[0]!.key, 0);
});

test('groupCompactItems: non-tool items between tool runs split them into separate rows', () => {
  const items = [
    { kind: 'tool' },
    { kind: 'tool' },
    { kind: 'assistant' },
    { kind: 'tool' },
  ];
  const g = groupCompactItems(items);
  assert.equal(g.length, 3);
  assert.equal(g[0]!.kind, 'tool-row');
  assert.equal((g[0] as { kind: 'tool-row'; items: { kind: string }[] }).items.length, 2);
  assert.equal(g[0]!.key, 0);
  assert.deepEqual(g[1], { kind: 'single', key: 2, item: { kind: 'assistant' } });
  assert.equal(g[2]!.kind, 'tool-row');
  assert.equal((g[2] as { kind: 'tool-row'; items: { kind: string }[] }).items.length, 1);
  assert.equal(g[2]!.key, 3);
});

test('groupCompactItems: group key is the index of the first item in the run (stable for append-only streams)', () => {
  const items = [
    { kind: 'user' },
    { kind: 'assistant' },
    { kind: 'tool' },
    { kind: 'tool' },
  ];
  const g = groupCompactItems(items);
  assert.equal(g[0]!.key, 0);
  assert.equal(g[1]!.key, 1);
  assert.equal(g[2]!.key, 2);
});

test('groupCompactItems: a mixed stream partitions correctly', () => {
  const items = [
    { kind: 'user' },
    { kind: 'tool' },
    { kind: 'tool' },
    { kind: 'assistant' },
    { kind: 'tool' },
    { kind: 'thinking' },
  ];
  const g = groupCompactItems(items);
  assert.equal(g.length, 5);
  assert.equal(g[0]!.kind, 'single');
  assert.equal(g[1]!.kind, 'tool-row');
  assert.equal((g[1] as { kind: 'tool-row'; items: { kind: string }[] }).items.length, 2);
  assert.equal(g[2]!.kind, 'single');
  assert.equal(g[3]!.kind, 'tool-row');
  assert.equal((g[3] as { kind: 'tool-row'; items: { kind: string }[] }).items.length, 1);
  assert.equal(g[4]!.kind, 'single');
});