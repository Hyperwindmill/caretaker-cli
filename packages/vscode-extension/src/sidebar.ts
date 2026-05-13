// Sidebar webview provider. Wires the bridge: receives `ViewToHost`
// messages from the webview, validates them, and dispatches. Sends
// `HostToView` messages back via `webview.postMessage`. This file owns
// HTML/CSP rendering; the React UI lives in src/webview/.
//
// Step 4 scope: echo only. A `start` from the webview triggers a
// fixed `chunk` + `done` response, no harness yet. Steps 5+ wire in
// ChatSessionController and harness.run().

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

import { parseViewToHost, type HostToView, type ViewToHost } from './bridge.js';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'caretaker.chatView';

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

    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseViewToHost(raw);
      if (!msg) {
        console.warn('[caretaker] dropped malformed message from webview', raw);
        return;
      }
      this.handleMessage(view.webview, msg);
    });

    this.post(view.webview, { type: 'ready' });
  }

  private handleMessage(webview: vscode.Webview, msg: ViewToHost): void {
    switch (msg.type) {
      case 'start':
        this.echo(webview, msg.prompt);
        return;
      case 'abort':
        // Step 4 has no in-flight work to abort; ignore.
        return;
      case 'permission_response':
        // No outstanding permission requests in the echo flow; ignore.
        return;
    }
  }

  private echo(webview: vscode.Webview, prompt: string): void {
    this.post(webview, { type: 'chunk', text: `echo: ${prompt}` });
    this.post(webview, { type: 'done' });
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
