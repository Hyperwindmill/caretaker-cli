import type { PronunciationEntry } from 'caretaker-types';

export interface PronunciationTableProps {
  /** Synthesis language code the dictionary belongs to; null when unknown. */
  code: string | null;
  entries: PronunciationEntry[];
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onChange: (entries: PronunciationEntry[]) => void;
  onRestoreDefaults: () => void;
  /** Speak `text` with the form's current (unsaved) settings. */
  onListen: (text: string) => void;
  listening: boolean;
  listenError: string | null;
}

/** Per-language respelling table ("stage" → "steidj"). Edits the form state
 *  only; the parent saves it with the rest of the voice config. */
export function PronunciationTable({
  code,
  entries,
  enabled,
  onEnabledChange,
  onChange,
  onRestoreDefaults,
  onListen,
  listening,
  listenError,
}: PronunciationTableProps) {
  const update = (i: number, patch: Partial<PronunciationEntry>) =>
    onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <div className="form-group">
      <div className="form-group--checkbox">
        <label htmlFor="voice-pron-enabled">
          <input
            id="voice-pron-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          Pronunciation dictionary
        </label>
      </div>
      {code === null ? (
        <small>Set a language above to edit its dictionary.</small>
      ) : (
        <>
          <small>
            Words below are respelled before synthesis (whole word, case-insensitive,
            longest first) for language <code>{code}</code>. Listen uses the unsaved form.
          </small>
          {entries.map((e, i) => (
            <div key={i} className="voice-backend-status">
              <input
                type="text"
                aria-label="Term"
                placeholder="term"
                value={e.term}
                onChange={(ev) => update(i, { term: ev.target.value })}
              />
              <input
                type="text"
                aria-label="Spoken as"
                placeholder="spoken as"
                value={e.say}
                onChange={(ev) => update(i, { say: ev.target.value })}
              />
              <button
                type="button"
                disabled={listening || !e.term.trim()}
                onClick={() => onListen(e.term.trim())}
              >
                Listen
              </button>
              <button type="button" onClick={() => onChange(entries.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div className="voice-backend-status">
            <button type="button" onClick={() => onChange([...entries, { term: '', say: '' }])}>
              Add word
            </button>
            <button type="button" onClick={onRestoreDefaults}>
              Restore defaults
            </button>
          </div>
        </>
      )}
      {listenError && <small className="form-error">Listen failed: {listenError}</small>}
    </div>
  );
}
