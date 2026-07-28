import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prettyArgs, popoverPosition, resultMetric, toolSummary } from './toolFormat.js';

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

// --- popoverPosition (compact tool-bubble popover placement) ---

test('popoverPosition opens below the chip when it is in the upper viewport', () => {
  const p = popoverPosition({ top: 100, left: 40, bottom: 120 }, 1000, 800);
  assert.equal(p.top, 126); // bottom + gap(6)
  assert.equal(p.bottom, undefined);
  assert.equal(p.left, 40);
});

test('popoverPosition flips above when the chip is in the lower ~40% of the viewport', () => {
  const p = popoverPosition({ top: 600, left: 40, bottom: 620 }, 1000, 800);
  // 600 > 800 * 0.6 → open upward, anchored by `bottom`
  assert.equal(p.top, undefined);
  assert.equal(p.bottom, 800 - 600 + 6); // vh - rect.top + gap
});

test('popoverPosition clamps left into the viewport', () => {
  const wide = popoverPosition({ top: 100, left: 950, bottom: 120 }, 1000, 800, 6, 480);
  // maxWidth = min(480, 1000-16) = 480; left clamped to 1000 - 8 - 480 = 512
  assert.equal(wide.maxWidth, 480);
  assert.equal(wide.left, 512);

  const off = popoverPosition({ top: 100, left: -50, bottom: 120 }, 1000, 800);
  assert.equal(off.left, 8); // never less than 8
});

test('popoverPosition shrinks maxWidth on a narrow viewport', () => {
  const p = popoverPosition({ top: 100, left: 10, bottom: 120 }, 300, 800, 6, 480);
  assert.equal(p.maxWidth, 300 - 16); // min(480, vw-16) = 284
  // vw=300, maxWidth=284 → upper clamp = 300 - 8 - 284 = 8; left = max(8, min(10, 8)) = 8
  assert.equal(p.left, 8);
});
