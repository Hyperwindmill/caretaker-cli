// Webview entry. Mounts React into #root and wires the bridge by
// exposing a thin `vscode` object obtained from `acquireVsCodeApi`
// (a single-call API VSCode injects into the webview global scope).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

declare global {
  interface Window {
    acquireVsCodeApi: <T = unknown>() => {
      postMessage(msg: unknown): void;
      getState(): T | undefined;
      setState(state: T): void;
    };
  }
}

const vscode = window.acquireVsCodeApi();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App postMessage={(m) => vscode.postMessage(m)} />
  </StrictMode>,
);
