import type { ChatCallbacks } from './server.js';

/** Silence a chat turn once it is superseded. Dropping the controller
 *  (new session, agent switch) does not stop its run, and the run's callbacks
 *  post straight to the socket — without this, a still-streaming turn keeps
 *  writing chunks, `done` and confirm cards into the session that replaced
 *  it. The old run keeps going; only its output is cut. A superseded turn's
 *  confirmations resolve `reject`: nobody can answer them any more. */
export function guardTurnCallbacks(cb: ChatCallbacks, isCurrent: () => boolean): ChatCallbacks {
  return {
    onChunk: (t) => isCurrent() && cb.onChunk(t),
    onThinking: (t) => isCurrent() && cb.onThinking(t),
    onToolCall: (id, name, args) => isCurrent() && cb.onToolCall(id, name, args),
    onToolResult: (id, content) => isCurrent() && cb.onToolResult(id, content),
    askConfirm: (id, toolName, args) =>
      isCurrent() ? cb.askConfirm(id, toolName, args) : Promise.resolve('reject'),
    onError: (m) => isCurrent() && cb.onError(m),
    onDone: () => isCurrent() && cb.onDone(),
    onSessionCreated: (id) => isCurrent() && cb.onSessionCreated?.(id),
  };
}
