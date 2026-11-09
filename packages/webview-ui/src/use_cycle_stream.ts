import { useEffect, useReducer, useRef } from 'react';
import type { HostToView } from './bridge.js';
import { chatReducer, initialChatState } from './chat_state.js';

/** Follows one live stream (a task cycle or a service run) keyed by `id`:
 *  `watch` asks the host for the replay, `unwatch` runs on unmount, `onDone`
 *  on the terminal `done` event. Callbacks are held in refs, so callers may
 *  pass fresh closures every render without re-watching. */
export function useCycleStream(id: string, handlers: { watch: () => void; unwatch: () => void; onDone: () => void }) {
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    function handle(event: MessageEvent<unknown>): void {
      const msg = event.data as HostToView;
      if (!msg || typeof msg !== 'object' || !('type' in msg) || !('sessionId' in msg)) return;
      if (msg.sessionId !== id) return;
      if (msg.type === 'cycleLoaded') {
        dispatch({ kind: 'load-history', messages: msg.messages, streaming: msg.running });
        return;
      }
      if (msg.type !== 'cycleEvent') return;
      const ev = msg.event;
      switch (ev.type) {
        case 'user':
          dispatch({ kind: 'send-user', text: ev.text });
          return;
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
          ref.current.onDone();
          return;
        case 'error':
          dispatch({ kind: 'error', text: ev.message });
          return;
      }
    }
    window.addEventListener('message', handle);
    ref.current.watch();
    return () => {
      window.removeEventListener('message', handle);
      ref.current.unwatch();
    };
  }, [id]);

  return chat;
}
