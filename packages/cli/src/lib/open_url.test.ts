import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCommandFor } from './open_url.js';

test('picks the platform opener', () => {
  assert.deepEqual(openCommandFor('darwin', 'http://x'), { cmd: 'open', args: ['http://x'] });
  assert.deepEqual(openCommandFor('win32', 'http://x'), { cmd: 'cmd', args: ['/c', 'start', '', 'http://x'] });
  assert.deepEqual(openCommandFor('linux', 'http://x'), { cmd: 'xdg-open', args: ['http://x'] });
});
