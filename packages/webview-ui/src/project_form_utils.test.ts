import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepositoryUrl } from './project_form_utils.js';

test('validateRepositoryUrl accepts empty and https, rejects ssh and everything else', () => {
  assert.equal(validateRepositoryUrl(''), null);
  assert.equal(validateRepositoryUrl('   '), null);
  assert.equal(validateRepositoryUrl('https://github.com/org/repo.git'), null);
  assert.match(validateRepositoryUrl('git@github.com:org/repo.git')!, /SSH/);
  assert.match(validateRepositoryUrl('ssh://git@host/repo.git')!, /SSH/);
  assert.match(validateRepositoryUrl('http://host/repo.git')!, /https:\/\//);
  assert.match(validateRepositoryUrl('ftp://host/repo')!, /https:\/\//);
});
