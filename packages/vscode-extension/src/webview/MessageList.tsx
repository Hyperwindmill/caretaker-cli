import { useEffect, useRef, type ReactNode } from 'react';

import type { ChatItem } from './App.js';
import { MarkdownText } from './MarkdownText.js';

export interface MessageListProps {
  items: ChatItem[];
  trailing?: ReactNode;
}

export function MessageList({ items, trailing }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [items, trailing]);

  if (items.length === 0 && !trailing) {
    return (
      <div className="messages messages--empty">
        <p>Send a message to start.</p>
      </div>
    );
  }

  return (
    <div className="messages">
      {items.map((item, i) => (
        <Item key={i} item={item} />
      ))}
      {trailing}
      <div ref={bottomRef} />
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="bubble bubble--user">
          <div className="bubble__role">user</div>
          <div className="bubble__text">
            <MarkdownText content={item.text} inline />
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="bubble bubble--assistant">
          <div className="bubble__role">assistant</div>
          <div className="bubble__text">
            <MarkdownText content={item.text} />
            {item.streaming && <span className="bubble__caret">▌</span>}
          </div>
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking" open>
          <summary className="thinking__header">
            <span className="thinking__icon">🧠</span>
            <span className="thinking__title">Thinking Process</span>
            <span className="thinking__chevron"></span>
          </summary>
          <div className="thinking__content">
            <MarkdownText content={item.text} />
          </div>
        </details>
      );
    case 'tool': {
      const argsPreview = previewJson(item.args);
      return (
        <div className="tool">
          <div className="tool__header">
            <span className="tool__icon">⚒</span>
            <span className="tool__name">{item.name}</span>
            <span className="tool__args">{argsPreview}</span>
          </div>
          {item.result !== null && (
            <div className="tool__result">
              <span className="tool__arrow">↳</span>
              <div className="tool__result-content">
                <MarkdownText content={item.result} />
              </div>
            </div>
          )}
        </div>
      );
    }
  }
}

function previewJson(value: unknown, max = 80): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return '';
    return truncate(s, max);
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
