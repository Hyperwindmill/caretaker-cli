import type { ToolAttachmentRecord } from '../../../session/types.js';

/** How long a caption-less image waits for text in a cold chat. */
export const HOLD_MS = 180_000;
/** How recently the chat must have flushed to count as warm. */
export const WARM_MS = 120_000;
export const MAX_ENTRIES = 20;
export const MAX_IMAGES = 8;

/** One received Telegram message, with its images already on disk. */
export interface PendingEntry {
  updateId: number;
  /** "@user", first_name, or "unknown". */
  fromLabel: string;
  /** msg.text ?? msg.caption, trimmed; absent when empty. */
  text?: string;
  attachments: ToolAttachmentRecord[];
}

/** The accumulation window of a single chat. */
export interface PendingChat {
  chatId: number;
  /** title ?? username ?? String(chatId). */
  chatLabel: string;
  chatType: string;
  entries: PendingEntry[];
  /** ms epoch of the oldest buffered entry. */
  firstAt: number;
  /** ms epoch of the last flush for this chat. */
  lastFlushAt?: number;
}

export interface PendingState {
  v: 1;
  chats: Record<string, PendingChat>;
}

export type FlushDecision = 'flush' | 'hold' | 'idle';

/** The session every message of a chat lands in, on every surface that touches it. */
export function telegramSessionId(chatId: number): string {
  return `telegram_${chatId}`;
}

/**
 * Whether the window should be delivered now. Text always goes straight
 * through; an image on its own waits for a caption, unless the chat flushed
 * recently enough that the agent already has the context in its history.
 */
export function decideFlush(chat: PendingChat, now: number): FlushDecision {
  if (chat.entries.length === 0) return 'idle';
  if (chat.entries.some((e) => !!e.text)) return 'flush';
  if (chat.lastFlushAt !== undefined && now - chat.lastFlushAt < WARM_MS) return 'flush';
  if (now - chat.firstAt >= HOLD_MS) return 'flush';
  return 'hold';
}

function imageCount(chat: PendingChat): number {
  return chat.entries.reduce((n, e) => n + e.attachments.length, 0);
}

export function isAtCapacity(chat: PendingChat): boolean {
  return chat.entries.length >= MAX_ENTRIES || imageCount(chat) >= MAX_IMAGES;
}

export function noTextLine(count: number): string {
  return count === 1
    ? "(L'utente ha inviato un'immagine senza scrivere nulla.)"
    : `(L'utente ha inviato ${count} immagini senza scrivere nulla.)`;
}

/**
 * The single user turn a flushed window becomes. One entry from one sender
 * reproduces the legacy format byte for byte.
 */
export function buildMergedPrompt(chat: PendingChat, isNewSession: boolean): string {
  const chatBlock = `Chat: ${chat.chatLabel} (id: ${chat.chatId}, type: ${chat.chatType})`;
  const senders = new Set(chat.entries.map((e) => e.fromLabel));

  if (senders.size <= 1) {
    const from = chat.entries[0]?.fromLabel ?? 'unknown';
    const header = isNewSession ? `From: ${from}\n${chatBlock}` : `From: ${from}`;
    const texts = chat.entries.map((e) => e.text).filter((t): t is string => !!t);
    const body = texts.length > 0 ? texts.join('\n\n') : noTextLine(imageCount(chat));
    return `${header}\n\n${body}`;
  }

  // Mixed senders: the agent needs to know who said what, so each entry
  // carries its own From line and the chat block moves to the top.
  const blocks = chat.entries.map(
    (e) => `From: ${e.fromLabel}\n\n${e.text || noTextLine(e.attachments.length || 1)}`,
  );
  return (isNewSession ? `${chatBlock}\n\n` : '') + blocks.join('\n\n');
}
