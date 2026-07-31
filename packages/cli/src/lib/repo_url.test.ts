import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateRepositoryUrl } from './repo_url.js';

test('validateRepositoryUrl accepts empty and plain https', () => {
  assert.equal(validateRepositoryUrl(''), null);
  assert.equal(validateRepositoryUrl('   '), null);
  assert.equal(validateRepositoryUrl('https://github.com/org/repo.git'), null);
  assert.equal(validateRepositoryUrl('https://gitlab.example.com:8443/g/s/repo.git'), null);
});

test('validateRepositoryUrl rejects SSH remotes', () => {
  assert.match(validateRepositoryUrl('git@github.com:org/repo.git')!, /SSH/);
  assert.match(validateRepositoryUrl('ssh://git@host/repo.git')!, /SSH/);
});

test('validateRepositoryUrl rejects non-https schemes', () => {
  assert.match(validateRepositoryUrl('http://host/repo.git')!, /https:\/\//);
  assert.match(validateRepositoryUrl('file:///tmp/repo')!, /https:\/\//);
});

test('validateRepositoryUrl rejects credentials embedded in the URL', () => {
  // The whole point of the token field is that the secret never reaches argv
  // or .git/config — an https prefix check alone does not enforce that.
  assert.match(validateRepositoryUrl('https://user:ghp_secret@github.com/o/r.git')!, /credentials/i);
  assert.match(validateRepositoryUrl('https://x-access-token:tok@github.com/o/r.git')!, /credentials/i);
  // A bare username with no password is still a credential.
  assert.match(validateRepositoryUrl('https://someone@github.com/o/r.git')!, /credentials/i);
});

test('validateRepositoryUrl rejects an unparseable URL', () => {
  assert.ok(validateRepositoryUrl('https://') !== null);
});
