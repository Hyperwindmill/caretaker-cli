// Markdown renderer. Parsing + sanitizing live in ./markdown.ts behind a cache;
// this component is memoized so an unchanged bubble is not even revisited.

import { memo } from 'react';

import { renderMarkdown } from './markdown.js';

export interface MarkdownTextProps {
  content: string;
  inline?: boolean;
  /** When false (the still-streaming bubble) the parsed HTML is not cached, so
   *  growing prefixes don't evict the settled conversation. Default true. */
  cache?: boolean;
}

export const MarkdownText = memo(function MarkdownText({ content, inline = false, cache = true }: MarkdownTextProps) {
  const html = renderMarkdown(content, cache);

  if (inline) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
});
