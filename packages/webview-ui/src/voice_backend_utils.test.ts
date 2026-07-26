import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendStatusText, splitNdjsonLines, type BackendStatus } from './voice_backend_utils.js';

function status(overrides: Partial<BackendStatus>): BackendStatus {
  return {
    docker: 'ok',
    container: 'stopped',
    imagePresent: false,
    port: 8969,
    responding: false,
    ...overrides,
  };
}

// --- backendStatusText ----------------------------------------------------

test('docker denied reports the group remedy regardless of container state', () => {
  assert.equal(
    backendStatusText(status({ docker: 'denied', container: 'running' })),
    'your user needs to be in the docker group',
  );
});

test('docker down reports the daemon remedy regardless of container state', () => {
  assert.equal(
    backendStatusText(status({ docker: 'down', container: 'running' })),
    'the Docker daemon is not running',
  );
});

test('a running container reports its port', () => {
  assert.equal(
    backendStatusText(status({ docker: 'ok', container: 'running', port: 8969 })),
    'Local backend: running on :8969',
  );
});

test('a stopped container reports stopped', () => {
  assert.equal(
    backendStatusText(status({ docker: 'ok', container: 'stopped' })),
    'Local backend: stopped',
  );
});

test('an absent container reports stopped, same as stopped', () => {
  assert.equal(
    backendStatusText(status({ docker: 'ok', container: 'absent' })),
    'Local backend: stopped',
  );
});

// --- splitNdjsonLines ------------------------------------------------------

test('a single chunk with two complete lines yields both, no remainder', () => {
  const { lines, remainder } = splitNdjsonLines('', '{"a":1}\n{"b":2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(remainder, '');
});

test('a chunk boundary mid-line does not yield a truncated line', () => {
  // First chunk ends inside the second JSON object.
  const first = splitNdjsonLines('', '{"a":1}\n{"b"');
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(first.remainder, '{"b"');

  // The next chunk completes it; the caller feeds the remainder back in as buffer.
  const second = splitNdjsonLines(first.remainder, ':2}\n');
  assert.deepEqual(second.lines, ['{"b":2}']);
  assert.equal(second.remainder, '');
});

test('a chunk with no newline at all is held entirely as remainder', () => {
  const { lines, remainder } = splitNdjsonLines('', '{"partial"');
  assert.deepEqual(lines, []);
  assert.equal(remainder, '{"partial"');
});

test('an empty chunk against a pending buffer changes nothing', () => {
  const { lines, remainder } = splitNdjsonLines('{"a"', '');
  assert.deepEqual(lines, []);
  assert.equal(remainder, '{"a"');
});

test('a boundary split across three chunks reassembles correctly', () => {
  const a = splitNdjsonLines('', '{"a":');
  const b = splitNdjsonLines(a.remainder, '1}\n{"b":2');
  const c = splitNdjsonLines(b.remainder, '}\n');
  assert.deepEqual(a.lines, []);
  assert.deepEqual(b.lines, ['{"a":1}']);
  assert.deepEqual(c.lines, ['{"b":2}']);
  assert.equal(c.remainder, '');
});
