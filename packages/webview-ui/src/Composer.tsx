import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import type { ContextUsage } from './bridge.js';
import { DocIcon, CloseIcon, AttachIcon, MicIcon } from './icons.js';
import { shouldFocusComposer } from './composer_utils.js';

export interface ComposerProps {
  disabled: boolean;
  canAbort: boolean;
  onSend: (text: string, attachments?: Array<{ name: string; mime: string; base64: string }>) => void;
  onAbort: () => void;
  contextUsage: ContextUsage | null;
  /** Voice control, or null when voice is unavailable on this surface. */
  voice?: {
    phase: 'idle' | 'recording' | 'transcribing' | 'awaiting' | 'speaking';
    mode: 'dictate' | 'conversation';
    canSpeak: boolean;
    setMode: (mode: 'dictate' | 'conversation') => void;
    toggle: () => void;
  } | null;
  value?: string;
  onValueChange?: (val: string) => void;
}

export function Composer({
  disabled,
  canAbort,
  onSend,
  onAbort,
  contextUsage,
  voice = null,
  value: propValue,
  onValueChange: propOnValueChange,
}: ComposerProps) {
  const [internalValue, setInternalValue] = useState('');
  const value = propValue !== undefined ? propValue : internalValue;
  const setValue = (val: string | ((prev: string) => string)) => {
    if (propOnValueChange) {
      if (typeof val === 'function') {
        propOnValueChange(val(value));
      } else {
        propOnValueChange(val);
      }
    } else {
      setInternalValue(val);
    }
  };

  const [attachments, setAttachments] = useState<Array<{ name: string; mime: string; base64: string }>>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Seed `true` so a composer that mounts already enabled counts as a
  // disabled -> enabled transition and autofocuses on load (guarded below).
  const prevDisabled = useRef(true);

  // Restore focus to the input when it becomes usable again — turn finished,
  // confirmation resolved, or an agent selected — but only when the webview
  // already holds focus, so we never steal the caret from the editor (VSCode
  // sidebar) or another window. See shouldFocusComposer / the design spec.
  useEffect(() => {
    if (shouldFocusComposer(prevDisabled.current, disabled, document.hasFocus())) {
      inputRef.current?.focus();
    }
    prevDisabled.current = disabled;
  }, [disabled]);

  const send = (): void => {
    onSend(value, attachments.length > 0 ? attachments : undefined);
    setValue('');
    setAttachments([]);
  };

  const removeAttachment = (idx: number): void => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleFiles = (files: FileList | null): void => {
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;

      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (typeof result === 'string') {
          const commaIdx = result.indexOf(',');
          const base64 = result.slice(commaIdx + 1);
          setAttachments((prev) => [
            ...prev,
            {
              name: file.name,
              mime: file.type || 'application/octet-stream',
              base64,
            },
          ]);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      handleFiles(e.clipboardData.files);
    }
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      setIsDragging(false);
      dragCounter.current = 0;
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragging(false);
    dragCounter.current = 0;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div 
      className={`composer ${isDragging ? 'composer--dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="composer__dropzone-overlay">
        Drop files or images here...
      </div>
      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map((att, i) => (
            <div key={i} className="composer__attachment">
              {att.mime.startsWith('image/') ? (
                <img 
                  className="composer__attachment-thumb" 
                  src={`data:${att.mime};base64,${att.base64}`} 
                  alt={att.name} 
                />
              ) : (
                <span className="composer__attachment-icon"><DocIcon size={13} /></span>
              )}
              <span className="composer__attachment-name" title={att.name}>
                {att.name}
              </span>
              <button
                type="button"
                className="composer__attachment-remove"
                aria-label="Remove attachment"
                onClick={() => removeAttachment(i)}
              >
                <CloseIcon size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="composer__input"
        value={value}
        placeholder="Message Caretaker (Drop/paste files/images)..."
        rows={2}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
      />
      <div className="composer__controls">
        <button 
          type="button" 
          className="composer__action-btn"
          title="Attach file or image"
          aria-label="Attach file or image"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
        >
          <AttachIcon size={16} />
        </button>
        <input 
          type="file" 
          ref={fileInputRef} 
          style={{ display: 'none' }} 
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
          multiple
        />
        {voice && (
          <div className="composer__voice">
            <button
              type="button"
              className={`composer__action-btn${
                voice.phase === 'recording'
                  ? ' composer__action-btn--recording'
                  : voice.phase === 'speaking'
                    ? ' composer__action-btn--speaking'
                    : ''
              }`}
              title={voice.phase === 'idle' ? 'Start voice' : 'Stop voice'}
              aria-label={voice.phase === 'idle' ? 'Start voice' : 'Stop voice'}
              aria-pressed={voice.phase !== 'idle'}
              onClick={voice.toggle}
              disabled={voice.phase === 'transcribing'}
            >
              <MicIcon size={16} />
            </button>
            {voice.canSpeak && (
              <select
                className="composer__voice-mode"
                value={voice.mode}
                onChange={(e) => voice.setMode(e.target.value as 'dictate' | 'conversation')}
                disabled={voice.phase !== 'idle'}
                aria-label="Voice mode"
              >
                <option value="dictate">Dictate</option>
                <option value="conversation">Conversation</option>
              </select>
            )}
            <span role="status" aria-live="polite" className="composer__voice-status">
              {voice.phase === 'recording'
                ? 'Listening…'
                : voice.phase === 'transcribing'
                  ? 'Transcribing…'
                  : voice.phase === 'speaking'
                    ? 'Speaking…'
                    : ''}
            </span>
          </div>
        )}
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
          <button 
            className="composer__send" 
            disabled={disabled || (!value.trim() && attachments.length === 0)} 
            onClick={send}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
