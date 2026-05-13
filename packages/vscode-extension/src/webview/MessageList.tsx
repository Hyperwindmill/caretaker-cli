import { useEffect, useRef } from 'react';

import type { ChatMessage } from './App.js';

export interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="messages messages--empty">
        <p>Send a message to start.</p>
      </div>
    );
  }

  return (
    <div className="messages">
      {messages.map((m, i) => (
        <div key={i} className={`bubble bubble--${m.role}`}>
          <div className="bubble__role">{m.role}</div>
          <div className="bubble__text">
            {m.text}
            {m.role === 'assistant' && m.streaming && <span className="bubble__caret">▌</span>}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
