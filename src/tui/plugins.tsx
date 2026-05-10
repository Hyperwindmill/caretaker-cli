import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import {
  createSource,
  deleteSource,
  listPlugins,
  listSources,
  patchSource,
  refreshSource,
  type RefreshOutcome,
} from '../plugins/source_manager.js';
import { maskToken } from '../lib/encryption.js';
import type { PluginRecord, PluginSource } from '../types.js';

type Mode = 'list' | 'detail' | 'create' | 'edit' | 'delete' | 'refreshing' | 'refresh-result';

export default function Plugins({ onBack }: { onBack: () => void }) {
  const [sources, setSources] = useState<PluginSource[]>([]);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<PluginSource | null>(null);
  const [lastOutcome, setLastOutcome] = useState<RefreshOutcome | null>(null);

  const reload = async () => {
    const [s, p] = await Promise.all([listSources(), listPlugins()]);
    setSources(s);
    setPlugins(p);
  };

  useEffect(() => {
    void reload().then(() => setLoaded(true));
  }, []);

  if (!loaded) return <Text dimColor>loading…</Text>;

  if (mode === 'create') {
    return (
      <SourceForm
        onCancel={() => setMode('list')}
        onSave={async (input) => {
          const created = await createSource(input);
          await reload();
          setSelected(created);
          setMode('detail');
        }}
      />
    );
  }

  if (mode === 'edit' && selected) {
    return (
      <SourceForm
        initial={selected}
        onCancel={() => setMode('detail')}
        onSave={async (input) => {
          const patched = await patchSource(selected.id, {
            url: input.url,
            ref: input.ref,
            authToken: input.authToken === undefined ? undefined : input.authToken,
            refreshOnStart: input.refreshOnStart,
          });
          if (patched) {
            await reload();
            setSelected(patched);
          }
          setMode('detail');
        }}
      />
    );
  }

  if (mode === 'delete' && selected) {
    const dependents = plugins.filter((p) => p.sourceId === selected.id).length;
    return (
      <Box flexDirection="column">
        <Text>Delete plugin source "{selected.url}"?</Text>
        {dependents > 0 && (
          <Text color="yellow">
            This will remove {dependents} discovered plugin{dependents === 1 ? '' : 's'} from agents
            that reference them.
          </Text>
        )}
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'No, cancel', value: 'no' },
              { label: 'Yes, delete', value: 'yes' },
            ]}
            onSelect={async (item) => {
              if (item.value === 'no') return setMode('detail');
              await deleteSource(selected.id);
              await reload();
              setSelected(null);
              setMode('list');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'refreshing' && selected) {
    return (
      <Box flexDirection="column">
        <Text dimColor>refreshing "{selected.url}"…</Text>
      </Box>
    );
  }

  if (mode === 'refresh-result' && selected && lastOutcome) {
    return (
      <Box flexDirection="column">
        <Text bold>{lastOutcome.error ? 'Refresh failed' : 'Refresh succeeded'}</Text>
        {lastOutcome.error ? (
          <Text color="red">{lastOutcome.error.slice(0, 400)}</Text>
        ) : (
          <Text>
            {lastOutcome.pluginsFound} plugin{lastOutcome.pluginsFound === 1 ? '' : 's'} found
            {lastOutcome.sha ? ` · ${lastOutcome.sha.slice(0, 8)}` : ''}
          </Text>
        )}
        <Box marginTop={1}>
          <SelectInput
            items={[{ label: '← Back', value: 'back' }]}
            onSelect={() => {
              setLastOutcome(null);
              setMode('detail');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'detail' && selected) {
    const mine = plugins.filter((p) => p.sourceId === selected.id);
    return (
      <Box flexDirection="column">
        <Text bold>{selected.url}</Text>
        <Text>kind: {selected.kind}</Text>
        {selected.kind === 'git' && (
          <>
            <Text>ref: {selected.ref ?? '(default branch)'}</Text>
            <Text>auth: {selected.authToken ? '(set)' : '(none)'}</Text>
          </>
        )}
        <Text>refreshOnStart: {selected.refreshOnStart ? 'yes' : 'no'}</Text>
        <Text>lastFetched: {selected.lastFetchedAt ?? '(never)'}</Text>
        {selected.lastFetchSha && <Text>lastSha: {selected.lastFetchSha.slice(0, 12)}</Text>}
        {selected.lastFetchError && (
          <Text color="red">lastError: {selected.lastFetchError.slice(0, 200)}</Text>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>discovered plugins ({mine.length}):</Text>
          {mine.length === 0 ? (
            <Text dimColor> (none — refresh to discover)</Text>
          ) : (
            mine.map((p) => (
              <Text key={p.id}>
                {`  · `}
                <Text bold>{p.name}</Text>
                <Text
                  dimColor
                >{` [${p.manifestKind}] ${p.description ? `— ${p.description}` : ''}`}</Text>
              </Text>
            ))
          )}
        </Box>

        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'Refresh now', value: 'refresh' },
              { label: 'Edit', value: 'edit' },
              { label: 'Delete', value: 'delete' },
              { label: '← Back', value: 'back' },
            ]}
            onSelect={async (item) => {
              if (item.value === 'refresh') {
                setMode('refreshing');
                const outcome = await refreshSource(selected.id);
                await reload();
                // Refresh `selected` from the freshly-loaded list so the
                // detail view shows the updated lastFetchedAt etc.
                const fresh = (await listSources()).find((s) => s.id === selected.id) ?? null;
                if (fresh) setSelected(fresh);
                setLastOutcome(outcome);
                setMode('refresh-result');
                return;
              }
              if (item.value === 'edit') return setMode('edit');
              if (item.value === 'delete') return setMode('delete');
              setMode('list');
            }}
          />
        </Box>
      </Box>
    );
  }

  const items = [
    ...sources.map((s) => {
      const count = plugins.filter((p) => p.sourceId === s.id).length;
      const label = `${s.kind === 'git' ? 'git' : 'path'}  ${s.url}  —  ${count} plugin${count === 1 ? '' : 's'}`;
      return { label, value: `s:${s.id}` };
    }),
    { label: '+ Create new', value: '__new__' },
    { label: '← Back', value: '__back__' },
  ];

  return (
    <Box flexDirection="column">
      <Text bold>Plugin sources ({sources.length})</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === '__back__') return onBack();
            if (item.value === '__new__') return setMode('create');
            const id = item.value.replace(/^s:/, '');
            const s = sources.find((x) => x.id === id);
            if (s) {
              setSelected(s);
              setMode('detail');
            }
          }}
        />
      </Box>
    </Box>
  );
}

