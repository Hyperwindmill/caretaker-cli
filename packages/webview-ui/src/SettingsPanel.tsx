import { useState } from 'react';
import type { ViewToHost, ModelsResult, RefreshOutcome, VoiceCatalogResult, AcpRegistryResult } from './bridge.js';
import type { CaretakerConfig, AgentConfig, PluginsFile, McpServerConfig } from 'caretaker-types';

import { ProvidersTab } from './ProvidersTab.js';
import { ProjectsTabSettings } from './ProjectsTabSettings.js';
import { AgentsTab } from './AgentsTab.js';
import { PluginsTab } from './PluginsTab.js';
import { McpTab } from './McpTab.js';
import { ServicesTab } from './ServicesTab.js';
import { VoiceTab } from './VoiceTab.js';
import { MemoryTab } from './MemoryTab.js';
import { DesktopTab } from './DesktopTab.js';
import { ApiAccessTab } from './ApiAccessTab.js';
import { BackIcon } from './icons.js';
import { settingsTabs, type TabId } from './settings_tabs.js';

export type { TabId };

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
  acpRegistry: AcpRegistryResult | null;
  acpInstall: { agentId: string; lines: string[]; result?: { ok: boolean; command?: string; args?: string[]; env?: Record<string, string>; error?: string } } | null;
  resetAcpInstall: () => void;
  sttCatalogResult: VoiceCatalogResult | null;
  ttsCatalogResult: VoiceCatalogResult | null;
  setModelsResult: (res: ModelsResult | null) => void;
  refreshingSourceId: string | null;
  refreshOutcome: RefreshOutcome | null;
  setRefreshOutcome: (out: RefreshOutcome | null) => void;
  mcpAuthOutcome: { serverId: string; ok: boolean; error?: string } | null;
  setMcpAuthOutcome: (out: { serverId: string; ok: boolean; error?: string } | null) => void;
  taskRuns?: Record<string, any[]>;
  onClose: () => void;
  initialTab?: TabId;
}

export function SettingsPanel({
  layout = 'compact',
  postMessage,
  settingsData,
  modelsResult,
  acpRegistry,
  acpInstall,
  resetAcpInstall,
  sttCatalogResult,
  ttsCatalogResult,
  setModelsResult,
  refreshingSourceId,
  refreshOutcome,
  setRefreshOutcome,
  mcpAuthOutcome,
  setMcpAuthOutcome,
  taskRuns = {},
  onClose,
  initialTab = 'providers',
}: SettingsPanelProps) {

  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  if (!settingsData) {
    return (
      <div className="settings-panel settings-panel--loading">
        <button className="settings-panel__back-btn" onClick={onClose}>
          <BackIcon size={14} /> Back to Chat
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
            acpRegistry={acpRegistry}
            acpInstall={acpInstall}
            resetAcpInstall={resetAcpInstall}
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
            mcpAuthOutcome={mcpAuthOutcome}
            setMcpAuthOutcome={setMcpAuthOutcome}
            postMessage={postMessage}
          />
        );

      case 'services':
        return (
          <ServicesTab
            config={config}
            agents={agents}
            postMessage={postMessage}
            taskRuns={taskRuns}
          />
        );

      case 'voice':
        return (
          <VoiceTab
            config={config}
            onSave={(updatedConfig) => postMessage({ type: 'saveConfig', config: updatedConfig })}
            postMessage={postMessage}
            sttCatalogResult={sttCatalogResult}
            ttsCatalogResult={ttsCatalogResult}
          />
        );

      case 'memory':
        return (
          <MemoryTab
            config={config}
            agents={agents}
            onSave={(updatedConfig) => postMessage({ type: 'saveConfig', config: updatedConfig })}
          />
        );

      case 'desktop':
        return (
          <DesktopTab
            config={config}
            agents={agents}
            onSave={(updatedConfig) => postMessage({ type: 'saveConfig', config: updatedConfig })}
          />
        );

      case 'api':
        return <ApiAccessTab />;
    }
  };

  return (
    <div className={`settings-panel${layout === 'sidebar' ? ' settings-panel--vertical' : ''}`}>
      <header className="settings-panel__header">
        {/* The sidebar layout has a persistent nav rail; only compact needs a way back. */}
        {layout !== 'sidebar' && (
          <button className="settings-panel__back-btn" onClick={onClose} title="Go back to chat">
            <BackIcon size={14} /> Chat
          </button>
        )}
        <h2 className="settings-panel__title">Caretaker Config</h2>
      </header>

      <nav className="settings-panel__tabs">
        {settingsTabs(layout).map((tab) => (
          <button
            key={tab.id}
            className={`settings-panel__tab-btn ${activeTab === tab.id ? 'settings-panel__tab-btn--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>


      <main className="settings-panel__content">
        {renderTabContent()}
      </main>
    </div>
  );
}
