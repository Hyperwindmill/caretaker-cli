import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daySeparators, dayLabel, fullDateTime, shortTime } from './message_time.js';

const now = new Date(2026, 10, 27, 10, 0);
const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo, d, h).toISOString();

test('dayLabel: today and yesterday are relative, older days are dates', () => {
  assert.equal(dayLabel(new Date(2026, 10, 27, 0, 5), now, 'en-US'), 'Today');
  assert.equal(dayLabel(new Date(2026, 10, 26, 23, 59), now, 'en-US'), 'Yesterday');
  const older = dayLabel(new Date(2026, 10, 25), now, 'en-US');
  assert.match(older, /Nov/);
  assert.match(older, /25/);
  assert.doesNotMatch(older, /2026/);
  assert.match(dayLabel(new Date(2025, 10, 25), now, 'en-US'), /2025/);
});

test('daySeparators: a label at the first dated entry and on each day change', () => {
  const seps = daySeparators(
    [undefined, at(2026, 10, 25), at(2026, 10, 25, 18), undefined, at(2026, 10, 27), 'garbage', at(2026, 10, 27, 13)],
    now,
    'en-US',
  );
  assert.equal(seps[0], null);
  assert.match(seps[1]!, /25/);
  assert.deepEqual(seps.slice(2), [null, null, 'Today', null, null]);
});

test('missing or malformed timestamps format to an empty string', () => {
  assert.equal(shortTime(undefined), '');
  assert.equal(shortTime(''), '');
  assert.equal(fullDateTime('not a date'), '');
  assert.notEqual(shortTime(at(2026, 10, 27)), '');
});
