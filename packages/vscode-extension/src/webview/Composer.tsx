import { useState, type KeyboardEvent } from 'react';

export interface ComposerProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled, onSend }: ComposerProps) {
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
      <button className="composer__send" disabled={disabled || !value.trim()} onClick={send}>
        Send
      </button>
    </div>
  );
}
