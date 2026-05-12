const MODELS_DEV_URL = 'https://models.dev/api.json';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

let registry: Map<string, number> = new Map();
let refreshTimer: NodeJS.Timeout | null = null;

type ModelsDevModel = { id?: string; limit?: { context?: number; output?: number } };
type ModelsDevProvider = { id?: string; models?: Record<string, ModelsDevModel> };
type ModelsDevApi = Record<string, ModelsDevProvider>;

/** Flatten the models.dev API JSON into a flat `model_id → context_tokens` map. */
export function parseModelsDevApi(api: ModelsDevApi): Map<string, number> {
  const out = new Map<string, number>();
  for (const provider of Object.values(api ?? {})) {
    const models = provider?.models ?? {};
    for (const [id, m] of Object.entries(models)) {
      const ctx = m?.limit?.context;
      if (typeof ctx === 'number' && ctx > 0) out.set(id, ctx);
    }
  }
  return out;
}

async function fetchOnce(): Promise<Map<string, number> | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(MODELS_DEV_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = (await res.json()) as ModelsDevApi;
    return parseModelsDevApi(json);
  } catch {
    return null;
  }
}

/** Populate the registry from models.dev. Idempotent; safe to call multiple times.
 *  On failure, the existing cache (possibly empty) is retained. */
export async function refreshModelLimits(): Promise<void> {
  const fresh = await fetchOnce();
  if (fresh && fresh.size > 0) registry = fresh;
}

/** Boot-time hook: kicks off a background refresh and schedules a periodic one.
 *  Awaits nothing; the meter degrades gracefully until the first fetch lands. */
export function initModelLimits(): void {
  void refreshModelLimits();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshModelLimits();
  }, REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

export function resolveContextWindow(model: string): number | null {
  const direct = registry.get(model);
  if (typeof direct === 'number' && direct > 0) return direct;
  const stripped = model.replace(/[-:]cloud$/, '');
  if (stripped !== model) {
    const fallback = registry.get(stripped);
    if (typeof fallback === 'number' && fallback > 0) return fallback;
  }
  return null;
}

/** Test hook — replace the in-memory registry directly. */
export function __setRegistryForTesting(map: Map<string, number>): void {
  registry = map;
}
