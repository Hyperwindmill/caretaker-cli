// Desktop assistant helpers for the Electron main process. No Electron
// imports on purpose: plain Node, so the logic stays small and checkable.
// See docs/superpowers/specs/2026-11-07-desktop-assistant-design.md

import fs from "node:fs";
import path from "node:path";

export type AssistantConfig = { agentId: string; shortcut: string };

/** `desktopAssistant` from `<dataDir>/caretaker.json`, or null when the
 *  feature is off: missing file, bad JSON, missing block, or blank agentId.
 *  Never throws — a broken config must not stop the app from booting. */
export function readAssistantConfig(dataDir: string): AssistantConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "caretaker.json"), "utf-8"));
    const block = raw?.desktopAssistant;
    const agentId = typeof block?.agentId === "string" ? block.agentId.trim() : "";
    if (!agentId) return null;
    const shortcut = typeof block.shortcut === "string" ? block.shortcut.trim() : "";
    return { agentId, shortcut };
  } catch {
    return null;
  }
}

/** JS source run in the page: hands `assistantActivate` to the webview the
 *  same way standalone.tsx hands it WebSocket frames (a window message). It
 *  also leaves the request on `window.__caretakerAssistant`, because on a
 *  first launch the app mounts only after its WebSocket connects — after
 *  did-finish-load — and would miss the event; the app reads and clears it. */
export function activationScript(agentId: string): string {
  const id = JSON.stringify(agentId);
  const data = JSON.stringify({ type: "assistantActivate", agentId });
  return `window.__caretakerAssistant = ${id}; window.dispatchEvent(new MessageEvent('message', { data: ${data} }))`;
}

export function hasAssistantFlag(argv: readonly string[]): boolean {
  return argv.includes("--assistant");
}
