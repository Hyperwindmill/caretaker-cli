// Sidebar webview provider. Holds at most one ChatSessionController
// per webview view; lazy-instantiates it on the first user `start`
// after running the preconditions (workspace folder open, agent
// configured, provider known, tools resolvable).
//
// Preconditions failures become `error` events shown inline in the
// webview. No special state events yet — keep the bridge thin.

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { watch, existsSync, mkdirSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';

import * as harness from 'caretaker-cli/harness';
import { loadAgents, loadConfig, dataDir, agentsPath } from 'caretaker-cli/store';
import { listForAgent, readSession } from 'caretaker-cli/session';
import type { AgentConfig, ProviderConfig } from 'caretaker-cli/types';

import {
  parseViewToHost,
  type ConfirmDecision,
  type HostToView,
  type ViewToHost,
} from './bridge.js';
import { ChatSessionController } from './session.js';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'caretaker.chatView';

  private view: vscode.WebviewView | null = null;
  private controller: ChatSessionController | null = null;
  private currentAgent: AgentConfig | null = null;
  private currentProvider: ProviderConfig | null = null;
  private currentTools: harness.Tool[] | null = null;
  private currentSessionId: string | null = null;
  private agents: AgentConfig[] = [];
  private watcher: FSWatcher | null = null;
  /** Pending confirm-gate round-trips: tool-call id → resolver for the
   * decision Promise the controller is awaiting. Cleared when the
   * matching `permission_response` arrives or when the run aborts (in
   * which case every pending entry resolves with `'reject'` so the
   * harness loop unblocks). */
  private pendingConfirms = new Map<string, (d: ConfirmDecision) => void>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = this.renderHtml(view.webview);

    view.onDidDispose(() => {
      this.resolveAllPending('reject');
      this.controller?.abort();
      this.controller = null;
      if (this.watcher) {
        this.watcher.close();
        this.watcher = null;
      }
      this.view = null;
    });

    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseViewToHost(raw);
      if (!msg) {
        console.warn('[caretaker] dropped malformed message from webview', raw);
        return;
      }
      void this.handleMessage(view.webview, msg);
    });
  }

  private async initializeView(webview: vscode.Webview): Promise<void> {
    this.post(webview, { type: 'ready' });
    await this.loadAgentsAndSend(webview);
    this.setupWatcher(webview);
  }

  private setupWatcher(webview: vscode.Webview): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    try {
      const dir = dataDir();
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      this.watcher = watch(dir, (eventType, filename) => {
        if (filename === 'agents.json') {
          void this.loadAgentsAndSend(webview);
        }
      });
    } catch (err) {
      console.warn('[caretaker] failed to set up agents.json watcher:', err);
    }
  }

  private async loadAgentsAndSend(webview: vscode.Webview): Promise<void> {
    try {
      const [agentsRes, configRes] = await Promise.all([loadAgents(), loadConfig()]);
      this.agents = agentsRes;
      const providers = configRes.providers;

      const agentSummaries = this.agents.map((a) => ({
        id: a.id,
        name: a.name,
        model: a.model,
        provider: a.provider,
      }));
      this.post(webview, { type: 'agentsLoaded', agents: agentSummaries });

      // Select default agent
      const requestedName = vscode.workspace
        .getConfiguration('caretaker')
        .get<string>('defaultAgent')
        ?.trim();
      const defaultAgent = requestedName
        ? this.agents.find((a) => a.name === requestedName)
        : this.agents[0];

      if (defaultAgent) {
        await this.selectAgentInternal(webview, defaultAgent, providers);
      }
    } catch (err) {
      this.post(webview, {
        type: 'error',
        message: `Failed to load Caretaker config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async selectAgentInternal(
    webview: vscode.Webview,
    agent: AgentConfig,
    providers: ProviderConfig[],
  ): Promise<void> {
    const provider = providers.find((p) => p.name === agent.provider);
    if (!provider) {
      this.post(webview, {
        type: 'error',
        message: `Provider "${agent.provider}" for agent "${agent.name}" is missing from caretaker.json.`,
      });
      return;
    }

    this.currentAgent = agent;
    this.currentProvider = provider;
    this.currentTools = await harness.resolveAgentTools(agent, harness.tools);
    this.currentSessionId = null;
    this.controller = null;

    // Load sessions for this agent
    await this.loadSessionsAndSend(webview, agent.id);
  }

  private async loadSessionsAndSend(webview: vscode.Webview, agentId: string): Promise<void> {
    try {
      const entries = await listForAgent(agentId);
      const sessionSummaries = entries.map((e) => ({
        id: e.meta.id,
        title: e.meta.title,
        updatedAt: e.updatedAt.toISOString(),
      }));
      this.post(webview, { type: 'sessionsLoaded', sessions: sessionSummaries });
    } catch (err) {
      console.warn('[caretaker] failed to load sessions:', err);
      this.post(webview, { type: 'sessionsLoaded', sessions: [] });
    }
  }

  private async loadSessionMessagesAndSend(
    webview: vscode.Webview,
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const session = await readSession(agentId, sessionId);
      const messages = session.messages
        .filter((m): m is typeof m & { role: 'user' | 'assistant' } =>
          m.role === 'user' || m.role === 'assistant',
        )
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        }));
      this.post(webview, { type: 'sessionLoaded', messages });
    } catch (err) {
      console.warn('[caretaker] failed to load session messages:', err);
      this.post(webview, { type: 'error', message: 'Failed to load conversation history' });
    }
  }

  private async handleMessage(webview: vscode.Webview, msg: ViewToHost): Promise<void> {
    switch (msg.type) {
      case 'webviewReady':
        void this.initializeView(webview);
        return;
      case 'start':
        await this.handleStart(webview, msg.prompt);
        return;
      case 'abort':
        this.resolveAllPending('reject');
        this.controller?.abort();
        return;
      case 'permission_response': {
        const resolve = this.pendingConfirms.get(msg.id);
        if (resolve) {
          this.pendingConfirms.delete(msg.id);
          resolve(msg.decision);
        }
        return;
      }
      case 'selectAgent': {
        const agent = this.agents.find((a) => a.id === msg.agentId);
        if (!agent || !this.view) return;
        const providers = (await loadConfig()).providers;
        await this.selectAgentInternal(webview, agent, providers);
        // Automatically load sessions for the selected agent
        await this.loadSessionsAndSend(webview, agent.id);
        return;
      }
      case 'selectSession': {
        this.currentSessionId = msg.sessionId;
        this.controller = null; // Reset controller to load existing session
        // Load and send the session messages
        if (this.currentAgent) {
          await this.loadSessionMessagesAndSend(webview, this.currentAgent.id, msg.sessionId);
        }
        return;
      }
      case 'createSession': {
        this.currentSessionId = null;
        this.controller = null;
        return;
      }
    }
  }

  private resolveAllPending(decision: ConfirmDecision): void {
    for (const resolve of this.pendingConfirms.values()) resolve(decision);
    this.pendingConfirms.clear();
  }

  private async handleStart(webview: vscode.Webview, prompt: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this.post(webview, {
        type: 'error',
        message: 'Open a folder to use Caretaker — the agent runs against the workspace root.',
      });
      return;
    }

    if (!this.currentAgent || !this.currentProvider || !this.currentTools) {
      this.post(webview, {
        type: 'error',
        message: 'Agent not selected. Please select an agent from the dropdown.',
      });
      return;
    }

    if (!this.controller) {
      this.controller = new ChatSessionController({
        agent: this.currentAgent,
        provider: this.currentProvider,
        tools: this.currentTools,
        workingDir: workspaceFolder,
        sessionId: this.currentSessionId ?? undefined,
      });
    }

    await this.controller.start(prompt, {
      onChunk: (text) => this.post(webview, { type: 'chunk', text }),
      onToolCall: (id, name, args) => this.post(webview, { type: 'tool_call', id, name, args }),
      onToolResult: (id, content) =>
        this.post(webview, { type: 'tool_result', id, content }),
      askConfirm: (id, toolName, args) =>
        new Promise<ConfirmDecision>((resolve) => {
          this.pendingConfirms.set(id, resolve);
          this.post(webview, { type: 'permission_request', id, toolName, args });
        }),
      onError: (message) => {
        this.resolveAllPending('reject');
        this.post(webview, { type: 'error', message });
      },
      onDone: () => {
        this.resolveAllPending('reject');
        this.post(webview, { type: 'done' });
      },
      onSessionCreated: (sessionId: string) => {
        this.currentSessionId = sessionId;
        void this.loadSessionsAndSend(webview, this.currentAgent!.id);
      },
    });
  }

  private post(webview: vscode.Webview, msg: HostToView): void {
    void webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Caretaker</title>
    <link rel="stylesheet" href="${styleUri}" />
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
