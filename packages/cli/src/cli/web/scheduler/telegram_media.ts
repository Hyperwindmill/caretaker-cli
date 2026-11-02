export interface TgPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: string;
    title?: string;
    first_name?: string;
    username?: string;
  };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  video?: unknown;
  audio?: unknown;
  voice?: unknown;
  sticker?: unknown;
  animation?: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/**
 * `content` is a message the agent should answer, `unsupported` is media the
 * user deliberately sent that we cannot deliver (it gets a spoken refusal),
 * `service` is everything Telegram puts on the same channel that nobody is
 * waiting for — joins, leaves, pins — which stays silent.
 */
export type MessageClass = 'content' | 'unsupported' | 'service';

function isImageDocument(doc?: TgDocument): boolean {
  return !!doc?.mime_type?.startsWith('image/');
}

export function classifyMessage(msg: TgMessage): MessageClass {
  // Unsupported media is checked before the caption on purpose: delivering a
  // video's caption without the video would have the agent answer about
  // something it cannot see.
  const hasUnsupported =
    !!msg.video ||
    !!msg.audio ||
    !!msg.voice ||
    !!msg.sticker ||
    !!msg.animation ||
    (!!msg.document && !isImageDocument(msg.document));
  if (hasUnsupported) return 'unsupported';

  if (messageText(msg) || (msg.photo && msg.photo.length > 0) || isImageDocument(msg.document)) {
    return 'content';
  }
  return 'service';
}

/** The largest photo size Telegram offers, or the image document. */
export function selectImage(msg: TgMessage): { fileId: string; fileSize?: number } | null {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
    return { fileId: largest.file_id, fileSize: largest.file_size };
  }
  if (isImageDocument(msg.document)) {
    return { fileId: msg.document!.file_id, fileSize: msg.document!.file_size };
  }
  return null;
}

export function messageText(msg: TgMessage): string | undefined {
  const raw = (msg.text ?? msg.caption ?? '').trim();
  return raw.length > 0 ? raw : undefined;
}

export function senderLabel(msg: TgMessage): string {
  if (msg.from?.username) return `@${msg.from.username}`;
  return msg.from?.first_name || 'unknown';
}
