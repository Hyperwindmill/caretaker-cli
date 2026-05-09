// Ported from caretaker server's src/api/models.ts (fetchOpenAiStyleModels).
// Queries /v1/models on an OpenAI-compatible provider; returns the list of ids
// or a structured error. 5s timeout.

export type ModelsResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

export async function fetchOpenAiStyleModels(
  baseUrl: string,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<ModelsResult> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${normalized}/v1/models`, { headers, signal: ac.signal });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 512);
      return { ok: false, error: `Provider returned ${res.status}: ${text}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      return {
        ok: false,
        error: `Provider at ${normalized}/v1/models did not return JSON (content-type: ${contentType || "unknown"}). First bytes: ${text.replace(/\s+/g, " ")}`,
      };
    }
    const payload = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (payload.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, ids };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to fetch models: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
