export type TabId =
  | 'providers'
  | 'projects'
  | 'agents'
  | 'plugins'
  | 'mcp'
  | 'services'
  | 'voice'
  | 'memory'
  | 'desktop'
  | 'api';

export interface SettingsTabDef {
  id: TabId;
  label: string;
  sidebarOnly?: boolean;
}

const ALL_TABS: SettingsTabDef[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'projects', label: 'Projects', sidebarOnly: true },
  { id: 'agents', label: 'Agents' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'mcp', label: 'MCP' },
  { id: 'services', label: 'Services', sidebarOnly: true },
  // Voice is out of scope for the VSCode sidebar (webview CSP blocks the mic).
  { id: 'voice', label: 'Voice', sidebarOnly: true },
  // The memory sweep runs only in the web server's scheduler.
  { id: 'memory', label: 'Memory', sidebarOnly: true },
  // Only the Electron desktop app acts on the assistant shortcut (runs web server).
  { id: 'desktop', label: 'Desktop', sidebarOnly: true },
  // The API listener belongs to the web server; /api/access exists only there.
  { id: 'api', label: 'API', sidebarOnly: true },
];

/**
 * Returns the settings tabs visible for the given layout in display order.
 */
export function settingsTabs(layout: 'compact' | 'sidebar'): { id: TabId; label: string }[] {
  return ALL_TABS
    .filter((t) => layout === 'sidebar' || !t.sidebarOnly)
    .map(({ id, label }) => ({ id, label }));
}
