import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { keepMissingProjects } from './save_config.js';

describe('keepMissingProjects', () => {
  test('projects on disk and absent from the save are kept, after the incoming ones', () => {
    const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' }, c = { id: 'c', name: 'C-edited' };
    assert.deepEqual(keepMissingProjects([a, b, { id: 'c', name: 'C' }], [c, a]), [c, a, b]);
  });

  test('an incoming edit wins over the on-disk copy', () => {
    assert.deepEqual(keepMissingProjects([{ id: 'a', name: 'old' }], [{ id: 'a', name: 'new' }]), [{ id: 'a', name: 'new' }]);
  });

  test('empty inputs', () => {
    assert.deepEqual(keepMissingProjects([], []), []);
    assert.deepEqual(keepMissingProjects([{ id: 'a' }], []), [{ id: 'a' }]);
  });
});
