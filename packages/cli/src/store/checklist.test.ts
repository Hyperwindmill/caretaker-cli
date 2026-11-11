import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklist } from './db.js';

const ok = (r: ReturnType<typeof buildChecklist>) => {
  assert.ok('checklist' in r, 'error' in r ? r.error : '');
  return r.checklist;
};
const fail = (r: ReturnType<typeof buildChecklist>) => {
  assert.ok('error' in r);
  return r.error;
};

test('keeps given ids, mints the others, orders by position', () => {
  const list = ok(
    buildChecklist([
      { id: 'a', text: 'first', status: 'done' },
      { text: 'second', status: 'pending' },
    ]),
  );
  assert.equal(list[0].id, 'a');
  assert.match(list[1].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    list.map((i) => [i.text, i.status, i.order]),
    [
      ['first', 'done', 0],
      ['second', 'pending', 1],
    ],
  );
});

test('status aliases are normalized', () => {
  assert.equal(ok(buildChecklist([{ text: 'x', status: 'completed' }]))[0].status, 'done');
});

test('a missing status takes the default, or is refused without one', () => {
  assert.equal(ok(buildChecklist([{ text: 'x' }], 'pending'))[0].status, 'pending');
  assert.match(fail(buildChecklist([{ text: 'x' }])), /has no status/);
});

test('an explicit status wins over the default', () => {
  assert.equal(ok(buildChecklist([{ text: 'x', status: 'done' }], 'pending'))[0].status, 'done');
});

test('an unknown status is refused even with a default', () => {
  assert.match(fail(buildChecklist([{ text: 'x', status: 'maybe' }], 'pending')), /"maybe"/);
});

test('refuses non-arrays, blank text and duplicate ids', () => {
  assert.match(fail(buildChecklist(undefined)), /must be an array/);
  assert.match(fail(buildChecklist([{ text: '  ', status: 'done' }])), /no text/);
  assert.match(fail(buildChecklist([null])), /no text/);
  assert.match(
    fail(
      buildChecklist([
        { id: 'a', text: 'x', status: 'done' },
        { id: 'a', text: 'y', status: 'done' },
      ]),
    ),
    /Duplicate/,
  );
});

test('an empty checklist is valid', () => {
  assert.deepEqual(ok(buildChecklist([])), []);
});
