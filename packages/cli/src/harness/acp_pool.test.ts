import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agent, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  acquireAcpAgent,
  releaseAcpAgent,
  __setConnector,
  __resetConnector,
  __shutdownAcpPool,
} from './acp_pool.js';
import type { ProviderConfig } from '../types.js';

const provider: ProviderConfig = { name: 'acp', type: 'acp', endpoint: '', command: 'fake' };

function fakeAgentApp() {
  return agent({ name: 'fake' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    }))
    .onRequest('session/new', () => ({ sessionId: 'acp-1' }));
}

/** In-process connector: ClientApp.connect(AgentApp) needs no transport. */
function useFakeAgent(app = fakeAgentApp()) {
  let killed = 0;
  __setConnector((_provider, clientApp) => {
    const conn = clientApp.connect(app);
    return { conn, kill: () => { killed += 1; conn.close(); } };
  });
  return { killedCount: () => killed };
}

afterEach(() => {
  __shutdownAcpPool();
  __resetConnector();
});

test('acquire initializes and pools by key; second acquire reuses', async () => {
  useFakeAgent();
  const h1 = await acquireAcpAgent(provider, 'ag1:sess1');
  assert.equal(h1.init.agentCapabilities?.loadSession, true);
  releaseAcpAgent('ag1:sess1', h1);
  const h2 = await acquireAcpAgent(provider, 'ag1:sess1');
  assert.equal(h2, h1); // same handle object
});

test('ephemeral acquire (null key) is killed on release', async () => {
  const fake = useFakeAgent();
  const h = await acquireAcpAgent(provider, null);
  releaseAcpAgent(null, h);
  assert.equal(fake.killedCount(), 1);
});

test('a closed connection is discarded and re-created on next acquire', async () => {
  useFakeAgent();
  const h1 = await acquireAcpAgent(provider, 'k');
  releaseAcpAgent('k', h1);
  h1.conn.close();
  await h1.conn.closed;
  const h2 = await acquireAcpAgent(provider, 'k');
  assert.notEqual(h2, h1);
});

test('missing command errors with a readable message', async () => {
  __resetConnector();
  await assert.rejects(
    () => acquireAcpAgent({ name: 'x', type: 'acp', endpoint: '' }, null),
    /provider "x".*command/i,
  );
});
