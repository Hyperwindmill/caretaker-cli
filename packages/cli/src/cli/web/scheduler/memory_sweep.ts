// Memory sweep — step 1 of the memory subsystem: a periodic pass over all
// chat sessions maintaining, per session, a cursor (last processed message)
// and a rolling summary produced by a dedicated model. The session_digests
// collection is a regenerable cache: dropping it costs one full re-scan.
// Design: docs/superpowers/specs/2026-08-24-memory-daemon-step1-design.md

import type { CaretakerConfig, ProviderConfig } from '../../../types.js';

export const DEFAULT_SWEEP_MINUTES = 5;
export const DEFAULT_MIN_NEW_MESSAGES = 4;
export const MAX_CALLS_PER_SWEEP = 10;
export const MAX_CHUNK_CHARS = 20_000;
export const MAX_TOOL_RESULT_CHARS = 500;
export const MAX_SUMMARY_CHARS = 4_000;

export interface ResolvedMemoryConfig {
  provider: ProviderConfig;
  model: string;
  sweepMinutes: number;
  minNewMessages: number;
}

/** null = subsystem off (unset/incomplete config, unknown provider, or a
 *  claude-code provider — no HTTP endpoint for fresh calls). */
export function resolveMemoryConfig(config: CaretakerConfig): ResolvedMemoryConfig | null {
  const m = config.memory;
  if (!m?.provider || !m.model) return null;
  const provider = (config.providers || []).find((p) => p.name === m.provider);
  if (!provider || provider.type === 'claude-code') return null;
  return {
    provider,
    model: m.model,
    sweepMinutes: m.sweepMinutes ?? DEFAULT_SWEEP_MINUTES,
    minNewMessages: m.minNewMessages ?? DEFAULT_MIN_NEW_MESSAGES,
  };
}
