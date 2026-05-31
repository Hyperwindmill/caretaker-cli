import { useState } from 'react';
import type { ViewToHost, ModelsResult, RefreshOutcome } from './bridge.js';
import type { CaretakerConfig, AgentConfig, PluginsFile, McpServerConfig } from 'caretaker-types';

import { ProvidersTab } from './ProvidersTab.js';
import { ProjectsTabSettings } from './ProjectsTabSettings.js';
import { AgentsTab } from './AgentsTab.js';
import { PluginsTab } from './PluginsTab.js';
import { McpTab } from './McpTab.js';
import { SchedulerTab } from './SchedulerTab.js';

interface SettingsPanelProps {
  layout?: 'compact' | 'sidebar';
  postMessage: (msg: ViewToHost) => void;
  settingsData: {
    config: CaretakerConfig;
    agents: AgentConfig[];
    pluginsFile: PluginsFile;
    mcpServersFile: { servers: McpServerConfig[] };
    availableTools: string[];
  } | null;
  modelsResult: ModelsResult | null;
  setModelsResult: (res: ModelsResult | null) => void;
  refreshingSourceId: string | null;
  refreshOutcome: RefreshOutcome | null;
  setRefreshOutcome: (out: RefreshOutcome | null) => void;
  taskRuns?: Record<string, any[]>;
  onClose: () => void;
}

type TabId = 'providers' | 'projects' | 'agents' | 'plugins' | 'mcp' | 'scheduler';

export function SettingsPanel({
  layout = 'compact',
  postMessage,
  settingsData,
  modelsResult,
  setModelsResult,
  refreshingSourceId,
  refreshOutcome,
  setRefreshOutcome,
  taskRuns = {},
  onClose,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('providers');

  if (!settingsData) {
    return (
      <div className="settings-panel settings-panel--loading">
        <button className="settings-panel__back-btn" onClick={onClose}>
          ← Back to Chat
        </button>
        <div className="settings-panel__loading-spinner">
          <div className="spinner"></div>
          <span>Loading configurations...</span>
        </div>
      </div>
    );
  }

  const { config, agents, pluginsFile, mcpServersFile, availableTools } = settingsData;

  const renderTabContent = () => {
    switch (activeTab) {
      case 'providers':
        return (
          <ProvidersTab
            config={config}
            agents={agents}
            postMessage={postMessage}
          />
        );
      case 'projects':
        return (
          <ProjectsTabSettings
            config={config}
            agents={agents}
            postMessage={postMessage}
          />
        );
      case 'agents':
        return (
          <AgentsTab
            config={config}
            agents={agents}
            pluginsFile={pluginsFile}
            mcpServersFile={mcpServersFile}
            availableTools={availableTools}
            modelsResult={modelsResult}
            setModelsResult={setModelsResult}
            postMessage={postMessage}
          />
        );
      case 'plugins':
        return (
          <PluginsTab
            pluginsFile={pluginsFile}
            refreshingSourceId={refreshingSourceId}
            refreshOutcome={refreshOutcome}
            setRefreshOutcome={setRefreshOutcome}
            postMessage={postMessage}
          />
        );
      case 'mcp':
        return (
          <McpTab
            mcpServersFile={mcpServersFile}
            postMessage={postMessage}
          />
        );
      case 'scheduler':
        return (
          <SchedulerTab
            config={config}
            agents={agents}
            postMessage={postMessage}
            taskRuns={taskRuns}
          />
        );
    }
  };

  return (
    <div className="settings-panel">
      <header className="settings-panel__header">
        <button className="settings-panel__back-btn" onClick={onClose} title="Go back to chat">
          ← Chat
        </button>
        <h2 className="settings-panel__title">Caretaker Config</h2>
      </header>

      <nav className="settings-panel__tabs">
        <button
          className={`settings-panel__tab-btn ${activeTab === 'providers' ? 'settings-panel__tab-btn--active' : ''}`}
          onClick={() => setActiveTab('providers')}
        >
          Providers
        </button>
        <button
          className={`settings-panel__tab-btn ${activeTab === 'projects' ? 'settings-panel__tab-btn--active' : ''}`}
          onClick={() => setActiveTab('projects')}
        >
          Projects
        </button>
        <button
          className={`settings-panel__tab-btn ${activeTab === 'agents' ? 'settings-panel__tab-btn--active' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          Agents
        </button>
        <button
          className={`settings-panel__tab-btn ${activeTab === 'plugins' ? 'settings-panel__tab-btn--active' : ''}`}
          onClick={() => setActiveTab('plugins')}
        >
          Plugins
        </button>
        <button
          className={`settings-panel__tab-btn ${activeTab === 'mcp' ? 'settings-panel__tab-btn--active' : ''}`}
          onClick={() => setActiveTab('mcp')}
        >
          MCP
        </button>
        {layout === 'sidebar' && (
          <button
            className={`settings-panel__tab-btn ${activeTab === 'scheduler' ? 'settings-panel__tab-btn--active' : ''}`}
            onClick={() => setActiveTab('scheduler')}
          >
            Scheduler
          </button>
        )}
      </nav>

      <main className="settings-panel__content">
        {renderTabContent()}
      </main>
    </div>
  );
}
