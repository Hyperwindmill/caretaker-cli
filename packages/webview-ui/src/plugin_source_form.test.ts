import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authTokenForSave } from './plugin_source_form.js';

test('creating a source with an empty token field stores no token', () => {
  assert.equal(authTokenForSave(false, '   '), null);
});

test('creating a source with a typed token sends it trimmed', () => {
  assert.equal(authTokenForSave(false, ' glpat-abc '), 'glpat-abc');
});

test('editing a source with an empty token field keeps the stored token', () => {
  assert.equal(authTokenForSave(true, ''), undefined);
});

test('editing a source with a typed token replaces it', () => {
  assert.equal(authTokenForSave(true, 'glpat-new'), 'glpat-new');
});
