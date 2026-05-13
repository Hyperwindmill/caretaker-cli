// Sidebar webview provider. Holds at most one ChatSessionController
// per webview view; lazy-instantiates it on the first user `start`
// after running the preconditions (workspace folder open, agent
// configured, provider known, tools resolvable).
//
// Preconditions failures become `error` events shown inline in the
// webview. No special state events yet — keep the bridge thin.

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

import * as harness from 'caretaker-cli/harness';
import { loadAgents, loadConfig } from 'caretaker-cli/store';
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

  private controller: ChatSessionController | null = null;
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
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = this.renderHtml(view.webview);

    view.onDidDispose(() => {
      this.resolveAllPending('reject');
      this.controller?.abort();
      this.controller = null;
    });

    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseViewToHost(raw);
      if (!msg) {
        console.warn('[caretaker] dropped malformed message from webview', raw);
        return;
      }
      void this.handleMessage(view.webview, msg);
    });

    this.post(view.webview, { type: 'ready' });
  }

  private async handleMessage(webview: vscode.Webview, msg: ViewToHost): Promise<void> {
    switch (msg.type) {
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
    }
  }

  private resolveAllPending(decision: ConfirmDecision): void {
    for (const resolve of this.pendingConfirms.values()) resolve(decision);
    this.pendingConfirms.clear();
  }

  private async handleStart(webview: vscode.Webview, prompt: string): Promise<void> {
    if (!this.controller) {
      const built = await this.buildController(webview);
      if (!built) return;
      this.controller = built;
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
    });
  }

  private async buildController(webview: vscode.Webview): Promise<ChatSessionController | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this.post(webview, {
        type: 'error',
        message: 'Open a folder to use Caretaker — the agent runs against the workspace root.',
      });
      return null;
    }

    let agents: AgentConfig[];
    let providers: ProviderConfig[];
    try {
      const [agentsRes, configRes] = await Promise.all([loadAgents(), loadConfig()]);
      agents = agentsRes;
      providers = configRes.providers;
    } catch (err) {
      this.post(webview, {
        type: 'error',
        message: `Failed to load Caretaker config: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }

    if (agents.length === 0) {
      this.post(webview, {
        type: 'error',
        message:
          'No agents configured. Run the Caretaker TUI (`pnpm -F caretaker-cli dev`) to create one.',
      });
      return null;
    }

    const requestedName = vscode.workspace
      .getConfiguration('caretaker')
      .get<string>('defaultAgent')
      ?.trim();
    const agent = requestedName
      ? agents.find((a) => a.name === requestedName)
      : agents[0];
    if (!agent) {
      const available = agents.map((a) => a.name).join(', ');
      this.post(webview, {
        type: 'error',
        message: `Agent "${requestedName}" not found. Available: ${available}.`,
      });
      return null;
    }

    const provider = providers.find((p) => p.name === agent.provider);
    if (!provider) {
      this.post(webview, {
        type: 'error',
        message: `Provider "${agent.provider}" for agent "${agent.name}" is missing from caretaker.json.`,
      });
      return null;
    }

    const tools = await harness.resolveAgentTools(agent, harness.tools);

    return new ChatSessionController({ agent, provider, tools, workingDir: workspaceFolder });
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
