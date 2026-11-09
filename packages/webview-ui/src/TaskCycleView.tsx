import type { ViewToHost } from './bridge.js';
import type { CycleItem } from './chat_state.js';
import { useCycleStream } from './use_cycle_stream.js';
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
  const { sessionId, agentId } = item;
  const chat = useCycleStream(sessionId, {
    watch: () => postMessage({ type: 'watchCycle', agentId, sessionId }),
    unwatch: () => postMessage({ type: 'unwatchCycle', sessionId }),
    // The recap is persisted before `done`: reload the finished session from disk.
    onDone: () => postMessage({ type: 'watchCycle', agentId, sessionId }),
  });

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
