import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { watch, existsSync, mkdirSync } from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';

import * as harness from '../../harness/index.js';
import {
  loadAgents,
  loadConfig,
  dataDir,
  saveAgents,
  saveConfig,
  loadPlugins,
  loadMcpServers,
  saveMcpServers,
} from '../../store/json.js';
import {
  createSource,
  deleteSource,
  patchSource,
  refreshSource,
} from '../../plugins/source_manager.js';
import {
  createMcpServer,
  deleteMcpServer,
  patchMcpServer,
} from '../../mcp/server_manager.js';
import {
  listForAgent,
  readSession,
  computeContextUsage,
  createSession,
  userMessage,
  appendMessage,
  type MessageRecord,
  type SessionMetaRecord
} from '../../session/index.js';

import type { AgentConfig, ProviderConfig, PluginsFile, McpServerConfig } from '../../types.js';
import type { ConfirmDecision, HostToView, ViewToHost } from 'webview-ui/bridge';
import {
  startBackgroundScheduler,
  loadTaskRuns,
} from './scheduler.js';

// Resolve Webview static files path
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webviewDistPath = path.resolve(__dirname, '../../../../webview-ui/dist');

export interface ChatCallbacks {
  onChunk: (text: string) => void;
  onToolCall: (id: string, name: string, args: unknown) => void;
  onToolResult: (id: string, content: string) => void;
  askConfirm: (id: string, toolName: string, args: unknown) => Promise<ConfirmDecision>;
  onError: (message: string) => void;
  onDone: () => void;
  onSessionCreated?: (sessionId: string) => void;
}

export class WebSessionController {
  private metaRecord: SessionMetaRecord | null = null;
  private history: MessageRecord[] = [];
  private inflight: AbortController | null = null;
  private readonly confirmSet: Set<string>;
  private readonly sessionId?: string;

  constructor(
    private readonly opts: {
      agent: AgentConfig;
      provider: ProviderConfig;
      tools: harness.Tool[];
      workingDir: string;
      sessionId?: string;
    }
  ) {
    this.confirmSet = new Set(opts.agent.confirmTools ?? []);
    this.sessionId = opts.sessionId;
  }

  get isRunning(): boolean {
    return this.inflight !== null;
  }

  getContextUsage(): any {
    return computeContextUsage(this.history, this.opts.agent.model);
  }

  async start(prompt: string, cb: ChatCallbacks): Promise<void> {
    if (this.inflight) {
      cb.onError('A turn is already in progress.');
      return;
    }
    const ac = new AbortController();
    this.inflight = ac;

    try {
      if (!this.metaRecord) {
        if (this.sessionId) {
          const sessionData = await readSession(this.opts.agent.id, this.sessionId);
          this.metaRecord = sessionData.meta;
          this.history = sessionData.messages;
        } else {
          const title = prompt.length > 50 ? `${prompt.slice(0, 50)}…` : prompt;
          const metaRec = await createSession({ agentId: this.opts.agent.id, title });
          this.metaRecord = metaRec;
          cb.onSessionCreated?.(metaRec.id);
          this.history = [];
        }
      }

      const meta = this.metaRecord!;
      const userMsg = userMessage(prompt);
      await appendMessage(meta, userMsg);
      const priorHistory = [...this.history];
      this.history.push(userMsg);

      await harness.run(
        {
          agent: this.opts.agent,
          provider: this.opts.provider,
          tools: this.opts.tools,
          prompt,
          history: priorHistory,
          signal: ac.signal,
          workingDir: this.opts.workingDir,
        },
        {
          onChunk: cb.onChunk,
          onToolCall: cb.onToolCall,
          onToolResult: cb.onToolResult,
          confirmTool: async (id, name, args) => {
            if (!this.confirmSet.has(name)) return 'once';
            const decision = await cb.askConfirm(id, name, args);
            if (decision === 'always') this.confirmSet.delete(name);
            return decision;
          },
          onMessage: async (msg) => {
            await appendMessage(meta, msg);
            this.history.push(msg);
          },
        },
      );
      cb.onDone();
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err));
    } finally {
      this.inflight = null;
    }
  }

  abort(): void {
    this.inflight?.abort();
  }
}

