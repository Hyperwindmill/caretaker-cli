// Markdown → sanitized HTML, with an LRU cache in front of the parser.
//
// Why the cache: the chat re-renders on every composer keystroke and every
// streaming chunk. Parsing every bubble again on each of those is
// O(whole conversation) work per render, which is what froze 200k-token
// sessions. Keyed on the raw content string, so a bubble that has not changed
// is a Map hit.
//
// The cache is skipped for the still-streaming bubble: each SSE token grows
// its content by one character, so caching the intermediate prefixes would
// insert one entry per token (~2000 for a single reply) and evict the whole
// conversation from a 2000-entry cache. Item/MarkdownText are memoized, so
// stable bubbles are never re-rendered — their cache entries are never
// re-touched, and an LRU would let them age out during one streaming reply.
// With streaming bubbles excluded, the cache holds only settled messages,
// which is bounded by the item count, not by the token count.

import { marked } from 'marked';

/** Strip dangerous tags/attributes while keeping formatting elements. Lightweight
 *  on purpose — not a full DOMPurify replacement, but sufficient for an AI chat
 *  whose source we control. */
function sanitize(html: string): string {
  // Remove script, style, iframe, object, embed, form, input
  const dangerous =
    /<(script|style|iframe|object|embed|form|input|button|textarea)[^>]*>.*?<\/\1>|<(script|style|iframe|object|embed|form|input|button|textarea)[^>]*>/gi;
  const sanitized = html.replace(dangerous, '');

  // Remove event handlers (onclick, onerror, etc.) and javascript: URLs
  const eventHandlers = /\s+on\w+\s*=\s*["'][^"']*["']/gi;
  const noEvents = sanitized.replace(eventHandlers, '');

  const jsUrls = /href\s*=\s*["']\s*javascript:[^"']*["']/gi;
  return noEvents.replace(jsUrls, 'href="#"');
}

// ponytail: entries keyed by the full content string; hash the key if the
// duplicated text ever costs more than the parse it saves. The limit has to
// exceed the item count of a realistic conversation, otherwise a single render
// pass evicts entries it still needs later in the same pass.
let cacheLimit = 2000;
const cache = new Map<string, string>();

/** Parse + sanitize markdown to HTML. When `useCache` is false (the
 *  still-streaming bubble) the result is computed but not stored, so growing
 *  prefixes don't evict the settled conversation. */
export function renderMarkdown(content: string, useCache = true): string {
  if (useCache) {
    const hit = cache.get(content);
    if (hit !== undefined) {
      // Map keeps insertion order: re-inserting marks this the most recent.
      cache.delete(content);
      cache.set(content, hit);
      return hit;
    }
  }
  const html = sanitize(marked.parse(content, { breaks: true, gfm: true }) as string);
  if (useCache) {
    cache.set(content, html);
    if (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }
  return html;
}

export function markdownCacheSizeForTest(): number {
  return cache.size;
}

export function resetMarkdownCacheForTest(limit = 2000): void {
  cache.clear();
  cacheLimit = limit;
}
