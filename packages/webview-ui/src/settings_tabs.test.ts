import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsTabs } from './settings_tabs.js';

describe('settingsTabs', () => {
  test('compact shows the four surface-independent tabs', () => {
    assert.deepEqual(settingsTabs('compact').map((t) => t.id), ['providers', 'agents', 'plugins', 'mcp']);
  });

  test('sidebar shows every tab in order', () => {
    assert.deepEqual(settingsTabs('sidebar').map((t) => t.id),
      ['providers', 'projects', 'agents', 'plugins', 'mcp', 'services', 'voice', 'memory', 'desktop', 'api']);
  });
});
