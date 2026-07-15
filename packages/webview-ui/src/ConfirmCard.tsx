// Tri-state confirm card shown inline at the bottom of the message
// list when the harness has requested permission for a `[!]`-gated
// tool. Mirrors the TUI labels: Run once / Always (this session) /
// Reject — same vocabulary the harness ConfirmDecision uses.

import type { ConfirmDecision } from './bridge.js';
import type { PendingConfirm } from './App.js';
import { LockIcon } from './icons.js';

export interface ConfirmCardProps {
  pending: PendingConfirm;
  onDecide: (id: string, decision: ConfirmDecision) => void;
}

export function ConfirmCard({ pending, onDecide }: ConfirmCardProps) {
  const argsText = previewJson(pending.args);
  return (
    <div className="confirm">
      <div className="confirm__header">
        <span className="confirm__icon"><LockIcon size={14} /></span>
        <span className="confirm__prompt">
          Allow <code className="confirm__tool">{pending.toolName}</code>?
        </span>
      </div>
      {argsText && <pre className="confirm__args">{argsText}</pre>}
      <div className="confirm__buttons">
        <button
          className="confirm__btn confirm__btn--primary"
          onClick={() => onDecide(pending.id, 'once')}
        >
          Run once
        </button>
        <button className="confirm__btn" onClick={() => onDecide(pending.id, 'always')}>
          Always (this chat)
        </button>
        <button
          className="confirm__btn confirm__btn--danger"
          onClick={() => onDecide(pending.id, 'reject')}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function previewJson(value: unknown, max = 400): string {
  try {
    const s = JSON.stringify(value, null, 2);
    if (s === undefined) return '';
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return '';
  }
}
