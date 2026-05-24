import { useState, type KeyboardEvent } from 'react';
import type { ContextUsage } from './bridge.js';

export interface ComposerProps {
  disabled: boolean;
  canAbort: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  contextUsage: ContextUsage | null;
}

export function Composer({ disabled, canAbort, onSend, onAbort, contextUsage }: ComposerProps) {
  const [value, setValue] = useState('');

  const send = (): void => {
    onSend(value);
    setValue('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer__input"
        value={value}
        placeholder="Message Caretaker..."
        rows={2}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer__controls">
        <div className="composer__usage">
          {contextUsage && (
            <>
              {contextUsage.contextWindow !== null && contextUsage.percent !== null ? (
                <div 
                  className="composer__usage-bar-container" 
                  title={`${contextUsage.lastTokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} tokens (${contextUsage.percent}%)`}
                >
                  <div className="composer__usage-bar-label">
                    <span>Context: {contextUsage.lastTokens.toLocaleString()} / {contextUsage.contextWindow.toLocaleString()}</span>
                    <span>{contextUsage.percent}%</span>
                  </div>
                  <div className="composer__usage-bar">
                    <div 
                      className={`composer__usage-progress ${contextUsage.percent > 85 ? 'composer__usage-progress--danger' : contextUsage.percent > 60 ? 'composer__usage-progress--warning' : ''}`}
                      style={{ width: `${Math.min(contextUsage.percent, 100)}%` }}
                    />
                  </div>
                </div>
              ) : (
                <div className="composer__usage-simple" title="Tokens used in last turn">
                  <span>Context: {contextUsage.lastTokens.toLocaleString()} tokens</span>
                </div>
              )}
            </>
          )}
        </div>
        {canAbort ? (
          <button className="composer__send composer__send--danger" onClick={onAbort}>
            Stop
          </button>
        ) : (
          <button className="composer__send" disabled={disabled || !value.trim()} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
