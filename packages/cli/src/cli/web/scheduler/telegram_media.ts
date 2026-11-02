import { basename, extname } from 'node:path';

import { saveAttachment } from '../../../session/store.js';
import type { ToolAttachmentRecord } from '../../../session/types.js';

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

/** Telegram's bot API will not serve a download above this. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(
      `image is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB Telegram download limit`,
    );
    this.name = 'FileTooLargeError';
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
};

/**
 * Fetches the image and stores it in the chat's session attachment folder, so
 * it is on disk before the window decides whether the turn runs now or in
 * three minutes. `fetchImpl` keeps the tests off the network.
 */
export async function downloadImage(
  token: string,
  sessionId: string,
  media: { fileId: string; fileSize?: number },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ToolAttachmentRecord> {
  if (media.fileSize !== undefined && media.fileSize > MAX_FILE_BYTES) {
    throw new FileTooLargeError(media.fileSize);
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const metaRes = await doFetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: media.fileId }),
  });
  const meta = (await metaRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
    description?: string;
  };
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(`Telegram API getFile failed: ${meta.description ?? 'no file_path'}`);
  }

  const filePath = meta.result.file_path;
  const fileRes = await doFetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!fileRes.ok) {
    throw new Error(`Telegram file download failed with status ${fileRes.status}`);
  }

  const buf = Buffer.from(await fileRes.arrayBuffer());
  const ext = (extname(filePath) || '.jpg').toLowerCase();
  const id = await saveAttachment(sessionId, buf, ext);
  return { mime: MIME_BY_EXT[ext] ?? 'image/jpeg', id, name: basename(filePath) };
}
