/**
 * Shared in-process locks across scheduler strategies.
 *
 * Heartbeat uses plain task IDs as keys; Telegram uses compound `${taskId}:${chatId}`
 * keys so concurrent chats can progress while serialising per-chat.
 */
export const runningTasks = new Set<string>();
