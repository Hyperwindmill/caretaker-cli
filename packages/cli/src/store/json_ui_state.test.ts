import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: must be set before importing anything that resolves CARETAKER_HOME.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-ui-state-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUiState, saveUiState } from './json.js';

test('ui state defaults to empty and is never a shared object', async () => {
  const a = await loadUiState();
  assert.deepEqual(a, {});
  a.lastProjectId = 'mutated';
  assert.deepEqual(await loadUiState(), {});
});

test('lastProjectId round-trips through ui-state.json', async () => {
  await saveUiState({ lastProjectId: 'caretaker' });
  assert.deepEqual(await loadUiState(), { lastProjectId: 'caretaker' });
});
