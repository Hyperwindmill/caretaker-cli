import { useEffect, useRef, type ReactNode } from 'react';

import type { ChatItem } from './App.js';
import { MarkdownText } from './MarkdownText.js';
import logo from './caretaker_cli.png';

export interface MessageListProps {
  items: ChatItem[];
  trailing?: ReactNode;
  isStreaming?: boolean;
  agentName?: string;
}

export function MessageList({ items, trailing, isStreaming, agentName }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevItemsLengthRef = useRef(items.length);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isNewMessage = items.length > prevItemsLengthRef.current;
    prevItemsLengthRef.current = items.length;

    // Check if the user is close to the bottom (within 100px)
    const threshold = 100;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;

    if (isNewMessage || isNearBottom) {
      // Use 'smooth' scroll when a new distinct message is added and we are not in streaming mode.
      // Use 'auto' scroll during high-frequency streaming to prevent animation lag.
      const behavior = isNewMessage && !isStreaming ? 'smooth' : 'auto';
      bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
    }
  }, [items, trailing, isStreaming]);

  if (items.length === 0 && !trailing && !isStreaming) {
    return (
      <div className="messages messages--empty">
        <p>Send a message to start.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="messages">
      {items.map((item, i) => (
        <Item key={i} item={item} />
      ))}
      {trailing}
      {isStreaming && (
        <div className="messages__loading-indicator">
          <img src={logo} alt="Loading" className="messages__loading-logo" />
          <span className="messages__loading-text">{agentName || 'Caretaker'} is thinking</span>
        </div>
      )}
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
            <MarkdownText content={item.text} />
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
