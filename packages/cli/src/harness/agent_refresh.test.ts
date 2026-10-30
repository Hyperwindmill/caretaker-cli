import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refreshAgentRuntime } from './agent_refresh.js';
import type { AgentConfig, ProviderConfig } from '../types.js';

const oldProv = { name: 'old', type: 'openai', endpoint: 'http://old', apiKey: '' } as ProviderConfig;
const newProv = { name: 'new', type: 'openai', endpoint: 'http://new', apiKey: '' } as ProviderConfig;
const agent = {
  id: 'a1',
  name: 'A',
  provider: 'old',
  model: 'm-old',
  allowedTools: ['read_file'],
} as AgentConfig;

describe('refreshAgentRuntime', () => {
  it('re-resolves the provider when the agent switches provider and model', () => {
    const r = refreshAgentRuntime(
      { agent, provider: oldProv },
      { ...agent, provider: 'new', model: 'm-new' },
      [oldProv, newProv],
    );
    assert.ok(r.ok);
    assert.equal(r.provider, newProv);
    assert.equal(r.agent.model, 'm-new');
    assert.equal(r.changed, true);
    assert.equal(r.toolsChanged, false);
  });

  it('reports changed when only the provider config was edited', () => {
    const edited = { ...oldProv, endpoint: 'http://moved' };
    const r = refreshAgentRuntime({ agent, provider: oldProv }, { ...agent }, [edited]);
    assert.ok(r.ok);
    assert.equal(r.provider, edited);
    assert.equal(r.changed, true);
  });

  it('reports nothing changed for an identical reload', () => {
    const r = refreshAgentRuntime({ agent, provider: oldProv }, { ...agent }, [{ ...oldProv }]);
    assert.ok(r.ok);
    assert.equal(r.changed, false);
    assert.equal(r.toolsChanged, false);
  });

  it('flags tool changes', () => {
    const r = refreshAgentRuntime(
      { agent, provider: oldProv },
      { ...agent, allowedTools: ['read_file', 'bash'] },
      [oldProv],
    );
    assert.ok(r.ok);
    assert.equal(r.toolsChanged, true);
    assert.equal(r.changed, true);
  });

  it('errors when the new provider is missing', () => {
    const r = refreshAgentRuntime({ agent, provider: oldProv }, { ...agent, provider: 'gone' }, [oldProv]);
    assert.equal(r.ok, false);
  });
});
