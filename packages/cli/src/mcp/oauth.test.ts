process.env.CARETAKER_HOME = `/tmp/ct-oauth-${process.pid}`;

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMcpServers, saveMcpServers } from '../store/json.js';
import { readOAuthBlob } from './oauth_store.js';
import { StoredOAuthProvider, revokeMcpAuth } from './oauth.js';

beforeEach(async () => {
  await saveMcpServers({
    servers: [{ id: 's1', name: 'gl', transport: 'http', enabled: true, url: 'https://x/mcp' }],
  });
});

test('saveTokens persists an encrypted blob and tokens() reads it back', async () => {
  const p = new StoredOAuthProvider('s1', 'http://127.0.0.1:1/callback');
  await p.saveTokens({ access_token: 'at', token_type: 'bearer', refresh_token: 'rt' });

  const file = await loadMcpServers();
  const row = file.servers.find((s) => s.id === 's1')!;
  assert.ok(row.oauthState && !row.oauthState.includes('at')); // encrypted
  assert.equal(readOAuthBlob(row).tokens?.access_token, 'at');
  assert.equal((await p.tokens())?.refresh_token, 'rt');
});

test('saveClientInformation persists and clientInformation() reads it back', async () => {
  const p = new StoredOAuthProvider('s1', 'http://127.0.0.1:1/callback');
  await p.saveClientInformation({ client_id: 'cid', redirect_uris: ['http://127.0.0.1:1/callback'] } as never);
  assert.equal((await p.clientInformation())?.client_id, 'cid');
});

test('code verifier is in-memory only', async () => {
  const p = new StoredOAuthProvider('s1', 'http://127.0.0.1:1/callback');
  await p.saveCodeVerifier('verifier-123');
  assert.equal(await p.codeVerifier(), 'verifier-123');
  const file = await loadMcpServers();
  assert.equal(JSON.stringify(file).includes('verifier-123'), false);
});

test('revokeMcpAuth clears oauthState', async () => {
  const p = new StoredOAuthProvider('s1', 'http://127.0.0.1:1/callback');
  await p.saveTokens({ access_token: 'at', token_type: 'bearer' });
  await revokeMcpAuth('s1');
  const file = await loadMcpServers();
  assert.equal(file.servers.find((s) => s.id === 's1')!.oauthState, undefined);
});
