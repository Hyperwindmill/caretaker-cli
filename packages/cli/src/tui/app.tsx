import { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Providers from './providers.js';
import Agents from './agents.js';
import Plugins from './plugins.js';
import McpServers from './mcp_servers.js';
import Logo from './logo.js';
import { loadConfig } from '../store/json.js';
import { cliVersion } from '../lib/version.js';
import { getLatestRelease, isNewer, UPDATE_COMMAND } from '../lib/update_check.js';

type View = 'menu' | 'providers' | 'agents' | 'plugins' | 'mcp';

export default function App() {
  const [view, setView] = useState<View>('menu');
  const { exit } = useApp();
  const [updateLine, setUpdateLine] = useState<string | null>(null);

  // Update notice: never blocks the menu, swallows every failure.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if ((await loadConfig()).updateCheck === false) return;
        const latest = await getLatestRelease();
        const current = cliVersion();
        if (!cancelled && latest && isNewer(latest.version, current)) {
          setUpdateLine(`⬆ Caretaker ${latest.version} available (you have ${current}) — ${UPDATE_COMMAND}`);
        }
      } catch {
        /* no notice */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (view === 'menu') exit();
    // Sub-views handle their own ESC via onBack chains.
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} flexDirection="column">
        <Logo />
        {updateLine && (
          <Text color="yellow" dimColor>
            {updateLine}
          </Text>
        )}
      </Box>
      {view === 'menu' && (
        <Box flexDirection="column">
          <SelectInput
            items={[
              { label: 'Agents', value: 'agents' },
              { label: 'Providers', value: 'providers' },
              { label: 'Plugins', value: 'plugins' },
              { label: 'MCP Servers', value: 'mcp' },
              { label: 'Quit', value: 'quit' },
            ]}
            onSelect={(item) => {
              if (item.value === 'quit') exit();
              else setView(item.value as View);
            }}
          />
          <Box marginTop={1}>
            <Text dimColor>(esc to quit)</Text>
          </Box>
        </Box>
      )}
      {view === 'providers' && <Providers onBack={() => setView('menu')} />}
      {view === 'agents' && <Agents onBack={() => setView('menu')} />}
      {view === 'plugins' && <Plugins onBack={() => setView('menu')} />}
      {view === 'mcp' && <McpServers onBack={() => setView('menu')} />}
    </Box>
  );
}
