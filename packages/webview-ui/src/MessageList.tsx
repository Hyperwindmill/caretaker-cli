import { memo, useEffect, useRef, useState, type ReactNode } from 'react';

import type { ChatItem } from './App.js';
import { MarkdownText } from './MarkdownText.js';
import { prettyArgs, popoverPosition, resultMetric, toolSummary } from './toolFormat.js';
import { DocIcon, ThinkingIcon, ToolIcon, SpinnerIcon, ResultArrowIcon, WarningIcon, SettingsIcon } from './icons.js';
import logo from './caretaker_cli.png';

export interface MessageListProps {
  items: ChatItem[];
  sessionId?: string | null;
  trailing?: ReactNode;
  isStreaming?: boolean;
  agentName?: string;
  /** Task log: render tool calls as compact left-aligned bubbles (no persisted
   *  results there), instead of full-width <details> blocks. */
  compact?: boolean;
}

const STICK_THRESHOLD = 100;

/** Memoized: the composer draft lives in `App` state, so this list re-renders on
 *  every keystroke unless it can bail out. That bail-out only works while callers
 *  keep `items` and `trailing` reference-stable — pass a `useMemo`'d array, never
 *  one built inline in JSX.
 *  ponytail: memoization + a cached parser, no virtualization. If a conversation
 *  ever gets heavy enough that the DOM itself is the bottleneck, the escalation is
 *  `content-visibility` on the heavy blocks first, a windowing library only after. */
export const MessageList = memo(function MessageList({
  items,
  sessionId = null,
  trailing,
  isStreaming,
  agentName,
  compact = false,
}: MessageListProps) {
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
        <Item key={i} item={item} sessionId={sessionId} compact={compact} />
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
});

// A closed <details> still mounts its children in React; tool results are the
// biggest strings in a long conversation, so keep them out of the DOM (and out
// of the markdown parser) until the user actually opens the block.
const ToolBlock = memo(function ToolBlock({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(item.args);
  const fullArgs = prettyArgs(item.args);
  return (
    <details className="tool" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
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
      {open && (
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
      )}
    </details>
  );
});

// Compact left-aligned "chip" rendering of a tool call for the task log, where
// results are not persisted so a full-width block per call is pure noise. The
// full args live in a hover/focus PREVIEW and a click-to-PIN popover that must
// escape `.messages`' overflow clip (overflow-y:auto forces overflow-x to auto,
// clipping both axes), so it is position:fixed and anchored to the chip's
// measured rect via popoverPosition().
const ToolBubble = memo(function ToolBubble({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const chipRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const summary = toolSummary(item.args);
  const fullArgs = prettyArgs(item.args);
  const hasResult = item.result !== null && item.result !== '';
  const hasDetail = Boolean(fullArgs) || hasResult;
  const open = hasDetail && (hovering || pinned);

  // Keep the fixed popover glued while open: re-measure the chip on scroll
  // (capture phase, so it catches the inner .messages scroller) and on resize.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      if (chipRef.current) setRect(chipRef.current.getBoundingClientRect());
    };
    measure();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setHovering(false);
      }
    };
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Dismiss a pinned popover on an outside click.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (chipRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      setPinned(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [pinned]);

  const pos = open && rect ? popoverPosition(rect, window.innerWidth, window.innerHeight) : null;

  return (
    <div className="tool-bubble-wrap">
      <div
        ref={chipRef}
        className={`tool-bubble${open ? ' tool-bubble--open' : ''}`}
        tabIndex={hasDetail ? 0 : -1}
        role={hasDetail ? 'button' : undefined}
        aria-expanded={hasDetail ? open : undefined}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        onClick={() => hasDetail && setPinned((p) => !p)}
        onKeyDown={(e) => {
          if (hasDetail && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setPinned((p) => !p);
          }
        }}
      >
        <span className="tool-bubble__icon"><ToolIcon size={12} /></span>
        <span className="tool-bubble__name">{item.name}</span>
        {summary && <span className="tool-bubble__summary">{summary}</span>}
        <span className="tool-bubble__status">
          {item.result === null ? (
            <SpinnerIcon className="tool__spinner" size={12} />
          ) : hasResult ? (
            resultMetric(item.result as string)
          ) : null}
        </span>
      </div>
      {pos && (
        <div
          ref={popoverRef}
          className={`tool-bubble__popover${pinned ? ' tool-bubble__popover--pinned' : ''}`}
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            maxWidth: pos.maxWidth,
            pointerEvents: pinned ? 'auto' : 'none',
          }}
        >
          {fullArgs && <pre className="tool-bubble__args">{fullArgs}</pre>}
          {hasResult && (
            <div className="tool-bubble__result">
              <MarkdownText content={item.result as string} />
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const Item = memo(function Item({
  item,
  sessionId,
  compact,
}: {
  item: ChatItem;
  sessionId: string | null;
  compact: boolean;
}) {
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
          <div className="bubble__role">{item.label || 'assistant'}</div>
          <div className="bubble__text">
            <MarkdownText content={item.text} cache={!item.streaming} />
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
            {/* cache=false: thinking items stream via append-thinking (one
                growing-prefix key per SSE delta), so caching them would evict
                the settled conversation — same failure mode as streaming
                assistant bubbles. A settled thinking item is never re-parsed
                anyway because Item is memoized. */}
            <MarkdownText content={item.text} cache={false} />
          </div>
        </details>
      );
    case 'tool':
      return compact ? <ToolBubble item={item} /> : <ToolBlock item={item} />;
    case 'notice':
      return (
        <div className={`notice${item.variant === 'block' ? ' notice--block' : ''}`}>
          {item.variant === 'block' ? <WarningIcon size={12} /> : <SettingsIcon size={12} />}
          <MarkdownText content={item.text} />
        </div>
      );
  }
});
