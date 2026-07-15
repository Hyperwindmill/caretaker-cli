import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCallbackListener } from './oauth_callback.js';

test('resolves with the code from the redirect', async () => {
  const listener = await startCallbackListener();
  const url = new URL(listener.redirectUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const codePromise = listener.waitForCode();
  const res = await fetch(`${listener.redirectUrl}?code=the-code&state=s`);
  assert.equal(res.status, 200);
  assert.equal(await codePromise, 'the-code');
  listener.close();
});

test('rejects when the provider returns error', async () => {
  const listener = await startCallbackListener();
  const codePromise = listener.waitForCode();
  const [, err] = await Promise.allSettled([
    fetch(`${listener.redirectUrl}?error=access_denied`),
    codePromise,
  ]);
  assert.equal(err.status, 'rejected');
  assert.match((err as PromiseRejectedResult).reason.message, /access_denied/);
  listener.close();
});

test('times out', async () => {
  const listener = await startCallbackListener({ timeoutMs: 50 });
  await assert.rejects(listener.waitForCode(), /timed out/);
  listener.close();
});