export async function startServer(port: number, host: string): Promise<void> {
  const app = new Hono();

  // Pure-Node static serving with absolute path validation and fallback
  app.get('/', (c) => {
    try {
      const html = fs.readFileSync(path.join(webviewDistPath, 'index.html'), 'utf-8');
      return c.html(html);
    } catch {
      return c.text('Caretaker Web standalone build not found. Did you run "pnpm -F webview-ui build"?', 500);
    }
  });

  app.get('/standalone.js', (c) => {
    const file = fs.readFileSync(path.join(webviewDistPath, 'standalone.js'));
    c.header('Content-Type', 'application/javascript');
    return c.body(file);
  });

  app.get('/standalone.js.map', (c) => {
    const file = fs.readFileSync(path.join(webviewDistPath, 'standalone.js.map'));
    c.header('Content-Type', 'application/json');
    return c.body(file);
  });

  app.get('/standalone.css', (c) => {
    const file = fs.readFileSync(path.join(webviewDistPath, 'standalone.css'));
    c.header('Content-Type', 'text/css');
    return c.body(file);
  });

  app.get('/standalone.css.map', (c) => {
    const file = fs.readFileSync(path.join(webviewDistPath, 'standalone.css.map'));
    c.header('Content-Type', 'application/json');
    return c.body(file);
  });

  const nodeServer = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  const wss = new WebSocketServer({ noServer: true });

  nodeServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '', `http://${host}:${port}`);
    if (pathname === '/api/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  console.log(`\n🚀 Caretaker Server running at http://${host}:${port}\n`);

  // Start the background scheduler trigger daemon
  startBackgroundScheduler();

  wss.on('connection', async (ws: WebSocket) => {
    let controller: WebSessionController | null = null;
    let currentAgent: AgentConfig | null = null;
    let currentProvider: ProviderConfig | null = null;
    let currentTools: harness.Tool[] | null = null;
    let currentSessionId: string | null = null;
    let agents: AgentConfig[] = [];
    const pendingConfirms = new Map<string, (d: ConfirmDecision) => void>();

    const post = (msg: HostToView) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const resolveAllPending = (decision: ConfirmDecision) => {
      for (const resolve of pendingConfirms.values()) resolve(decision);
      pendingConfirms.clear();
    };

    const loadAgentsAndSend = async () => {
      try {
        const [agentsRes, configRes] = await Promise.all([loadAgents(), loadConfig()]);
        agents = agentsRes;
        const providers = configRes.providers;

        const agentSummaries = agents.map((a) => ({
          id: a.id,
          name: a.name,
          model: a.model,
          provider: a.provider,
        }));
        post({ type: 'agentsLoaded', agents: agentSummaries });

        // Select the first agent as default if none is active
        if (!currentAgent && agents.length > 0) {
          await selectAgentInternal(agents[0], providers);
        }
      } catch (err) {
        post({
          type: 'error',
          message: `Failed to load Caretaker config: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    const selectAgentInternal = async (agent: AgentConfig, providers: ProviderConfig[]) => {
      const provider = providers.find((p) => p.name === agent.provider);
      if (!provider) {
        post({
          type: 'error',
          message: `Provider "${agent.provider}" for agent "${agent.name}" is missing from caretaker.json.`,
        });
        return;
      }

      currentAgent = agent;
      currentProvider = provider;
      currentTools = await harness.resolveAgentTools(agent, harness.tools);
      currentSessionId = null;
      controller = null;
      post({ type: 'contextUsage', usage: null });

      await loadSessionsAndSend(agent.id);
    };

    const loadSessionsAndSend = async (agentId: string) => {
      try {
        const entries = await listForAgent(agentId);
        const sessionSummaries = entries.map((e) => ({
          id: e.meta.id,
          title: e.meta.title,
          updatedAt: e.updatedAt.toISOString(),
        }));
        post({ type: 'sessionsLoaded', sessions: sessionSummaries });
      } catch (err) {
        post({ type: 'sessionsLoaded', sessions: [] });
      }
    };

    const loadSessionMessagesAndSend = async (agentId: string, sessionId: string) => {
      try {
        const sessionData = await readSession(agentId, sessionId);
        const messages = sessionData.messages.map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant' | 'tool',
          content: m.content,
          parts: m.parts,
          toolCallId: m.toolCallId,
          createdAt: m.createdAt,
        }));
        post({ type: 'sessionLoaded', messages });

        const usage = computeContextUsage(sessionData.messages, currentAgent?.model ?? null);
        post({ type: 'contextUsage', usage });
      } catch (err) {
        console.warn('[web] failed to load session messages:', err);
        post({ type: 'error', message: 'Failed to load conversation history' });
      }
    };

    const sendSettingsData = async () => {
      try {
        const [config, agentsRes, pluginsFile, mcpServersFile] = await Promise.all([
          loadConfig(),
          loadAgents(),
          loadPlugins(),
          loadMcpServers(),
        ]);
        const availableTools = harness.tools.list().map((t) => t.name);
        post({
          type: 'settingsDataLoaded',
          config,
          agents: agentsRes,
          pluginsFile,
          mcpServersFile,
          availableTools,
        });
      } catch (err) {
        console.warn('[web] failed to load settings data:', err);
      }
    };

    // Set up file watcher to sync state changes live, just like in VSCode
    const dir = dataDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const watcher = watch(dir, (eventType, filename) => {
      if (
        filename === 'agents.json' ||
        filename === 'caretaker.json' ||
        filename === 'plugins.json' ||
        filename === 'mcp.json'
      ) {
        void loadAgentsAndSend();
        void sendSettingsData();
      }
    });

    ws.on('close', () => {
      resolveAllPending('reject');
      controller?.abort();
      watcher.close();
    });

    ws.on('message', async (data: string) => {
      try {
        const msg = JSON.parse(data) as ViewToHost;
        switch (msg.type) {
          case 'webviewReady':
            post({ type: 'ready' });
            await loadAgentsAndSend();
            return;
          case 'start': {
            const workspaceFolder = process.cwd(); // Default local-first workspace folder!
            if (!currentAgent || !currentProvider || !currentTools) {
              post({
                type: 'error',
                message: 'Agent not selected. Please select an agent from the dropdown.',
              });
              return;
            }

            if (!controller) {
              controller = new WebSessionController({
                agent: currentAgent,
                provider: currentProvider,
                tools: currentTools,
                workingDir: workspaceFolder,
                sessionId: currentSessionId ?? undefined,
              });
            }

            await controller.start(msg.prompt, {
              onChunk: (text) => post({ type: 'chunk', text }),
              onToolCall: (id, name, args) => post({ type: 'tool_call', id, name, args }),
              onToolResult: (id, content) => post({ type: 'tool_result', id, content }),
              askConfirm: (id, toolName, args) =>
                new Promise<ConfirmDecision>((resolve) => {
                  pendingConfirms.set(id, resolve);
                  post({ type: 'permission_request', id, toolName, args });
                }),
              onError: (message) => {
                resolveAllPending('reject');
                post({ type: 'error', message });
              },
              onDone: () => {
                resolveAllPending('reject');
                post({ type: 'done' });
                if (controller) {
                  const usage = controller.getContextUsage();
                  post({ type: 'contextUsage', usage });
                }
              },
              onSessionCreated: (sessionId: string) => {
                currentSessionId = sessionId;
                void loadSessionsAndSend(currentAgent!.id);
              },
            });
            return;
          }
          case 'abort':
            resolveAllPending('reject');
            controller?.abort();
            return;
          case 'permission_response': {
            const resolve = pendingConfirms.get(msg.id);
            if (resolve) {
              pendingConfirms.delete(msg.id);
              resolve(msg.decision);
            }
            return;
          }
          case 'selectAgent': {
            const agent = agents.find((a) => a.id === msg.agentId);
            if (!agent) return;
            const providers = (await loadConfig()).providers;
            await selectAgentInternal(agent, providers);
            await loadSessionsAndSend(agent.id);
            return;
          }
          case 'selectSession': {
            currentSessionId = msg.sessionId;
            controller = null; // Reset controller to load existing session
            if (currentAgent) {
              await loadSessionMessagesAndSend(currentAgent.id, msg.sessionId);
            }
            return;
          }
          case 'createSession': {
            currentSessionId = null;
            controller = null;
            post({ type: 'contextUsage', usage: null });
            return;
          }
          case 'getSettingsData':
            void sendSettingsData();
            return;
          case 'saveConfig':
            try {
              await saveConfig(msg.config);
              void loadAgentsAndSend();
              void sendSettingsData();
            } catch (err) {
              post({ type: 'error', message: `Failed to save config: ${err}` });
            }
            return;
          case 'saveAgent':
            try {
              const agentsList = await loadAgents();
              const existingIdx = agentsList.findIndex((a) => a.id === msg.agent.id);
              if (existingIdx !== -1) {
                agentsList[existingIdx] = msg.agent;
              } else {
                agentsList.push(msg.agent);
              }
              await saveAgents(agentsList);
              void loadAgentsAndSend();
              void sendSettingsData();
            } catch (err) {
              post({ type: 'error', message: `Failed to save agent: ${err}` });
            }
            return;
          case 'deleteAgent':
            try {
              let agentsList = await loadAgents();
              agentsList = agentsList.filter((a) => a.id !== msg.agentId);
              await saveAgents(agentsList);
              void loadAgentsAndSend();
              void sendSettingsData();
            } catch (err) {
              post({ type: 'error', message: `Failed to delete agent: ${err}` });
            }
            return;
          case 'savePluginSource':
            try {
              if (msg.source.id) {
                await patchSource(msg.source.id, {
                  url: msg.source.url,
                  ref: msg.source.ref,
                  authToken: msg.source.authToken,
                  refreshOnStart: msg.source.refreshOnStart,
                });
              } else {
                await createSource(msg.source);
              }
              void loadAgentsAndSend();
              void sendSettingsData();
            } catch (err) {
              post({ type: 'error', message: `Failed to save plugin source: ${err}` });
            }
            return;
          case 'deletePluginSource':
            try {
              await deleteSource(msg.sourceId);
              void loadAgentsAndSend();
              void sendSettingsData();
            } catch (err) {
              post({ type: 'error', message: `Failed to delete plugin source: ${err}` });
            }
            return;
          case 'refreshPluginSource':
            try {
              post({ type: 'refreshingPlugin', sourceId: msg.sourceId });
              const outcome = await refreshSource(msg.sourceId);
              void loadAgentsAndSend();
              void sendSettingsData();
              post({ type: 'refreshPluginOutcome', outcome });
            } catch (err) {
              post({
                type: 'refreshPluginOutcome',
                outcome: { pluginsFound: 0, sha: null, error: String(err) },
              });
            }
            return;
          case 'saveMcpServer':
            try {
              if (msg.server.id) {
                await patchMcpServer(msg.server.id, {
                  name: msg.server.name,
                  enabled: msg.server.enabled,
                  command: msg.server.command,
                  args: msg.server.args,
                  env: msg.server.env,
                  url: msg.server.url,
                  headers: msg.server.headers,
                });
              } else {
                await createMcpServer(msg.server);
              }
              void loadAgentsAndSend();
              void sendSettingsData();
            } catch (err) {
              post({ type: 'error', message: `Failed to save MCP server: ${err}` });
            }
            return;
          case 'deleteMcpServer':
            try {
              await deleteMcpServer(msg.serverId);
              void loadAgentsAndSend();
              void sendSettingsData();
            } catch (err) {
              post({ type: 'error', message: `Failed to delete MCP server: ${err}` });
            }
            return;
          case 'fetchModels':
            try {
              const result = await harness.fetchOpenAiStyleModels(msg.endpoint, msg.apiKey ?? null);
              post({ type: 'modelsFetched', result });
            } catch (err) {
              post({
                type: 'modelsFetched',
                result: { ok: false, error: String(err) },
              });
            }
            return;
          case 'getTaskRuns':
            try {
              const runs = await loadTaskRuns(msg.taskId);
              post({ type: 'taskRunsLoaded', taskId: msg.taskId, runs });
            } catch (err) {
              console.error('[web] failed to load task runs:', err);
              post({
                type: 'error',
                message: `Failed to load task runs: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
        }
      } catch (err) {
        console.error('[web] WebSocket message handling failed:', err);
      }
    });
  });
}
