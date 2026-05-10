import { resolveContextWindow } from '../harness/model_limits.js';
import type { AssistantUsage } from './types.js';

export type ContextUsage = {
  lastTokens: number;
  contextWindow: number | null;
  percent: number | null;
};

type Row = { role: string; usage?: AssistantUsage | null };

export function computeContextUsage(rows: Row[], model: string | null): ContextUsage | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.role !== 'assistant') continue;
    const u = r.usage;
    if (!u || typeof u !== 'object') continue;
    const total =
      (u.input ?? 0) +
      (u.output ?? 0) +
      (u.cacheRead ?? 0) +
      (u.cacheWrite ?? 0) +
      (u.reasoning ?? 0);
    if (total <= 0) continue;
    const window = model ? resolveContextWindow(model) : null;
    return {
      lastTokens: total,
      contextWindow: window,
      percent: window ? Math.round((total / window) * 100) : null,
    };
  }
  return null;
}
