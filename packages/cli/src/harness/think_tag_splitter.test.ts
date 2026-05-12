import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkTagSplitter } from './think_tag_splitter.js';

function feed(splitter: ThinkTagSplitter, chunks: string[]): { thinking: string; content: string } {
  let thinking = '';
  let content = '';
  for (const c of chunks) {
    for (const e of splitter.push(c)) {
      if (e.kind === 'thinking') thinking += e.text;
      else content += e.text;
    }
  }
  for (const e of splitter.flush()) {
    if (e.kind === 'thinking') thinking += e.text;
    else content += e.text;
  }
  return { thinking, content };
}

test('no tags → all content', () => {
  const r = feed(new ThinkTagSplitter(), ['hello ', 'world']);
  assert.equal(r.content, 'hello world');
  assert.equal(r.thinking, '');
});

test('simple think block in one chunk', () => {
  const r = feed(new ThinkTagSplitter(), ['pre <think>plan</think> post']);
  assert.equal(r.content, 'pre  post');
  assert.equal(r.thinking, 'plan');
});

test('think block split across chunks at the open tag', () => {
  const r = feed(new ThinkTagSplitter(), ['pre <th', 'ink>plan</think> post']);
  assert.equal(r.content, 'pre  post');
  assert.equal(r.thinking, 'plan');
});

test('think block split across chunks at the close tag', () => {
  const r = feed(new ThinkTagSplitter(), ['pre <think>pl', 'an</thi', 'nk> post']);
  assert.equal(r.content, 'pre  post');
  assert.equal(r.thinking, 'plan');
});

test('multiple think blocks', () => {
  const r = feed(new ThinkTagSplitter(), ['a<think>x</think>b<think>y</think>c']);
  assert.equal(r.content, 'abc');
  assert.equal(r.thinking, 'xy');
});

test('unclosed think block → all remainder is thinking after flush', () => {
  const r = feed(new ThinkTagSplitter(), ["pre <think>plan and that's it"]);
  assert.equal(r.content, 'pre ');
  assert.equal(r.thinking, "plan and that's it");
});

test('case-insensitive and whitespace-tolerant tags', () => {
  const r = feed(new ThinkTagSplitter(), ['a < THINK >x</ Think > b']);
  assert.equal(r.content, 'a  b');
  assert.equal(r.thinking, 'x');
});

test('character-by-character feed reconstructs the same split as bulk feed', () => {
  const text = 'alpha <think>secret reasoning</think> beta <think>more</think> gamma';
  const bulk = feed(new ThinkTagSplitter(), [text]);
  const trickle = feed(new ThinkTagSplitter(), text.split(''));
  assert.deepEqual(trickle, bulk);
});
