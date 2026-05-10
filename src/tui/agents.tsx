import { useEffect, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { loadAgents, loadConfig, saveAgents } from '../store/json.js';
import { fetchOpenAiStyleModels } from '../harness/models.js';
import { tools as toolRegistry } from '../harness/tools/instance.js';
import type { Tool } from '../harness/tools/index.js';
import { listPlugins as listDiscoveredPlugins } from '../plugins/source_manager.js';
import { listMcpServers } from '../mcp/server_manager.js';
import type { McpServerConfig, PluginRecord } from '../types.js';
import { deleteSession, listForAgent, type SessionListEntry } from '../session/store.js';
import type { SessionMetaRecord } from '../session/types.js';
import ChatScreen from './chat.js';
import {
  applyToolState,
  cycleToolState,
  formatToolsForDetail,
  getToolState,
} from './tool_picker_state.js';
import type { AgentConfig, ProviderConfig } from '../types.js';

type Mode =
  | 'list'
  | 'detail'
  | 'create'
  | 'edit'
  | 'delete'
  | 'chat'
  | 'past-chats'
  | 'session-detail'
  | 'session-delete';

export default function Agents({ onBack }: { onBack: () => void }) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<AgentConfig | null>(null);
  const [pastSessions, setPastSessions] = useState<SessionListEntry[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionMetaRecord | null>(null);

  useEffect(() => {
    void Promise.all([loadAgents(), loadConfig()]).then(([a, c]) => {
      setAgents(a);
      setProviders(c.providers);
      setLoaded(true);
    });
  }, []);

  // Refresh past-chats list whenever we enter or return to the agent detail.
  const selectedId = selected?.id;
  useEffect(() => {
    if (mode === 'detail' && selectedId) {
      void listForAgent(selectedId).then(setPastSessions);
    }
  }, [mode, selectedId]);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (mode === 'list') onBack();
    else if (mode === 'detail') setMode('list');
    else if (mode === 'delete') setMode('detail');
    else if (mode === 'past-chats') setMode('detail');
    else if (mode === 'session-detail') {
      setSelectedSession(null);
      setMode('past-chats');
    } else if (mode === 'session-delete') setMode('session-detail');
    // create/edit: AgentForm; chat: ChatScreen — both have their own ESC.
  });

  if (!loaded) return <Text dimColor>loading…</Text>;

  if (mode === 'create' || mode === 'edit') {
    if (providers.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">No providers configured. Create a provider first.</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[{ label: '← Back', value: 'back' }]}
              onSelect={() => setMode('list')}
            />
          </Box>
        </Box>
      );
    }
    const isEdit = mode === 'edit';
    return (
      <AgentForm
        providers={providers}
        existingNames={agents.filter((a) => a.id !== selected?.id).map((a) => a.name)}
        initial={isEdit ? (selected ?? undefined) : undefined}
        onCancel={() => setMode(isEdit ? 'detail' : 'list')}
        onSave={async (a) => {
          let next: AgentConfig[];
          if (isEdit) {
            next = agents.map((x) => (x.id === a.id ? a : x));
          } else {
            next = [...agents, a];
          }
          await saveAgents(next);
          setAgents(next);
          if (isEdit) {
            setSelected(a);
            setMode('detail');
          } else {
            setMode('list');
          }
        }}
      />
    );
  }

  if (mode === 'chat' && selected) {
    const provider = providers.find((p) => p.name === selected.provider);
    if (!provider) {
      return (
        <Box flexDirection="column">
          <Text color="red">Provider "{selected.provider}" not found.</Text>
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
      <ChatScreen
        agent={selected}
        provider={provider}
        initialSession={selectedSession}
        onBack={() => {
          const cameFromPast = !!selectedSession;
          setSelectedSession(null);
          if (cameFromPast) {
            setMode('past-chats');
            void listForAgent(selected.id).then(setPastSessions);
          } else {
            setMode('detail');
          }
        }}
      />
    );
  }

  if (mode === 'session-detail' && selected && selectedSession) {
    const entry = pastSessions.find((e) => e.meta.id === selectedSession.id);
    return (
      <Box flexDirection="column">
        <Text bold>{selectedSession.title}</Text>
        {entry && <Text dimColor>last updated {formatRelative(entry.updatedAt)}</Text>}
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'Load', value: 'load' },
              { label: 'Delete', value: 'delete' },
              { label: '← Back', value: 'back' },
            ]}
            onSelect={(item) => {
              if (item.value === 'load') return setMode('chat');
              if (item.value === 'delete') return setMode('session-delete');
              setSelectedSession(null);
              setMode('past-chats');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'session-delete' && selected && selectedSession) {
    const targetId = selectedSession.id;
    const targetAgentId = selectedSession.agentId;
    return (
      <Box flexDirection="column">
        <Text>Delete chat "{selectedSession.title}"?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'No, cancel', value: 'no' },
              { label: 'Yes, delete', value: 'yes' },
            ]}
            onSelect={async (item) => {
              if (item.value === 'no') return setMode('session-detail');
              await deleteSession(targetAgentId, targetId);
              const fresh = await listForAgent(selected.id);
              setPastSessions(fresh);
              setSelectedSession(null);
              setMode(fresh.length > 0 ? 'past-chats' : 'detail');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'past-chats' && selected) {
    if (pastSessions.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No past chats for "{selected.name}".</Text>
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
        <Text bold>
          Past chats — {selected.name} ({pastSessions.length})
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              ...pastSessions.map((s) => ({
                label: `${s.meta.title}  —  ${formatRelative(s.updatedAt)}`,
                value: `s:${s.meta.id}`,
              })),
              { label: '← Back', value: '__back__' },
            ]}
            onSelect={(item) => {
              if (item.value === '__back__') return setMode('detail');
              const id = item.value.replace(/^s:/, '');
              const entry = pastSessions.find((x) => x.meta.id === id);
              if (entry) {
                setSelectedSession(entry.meta);
                setMode('session-detail');
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

  if (mode === 'delete' && selected) {
    return (
      <Box flexDirection="column">
        <Text>Delete agent "{selected.name}"?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'No, cancel', value: 'no' },
              { label: 'Yes, delete', value: 'yes' },
            ]}
            onSelect={async (item) => {
              if (item.value === 'no') return setMode('detail');
              const next = agents.filter((x) => x.id !== selected.id);
              await saveAgents(next);
              setAgents(next);
              setSelected(null);
              setMode('list');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'detail' && selected) {
    const managed = !!selected.pluginId;
    return (
      <Box flexDirection="column">
        <Text bold>{selected.name}</Text>
        {managed && (
          <Text color="cyan">
            [managed by plugin · name + system prompt come from the manifest]
          </Text>
        )}
        <Text>provider: {selected.provider}</Text>
        <Text>model: {selected.model}</Text>
        <Text>maxTurns: {selected.maxTurns === 0 ? 'unlimited' : selected.maxTurns}</Text>
        <Text>
          tools:{' '}
          {selected.allowedTools.length === 0
            ? '(none)'
            : formatToolsForDetail(selected.allowedTools, selected.confirmTools ?? [])}
        </Text>
        <Text>
          plugins: {(selected.plugins ?? []).length === 0 ? '(none)' : selected.plugins!.join(', ')}
        </Text>
        <Text>
          mcp: {(selected.mcpServers ?? []).length === 0 ? '(none)' : selected.mcpServers!.length}{' '}
          server(s)
        </Text>
        <Text>workDir: {selected.workingDir || '(cwd)'}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>system prompt:</Text>
          <Text>{selected.systemPrompt || '(empty)'}</Text>
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'New chat', value: 'new-chat' },
              ...(pastSessions.length > 0
                ? [{ label: `Past chats (${pastSessions.length})`, value: 'past-chats' }]
                : []),
              { label: 'Edit', value: 'edit' },
              ...(managed ? [] : [{ label: 'Delete', value: 'delete' }]),
              { label: '← Back', value: 'back' },
            ]}
            onSelect={(item) => {
              if (item.value === 'new-chat') {
                setSelectedSession(null);
                return setMode('chat');
              }
              if (item.value === 'past-chats') return setMode('past-chats');
              if (item.value === 'edit') return setMode('edit');
              if (item.value === 'delete') return setMode('delete');
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
    ...agents.map((a) => {
      const flag = a.pluginId ? ' [managed]' : '';
      return {
        label: `${a.name}  —  ${a.model} via ${a.provider}${flag}`,
        value: `a:${a.id}`,
      };
    }),
    { label: '+ Create new', value: '__new__' },
    { label: '← Back', value: '__back__' },
  ];

  return (
    <Box flexDirection="column">
      <Text bold>Agents ({agents.length})</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === '__back__') return onBack();
            if (item.value === '__new__') return setMode('create');
            const id = item.value.replace(/^a:/, '');
            const a = agents.find((x) => x.id === id);
            if (a) {
              setSelected(a);
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

type FormStep =
  | 'name'
  | 'provider'
  | 'model'
  | 'systemPrompt'
  | 'tools'
  | 'plugins'
  | 'mcpServers'
  | 'workingDir'
  | 'maxTurns';

function AgentForm({
  providers,
  existingNames,
  initial,
  onSave,
  onCancel,
}: {
  providers: ProviderConfig[];
  existingNames: string[];
  initial?: AgentConfig;
  onSave: (a: AgentConfig) => void | Promise<void>;
  onCancel: () => void;
}) {
  const isEdit = !!initial;
  const managed = !!initial?.pluginId;
  // Managed agents: skip the name step (locked to manifest) and start at
  // provider. systemPrompt is locked too — handled in advance() below.
  const [step, setStep] = useState<FormStep>(managed ? 'provider' : 'name');
  const [name, setName] = useState(initial?.name ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [allowedTools, setAllowedTools] = useState<string[]>(initial?.allowedTools ?? []);
  const [confirmTools, setConfirmTools] = useState<string[]>(initial?.confirmTools ?? []);
  const [activePlugins, setActivePlugins] = useState<string[]>(initial?.plugins ?? []);
  const [discoveredPlugins, setDiscoveredPlugins] = useState<PluginRecord[]>([]);
  const [activeMcp, setActiveMcp] = useState<string[]>(initial?.mcpServers ?? []);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [workingDir, setWorkingDir] = useState(initial?.workingDir ?? '');
  const [maxTurns, setMaxTurns] = useState(String(initial?.maxTurns ?? 30));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listDiscoveredPlugins().then(setDiscoveredPlugins);
    void listMcpServers().then(setMcpServers);
  }, []);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const advance = () => {
    if (step === 'name') {
      const v = name.trim();
      if (!v) return setError('name is required');
      if (existingNames.includes(v)) return setError('name already exists');
      setError(null);
      setStep('provider');
    } else if (step === 'systemPrompt') {
      setError(null);
      setStep('tools');
    } else if (step === 'model' && managed) {
      // Managed agents skip the systemPrompt step — manifest-owned.
      setError(null);
      setStep('tools');
    } else if (step === 'tools') {
      setError(null);
      setStep('plugins');
    } else if (step === 'plugins') {
      setError(null);
      setStep('mcpServers');
    } else if (step === 'mcpServers') {
      setError(null);
      setStep('workingDir');
    } else if (step === 'workingDir') {
      const v = workingDir.trim();
      if (v && !isAbsolute(v))
        return setError('workingDir must be an absolute path (or empty for cwd)');
      setError(null);
      setStep('maxTurns');
    } else if (step === 'maxTurns') {
      const n = Number.parseInt(maxTurns.trim(), 10);
      if (!Number.isFinite(n) || n < 0)
        return setError('maxTurns must be a non-negative integer (0 = unlimited)');
      const a: AgentConfig = {
        id: initial?.id ?? randomUUID(),
        name: name.trim(),
        systemPrompt: systemPrompt.trim(),
        provider,
        model: model.trim(),
        allowedTools,
        maxTurns: n,
        ...(confirmTools.length > 0 ? { confirmTools } : {}),
        ...(activePlugins.length > 0 ? { plugins: activePlugins } : {}),
        ...(activeMcp.length > 0 ? { mcpServers: activeMcp } : {}),
        ...(workingDir.trim() ? { workingDir: workingDir.trim() } : {}),
        // Preserve plugin-managed origin tags so the next sync recognizes
        // this row instead of orphaning it.
        ...(initial?.pluginId ? { pluginId: initial.pluginId } : {}),
        ...(initial?.pluginScopedName ? { pluginScopedName: initial.pluginScopedName } : {}),
      };
      void onSave(a);
    }
  };

  const providerInitialIndex = Math.max(
    0,
    providers.findIndex((p) => p.name === provider),
  );

  return (
    <Box flexDirection="column">
      <Text bold>{isEdit ? `Edit agent "${initial!.name}"` : 'New agent'}</Text>

      <Box marginTop={1}>
        <Text>name: </Text>
        {managed ? (
          <Text>
            <Text>{name}</Text>
            <Text dimColor>{'  (managed by plugin)'}</Text>
          </Text>
        ) : step === 'name' ? (
          <TextInput value={name} onChange={setName} onSubmit={advance} />
        ) : (
          <Text>{name}</Text>
        )}
      </Box>

      <Box>
        <Text>provider: </Text>
        {step === 'provider' ? (
          <Box flexDirection="column">
            <SelectInput
              items={providers.map((p) => ({ label: p.name, value: p.name }))}
              initialIndex={providerInitialIndex}
              onSelect={(item) => {
                setProvider(item.value);
                setStep('model');
              }}
            />
          </Box>
        ) : step === 'name' ? (
          <Text dimColor>(pending)</Text>
        ) : (
          <Text>{provider}</Text>
        )}
      </Box>

      <Box>
        <Text>model: </Text>
        {step === 'model' ? (
          <ModelStep
            provider={providers.find((p) => p.name === provider)!}
            initialModel={model || undefined}
            onPick={(id) => {
              setModel(id);
              setError(null);
              // Managed agents lock the systemPrompt — jump straight to tools.
              setStep(managed ? 'tools' : 'systemPrompt');
            }}
          />
        ) : ['name', 'provider'].includes(step) ? (
          <Text dimColor>(pending)</Text>
        ) : (
          <Text>{model}</Text>
        )}
      </Box>

      <Box>
        <Text>prompt: </Text>
        {managed ? (
          <Text>
            <Text>
              {(systemPrompt || '(empty)').slice(0, 80)}
              {systemPrompt.length > 80 ? '…' : ''}
            </Text>
            <Text dimColor>{'  (managed by plugin)'}</Text>
          </Text>
        ) : step === 'systemPrompt' ? (
          <TextInput
            value={systemPrompt}
            onChange={setSystemPrompt}
            onSubmit={advance}
            placeholder={isEdit ? '(enter to keep current)' : '(optional system prompt)'}
          />
        ) : ['name', 'provider', 'model'].includes(step) ? (
          <Text dimColor>(pending)</Text>
        ) : (
          <Text>{systemPrompt || '(empty)'}</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text>tools:</Text>
        {step === 'tools' ? (
          <ToolPicker
            tools={toolRegistry.list()}
            allowed={allowedTools}
            confirm={confirmTools}
            onChange={(a, c) => {
              setAllowedTools(a);
              setConfirmTools(c);
            }}
            onSubmit={advance}
          />
        ) : ['name', 'provider', 'model', 'systemPrompt'].includes(step) ? (
          <Text dimColor> (pending)</Text>
        ) : (
          <Text>{`  ${allowedTools.length === 0 ? '(none)' : formatToolsForDetail(allowedTools, confirmTools)}`}</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text>plugins:</Text>
        {step === 'plugins' ? (
          <PluginPicker
            plugins={discoveredPlugins}
            value={activePlugins}
            onChange={setActivePlugins}
            onSubmit={advance}
          />
        ) : ['name', 'provider', 'model', 'systemPrompt', 'tools'].includes(step) ? (
          <Text dimColor> (pending)</Text>
        ) : (
          <Text>{`  ${activePlugins.length === 0 ? '(none)' : activePlugins.join(', ')}`}</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text>mcp:</Text>
        {step === 'mcpServers' ? (
          <McpPicker
            servers={mcpServers}
            value={activeMcp}
            onChange={setActiveMcp}
            onSubmit={advance}
          />
        ) : ['name', 'provider', 'model', 'systemPrompt', 'tools', 'plugins'].includes(step) ? (
          <Text dimColor> (pending)</Text>
        ) : (
          <Text>
            {`  ${
              activeMcp.length === 0
                ? '(none)'
                : activeMcp.map((id) => mcpServers.find((s) => s.id === id)?.name ?? id).join(', ')
            }`}
          </Text>
        )}
      </Box>

      <Box>
        <Text>workDir: </Text>
        {step === 'workingDir' ? (
          <TextInput
            value={workingDir}
            onChange={setWorkingDir}
            onSubmit={advance}
            placeholder="(empty = process.cwd() — absolute path otherwise)"
          />
        ) : [
            'name',
            'provider',
            'model',
            'systemPrompt',
            'tools',
            'plugins',
            'mcpServers',
          ].includes(step) ? (
          <Text dimColor>(pending)</Text>
        ) : (
          <Text>{workingDir.trim() || '(cwd)'}</Text>
        )}
      </Box>

      <Box>
        <Text>maxTurns: </Text>
        {step === 'maxTurns' ? (
          <TextInput
            value={maxTurns}
            onChange={setMaxTurns}
            onSubmit={advance}
            placeholder="0 = unlimited"
          />
        ) : (
          <Text dimColor>(pending)</Text>
        )}
      </Box>

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

type ModelStepState =
  | { mode: 'loading' }
  | { mode: 'select'; ids: string[] }
  | { mode: 'manual'; reason: string | null };

function ModelStep({
  provider,
  initialModel,
  onPick,
}: {
  provider: ProviderConfig;
  initialModel?: string;
  onPick: (id: string) => void;
}) {
  const [state, setState] = useState<ModelStepState>({ mode: 'loading' });
  const [manualValue, setManualValue] = useState(initialModel ?? '');

  useEffect(() => {
    let cancelled = false;
    void fetchOpenAiStyleModels(provider.endpoint, provider.apiKey ?? null).then((res) => {
      if (cancelled) return;
      if (res.ok && res.ids.length > 0) {
        setState({ mode: 'select', ids: res.ids.sort() });
      } else if (res.ok) {
        setState({ mode: 'manual', reason: 'provider returned an empty list' });
      } else {
        setState({ mode: 'manual', reason: res.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [provider.endpoint, provider.apiKey]);

  if (state.mode === 'loading') {
    return <Text dimColor>fetching models from {provider.name}…</Text>;
  }

  if (state.mode === 'manual') {
    return (
      <Box flexDirection="column">
        <TextInput
          value={manualValue}
          onChange={setManualValue}
          onSubmit={() => {
            const v = manualValue.trim();
            if (v) onPick(v);
          }}
          placeholder="e.g. gpt-4o-mini"
        />
        {state.reason && (
          <Text dimColor color="yellow">
            {state.reason.slice(0, 200)}
          </Text>
        )}
      </Box>
    );
  }

  const items = [
    ...state.ids.map((id) => ({ label: id, value: `m:${id}` })),
    { label: '✏ enter manually', value: '__manual__' },
  ];
  const initialIndex = initialModel ? Math.max(0, state.ids.indexOf(initialModel)) : 0;

  return (
    <SelectInput
      items={items}
      initialIndex={initialIndex}
      onSelect={(item) => {
        if (item.value === '__manual__') {
          setState({ mode: 'manual', reason: null });
          return;
        }
        onPick(item.value.replace(/^m:/, ''));
      }}
    />
  );
}

function ToolPicker({
  tools,
  allowed,
  confirm,
  onChange,
  onSubmit,
}: {
  tools: Tool[];
  allowed: string[];
  confirm: string[];
  onChange: (allowed: string[], confirm: string[]) => void;
  onSubmit: () => void;
}) {
  const [hl, setHl] = useState(0);

  // Auto-skip when nothing to pick. Intentionally fires only when the list size changes,
  // not on every onSubmit identity change from the parent.
  useEffect(() => {
    if (tools.length === 0) onSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools.length]);

  useInput((input, key) => {
    if (tools.length === 0) return;
    if (key.upArrow) {
      setHl((h) => Math.max(0, h - 1));
    } else if (key.downArrow) {
      setHl((h) => Math.min(tools.length - 1, h + 1));
    } else if (input === ' ') {
      const tool = tools[hl];
      if (!tool) return;
      const cur = getToolState(tool.name, allowed, confirm);
      const next = applyToolState(tool.name, cycleToolState(cur), allowed, confirm);
      onChange(next.allowed, next.confirm);
    } else if (key.return) {
      onSubmit();
    }
  });

  if (tools.length === 0) {
    return <Text dimColor> (no tools registered, skipping)</Text>;
  }

  return (
    <Box flexDirection="column">
      {tools.map((t, i) => {
        const state = getToolState(t.name, allowed, confirm);
        const cursor = i === hl ? '›' : ' ';
        const checkbox = state === 'inactive' ? '[ ]' : state === 'active' ? '[x]' : '[!]';
        const checkboxColor = state === 'confirm' ? 'yellow' : undefined;
        const dangerSuffix = t.dangerous ? ' (dangerous)' : '';
        const desc = t.description.length > 60 ? `${t.description.slice(0, 57)}…` : t.description;
        return (
          <Text key={t.name}>
            {`  ${cursor} `}
            <Text color={checkboxColor}>{checkbox}</Text> <Text bold={i === hl}>{t.name}</Text>
            <Text dimColor>{`${dangerSuffix} — ${desc}`}</Text>
          </Text>
        );
      })}
      <Text dimColor> (↑/↓ navigate · space cycles inactive → active → confirm · enter)</Text>
    </Box>
  );
}

function PluginPicker({
  plugins,
  value,
  onChange,
  onSubmit,
}: {
  plugins: PluginRecord[];
  value: string[];
  onChange: (v: string[]) => void;
  onSubmit: () => void;
}) {
  const [hl, setHl] = useState(0);

  // Auto-skip when nothing to pick — but keep the user in the step long
  // enough to read the hint, by surfacing a Continue line they can press
  // enter on. (Skipping silently would advance instantly when no plugins
  // are configured, hiding the fact that the field exists.)
  useInput((_input, key) => {
    if (plugins.length === 0) {
      if (key.return) onSubmit();
      return;
    }
    if (key.upArrow) {
      setHl((h) => Math.max(0, h - 1));
    } else if (key.downArrow) {
      setHl((h) => Math.min(plugins.length - 1, h + 1));
    } else if (_input === ' ') {
      const p = plugins[hl];
      if (!p) return;
      const set = new Set(value);
      if (set.has(p.name)) set.delete(p.name);
      else set.add(p.name);
      onChange([...set]);
    } else if (key.return) {
      onSubmit();
    }
  });

  if (plugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor> (no discovered plugins — add a source from the Plugins menu)</Text>
        <Text dimColor> (enter to continue)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {plugins.map((p, i) => {
        const checked = value.includes(p.name);
        const cursor = i === hl ? '›' : ' ';
        const checkbox = checked ? '[x]' : '[ ]';
        const desc = p.description
          ? p.description.length > 60
            ? `${p.description.slice(0, 57)}…`
            : p.description
          : '';
        return (
          <Text key={p.id}>
            {`  ${cursor} ${checkbox} `}
            <Text bold={i === hl}>{p.name}</Text>
            <Text dimColor>{` [${p.manifestKind}]${desc ? ` — ${desc}` : ''}`}</Text>
          </Text>
        );
      })}
      <Text dimColor> (↑/↓ navigate · space toggle · enter confirm)</Text>
    </Box>
  );
}

function McpPicker({
  servers,
  value,
  onChange,
  onSubmit,
}: {
  servers: McpServerConfig[];
  value: string[];
  onChange: (v: string[]) => void;
  onSubmit: () => void;
}) {
  const [hl, setHl] = useState(0);

  useInput((_input, key) => {
    if (servers.length === 0) {
      if (key.return) onSubmit();
      return;
    }
    if (key.upArrow) {
      setHl((h) => Math.max(0, h - 1));
    } else if (key.downArrow) {
      setHl((h) => Math.min(servers.length - 1, h + 1));
    } else if (_input === ' ') {
      const s = servers[hl];
      if (!s) return;
      const set = new Set(value);
      if (set.has(s.id)) set.delete(s.id);
      else set.add(s.id);
      onChange([...set]);
    } else if (key.return) {
      onSubmit();
    }
  });

  if (servers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor> (no MCP servers configured — add one from the MCP Servers menu)</Text>
        <Text dimColor> (enter to continue)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {servers.map((s, i) => {
        const checked = value.includes(s.id);
        const cursor = i === hl ? '›' : ' ';
        const checkbox = checked ? '[x]' : '[ ]';
        const tail = `${s.transport} · ${s.enabled ? 'enabled' : 'disabled'}`;
        return (
          <Text key={s.id}>
            {`  ${cursor} ${checkbox} `}
            <Text bold>{s.name}</Text>
            <Text dimColor>{`  (${tail})`}</Text>
          </Text>
        );
      })}
      <Text dimColor> (↑/↓ navigate · space toggle · enter confirm)</Text>
    </Box>
  );
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}
