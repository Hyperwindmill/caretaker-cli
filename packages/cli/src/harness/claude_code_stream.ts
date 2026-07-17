// Parser for `claude -p --output-format stream-json --verbose
// --include-partial-messages` output. One JSON object per line.
// Derived from real captured fixtures in ./fixtures/ — do not "fix"
// field paths from memory; check the fixtures.

import type { AssistantUsage } from './provider.js';
import type { AssistantPart } from '../session/types.js';

export type ClaudeStreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'assistant_message';
      /** Anthropic message id — events for the same message id must be merged. */
      id: string;
      /** Blocks contained in THIS event (Claude Code emits one event per completed block). */
      parts: AssistantPart[];
      usage?: AssistantUsage;
    }
  | { kind: 'tool_result'; toolUseId: string; content: string }
  | {
      kind: 'result';
      subtype: string;
      text: string;
      usage?: AssistantUsage;
      costUsd?: number;
      isError: boolean;
    };

function mapUsage(u: any): AssistantUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const usage: AssistantUsage = {
    input: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
    output: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
  };
  if (typeof u.cache_read_input_tokens === 'number') usage.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number')
    usage.cacheWrite = u.cache_creation_input_tokens;
  return usage;
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

export function parseClaudeStreamLine(rawLine: string): ClaudeStreamEvent[] {
  const line = rawLine.trim();
  if (!line) return [];
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];

  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init' && typeof obj.session_id === 'string') {
        return [{ kind: 'init', sessionId: obj.session_id }];
      }
      return [];
    case 'stream_event': {
      const ev = obj.event;
      if (ev?.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
          return [{ kind: 'text', text: d.text }];
        }
        if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking.length > 0) {
          return [{ kind: 'thinking', text: d.thinking }];
        }
      }
      return [];
    }
    case 'assistant': {
      const msg = obj.message;
      if (!msg || !Array.isArray(msg.content)) return [];
      const parts: AssistantPart[] = [];
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text });
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
          parts.push({ type: 'thinking', text: block.thinking });
        } else if (block?.type === 'tool_use') {
          parts.push({ type: 'tool_use', id: block.id, name: block.name, args: block.input });
        }
      }
      if (parts.length === 0) return [];
      return [
        {
          kind: 'assistant_message',
          id: typeof msg.id === 'string' ? msg.id : '',
          parts,
          usage: mapUsage(msg.usage),
        },
      ];
    }
    case 'user': {
      const content = obj.message?.content;
      if (!Array.isArray(content)) return [];
      const out: ClaudeStreamEvent[] = [];
      for (const block of content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          out.push({
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            content: textFromToolResultContent(block.content),
          });
        }
      }
      return out;
    }
    case 'result':
      return [
        {
          kind: 'result',
          subtype: typeof obj.subtype === 'string' ? obj.subtype : '',
          text: typeof obj.result === 'string' ? obj.result : '',
          usage: mapUsage(obj.usage),
          costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
          isError: obj.is_error === true || String(obj.subtype ?? '').startsWith('error'),
        },
      ];
    default:
      return [];
  }
}
