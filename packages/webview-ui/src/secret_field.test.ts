import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergedSecret, secretForSave } from './secret_field.js';

test('creating with an empty field stores no secret', () => {
  assert.equal(secretForSave(false, '   '), null);
});

test('creating with a typed value sends it trimmed', () => {
  assert.equal(secretForSave(false, ' glpat-abc '), 'glpat-abc');
});

test('editing with an empty field keeps the stored secret', () => {
  assert.equal(secretForSave(true, ''), undefined);
});

test('editing with a typed value replaces it', () => {
  assert.equal(secretForSave(true, 'glpat-new'), 'glpat-new');
});

test('editing with remove set clears the stored secret', () => {
  assert.equal(secretForSave(true, '', true), null);
});

test('a typed value wins over remove', () => {
  assert.equal(secretForSave(true, 'glpat-new', true), 'glpat-new');
});

test('mergedSecret: typed wins, blank keeps the stored value, remove drops it', () => {
  assert.equal(mergedSecret('stored', ' new '), 'new');
  assert.equal(mergedSecret('stored', ''), 'stored');
  assert.equal(mergedSecret('stored', '', true), undefined);
  assert.equal(mergedSecret('stored', 'new', true), 'new');
  assert.equal(mergedSecret(null, ''), undefined);
});
