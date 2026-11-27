interface SecretInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** A secret is already stored: the field stays empty and offers to remove it. */
  hasSaved: boolean;
  /** Omit both for a required secret: it can be replaced but not removed. */
  remove?: boolean;
  onRemoveChange?: (remove: boolean) => void;
  /** Shown when nothing is stored. */
  placeholder?: string;
}

/**
 * Password field for a secret stored encrypted: never pre-filled, empty keeps
 * the stored value, and removing it is an explicit toggle (see secretForSave).
 */
export function SecretInput({
  id,
  value,
  onChange,
  hasSaved,
  remove = false,
  onRemoveChange,
  placeholder,
}: SecretInputProps) {
  return (
    <>
      <input
        id={id}
        type="password"
        autoComplete="off"
        disabled={remove}
        value={remove ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          remove
            ? 'Will be removed on save'
            : hasSaved
              ? '•••••••• (leave blank to keep the saved value)'
              : placeholder
        }
      />
      {hasSaved && onRemoveChange && (
        <button
          type="button"
          className="btn btn--secondary btn--xs"
          style={{ marginTop: 6 }}
          onClick={() => onRemoveChange(!remove)}
        >
          {remove ? 'Keep saved value' : 'Remove saved value'}
        </button>
      )}
    </>
  );
}
