import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { loadAgents, loadConfig, saveConfig } from '../store/json.js';
import type { ProviderConfig } from '../types.js';

type Mode = 'list' | 'detail' | 'create' | 'edit' | 'delete';

export default function Providers({ onBack }: { onBack: () => void }) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<ProviderConfig | null>(null);
  const [agentDeps, setAgentDeps] = useState<number>(0);

  useEffect(() => {
    void loadConfig().then((c) => {
      setProviders(c.providers);
      setLoaded(true);
    });
  }, []);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (mode === 'list') onBack();
    else if (mode === 'detail') setMode('list');
    else if (mode === 'delete') setMode('detail');
    // create/edit: handled by ProviderForm
  });

  if (!loaded) return <Text dimColor>loading…</Text>;

  if (mode === 'create') {
    return (
      <ProviderForm
        existingNames={providers.map((p) => p.name)}
        onCancel={() => setMode('list')}
        onSave={async (p) => {
          const c = await loadConfig();
          c.providers = [...c.providers, p];
          await saveConfig(c);
          setProviders(c.providers);
          setMode('list');
        }}
      />
    );
  }

  if (mode === 'edit' && selected) {
    return (
      <ProviderForm
        existingNames={providers.map((p) => p.name)}
        initial={selected}
        onCancel={() => setMode('detail')}
        onSave={async (p) => {
          const c = await loadConfig();
          c.providers = c.providers.map((x) => (x.name === p.name ? p : x));
          await saveConfig(c);
          setProviders(c.providers);
          setSelected(p);
          setMode('detail');
        }}
      />
    );
  }

  if (mode === 'delete' && selected) {
    if (agentDeps > 0) {
      return (
        <Box flexDirection="column">
          <Text bold>Cannot delete "{selected.name}"</Text>
          <Text color="red">
            {agentDeps} agent{agentDeps === 1 ? '' : 's'} reference this provider.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={[{ label: '← Back', value: 'back' }]}
              onSelect={() => setMode('detail')}
            />
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text>Delete provider "{selected.name}"?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'No, cancel', value: 'no' },
              { label: 'Yes, delete', value: 'yes' },
            ]}
            onSelect={async (item) => {
              if (item.value === 'no') return setMode('detail');
              const c = await loadConfig();
              c.providers = c.providers.filter((x) => x.name !== selected.name);
              await saveConfig(c);
              setProviders(c.providers);
              setSelected(null);
              setMode('list');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'detail' && selected) {
    const isClaudeCode = selected.type === 'claude-code';
    return (
      <Box flexDirection="column">
        <Text bold>{selected.name}</Text>
        {isClaudeCode ? (
          <>
            <Text>type: claude-code</Text>
            <Text>command: {selected.command || '(default: claude on PATH)'}</Text>
          </>
        ) : (
          <>
            <Text>endpoint: {selected.endpoint}</Text>
            <Text>apiKey: {selected.apiKey ? '(set)' : '(none)'}</Text>
          </>
        )}
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'Edit', value: 'edit' },
              { label: 'Delete', value: 'delete' },
              { label: '← Back', value: 'back' },
            ]}
            onSelect={async (item) => {
              if (item.value === 'edit') return setMode('edit');
              if (item.value === 'delete') {
                const agents = await loadAgents();
                setAgentDeps(agents.filter((a) => a.provider === selected.name).length);
                return setMode('delete');
              }
              setMode('list');
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>(esc to go back)</Text>
        </Box>
      </Box>
    );
  }

  const items = [
    ...providers.map((p) => ({
      label:
        p.type === 'claude-code'
          ? `${p.name}  —  Claude Code (local CLI)${p.command ? `  —  ${p.command}` : ''}`
          : `${p.name}  —  ${p.endpoint}`,
      value: `p:${p.name}`,
    })),
    { label: '+ Create new', value: '__new__' },
    { label: '← Back', value: '__back__' },
  ];

  return (
    <Box flexDirection="column">
      <Text bold>Providers ({providers.length})</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === '__back__') return onBack();
            if (item.value === '__new__') return setMode('create');
            const name = item.value.replace(/^p:/, '');
            const p = providers.find((x) => x.name === name);
            if (p) {
              setSelected(p);
              setMode('detail');
            }
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>(esc to go back)</Text>
      </Box>
    </Box>
  );
}

type FormStep = 'type' | 'name' | 'endpoint' | 'apiKey' | 'command';
type ProviderType = 'openai' | 'claude-code';

