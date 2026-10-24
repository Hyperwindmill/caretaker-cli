import { useEffect, useReducer, useRef } from 'react';
import type { HostToView, ViewToHost } from './bridge.js';
import { chatReducer, initialChatState, type CycleItem } from './chat_state.js';
import { MessageList } from './MessageList.js';
import { cycleOutcomeLabel, cycleRoleLabel } from './task_timeline.js';
import { BackIcon } from './icons.js';

export interface TaskCycleViewProps {
  item: CycleItem;
  postMessage: (msg: ViewToHost) => void;
  onBack: () => void;
}

/** One task cycle, full pane: the cycle's own chat session, replayed from the
 *  host and followed live. Same reducer and renderer as the main chat. */
export function TaskCycleView({ item, postMessage, onBack }: TaskCycleViewProps) {
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const { sessionId, agentId } = item;
  // Held in a ref: callers pass a new postMessage closure on most renders, and
  // a changed dependency would unwatch and re-watch the cycle each time.
  const postRef = useRef(postMessage);
  postRef.current = postMessage;

  useEffect(() => {
    function handle(event: MessageEvent<unknown>): void {
      const msg = event.data as HostToView;
      if (!msg || typeof msg !== 'object' || !('type' in msg) || !('sessionId' in msg)) return;
      if (msg.sessionId !== sessionId) return;
      if (msg.type === 'cycleLoaded') {
        dispatch({ kind: 'load-history', messages: msg.messages, streaming: msg.running });
        return;
      }
      if (msg.type !== 'cycleEvent') return;
      const ev = msg.event;
      switch (ev.type) {
        case 'chunk':
          dispatch({ kind: 'append-chunk', text: ev.text });
          return;
        case 'thinking':
          dispatch({ kind: 'append-thinking', text: ev.text });
          return;
        case 'tool_call':
          dispatch({ kind: 'tool-call', id: ev.id, name: ev.name, args: ev.args });
          return;
        case 'tool_result':
          dispatch({ kind: 'tool-result', id: ev.id, content: ev.content });
          return;
        case 'done':
          dispatch({ kind: 'done' });
          // The recap is persisted before `done`: reload the finished session from disk.
          postRef.current({ type: 'watchCycle', agentId, sessionId });
          return;
        case 'error':
          dispatch({ kind: 'error', text: ev.message });
          return;
      }
    }
    window.addEventListener('message', handle);
    postRef.current({ type: 'watchCycle', agentId, sessionId });
    return () => {
      window.removeEventListener('message', handle);
      postRef.current({ type: 'unwatchCycle', sessionId });
    };
  }, [sessionId, agentId]);

  const running = chat.status === 'streaming';
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <header className="app__chat-header task-view__sub-header" style={{ padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button className="settings-panel__back-btn" onClick={onBack} title="Back to the task thread">
            <BackIcon size={13} />
          </button>
          <div className="app__chat-header-info">
            <h3 className="app__chat-header-title" style={{ fontSize: '13px', margin: 0 }}>
              {cycleRoleLabel(item.role)} cycle{item.label ? ` · ${item.label}` : ''}
            </h3>
            <span className="app__chat-header-status" style={{ fontSize: '10px' }}>
              {running ? 'running' : cycleOutcomeLabel(item.outcome)}
            </span>
          </div>
        </div>
      </header>
      <MessageList items={chat.items} sessionId={null} isStreaming={running} agentName={item.label} />
      {chat.errorText && <div className="notice notice--block">{chat.errorText}</div>}
    </div>
  );
}
