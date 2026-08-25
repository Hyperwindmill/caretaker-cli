import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectIdForDir } from './project_resolve.js';
import type { ProjectConfig } from '../types.js';

const proj = (id: string, workingDir: string): ProjectConfig =>
  ({ id, name: id, workingDir }) as ProjectConfig;

describe('resolveProjectIdForDir', () => {
  const projects = [proj('outer', '/home/u/dev'), proj('inner', '/home/u/dev/app')];

  it('matches exact dir and subdirectories', () => {
    assert.equal(resolveProjectIdForDir('/home/u/dev/app', projects), 'inner');
    assert.equal(resolveProjectIdForDir('/home/u/dev/app/src', projects), 'inner');
    assert.equal(resolveProjectIdForDir('/home/u/dev/other', projects), 'outer');
  });

  it('longest prefix wins (nested projects)', () => {
    assert.equal(resolveProjectIdForDir('/home/u/dev/app/deep/x', projects), 'inner');
  });

  it('no false prefix match on sibling names', () => {
    assert.equal(resolveProjectIdForDir('/home/u/dev-other', projects), '');
  });

  it("'' on empty/relative dirs and on projects without workingDir", () => {
    assert.equal(resolveProjectIdForDir('', projects), '');
    assert.equal(resolveProjectIdForDir('relative/path', projects), '');
    assert.equal(resolveProjectIdForDir('/x', [proj('p', '')]), '');
  });
});
