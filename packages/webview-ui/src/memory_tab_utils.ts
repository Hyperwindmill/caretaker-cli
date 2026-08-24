// Pure logic for the Memory settings tab. Kept out of the component so the
// form → MemoryConfig mapping is unit-testable (repo convention).

import type { MemoryConfig } from 'caretaker-types';

/** Form state → MemoryConfig to persist. `undefined` = subsystem off (the
 *  `memory` key is removed from the config). Blank or invalid numeric fields
 *  are omitted so the daemon's defaults (5 min / 4 messages) apply. */
export function buildMemoryConfig(form: {
  enabled: boolean;
  agentId: string;
  sweepMinutes: string;
  minNewMessages: string;
}): MemoryConfig | undefined {
  const agentId = form.agentId.trim();
  if (!form.enabled || !agentId) return undefined;
  const out: MemoryConfig = { agentId };
  const sweep = Number.parseInt(form.sweepMinutes, 10);
  if (Number.isFinite(sweep) && sweep > 0) out.sweepMinutes = sweep;
  const min = Number.parseInt(form.minNewMessages, 10);
  if (Number.isFinite(min) && min > 0) out.minNewMessages = min;
  return out;
}

/** Stable signature of the persisted shape — the Saved ✓ badge flips only
 *  when the config prop reflects what this form submitted (voiceSignature
 *  pattern). '' = memory off. */
export function memorySignature(m: Record<string, unknown> | undefined | null): string {
  if (!m) return '';
  return JSON.stringify([m.agentId ?? '', m.sweepMinutes ?? '', m.minNewMessages ?? '']);
}
