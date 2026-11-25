import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, getLatestRelease, __resetUpdateCacheForTests } from './update_check.js';

const RELEASES_URL = 'https://api.github.com/repos/Hyperwindmill/caretaker-cli/releases/latest';
const HTML_URL = 'https://github.com/Hyperwindmill/caretaker-cli/releases/tag/v0.38.0';

beforeEach(() => __resetUpdateCacheForTests());

test('isNewer compares X.Y.Z numerically and rejects odd tags', () => {
  assert.equal(isNewer('0.38.0', '0.37.0'), true);
  assert.equal(isNewer('v0.38.0', '0.37.0'), true);
  assert.equal(isNewer('0.37.0', '0.38.0'), false);
  assert.equal(isNewer('0.37.0', '0.37.0'), false);
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('0.38.0-beta.1', '0.37.0'), false);
  assert.equal(isNewer('nightly', '0.37.0'), false);
});

function stubFetch(respond: () => Promise<Response>) {
  const calls: string[] = [];
  const fn = (async (url: any) => {
    calls.push(String(url));
    return respond();
  }) as typeof fetch;
  return { fn, calls };
}

const ok = () =>
  Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.38.0', html_url: HTML_URL }), { status: 200 }));

test('getLatestRelease reads tag_name and html_url from the latest published release', async () => {
  const { fn, calls } = stubFetch(ok);
  assert.deepEqual(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), { version: '0.38.0', url: HTML_URL });
  assert.deepEqual(calls, [RELEASES_URL]);
});

test('fetch failure → null', async () => {
  const { fn } = stubFetch(() => Promise.reject(new Error('offline')));
  assert.equal(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), null);
});

test('non-2xx (rate limit) → null', async () => {
  const { fn } = stubFetch(() => Promise.resolve(new Response('{}', { status: 403 })));
  assert.equal(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), null);
});

test('body without tag_name → null', async () => {
  const { fn } = stubFetch(() => Promise.resolve(new Response(JSON.stringify({ html_url: HTML_URL }))));
  assert.equal(await getLatestRelease({ fetchImpl: fn, now: () => 0 }), null);
});

test('success is cached for 6 h', async () => {
  const { fn, calls } = stubFetch(ok);
  await getLatestRelease({ fetchImpl: fn, now: () => 0 });
  await getLatestRelease({ fetchImpl: fn, now: () => 6 * 3600_000 });
  assert.equal(calls.length, 1);
  await getLatestRelease({ fetchImpl: fn, now: () => 6 * 3600_000 + 1 });
  assert.equal(calls.length, 2);
});

test('failure is cached for 15 min only', async () => {
  const { fn, calls } = stubFetch(() => Promise.reject(new Error('offline')));
  await getLatestRelease({ fetchImpl: fn, now: () => 0 });
  await getLatestRelease({ fetchImpl: fn, now: () => 15 * 60_000 });
  assert.equal(calls.length, 1);
  await getLatestRelease({ fetchImpl: fn, now: () => 15 * 60_000 + 1 });
  assert.equal(calls.length, 2);
});
