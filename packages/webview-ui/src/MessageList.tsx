import { useEffect, useRef, type ReactNode } from 'react';

import type { ChatItem } from './App.js';
import { MarkdownText } from './MarkdownText.js';
import { prettyArgs, resultMetric, toolSummary } from './toolFormat.js';
import { DocIcon, ThinkingIcon, ToolIcon, SpinnerIcon, ResultArrowIcon, WarningIcon, SettingsIcon } from './icons.js';
import logo from './caretaker_cli.png';

export interface MessageListProps {
  items: ChatItem[];
  sessionId?: string | null;
  trailing?: ReactNode;
  isStreaming?: boolean;
  agentName?: string;
}

const STICK_THRESHOLD = 100;

export function MessageList({ items, sessionId = null, trailing, isStreaming, agentName }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevItemsLengthRef = useRef(items.length);
  // Whether the view is pinned to the bottom. Starts true so opening a
  // chat/task lands on the latest content; the scroll handler flips it off the
  // moment the user scrolls up, and back on when they return to the bottom.
  const stickRef = useRef(true);

  const onScroll = () => {
    const c = containerRef.current;
    if (!c) return;
    stickRef.current = c.scrollHeight - c.scrollTop - c.clientHeight <= STICK_THRESHOLD;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const grew = items.length > prevItemsLengthRef.current;
    prevItemsLengthRef.current = items.length;

    // Sending your own message re-pins to the bottom, matching every chat app.
    const lastIsUser = items.length > 0 && items[items.length - 1]!.kind === 'user';
    if (grew && lastIsUser) stickRef.current = true;

    // Otherwise only follow new content when the user is already at the bottom.
    // Scroll the container directly (not scrollIntoView, which walks every
    // scrollable ancestor and can jerk the surrounding task layout). 'auto'
    // overrides the CSS smooth-scroll so high-frequency streaming doesn't lag.
    if (stickRef.current) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
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
    <div ref={containerRef} className="messages" onScroll={onScroll}>
      {items.map((item, i) => (
        <Item key={i} item={item} sessionId={sessionId} />
      ))}
      {trailing}
      {isStreaming && (
        <div className="messages__loading-indicator">
          <img src={logo} alt="Loading" className="messages__loading-logo" />
          <span className="messages__loading-text">{agentName || 'Caretaker'} is thinking</span>
        </div>
      )}
    </div>
  );
}

function Item({ item, sessionId }: { item: ChatItem; sessionId: string | null }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="bubble bubble--user">
          <div className="bubble__role">user</div>
          <div className="bubble__text">
            <MarkdownText content={item.text} />
            {item.attachments && item.attachments.length > 0 && (
              <div className="bubble__attachments">
                {item.attachments.map((att, idx) => {
                  const isImage = att.mime.startsWith('image/');
                  const imgSrc = att.base64
                    ? `data:${att.mime};base64,${att.base64}`
                    : sessionId
                    ? `/api/attachments/${sessionId}/${att.id}`
                    : null;

                  if (isImage && imgSrc) {
                    return (
                      <img
                        key={idx}
                        className="bubble__attachment-img"
                        src={imgSrc}
                        alt={att.name || 'image'}
                      />
                    );
                  }

                  const docHref = sessionId ? `/api/attachments/${sessionId}/${att.id}` : '#';
                  return (
                    <a
                      key={idx}
                      href={docHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bubble__attachment"
                      title={att.name || att.id}
                      onClick={(e) => {
                        if (!sessionId) e.preventDefault();
                      }}
                    >
                      <span className="composer__attachment-icon"><DocIcon size={13} /></span>
                      <span className="composer__attachment-name">{att.name || att.id}</span>
                    </a>
                  );
                })}
              </div>
            )}
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
            <span className="thinking__icon"><ThinkingIcon size={14} /></span>
            <span className="thinking__title">Thinking Process</span>
            <span className="thinking__chevron"></span>
          </summary>
          <div className="thinking__content">
            <MarkdownText content={item.text} />
          </div>
        </details>
      );
    case 'tool': {
      const summary = toolSummary(item.args);
      const fullArgs = prettyArgs(item.args);
      return (
        <details className="tool">
          <summary className="tool__header">
            <span className="tool__icon"><ToolIcon size={14} /></span>
            <span className="tool__name">{item.name}</span>
            {summary && <span className="tool__args">{summary}</span>}
            <span className="tool__status">
              {item.result === null ? (
                <SpinnerIcon className="tool__spinner" size={14} />
              ) : item.result === '' ? null : (
                resultMetric(item.result)
              )}
            </span>
            <span className="tool__chevron"></span>
          </summary>
          <div className="tool__body">
            {fullArgs && <pre className="tool__args-full">{fullArgs}</pre>}
            {/* ponytail: '' result = no stored result (autonomous task tool calls); render args only */}
            {item.result !== null && item.result !== '' && (
              <div className="tool__result">
                <span className="tool__arrow"><ResultArrowIcon size={13} /></span>
                <div className="tool__result-content">
                  <MarkdownText content={item.result} />
                </div>
              </div>
            )}
          </div>
        </details>
      );
    }
    case 'notice':
      return (
        <div className={`notice${item.variant === 'block' ? ' notice--block' : ''}`}>
          {item.variant === 'block' ? <WarningIcon size={12} /> : <SettingsIcon size={12} />}
          <MarkdownText content={item.text} />
        </div>
      );
  }
}
