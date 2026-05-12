// VSCode extension entry. MVP scaffold: resolves CARETAKER_HOME from
// (env > setting > default), imports the caretaker-cli harness to prove
// the embedding path works, and registers a placeholder command. The
// chat sidebar webview comes in the next step.

import * as vscode from 'vscode';

import * as harness from 'caretaker-cli/harness';

import { resolveCaretakerHome } from './config.js';

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

  context.subscriptions.push(
    vscode.commands.registerCommand('caretaker.openChat', () => {
      vscode.window.showInformationMessage(
        `Caretaker chat sidebar is not implemented yet (CARETAKER_HOME=${home}).`,
      );
    }),
  );
}

export function deactivate(): void {
  // No long-running state in this scaffold yet.
}
