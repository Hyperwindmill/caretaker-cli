import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig, ProjectConfig } from '../../../types.js';
import * as ex from './memory_extract.js';

// Pure functions only — no CARETAKER_HOME needed in this file.

describe('buildCombinedPrompt', () => {
  const ctx = (over: Partial<ex.SummarizeContext> = {}): ex.SummarizeContext => ({
    prevSummary: 'old facts',
    chunkText: 'user: hi',
    dedupBlock: '- Uses pnpm [pnpm]',
    hasProject: true,
    ...over,
  });

  it('embeds summary, chunk, and dedup block; marks missing ones', () => {
    const p = ex.buildCombinedPrompt(ctx());
    assert.ok(p.includes('old facts'));
    assert.ok(p.includes('user: hi'));
    assert.ok(p.includes('- Uses pnpm [pnpm]'));
    const empty = ex.buildCombinedPrompt(ctx({ prevSummary: '', dedupBlock: '' }));
    assert.ok(empty.includes('(none)'));
  });

  it('offers the project level only when a project is in scope', () => {
    assert.ok(ex.buildCombinedPrompt(ctx()).includes('"project"'));
    const globalOnly = ex.buildCombinedPrompt(ctx({ hasProject: false }));
    assert.ok(!globalOnly.includes('"level": "project"'));
    assert.ok(globalOnly.includes('always "global"'));
  });
});

describe('parseCombinedResponse', () => {
  it('parses a bare JSON object', () => {
    const r = ex.parseCombinedResponse('{"summary":" s ","memories":[]}');
    assert.ok(r);
    assert.equal(r.summary, 's');
    assert.deepEqual(r.memories, []);
  });

  it('parses JSON wrapped in a code fence or prose', () => {
    const r = ex.parseCombinedResponse('Here you go:\n```json\n{"summary":"s","memories":[]}\n```\n');
    assert.ok(r);
    assert.equal(r.summary, 's');
  });

  it('returns null on garbage, on missing/empty summary, and on non-JSON', () => {
    assert.equal(ex.parseCombinedResponse('plain text summary'), null);
    assert.equal(ex.parseCombinedResponse('{"memories":[]}'), null);
    assert.equal(ex.parseCombinedResponse('{"summary":"  ","memories":[]}'), null);
    assert.equal(ex.parseCombinedResponse('{broken'), null);
  });
});

describe('validateMemories', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    level: 'project',
    kind: 'fact',
    importance: 'high',
    title: 'T',
    body: 'B',
    keywords: ['k1', 'k2'],
    ...over,
  });

  it('accepts a valid entry as-is', () => {
    const out = ex.validateMemories([entry()], true);
    assert.deepEqual(out, [entry()]);
  });

  it('drops entries missing title or body; non-arrays yield []', () => {
    assert.deepEqual(ex.validateMemories([entry({ title: ' ' }), entry({ body: undefined })], true), []);
    assert.deepEqual(ex.validateMemories('nope', true), []);
    assert.deepEqual(ex.validateMemories(undefined, true), []);
  });

  it('coerces invalid kind/importance to fact/normal', () => {
    const out = ex.validateMemories([entry({ kind: 'weird', importance: 7 })], true);
    assert.equal(out[0]!.kind, 'fact');
    assert.equal(out[0]!.importance, 'normal');
  });

  it('degrades level project → global when no project is in scope', () => {
    const out = ex.validateMemories([entry()], false);
    assert.equal(out[0]!.level, 'global');
  });

  it('caps count, title, body, and keywords', () => {
    const many = Array.from({ length: 10 }, (_, i) => entry({ title: `T${i}` }));
    assert.equal(ex.validateMemories(many, true).length, ex.MAX_MEMORIES_PER_CALL);
    const big = ex.validateMemories(
      [entry({ title: 'x'.repeat(1000), body: 'y'.repeat(50_000), keywords: Array(50).fill('k') })],
      true
    );
    assert.equal(big[0]!.title.length, ex.MAX_MEMORY_TITLE_CHARS);
    assert.equal(big[0]!.body.length, ex.MAX_MEMORY_BODY_CHARS);
    assert.equal(big[0]!.keywords.length, ex.MAX_MEMORY_KEYWORDS);
  });

  it('drops non-string keywords instead of failing the entry', () => {
    const out = ex.validateMemories([entry({ keywords: ['ok', 42, ' ', 'fine'] })], true);
    assert.deepEqual(out[0]!.keywords, ['ok', 'fine']);
  });
});

describe('formatDedupBlock', () => {
  it('renders one line per entry, keywords bracketed', () => {
    const block = ex.formatDedupBlock([
      { title: 'Uses pnpm', keywords: ['pnpm'] },
      { title: 'No amend', keywords: [] },
    ]);
    assert.equal(block, '- Uses pnpm [pnpm]\n- No amend');
  });

  it('stops before exceeding the char cap, keeping the newest (first) entries', () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      title: `memory number ${i} ` + 'x'.repeat(50),
      keywords: ['k'],
    }));
    const block = ex.formatDedupBlock(entries);
    assert.ok(block.length <= ex.MAX_DEDUP_CHARS);
    assert.ok(block.startsWith('- memory number 0'));
  });

  it('returns "" for no entries', () => {
    assert.equal(ex.formatDedupBlock([]), '');
  });
});

describe('resolveProjectId', () => {
  const agent = (id: string, workingDir?: string): AgentConfig => ({
    id,
    name: id,
    systemPrompt: '',
    provider: 'p',
    model: 'm',
    allowedTools: [],
    maxTurns: 5,
    ...(workingDir !== undefined ? { workingDir } : {}),
  });
  const project = (id: string, workingDir: string): ProjectConfig => ({
    id,
    name: id,
    description: '',
    workingDir,
    agentId: '',
    active: true,
  });

  const agents = [
    agent('ag-in', '/home/u/dev/proj-a/sub'),
    agent('ag-exact', '/home/u/dev/proj-a'),
    agent('ag-out', '/home/u/elsewhere'),
    agent('ag-nodir'),
    agent('ag-rel', 'relative/dir'),
  ];
  const projects = [project('proj-a', '/home/u/dev/proj-a'), project('proj-nested', '/home/u/dev/proj-a/sub')];

  it('matches exact dir and subdirectory (prefix, path-aware)', () => {
    assert.equal(ex.resolveProjectId('ag-exact', agents, projects), 'proj-a');
    // nested project wins over its parent (longest match)
    assert.equal(ex.resolveProjectId('ag-in', agents, projects), 'proj-nested');
  });

  it('does not match a sibling dir sharing a name prefix', () => {
    const p = [project('proj-a', '/home/u/dev/proj')];
    assert.equal(ex.resolveProjectId('ag-exact', agents, p), '');
  });

  it("returns '' for unknown agent, no workingDir, relative workingDir, or no match", () => {
    assert.equal(ex.resolveProjectId('nope', agents, projects), '');
    assert.equal(ex.resolveProjectId('ag-nodir', agents, projects), '');
    assert.equal(ex.resolveProjectId('ag-rel', agents, projects), '');
    assert.equal(ex.resolveProjectId('ag-out', agents, projects), '');
  });
});