type FormStep = 'kind' | 'url' | 'ref' | 'authToken' | 'refreshOnStart';

interface FormResult {
  kind: 'git' | 'path';
  url: string;
  ref?: string | null;
  /** undefined = leave unchanged (edit mode); null = clear; string = set/replace. */
  authToken?: string | null;
  refreshOnStart: boolean;
}

function SourceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: PluginSource;
  onSave: (input: FormResult) => void | Promise<void>;
  onCancel: () => void;
}) {
  const isEdit = !!initial;
  // In edit mode the kind is fixed (changing it would invalidate the cache);
  // we skip the kind step and start at url.
  const [step, setStep] = useState<FormStep>(isEdit ? 'url' : 'kind');
  const [kind, setKind] = useState<'git' | 'path'>(initial?.kind ?? 'git');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [ref, setRef] = useState(initial?.ref ?? '');
  const [authToken, setAuthToken] = useState('');
  const [refreshOnStart, setRefreshOnStart] = useState(initial?.refreshOnStart ?? false);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const finalize = () => {
    const result: FormResult = {
      kind,
      url: url.trim(),
      refreshOnStart,
    };
    if (kind === 'git') {
      result.ref = ref.trim() || null;
      // Edit mode: empty input means "keep existing" → leave authToken
      // undefined so patchSource skips the field. In create mode an empty
      // input means "no token".
      if (isEdit) {
        result.authToken = authToken.trim() ? authToken.trim() : undefined;
      } else {
        result.authToken = authToken.trim() || null;
      }
    }
    void onSave(result);
  };

  const submit = () => {
    if (step === 'kind') {
      setError(null);
      setStep('url');
    } else if (step === 'url') {
      const v = url.trim();
      if (!v) return setError('url is required');
      if (kind === 'path' && !v.startsWith('/')) return setError('path must be absolute');
      setError(null);
      if (kind === 'git') setStep('ref');
      else setStep('refreshOnStart');
    } else if (step === 'ref') {
      setError(null);
      setStep('authToken');
    } else if (step === 'authToken') {
      setError(null);
      setStep('refreshOnStart');
    } else if (step === 'refreshOnStart') {
      finalize();
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold>{isEdit ? `Edit source "${initial!.url}"` : 'New plugin source'}</Text>

      <Box marginTop={1}>
        <Text>kind: </Text>
        {step === 'kind' ? (
          <SelectInput
            items={[
              { label: 'git (clone a repo)', value: 'git' },
              { label: 'path (local directory)', value: 'path' },
            ]}
            onSelect={(item) => {
              setKind(item.value as 'git' | 'path');
              setStep('url');
            }}
          />
        ) : (
          <Text>{kind}</Text>
        )}
      </Box>

      <Box>
        <Text>url: </Text>
        {step === 'url' ? (
          <TextInput
            value={url}
            onChange={setUrl}
            onSubmit={submit}
            placeholder={
              kind === 'git' ? 'https://github.com/owner/repo.git' : '/absolute/path/to/dir'
            }
          />
        ) : step === 'kind' ? (
          <Text dimColor>(pending)</Text>
        ) : (
          <Text>{url}</Text>
        )}
      </Box>

      {kind === 'git' && (
        <Box>
          <Text>ref: </Text>
          {step === 'ref' ? (
            <TextInput
              value={ref}
              onChange={setRef}
              onSubmit={submit}
              placeholder="(empty = default branch)"
            />
          ) : ['kind', 'url'].includes(step) ? (
            <Text dimColor>(pending)</Text>
          ) : (
            <Text>{ref || '(default branch)'}</Text>
          )}
        </Box>
      )}

      {kind === 'git' && (
        <Box>
          <Text>authToken: </Text>
          {step === 'authToken' ? (
            <TextInput
              value={authToken}
              onChange={setAuthToken}
              onSubmit={submit}
              placeholder={
                isEdit
                  ? initial!.authToken
                    ? `(${maskToken(initial!.authToken.slice(-12))} — enter to keep)`
                    : '(optional)'
                  : '(optional)'
              }
              mask="*"
            />
          ) : ['kind', 'url', 'ref'].includes(step) ? (
            <Text dimColor>(pending)</Text>
          ) : (
            <Text>{authToken ? '(set)' : initial?.authToken ? '(unchanged)' : '(none)'}</Text>
          )}
        </Box>
      )}

      <Box>
        <Text>refreshOnStart: </Text>
        {step === 'refreshOnStart' ? (
          <SelectInput
            items={[
              { label: 'no', value: 'no' },
              { label: 'yes — refresh this source on every TUI launch', value: 'yes' },
            ]}
            initialIndex={refreshOnStart ? 1 : 0}
            onSelect={(item) => {
              setRefreshOnStart(item.value === 'yes');
              // Use a microtask so React applies the state before finalize reads it.
              setTimeout(() => {
                const result: FormResult = {
                  kind,
                  url: url.trim(),
                  refreshOnStart: item.value === 'yes',
                };
                if (kind === 'git') {
                  result.ref = ref.trim() || null;
                  if (isEdit) {
                    result.authToken = authToken.trim() ? authToken.trim() : undefined;
                  } else {
                    result.authToken = authToken.trim() || null;
                  }
                }
                void onSave(result);
              }, 0);
            }}
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
