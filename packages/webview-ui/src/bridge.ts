// Wire protocol between the extension host and the chat webview.
// Both sides import these types so a change here forces both ends to
// update. Event names mirror the sister repo's SSE protocol where the
// concepts overlap, adapted to the in-process model.
//
// The webview is hostile until proven otherwise: messages arriving on
// the host side must be runtime-validated with `parseViewToHost`. The
// other direction (host → view) is trusted because the host builds the
// messages itself.

export type AgentConfig = any;
export type CaretakerConfig = any;
export type PluginsFile = any;
export type McpServerConfig = any;

export type ConfirmDecision = 'once' | 'always' | 'reject';

export interface AgentSummary {
  id: string;
  name: string;
  model: string;
  provider: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ToolAttachmentRecord {
  mime: string;
  id: string;
  name?: string;
  base64?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  parts?: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | { type: 'tool_use'; id: string; name: string; args: unknown }
  >;
  toolCallId?: string;
  attachments?: ToolAttachmentRecord[];
  createdAt: string;
}

export interface ContextUsage {
  lastTokens: number;
  contextWindow: number | null;
  percent: number | null;
}

export type ModelsResult = { ok: true; ids: string[] } | { ok: false; error: string };

export type RefreshOutcome = {
  pluginsFound: number;
  sha: string | null;
  error: string | null;
};

export type HostToView =
  | { type: 'ready' }
  | { type: 'agentsLoaded'; agents: AgentSummary[] }
  | { type: 'sessionsLoaded'; sessions: SessionSummary[] }
  | { type: 'sessionLoaded'; messages: ChatMessage[] }
  | { type: 'chunk'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string }
  | { type: 'permission_request'; id: string; toolName: string; args: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'contextUsage'; usage: ContextUsage | null }
  | {
      type: 'settingsDataLoaded';
      config: CaretakerConfig;
      agents: AgentConfig[];
      pluginsFile: PluginsFile;
      mcpServersFile: { servers: McpServerConfig[] };
      availableTools: string[];
    }
  | { type: 'modelsFetched'; result: ModelsResult }
  | { type: 'refreshingPlugin'; sourceId: string }
  | { type: 'refreshPluginOutcome'; outcome: RefreshOutcome }
  | { type: 'taskRunsLoaded'; taskId: string; runs: any[] }
  | { type: 'mcpAuthOutcome'; serverId: string; ok: boolean; error?: string };

export type ViewToHost =
  | { type: 'start'; prompt: string; attachments?: Array<{ name: string; mime: string; base64: string }> }
  | { type: 'abort' }
  | { type: 'permission_response'; id: string; decision: ConfirmDecision }
  | { type: 'selectAgent'; agentId: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'createSession' }
  | { type: 'webviewReady' }
  | { type: 'getSettingsData' }
  | { type: 'saveConfig'; config: CaretakerConfig }
  | { type: 'saveAgent'; agent: AgentConfig }
  | { type: 'deleteAgent'; agentId: string }
  | { type: 'savePluginSource'; source: any }
  | { type: 'deletePluginSource'; sourceId: string }
  | { type: 'refreshPluginSource'; sourceId: string }
  | { type: 'saveMcpServer'; server: any }
  | { type: 'deleteMcpServer'; serverId: string }
  | { type: 'fetchModels'; endpoint: string; apiKey?: string }
  | { type: 'getTaskRuns'; taskId: string }
  | { type: 'authenticateMcpServer'; serverId: string }
  | { type: 'revokeMcpAuth'; serverId: string };

/** Runtime validator for messages coming from the webview. Returns
 * the typed message on success, or null on any structural mismatch.
 * Keep this exhaustive — adding a new `ViewToHost` variant must add a
 * branch here, otherwise the host will silently drop it.
 */
export function parseViewToHost(value: unknown): ViewToHost | null {
  if (!isRecord(value)) return null;
  const type = value.type;

  switch (type) {
    case 'start': {
      if (typeof value.prompt !== 'string') return null;
      let attachments: Array<{ name: string; mime: string; base64: string }> | undefined = undefined;
      if ('attachments' in value) {
        if (!Array.isArray(value.attachments)) return null;
        attachments = [];
        for (const att of value.attachments) {
          if (typeof att !== 'object' || att === null) return null;
          if (typeof att.name !== 'string' || typeof att.mime !== 'string' || typeof att.base64 !== 'string') return null;
          attachments.push({ name: att.name, mime: att.mime, base64: att.base64 });
        }
      }
      const res: Extract<ViewToHost, { type: 'start' }> = { type, prompt: value.prompt };
      if (attachments !== undefined) {
        res.attachments = attachments;
      }
      return res;
    }
    case 'abort':
      return { type };
    case 'permission_response': {
      const { id, decision } = value;
      if (typeof id !== 'string') return null;
      if (decision !== 'once' && decision !== 'always' && decision !== 'reject') return null;
      return { type, id, decision };
    }
    case 'selectAgent':
      return typeof value.agentId === 'string' ? { type, agentId: value.agentId } : null;
    case 'selectSession':
      return typeof value.sessionId === 'string' ? { type, sessionId: value.sessionId } : null;
    case 'deleteSession':
      return typeof value.sessionId === 'string' ? { type, sessionId: value.sessionId } : null;
    case 'createSession':
      return { type };
    case 'webviewReady':
      return { type };
    case 'getSettingsData':
      return { type };
    case 'saveConfig':
      return isRecord(value.config) ? { type, config: value.config as any } : null;
    case 'saveAgent':
      return isRecord(value.agent) ? { type, agent: value.agent as any } : null;
    case 'deleteAgent':
      return typeof value.agentId === 'string' ? { type, agentId: value.agentId } : null;
    case 'savePluginSource':
      return isRecord(value.source) ? { type, source: value.source } : null;
    case 'deletePluginSource':
      return typeof value.sourceId === 'string' ? { type, sourceId: value.sourceId } : null;
    case 'refreshPluginSource':
      return typeof value.sourceId === 'string' ? { type, sourceId: value.sourceId } : null;
    case 'saveMcpServer':
      return isRecord(value.server) ? { type, server: value.server } : null;
    case 'deleteMcpServer':
      return typeof value.serverId === 'string' ? { type, serverId: value.serverId } : null;
    case 'fetchModels':
      return typeof value.endpoint === 'string'
        ? { type, endpoint: value.endpoint, apiKey: typeof value.apiKey === 'string' ? value.apiKey : undefined }
        : null;
    case 'getTaskRuns':
      return typeof value.taskId === 'string' ? { type, taskId: value.taskId } : null;
    case 'authenticateMcpServer':
      return typeof value.serverId === 'string' ? { type, serverId: value.serverId } : null;
    case 'revokeMcpAuth':
      return typeof value.serverId === 'string' ? { type, serverId: value.serverId } : null;

    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
