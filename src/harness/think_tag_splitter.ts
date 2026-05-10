/**
 * Stateful streaming splitter for `<think>...</think>` tags inside content.
 *
 * Some models (GLM, Qwen3 thinking, QwQ, open-weight reasoning tunes) emit
 * their reasoning as inline tags in `delta.content`. This util takes raw
 * chunks (in stream order) and yields normalized events:
 *   - `{ kind: "thinking", text }` for content inside `<think>...</think>`
 *   - `{ kind: "content", text }` for content outside the tag
 *
 * Tags can span chunk boundaries; the splitter buffers partial tag matches
 * until enough characters arrive to disambiguate.
 *
 * Tag matching is lenient: case-insensitive on the tag name, allows whitespace
 * inside the brackets (e.g. `<think >`, `</ think >`), no attributes.
 */

const OPEN_RE = /<\s*think\s*>/i;
const CLOSE_RE = /<\s*\/\s*think\s*>/i;

// Longest possible "ambiguous prefix" we may have to retain at the end of a
// chunk while waiting for more bytes to confirm or reject a tag match.
// "</ think >" → 10 chars, plus a small margin.
const MAX_PARTIAL = 16;

export type ThinkSplitEvent =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string };

export class ThinkTagSplitter {
  private inThink = false;
  private buffer = '';

  /** Push a raw content chunk and pull all events that can be emitted now. */
  push(chunk: string): ThinkSplitEvent[] {
    this.buffer += chunk;
    const out: ThinkSplitEvent[] = [];
    // Loop: find the next tag transition; emit text up to it; switch state; repeat.
    // Stop when no more transitions are available in the buffered text.
    // Whatever is left in `this.buffer` is held until either:
    //   - more data arrives (next push), OR
    //   - flush() is called.
    while (true) {
      const re = this.inThink ? CLOSE_RE : OPEN_RE;
      const match = re.exec(this.buffer);
      if (!match) {
        // No tag found. Emit all but the last MAX_PARTIAL chars (which might
        // be the start of an upcoming tag we can't yet verify).
        if (this.buffer.length > MAX_PARTIAL) {
          const head = this.buffer.slice(0, this.buffer.length - MAX_PARTIAL);
          this.buffer = this.buffer.slice(this.buffer.length - MAX_PARTIAL);
          if (head) out.push({ kind: this.inThink ? 'thinking' : 'content', text: head });
        }
        break;
      }
      const before = this.buffer.slice(0, match.index);
      if (before) out.push({ kind: this.inThink ? 'thinking' : 'content', text: before });
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.inThink = !this.inThink;
    }
    return out;
  }

  /** Flush remaining buffered text. Call when the stream ends. */
  flush(): ThinkSplitEvent[] {
    if (!this.buffer) return [];
    const out: ThinkSplitEvent[] = [
      { kind: this.inThink ? 'thinking' : 'content', text: this.buffer },
    ];
    this.buffer = '';
    return out;
  }

  /** True when the splitter is currently inside an open <think> tag. */
  get isInsideThink(): boolean {
    return this.inThink;
  }
}
