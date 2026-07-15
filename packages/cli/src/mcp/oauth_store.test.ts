process.env.CARETAKER_HOME = `/tmp/ct-oauth-store-${process.pid}`;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEncrypted } from '../lib/encryption.js';
import { readOAuthBlob, writeOAuthBlob } from './oauth_store.js';
import type { McpServerConfig } from '../types.js';

const base: McpServerConfig = {
  id: 'srv1',
  name: 'gitlab',
  transport: 'http',
  enabled: true,
  url: 'https://example.com/mcp',
};

test('writeOAuthBlob produces an encrypted string', () => {
  const enc = writeOAuthBlob({ tokens: { access_token: 'secret-abc', token_type: 'bearer' } });
  assert.equal(isEncrypted(enc), true);
  assert.equal(enc.includes('secret-abc'), false);
});

test('readOAuthBlob round-trips through oauthState', () => {
  const oauthState = writeOAuthBlob({
    clientInformation: { client_id: 'cid', redirect_uris: ['http://127.0.0.1:1/callback'] } as never,
    tokens: { access_token: 'tok', token_type: 'bearer', refresh_token: 'r' },
  });
  const blob = readOAuthBlob({ ...base, oauthState });
  assert.equal(blob.tokens?.access_token, 'tok');
  assert.equal(blob.tokens?.refresh_token, 'r');
  assert.equal(blob.clientInformation?.client_id, 'cid');
});

test('readOAuthBlob returns {} when no oauthState', () => {
  assert.deepEqual(readOAuthBlob(base), {});
});
