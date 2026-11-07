import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesktopAssistantConfig,
  desktopAssistantSignature,
  DEFAULT_ASSISTANT_SHORTCUT,
} from './desktop_tab_utils.js';

test('disabled or no agent → undefined (feature off)', () => {
  assert.equal(buildDesktopAssistantConfig({ enabled: false, agentId: 'a', shortcut: 'X' }), undefined);
  assert.equal(buildDesktopAssistantConfig({ enabled: true, agentId: '  ', shortcut: 'X' }), undefined);
});

test('blank shortcut → default accelerator', () => {
  assert.equal(DEFAULT_ASSISTANT_SHORTCUT, 'CommandOrControl+Shift+Space');
  assert.deepEqual(buildDesktopAssistantConfig({ enabled: true, agentId: 'a', shortcut: '  ' }), {
    agentId: 'a',
    shortcut: DEFAULT_ASSISTANT_SHORTCUT,
  });
});

test('explicit shortcut kept, trimmed', () => {
  assert.deepEqual(buildDesktopAssistantConfig({ enabled: true, agentId: ' a ', shortcut: ' Alt+F1 ' }), {
    agentId: 'a',
    shortcut: 'Alt+F1',
  });
});

test('signature tracks the persisted shape', () => {
  assert.equal(desktopAssistantSignature(undefined), '');
  assert.equal(
    desktopAssistantSignature({ agentId: 'a', shortcut: 'Alt+F1' }),
    desktopAssistantSignature({ shortcut: 'Alt+F1', agentId: 'a' }),
  );
  assert.notEqual(
    desktopAssistantSignature({ agentId: 'a', shortcut: 'Alt+F1' }),
    desktopAssistantSignature({ agentId: 'a', shortcut: 'Alt+F2' }),
  );
});
