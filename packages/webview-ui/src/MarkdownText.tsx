// Markdown renderer. Parsing + sanitizing live in ./markdown.ts behind a cache;
// this component is memoized so an unchanged bubble is not even revisited.

import { memo } from 'react';

import { renderMarkdown } from './markdown.js';

export interface MarkdownTextProps {
  content: string;
  inline?: boolean;
}

export const MarkdownText = memo(function MarkdownText({ content, inline = false }: MarkdownTextProps) {
  const html = renderMarkdown(content);

  if (inline) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
});