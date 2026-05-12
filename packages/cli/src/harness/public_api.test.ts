// Guards the public API surface exported under `caretaker-cli/harness`.
// If a re-export name changes or disappears, this test fails — preventing
// silent breaking changes for embedders (VSCode extension, future hosts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as harness from './index.js';

test('harness barrel exports the public surface', () => {
  for (const name of [
    'run',
    'resolveAgentTools',
    'ToolRegistry',
    'registerBuiltins',
    'toOpenAiTool',
    'tools',
  ] as const) {
    assert.ok(name in harness, `missing export: ${name}`);
  }
  assert.equal(typeof harness.run, 'function');
  assert.equal(typeof harness.resolveAgentTools, 'function');
  assert.equal(typeof harness.tools, 'object');
});
