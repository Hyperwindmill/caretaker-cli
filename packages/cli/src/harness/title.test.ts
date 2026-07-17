import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, generateTitle } from './title.js';

test('cleanTitle: pass-through on already-clean input', () => {
  assert.equal(cleanTitle('Hello world test'), 'Hello world test');
});

test('cleanTitle: trims surrounding whitespace', () => {
  assert.equal(cleanTitle('   spacy   '), 'spacy');
});

test('cleanTitle: strips matching surrounding quotes and asterisks', () => {
  assert.equal(cleanTitle('"quoted title"'), 'quoted title');
  assert.equal(cleanTitle("'single quoted'"), 'single quoted');
  assert.equal(cleanTitle('**bold**'), 'bold');
  assert.equal(cleanTitle('`code`'), 'code');
  assert.equal(cleanTitle('_italic_'), 'italic');
});

test('cleanTitle: drops trailing period but keeps ellipsis', () => {
  assert.equal(cleanTitle('title.'), 'title');
  assert.equal(cleanTitle('title...'), 'title...');
  assert.equal(cleanTitle('title..'), 'title..');
});

test('cleanTitle: collapses whitespace runs', () => {
  assert.equal(cleanTitle('a   b\t\tc\nd'), 'a b c d');
});

test('cleanTitle: caps long titles with ellipsis', () => {
  const long = 'word '.repeat(40).trim(); // 40 words, well over 80 chars
  const out = cleanTitle(long);
  assert.equal(out.length, 80);
  assert.ok(out.endsWith('…'));
});

test('cleanTitle: combined cleanup', () => {
  assert.equal(cleanTitle('  "**Hello   world.**"  '), 'Hello world');
});

test('generateTitle returns null for claude-code providers', async () => {
  const title = await generateTitle({
    agent: { id: 'a', name: 'a', systemPrompt: '', provider: 'cc', model: 'sonnet', allowedTools: [], maxTurns: 30 },
    provider: { name: 'cc', type: 'claude-code', endpoint: '' },
    firstUserPrompt: 'hello',
    firstAssistantText: 'world',
  });
  assert.equal(title, null);
});
