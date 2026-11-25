import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowBanner, cliUpdateMessage, type UpdateStatus } from './update_banner_utils.js';

const base: UpdateStatus = {
  current: '0.37.0',
  latest: '0.38.0',
  url: 'https://github.com/Hyperwindmill/caretaker-cli/releases/tag/v0.38.0',
  appOutdated: true,
  cliOutdated: false,
};

test('shouldShowBanner: hidden without status, without latest, or when nothing is behind', () => {
  assert.equal(shouldShowBanner(null), false);
  assert.equal(shouldShowBanner({ current: '0.37.0', appOutdated: false, cliOutdated: false }), false);
  assert.equal(shouldShowBanner({ ...base, appOutdated: false, cliOutdated: false }), false);
});

test('shouldShowBanner: shown when the app or the CLI is behind', () => {
  assert.equal(shouldShowBanner(base), true);
  assert.equal(shouldShowBanner({ ...base, appOutdated: false, cliOutdated: true }), true);
});

test('shouldShowBanner: hidden for the dismissed version, back for a newer one', () => {
  assert.equal(shouldShowBanner({ ...base, dismissedVersion: '0.38.0' }), false);
  assert.equal(shouldShowBanner({ ...base, dismissedVersion: '0.37.5' }), true);
});

test('cliUpdateMessage: done / failed / stale', () => {
  assert.deepEqual(cliUpdateMessage({ ok: true, output: '', cliVersion: '0.38.0', cliOutdated: false }), {
    kind: 'done',
    text: 'CLI updated — restart open caretaker-cli sessions to use it.',
  });
  assert.deepEqual(cliUpdateMessage({ ok: false, output: 'EACCES', cliVersion: '0.36.0', cliOutdated: true }), {
    kind: 'failed',
    text: 'Update failed. Run the command yourself (it may need admin rights):',
  });
  assert.deepEqual(cliUpdateMessage({ ok: true, output: '', cliVersion: '0.36.0', cliOutdated: true }), {
    kind: 'stale',
    text: 'npm finished, but the caretaker-cli on your PATH is still 0.36.0 (installed another way?).',
  });
  assert.equal(
    cliUpdateMessage({ ok: true, output: '', cliOutdated: true }).text,
    'npm finished, but the caretaker-cli on your PATH is still unknown (installed another way?).',
  );
});
