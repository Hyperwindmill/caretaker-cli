import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fetchGit, __setGitClient, type GitClient } from './git.js';
import { encrypt } from '../../lib/encryption.js';

afterEach(() => __setGitClient(null));

interface RecordedCall {
  op: string;
  args: Record<string, unknown>;
}

function makeMock(opts: { sha?: string; cloneThrows?: Error; fetchThrows?: Error } = {}) {
  const calls: RecordedCall[] = [];
  const sha = opts.sha ?? 'a'.repeat(40);
  const client: GitClient = {
    async clone(args) {
      calls.push({ op: 'clone', args: args as unknown as Record<string, unknown> });
      if (opts.cloneThrows) throw opts.cloneThrows;
    },
    async fetch(args) {
      calls.push({ op: 'fetch', args: args as unknown as Record<string, unknown> });
      if (opts.fetchThrows) throw opts.fetchThrows;
      return {};
    },
    async checkout(args) {
      calls.push({ op: 'checkout', args: args as unknown as Record<string, unknown> });
    },
    async resolveRef(args) {
      calls.push({ op: 'resolveRef', args: args as unknown as Record<string, unknown> });
      return sha;
    },
    async currentBranch(args) {
      calls.push({ op: 'currentBranch', args: args as unknown as Record<string, unknown> });
      return 'main';
    },
  };
  return { client, calls, sha };
}

test('fetchGit clones when cache has no .git', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  rmSync(cache, { recursive: true, force: true });
  try {
    const { client, calls, sha } = makeMock();
    __setGitClient(client);

    const result = await fetchGit(
      { url: 'https://example.com/x.git', ref: null, authToken: null },
      cache,
    );

    assert.equal(result.root, cache);
    assert.equal(result.sha, sha);
    assert.equal(calls[0].op, 'clone');
    assert.equal(calls[0].args.url, 'https://example.com/x.git');
    assert.equal(calls[0].args.depth, 1);
    assert.equal(calls[0].args.singleBranch, true);
    assert.equal(calls[0].args.dir, cache);
    assert.equal(calls[0].args.onAuth, undefined);
    assert.equal(calls[0].args.ref, undefined);
    const last = calls[calls.length - 1];
    assert.equal(last.op, 'resolveRef');
    assert.equal(last.args.ref, 'HEAD');
    assert.ok(!calls.some((c) => c.op === 'fetch'));
    assert.ok(!calls.some((c) => c.op === 'checkout'));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('fetchGit fetches and checks out when cache has .git', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  mkdirSync(path.join(cache, '.git'), { recursive: true });
  try {
    const { client, calls, sha } = makeMock();
    __setGitClient(client);

    const result = await fetchGit(
      { url: 'https://example.com/x.git', ref: 'develop', authToken: null },
      cache,
    );

    assert.equal(result.sha, sha);
    assert.equal(calls[0].op, 'fetch');
    assert.equal(calls[0].args.url, 'https://example.com/x.git');
    assert.equal(calls[0].args.ref, 'develop');
    assert.equal(calls[0].args.depth, 1);
    assert.equal(calls[0].args.singleBranch, true);

    const checkout = calls.find((c) => c.op === 'checkout');
    assert.ok(checkout, 'checkout should be called');
    assert.equal(checkout.args.ref, 'develop');
    assert.equal(checkout.args.force, true);

    assert.ok(!calls.some((c) => c.op === 'clone'));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('fetchGit returns the sha resolved from HEAD', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  rmSync(cache, { recursive: true, force: true });
  try {
    const expectedSha = '1234567890abcdef1234567890abcdef12345678';
    const { client } = makeMock({ sha: expectedSha });
    __setGitClient(client);

    const result = await fetchGit(
      { url: 'https://example.com/x.git', ref: null, authToken: null },
      cache,
    );

    assert.equal(result.sha, expectedSha);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('fetchGit auth: plaintext token produces onAuth with x-access-token', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  rmSync(cache, { recursive: true, force: true });
  try {
    const { client, calls } = makeMock();
    __setGitClient(client);

    await fetchGit(
      { url: 'https://example.com/x.git', ref: null, authToken: 'ghp_plaintexttoken' },
      cache,
    );

    const cloneCall = calls.find((c) => c.op === 'clone');
    assert.ok(cloneCall);
    const onAuth = cloneCall.args.onAuth as
      | undefined
      | (() => { username: string; password: string });
    assert.equal(typeof onAuth, 'function');
    const auth = onAuth!();
    assert.equal(auth.username, 'x-access-token');
    assert.equal(auth.password, 'ghp_plaintexttoken');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('fetchGit auth: encrypted blob is decrypted in onAuth', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  rmSync(cache, { recursive: true, force: true });
  try {
    const plaintext = 'secret-token-value';
    const blob = encrypt(plaintext);

    const { client, calls } = makeMock();
    __setGitClient(client);

    await fetchGit({ url: 'https://example.com/x.git', ref: null, authToken: blob }, cache);

    const cloneCall = calls.find((c) => c.op === 'clone');
    assert.ok(cloneCall);
    const onAuth = cloneCall.args.onAuth as
      | undefined
      | (() => { username: string; password: string });
    assert.equal(typeof onAuth, 'function');
    const auth = onAuth!();
    assert.equal(auth.username, 'x-access-token');
    assert.equal(auth.password, plaintext);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('fetchGit propagates errors from clone', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  rmSync(cache, { recursive: true, force: true });
  try {
    const { client } = makeMock({ cloneThrows: new Error('boom') });
    __setGitClient(client);

    await assert.rejects(
      fetchGit({ url: 'https://example.com/x.git', ref: null, authToken: null }, cache),
      /boom/,
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('fetchGit reclones when in-place update fails (Windows self-heal)', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  mkdirSync(path.join(cache, '.git'), { recursive: true });
  try {
    const { client, calls, sha } = makeMock({ fetchThrows: new Error('CheckoutConflictError') });
    __setGitClient(client);

    const result = await fetchGit(
      { url: 'https://example.com/x.git', ref: null, authToken: null },
      cache,
    );

    // fetch was attempted, threw, then the cache was reclone'd from scratch.
    assert.ok(calls.some((c) => c.op === 'fetch'));
    assert.ok(calls.some((c) => c.op === 'clone'));
    assert.equal(result.sha, sha);
    assert.equal(result.root, cache);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('fetchGit on existing cache with ref:null uses currentBranch for checkout', async () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'plug-cache-'));
  mkdirSync(path.join(cache, '.git'), { recursive: true });
  const { client, calls } = makeMock();
  __setGitClient(client);
  await fetchGit({ url: 'https://example/x.git', ref: null, authToken: null }, cache);
  assert.equal(
    calls.find((c) => c.op === 'clone'),
    undefined,
  );
  assert.ok(calls.some((c) => c.op === 'fetch'));
  const cb = calls.find((c) => c.op === 'currentBranch');
  assert.ok(cb, 'currentBranch should be queried when ref is null on update');
  const co = calls.find((c) => c.op === 'checkout');
  assert.ok(co);
  assert.equal(co.args.ref, 'main');
  rmSync(cache, { recursive: true, force: true });
});
