import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectSlug, validateProjectIds } from './project_slug.js';

describe('validateProjectSlug', () => {
  it('accepts simple slugs', () => {
    assert.equal(validateProjectSlug('caretaker-cli'), null);
    assert.equal(validateProjectSlug('a'), null);
    assert.equal(validateProjectSlug('3'), null); // migrated numeric id
    assert.equal(validateProjectSlug('a'.repeat(39)), null);
  });
  it('rejects bad charset and shape', () => {
    // trailing hyphen: docker image grammar requires components end alphanumeric
    assert.ok(validateProjectSlug('foo-'));
    assert.ok(validateProjectSlug('-foo'));
    assert.ok(validateProjectSlug('Foo'));
    assert.ok(validateProjectSlug('foo_bar'));
    assert.ok(validateProjectSlug('foo/bar'));
    assert.ok(validateProjectSlug('..'));
    assert.ok(validateProjectSlug(''));
    assert.ok(validateProjectSlug('a'.repeat(40)));
  });
});

describe('validateProjectIds', () => {
  it('accepts a valid unique set', () => {
    assert.equal(validateProjectIds([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), null);
  });
  it('rejects a duplicate id', () => {
    const err = validateProjectIds([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]);
    assert.ok(err && err.includes('a'));
  });
  it('rejects an invalid id and names the project', () => {
    const err = validateProjectIds([{ id: 'Foo-', name: 'Broken' }]);
    assert.ok(err && err.includes('Broken'));
  });
});
