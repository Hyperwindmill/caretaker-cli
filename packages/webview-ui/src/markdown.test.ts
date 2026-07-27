import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, markdownCacheSizeForTest, resetMarkdownCacheForTest } from './markdown.js';

test('renders gfm markdown', () => {
  resetMarkdownCacheForTest();
  const html = renderMarkdown('**bold** and `code`');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('strips script tags and inline event handlers', () => {
  resetMarkdownCacheForTest();
  const html = renderMarkdown('<script>alert(1)</script><p onclick="alert(1)">hi</p>');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onclick/i);
});

test('a repeated key is served from the cache instead of growing it', () => {
  resetMarkdownCacheForTest();
  const first = renderMarkdown('# same');
  assert.equal(markdownCacheSizeForTest(), 1);
  const second = renderMarkdown('# same');
  assert.equal(second, first);
  assert.equal(markdownCacheSizeForTest(), 1);
});

test('evicts the least-recently-used entry past the limit', () => {
  resetMarkdownCacheForTest(2);
  renderMarkdown('a');
  renderMarkdown('b');
  renderMarkdown('a'); // touching 'a' makes 'b' the oldest
  renderMarkdown('c'); // evicts 'b'
  assert.equal(markdownCacheSizeForTest(), 2);
  renderMarkdown('a');
  assert.equal(markdownCacheSizeForTest(), 2, "'a' should still be cached");
  renderMarkdown('b');
  assert.equal(markdownCacheSizeForTest(), 2, "'b' was evicted, re-adding it evicts 'c'");
});

// The regression guard for the actual bug: re-rendering a whole conversation must not
// re-parse it. Ratio, not absolute time, so it holds on any machine.
test('a cached second pass over a long conversation is far cheaper than the first', () => {
  resetMarkdownCacheForTest();
  const docs = Array.from(
    { length: 800 },
    (_, i) => `## Item ${i}\n\nSome **text** with \`code\` and a list:\n\n- one\n- two\n`,
  );
  const cold = process.hrtime.bigint();
  for (const d of docs) renderMarkdown(d);
  const afterCold = process.hrtime.bigint();
  for (const d of docs) renderMarkdown(d);
  const afterWarm = process.hrtime.bigint();

  const coldNs = Number(afterCold - cold);
  const warmNs = Number(afterWarm - afterCold);
  assert.ok(
    warmNs * 5 < coldNs,
    `expected the cached pass to be >5x faster (cold ${coldNs}ns, warm ${warmNs}ns)`,
  );
});