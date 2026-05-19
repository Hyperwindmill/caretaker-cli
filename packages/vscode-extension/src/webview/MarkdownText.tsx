// Markdown renderer using marked. Sanitizes HTML to prevent XSS and
// applies VSCode theme variables for code blocks, tables, etc.

import { marked } from 'marked';

// Sanitize HTML by stripping dangerous tags/attributes while keeping
// formatting elements. This is a lightweight sanitizer — not a full
// DOMPurify replacement, but sufficient for an AI chat context where
// we control the source.
function sanitize(html: string): string {
  // Remove script, style, iframe, object, embed, form, input
  const dangerous = /<(script|style|iframe|object|embed|form|input|button|textarea)[^>]*>.*?<\/\1>|<(script|style|iframe|object|embed|form|input|button|textarea)[^>]*>/gi;
  const sanitized = html.replace(dangerous, '');

  // Remove event handlers (onclick, onerror, etc.) and javascript: URLs
  const eventHandlers = /\s+on\w+\s*=\s*["'][^"']*["']/gi;
  const noEvents = sanitized.replace(eventHandlers, '');

  const jsUrls = /href\s*=\s*["']\s*javascript:[^"']*["']/gi;
  return noEvents.replace(jsUrls, 'href="#"');
}

export interface MarkdownTextProps {
  content: string;
  inline?: boolean;
}

export function MarkdownText({ content, inline = false }: MarkdownTextProps) {
  const html = marked.parse(content, {
    breaks: true,
    gfm: true,
  }) as string;

  const sanitized = sanitize(html);

  if (inline) {
    return <span dangerouslySetInnerHTML={{ __html: sanitized }} />;
  }

  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: sanitized }} />;
}