function ProviderForm({
  existingNames,
  initial,
  onSave,
  onCancel,
}: {
  existingNames: string[];
  initial?: ProviderConfig;
  onSave: (p: ProviderConfig) => void | Promise<void>;
  onCancel: () => void;
}) {
  const isEdit = !!initial;
  // Editing an existing provider keeps its type fixed — agents reference
  // providers by name, so switching type out from under them is a footgun
  // (same rationale as the webview form).
  const [type, setType] = useState<ProviderType>(initial?.type ?? 'openai');
  const [step, setStep] = useState<FormStep>(
    isEdit ? (type === 'claude-code' ? 'command' : 'endpoint') : 'type',
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const finalize = () => {
    if (type === 'claude-code') {
      const p: ProviderConfig = { name: name.trim(), type: 'claude-code', endpoint: '' };
      if (command.trim()) p.command = command.trim();
      void onSave(p);
      return;
    }
    const p: ProviderConfig = { name: name.trim(), endpoint: endpoint.trim() };
    if (apiKey.trim()) p.apiKey = apiKey.trim();
    void onSave(p);
  };

  const submit = () => {
    if (step === 'type') {
      setError(null);
      setStep('name');
    } else if (step === 'name') {
      const v = name.trim();
      if (!v) return setError('name is required');
      if (existingNames.includes(v)) return setError('name already exists');
      setError(null);
      setStep(type === 'claude-code' ? 'command' : 'endpoint');
    } else if (step === 'endpoint') {
      const v = endpoint.trim();
      if (!v) return setError('endpoint is required');
      setError(null);
      setStep('apiKey');
    } else if (step === 'command') {
      setError(null);
      finalize();
    } else {
      finalize();
    }
  };

  const stepOrder: FormStep[] =
    type === 'claude-code' ? ['type', 'name', 'command'] : ['type', 'name', 'endpoint', 'apiKey'];
  const currentIdx = stepOrder.indexOf(step);
  const isPending = (s: FormStep) => stepOrder.indexOf(s) > currentIdx;

  return (
    <Box flexDirection="column">
      <Text bold>{isEdit ? `Edit provider "${initial!.name}"` : 'New provider'}</Text>
      <Box marginTop={1}>
        <Text>type: </Text>
        {!isEdit && step === 'type' ? (
          <SelectInput
            items={[
              { label: 'OpenAI-compatible endpoint', value: 'openai' },
              { label: 'Claude Code (local CLI)', value: 'claude-code' },
            ]}
            initialIndex={type === 'claude-code' ? 1 : 0}
            onSelect={(item) => {
              setType(item.value as ProviderType);
              setError(null);
              setStep('name');
            }}
          />
        ) : (
          <Text>
            {type === 'claude-code' ? 'Claude Code (local CLI)' : 'OpenAI-compatible endpoint'}
          </Text>
        )}
      </Box>
      <Box>
        <Text>name: </Text>
        {!isEdit && step === 'name' ? (
          <TextInput value={name} onChange={setName} onSubmit={submit} />
        ) : isPending('name') ? (
          <Text dimColor>(pending)</Text>
        ) : (
          <Text>{name}</Text>
        )}
      </Box>
      {type === 'claude-code' ? (
        <>
          <Box>
            <Text>command: </Text>
            {step === 'command' ? (
              <TextInput
                value={command}
                onChange={setCommand}
                onSubmit={submit}
                placeholder="claude (default: resolved from PATH)"
              />
            ) : isPending('command') ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>{command || '(default: claude on PATH)'}</Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Uses your local Claude Code session; Anthropic may bill programmatic use as extra
              usage.
            </Text>
          </Box>
        </>
      ) : (
        <>
          <Box>
            <Text>endpoint: </Text>
            {step === 'endpoint' ? (
              <TextInput
                value={endpoint}
                onChange={setEndpoint}
                onSubmit={submit}
                placeholder="https://api.openai.com"
              />
            ) : isPending('endpoint') ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>{endpoint}</Text>
            )}
          </Box>
          <Box>
            <Text>apiKey: </Text>
            {step === 'apiKey' ? (
              <TextInput
                value={apiKey}
                onChange={setApiKey}
                onSubmit={submit}
                placeholder={isEdit ? '(enter to keep current)' : '(optional, enter to skip)'}
                mask="*"
              />
            ) : isPending('apiKey') ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>{apiKey ? '(set)' : '(none)'}</Text>
            )}
          </Box>
        </>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>(esc to cancel)</Text>
      </Box>
    </Box>
  );
}
