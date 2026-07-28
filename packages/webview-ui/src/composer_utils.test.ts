import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFocusComposer } from './composer_utils.js';

test('focuses on a disabled -> enabled transition when the webview has focus', () => {
  assert.equal(shouldFocusComposer(true, false, true), true);
});

test('does NOT focus when the webview does not have focus (no steal)', () => {
  // e.g. turn finished while the user is in the VSCode editor
  assert.equal(shouldFocusComposer(true, false, false), false);
});

test('does NOT focus when the field is still disabled', () => {
  assert.equal(shouldFocusComposer(true, true, true), false);
});

test('does NOT focus when there was no transition (already enabled)', () => {
  // steady enabled state (e.g. a re-render that did not toggle disabled)
  assert.equal(shouldFocusComposer(false, false, true), false);
});

test('does NOT focus on an enabled -> disabled transition', () => {
  assert.equal(shouldFocusComposer(false, true, true), false);
});

test('initial mount already enabled + focused (prevDisabled seeded true) focuses', () => {
  assert.equal(shouldFocusComposer(true, false, true), true);
});