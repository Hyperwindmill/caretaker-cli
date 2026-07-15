import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prettyArgs, resultMetric, toolSummary } from './toolFormat.js';

test('toolSummary: path-like args → basename', () => {
  assert.equal(toolSummary({ path: 'src/App.tsx' }), 'App.tsx');
  assert.equal(toolSummary({ file_path: '/a/b/c.ts' }), 'c.ts');
  assert.equal(toolSummary({ filePath: 'x\\y\\z.md' }), 'z.md');
  assert.equal(toolSummary({ path: 'foo.txt' }), 'foo.txt');
});

test('toolSummary: command arg → command, truncated', () => {
  assert.equal(toolSummary({ command: 'pnpm build' }), 'pnpm build');
  assert.equal(toolSummary({ command: 'x'.repeat(100) }, 10), `${'x'.repeat(10)}…`);
});

test('toolSummary: other args → truncated JSON', () => {
  assert.equal(toolSummary({ foo: 1 }), '{"foo":1}');
});

test('resultMetric: multiline → line count (ignores trailing newlines)', () => {
  assert.equal(resultMetric('a\nb\nc'), '3 lines');
  assert.equal(resultMetric('a\nb\n'), '2 lines');
});

test('resultMetric: single line → byte size', () => {
  assert.equal(resultMetric('hello'), '5 B');
  assert.equal(resultMetric('x'.repeat(2048)), '2.0 KB');
});

test('prettyArgs: empty for null / {}', () => {
  assert.equal(prettyArgs(null), '');
  assert.equal(prettyArgs({}), '');
  assert.equal(prettyArgs({ a: 1 }), '{\n  "a": 1\n}');
});
