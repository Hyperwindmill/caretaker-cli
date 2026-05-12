import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveCaretakerHome } from './config.js';

test('env value wins over setting', () => {
  const home = resolveCaretakerHome({ envValue: '/tmp/env', settingValue: '/tmp/setting' });
  assert.equal(home, '/tmp/env');
});

test('setting is used when env is unset', () => {
  const home = resolveCaretakerHome({ envValue: undefined, settingValue: '/tmp/setting' });
  assert.equal(home, '/tmp/setting');
});

test('empty strings are treated as unset', () => {
  const home = resolveCaretakerHome({ envValue: '   ', settingValue: '' });
  assert.equal(home, join(homedir(), '.caretaker'));
});

test('defaults to ~/.caretaker when nothing is set', () => {
  const home = resolveCaretakerHome({ envValue: undefined, settingValue: undefined });
  assert.equal(home, join(homedir(), '.caretaker'));
});
