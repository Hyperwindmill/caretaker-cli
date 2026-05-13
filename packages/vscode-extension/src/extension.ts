// VSCode extension entry. Resolves CARETAKER_HOME from
// (env > setting > default), imports caretaker-cli/harness as a
// load-time smoke check, and registers the sidebar chat webview
// provider. Step 4: the webview is wired with an echo bridge — no
// harness invocation yet.

import * as vscode from 'vscode';

import * as harness from 'caretaker-cli/harness';

import { resolveCaretakerHome } from './config.js';
import { SidebarWebviewProvider } from './sidebar.js';

export function activate(context: vscode.ExtensionContext): void {
  const home = resolveCaretakerHome({
    envValue: process.env.CARETAKER_HOME,
    settingValue: vscode.workspace.getConfiguration('caretaker').get<string>('home'),
  });
  process.env.CARETAKER_HOME = home;

  // Touch the harness barrel so esbuild keeps the import and we get a
  // real load-time failure if the public API surface drifts.
  const toolCount = harness.tools.list().length;

  console.log(`[caretaker] activated. CARETAKER_HOME=${home} tools=${toolCount}`);

  const sidebar = new SidebarWebviewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarWebviewProvider.viewId, sidebar),
    vscode.commands.registerCommand('caretaker.openChat', () => {
      void vscode.commands.executeCommand('workbench.view.extension.caretaker');
    }),
  );
}

export function deactivate(): void {
  // No long-running state in this scaffold yet.
}
