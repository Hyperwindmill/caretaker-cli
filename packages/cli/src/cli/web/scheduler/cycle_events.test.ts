import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CycleEvent } from './cycle_events.js';
import { beginCycleStream, emitCycleEvent, watchCycleStream } from './cycle_events.js';
import { userMessage } from '../../../session/store.js';

const prompt = userMessage('go');

test('late watcher sees the same events as an early one', () => {
  const early: CycleEvent[] = [];
  beginCycleStream('s1', prompt);
  watchCycleStream('s1', (e) => early.push(e));
  emitCycleEvent('s1', { type: 'chunk', text: 'he' });
  emitCycleEvent('s1', { type: 'chunk', text: 'llo' });
  emitCycleEvent('s1', { type: 'tool_call', id: 't', name: 'read_file', args: {} });
  const late = watchCycleStream('s1', () => {})!;
  emitCycleEvent('s1', { type: 'tool_result', id: 't', content: 'x' });
  assert.deepEqual(late.events, [{ type: 'chunk', text: 'hello' }, { type: 'tool_call', id: 't', name: 'read_file', args: {} }]);
  assert.equal(early.length, 4); // listeners get raw events, the buffer coalesces
});

test('subscribing at any point yields the same final events as watching from the start', () => {
  const sequence: CycleEvent[] = [
    { type: 'thinking', text: 'a' },
    { type: 'thinking', text: 'b' },
    { type: 'chunk', text: 'x' },
    { type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'p' } },
    { type: 'tool_result', id: 't1', content: 'body' },
    { type: 'chunk', text: 'y' },
    { type: 'chunk', text: 'z' },
  ];
  // Reference: a watcher attached before anything, folding every raw event.
  beginCycleStream('eq-ref', prompt);
  const ref: CycleEvent[] = [];
  watchCycleStream('eq-ref', (e) => ref.push(e));
  for (const ev of sequence) emitCycleEvent('eq-ref', ev);
  emitCycleEvent('eq-ref', { type: 'done' });

  for (let cut = 0; cut <= sequence.length; cut++) {
    const id = `eq-${cut}`;
    beginCycleStream(id, prompt);
    for (const ev of sequence.slice(0, cut)) emitCycleEvent(id, ev);
    const late: CycleEvent[] = [];
    const snap = watchCycleStream(id, (e) => late.push(e))!;
    for (const ev of sequence.slice(cut)) emitCycleEvent(id, ev);
    emitCycleEvent(id, { type: 'done' });
    // Snapshot + live tail must reproduce exactly what the early watcher folded.
    assert.deepEqual(fold([...snap.events, ...late]), fold(ref), `cut ${cut}`);
  }
});

// Compare streams on equal terms: drop the terminal event, then coalesce
// consecutive chunk/thinking events the way the buffer does.
function fold(events: CycleEvent[]): CycleEvent[] {
  const out: CycleEvent[] = [];
  for (const ev of events.filter((e) => e.type !== 'done')) {
    const last = out[out.length - 1];
    if (last && ev.type === 'chunk' && last.type === 'chunk') out[out.length - 1] = { type: 'chunk', text: last.text + ev.text };
    else if (last && ev.type === 'thinking' && last.type === 'thinking') out[out.length - 1] = { type: 'thinking', text: last.text + ev.text };
    else out.push(ev);
  }
  return out;
}

test('finished stream is gone: watcher gets null', () => {
  beginCycleStream('s2', prompt);
  emitCycleEvent('s2', { type: 'done' });
  assert.equal(watchCycleStream('s2', () => {}), null);
});

test('two watchers, one unwatches', () => {
  beginCycleStream('s3', prompt);
  const a: CycleEvent[] = []; const b: CycleEvent[] = [];
  const wa = watchCycleStream('s3', (e) => a.push(e))!;
  watchCycleStream('s3', (e) => b.push(e));
  wa.unwatch();
  emitCycleEvent('s3', { type: 'chunk', text: 'x' });
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
});
