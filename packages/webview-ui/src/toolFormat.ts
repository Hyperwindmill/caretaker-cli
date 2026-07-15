/** Formatting helpers for the collapsed tool block in MessageList. Pure, no React. */

const PATH_KEYS = ['path', 'file_path', 'filePath'];

/** Compact one-line arg preview for the collapsed tool header.
 *  Path-like args (read/write) → basename; a `command` arg → the command; else truncated JSON. */
export function toolSummary(args: unknown, max = 80): string {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    for (const key of PATH_KEYS) {
      if (typeof obj[key] === 'string') return basename(obj[key] as string);
    }
    if (typeof obj.command === 'string') return truncate(obj.command, max);
  }
  return previewJson(args, max);
}

/** Neutral outcome hint for the collapsed header: line count if multiline, else size. */
export function resultMetric(result: string): string {
  const trimmed = result.replace(/\n+$/, '');
  if (trimmed.includes('\n')) {
    const n = trimmed.split('\n').length;
    return `${n} lines`;
  }
  const bytes = result.length;
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** Pretty-printed args for the expanded body; empty for null / {} so the block is skipped. */
export function prettyArgs(value: unknown, max = 2000): string {
  try {
    const s = JSON.stringify(value, null, 2);
    if (s === undefined || s === '{}' || s === 'null') return '';
    return truncate(s, max);
  } catch {
    return '';
  }
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function previewJson(value: unknown, max = 80): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return '';
    return truncate(s, max);
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
