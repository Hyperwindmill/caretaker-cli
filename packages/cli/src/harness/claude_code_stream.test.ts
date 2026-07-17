import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeStreamLine, type ClaudeStreamEvent } from './claude_code_stream.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string[] =>
  readFileSync(path.join(here, 'fixtures', name), 'utf8').split('\n').filter(Boolean);

function parseAll(lines: string[]): ClaudeStreamEvent[] {
  return lines.flatMap((l) => parseClaudeStreamLine(l));
}

test('text fixture: init, text deltas, assistant message, result', () => {
  const events = parseAll(fixture('claude_code_stream_text.jsonl'));
  const init = events.find((e) => e.kind === 'init');
  assert.ok(init && init.kind === 'init' && init.sessionId.length > 10);
  const text = events.filter((e) => e.kind === 'text').map((e: any) => e.text).join('');
  assert.ok(text.toLowerCase().includes('ok'));
  const thinking = events.filter((e) => e.kind === 'thinking');
  assert.ok(thinking.length > 0);
  const result = events.find((e) => e.kind === 'result');
  assert.ok(result && result.kind === 'result');
  assert.equal(result.isError, false);
  assert.ok(result.usage && result.usage.output > 0);
});

test('tooluse fixture: tool_use, tool_result, assistant parts, cost', () => {
  const events = parseAll(fixture('claude_code_stream_tooluse.jsonl'));
  const toolUses = events.filter((e) => e.kind === 'assistant_message')
    .flatMap((e: any) => e.parts.filter((p: any) => p.type === 'tool_use'));
  assert.ok(toolUses.length >= 2, `expected >=2 tool_use, got ${toolUses.length}`);
  assert.ok(toolUses.every((p: any) => typeof p.id === 'string' && typeof p.name === 'string'));
  const toolResults = events.filter((e) => e.kind === 'tool_result');
  assert.equal(toolResults.length, toolUses.length);
  assert.ok(toolResults.every((e: any) => typeof e.content === 'string'));
  const result = events.find((e) => e.kind === 'result') as any;
  assert.ok(typeof result.costUsd === 'number' && result.costUsd > 0);
  // every assistant_message event carries the message id for merging
  const am = events.filter((e) => e.kind === 'assistant_message') as any[];
  assert.ok(am.every((e) => typeof e.id === 'string' && e.id.length > 0));
});

test('garbage and unknown lines yield no events', () => {
  assert.deepEqual(parseClaudeStreamLine('not json'), []);
  assert.deepEqual(parseClaudeStreamLine(''), []);
  assert.deepEqual(parseClaudeStreamLine('{"type":"system","subtype":"status"}'), []);
});
