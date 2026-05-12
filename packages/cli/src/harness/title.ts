// One-shot title generator: a hidden non-streaming chat completion request
// that asks the agent's own model to summarize the first turn into a 5–7
// word chat title. Used as fire-and-forget after the first successful turn
// of a freshly created session — failure leaves the fallback title in place
// (no UI surfacing, no retry).

import type { AgentConfig, ProviderConfig } from '../types.js';

const TITLE_INSTRUCTION =
  'Summarize this conversation in 5–7 words for a chat title. ' +
  'Reply with only the title — no quotes, no leading/trailing punctuation, no prefix.';

export interface GenerateTitleInput {
  agent: AgentConfig;
  provider: ProviderConfig;
  firstUserPrompt: string;
  firstAssistantText: string;
  /** Caller-provided abort. Independent of our 15s internal timeout. */
  signal?: AbortSignal;
}

/** Returns the cleaned title, or null on any failure (network, non-OK,
 *  empty response, parse error). The session keeps its fallback title in
 *  that case — title generation is best-effort. */
export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const { agent, provider, firstUserPrompt, firstAssistantText, signal } = input;
  if (!firstUserPrompt.trim() && !firstAssistantText.trim()) return null;

  const baseUrl = provider.endpoint.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const body = {
    model: agent.model,
    stream: false,
    messages: [
      { role: 'user', content: firstUserPrompt },
      { role: 'assistant', content: firstAssistantText },
      { role: 'user', content: TITLE_INSTRUCTION },
    ],
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  const onParentAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onParentAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const raw = json?.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    return cleanTitle(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

/** Strip surrounding quotes/asterisks, trailing period, collapse whitespace,
 *  cap length. Exported for unit testing. */
export function cleanTitle(s: string): string {
  let out = s.trim();
  // Drop surrounding decorations: quotes, backticks, markdown emphasis.
  out = out.replace(/^["'`*_]+/, '').replace(/["'`*_]+$/, '');
  // Drop a single trailing period — but not "..." which models sometimes use.
  if (out.endsWith('.') && !out.endsWith('..')) out = out.slice(0, -1);
  // Collapse internal whitespace.
  out = out.replace(/\s+/g, ' ').trim();
  // Cap length so the list view stays tidy.
  if (out.length > 80) out = out.slice(0, 79) + '…';
  return out;
}
