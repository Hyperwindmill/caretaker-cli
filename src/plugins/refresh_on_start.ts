// Refresh-on-start: at app boot, kick a parallel refresh for every source
// flagged with refreshOnStart=true and resolve when they all settle.
//
// Callers fire this in the background — startup must not block on a slow
// git fetch. The next agent run picks up the freshly-discovered plugins
// automatically because the skill loader reads plugins.json each time.

import { listSources, refreshSource, type RefreshOutcome } from "./source_manager.js";

export interface RefreshOnStartResult {
  sourceId: string;
  outcome: RefreshOutcome;
}

export async function refreshSourcesOnStart(): Promise<RefreshOnStartResult[]> {
  let sources;
  try {
    sources = await listSources();
  } catch (err) {
    console.error("[refresh-on-start] failed to read plugins.json:", err);
    return [];
  }
  const targets = sources.filter((s) => s.refreshOnStart);
  if (targets.length === 0) return [];

  const results = await Promise.all(
    targets.map(async (s): Promise<RefreshOnStartResult> => {
      try {
        const outcome = await refreshSource(s.id);
        if (outcome.error) {
          console.error(`[refresh-on-start] ${s.url}: ${outcome.error}`);
        }
        return { sourceId: s.id, outcome };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refresh-on-start] ${s.url}: ${msg}`);
        return { sourceId: s.id, outcome: { pluginsFound: 0, sha: null, error: msg } };
      }
    }),
  );
  return results;
}
