// Pure logic for the Desktop settings tab (memory_tab_utils pattern).

import type { DesktopAssistantConfig } from 'caretaker-types';

export const DEFAULT_ASSISTANT_SHORTCUT = 'CommandOrControl+Shift+Space';

/** Form state → config to persist. `undefined` = feature off (the
 *  `desktopAssistant` key is removed). Blank shortcut → the default. */
export function buildDesktopAssistantConfig(form: {
  enabled: boolean;
  agentId: string;
  shortcut: string;
}): DesktopAssistantConfig | undefined {
  const agentId = form.agentId.trim();
  if (!form.enabled || !agentId) return undefined;
  return { agentId, shortcut: form.shortcut.trim() || DEFAULT_ASSISTANT_SHORTCUT };
}

/** Stable signature for the Saved ✓ badge. '' = feature off. */
export function desktopAssistantSignature(c: Record<string, unknown> | undefined | null): string {
  if (!c) return '';
  return JSON.stringify([c.agentId ?? '', c.shortcut ?? '']);
}
