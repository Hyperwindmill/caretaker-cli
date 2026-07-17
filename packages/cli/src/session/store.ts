// Session store backed by JSONL files, one per session.
// Layout: <dataDir>/sessions/<agentId>/<sessionId>.jsonl
//
// Append-only writes for new messages. Meta updates (retitle) rewrite the
// file atomically via temp+rename to keep "first line = current meta"
// invariant — this lets `listForAgent()` read a single line per session for
// the index view. Sort order in `listForAgent()` uses fs.stat.mtime, which
// is updated for free on every append, so we never have to rewrite the file
// just to bump a timestamp.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  open,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type {
  AssistantPart,
  AssistantUsage,
  MessageRecord,
  Session,
  SessionMetaRecord,
  ToolAttachmentRecord,
} from './types.js';

export function dataDir(): string {
  return process.env.CARETAKER_HOME ?? join(homedir(), '.caretaker');
}

export function sessionsRoot(): string {
  return join(dataDir(), 'sessions');
}

function agentDir(agentId: string): string {
  return join(sessionsRoot(), agentId);
}

function sessionPath(agentId: string, sessionId: string): string {
  return join(agentDir(agentId), `${sessionId}.jsonl`);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function nowIso(): string {
  return new Date().toISOString();
}

function serialize(record: unknown): string {
  return JSON.stringify(record) + '\n';
}

/** Concatenate text parts of an assistant turn into the canonical `content`
 *  string. Mirrors textConcat() in the server's chat_parts module. */
function textConcat(parts: AssistantPart[]): string {
  return parts
    .filter((p): p is Extract<AssistantPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Parse a single line. Returns null for blank or malformed lines (caller logs). */
function parseLine(line: string): unknown | null {
  const trimmed = line.trimEnd();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isMeta(rec: unknown): rec is SessionMetaRecord {
  return (
    !!rec &&
    typeof rec === 'object' &&
    (rec as { type?: unknown }).type === 'session_meta' &&
    (rec as { v?: unknown }).v === 1
  );
}

function isMessage(rec: unknown): rec is MessageRecord {
  if (!rec || typeof rec !== 'object') return false;
  const o = rec as { v?: unknown; type?: unknown; role?: unknown };
  if (o.v !== 1 || o.type !== 'message') return false;
  return o.role === 'user' || o.role === 'assistant' || o.role === 'tool';
}

export interface CreateSessionInput {
  agentId: string;
  title: string;
  /** Optional explicit id. Defaults to a fresh uuid. */
  id?: string;
  /** Optional explicit createdAt (ISO). Defaults to now. Useful for tests. */
  createdAt?: string;
}

/** Create a new session: writes the initial meta line. Returns the meta. */
export async function createSession(input: CreateSessionInput): Promise<SessionMetaRecord> {
  const meta: SessionMetaRecord = {
    v: 1,
    type: 'session_meta',
    id: input.id ?? randomUUID(),
    agentId: input.agentId,
    title: input.title,
    createdAt: input.createdAt ?? nowIso(),
  };
  await ensureDir(agentDir(input.agentId));
  const path = sessionPath(input.agentId, meta.id);
  // `wx` flag: fail if file already exists. Prevents accidental id collision overwriting an existing session.
  await writeFile(path, serialize(meta), { mode: 0o600, flag: 'wx' });
  return meta;
}

/** Append a message record (user / assistant / tool) to an existing session. */
export async function appendMessage(
  meta: Pick<SessionMetaRecord, 'agentId' | 'id'>,
  record: MessageRecord,
): Promise<void> {
  const path = sessionPath(meta.agentId, meta.id);
  // `appendFile` with default flag `a` is the right primitive: writes are
  // atomic per-call on POSIX for payloads under PIPE_BUF (typically 4 KiB);
  // larger payloads can interleave between concurrent writers, but the store
  // is single-writer by design.
  await appendFile(path, serialize(record), { mode: 0o600 });
}

/**
 * Read a session in full. The latest `session_meta` record wins (so retitles
 * appended without a rewrite are honored too — the rewrite path is the
 * preferred one, but this keeps the reader robust).
 *
 * Lines that fail to parse or have an unknown `type`/`v` are skipped with
 * a console warning; the rest of the file is still returned.
 */
export async function readSession(agentId: string, sessionId: string): Promise<Session> {
  const path = sessionPath(agentId, sessionId);
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');

  let meta: SessionMetaRecord | null = null;
  const messages: MessageRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]!);
    if (parsed === null) continue;
    if (isMeta(parsed)) {
      meta = parsed;
      continue;
    }
    if (isMessage(parsed)) {
      messages.push(parsed);
      continue;
    }
    console.warn(`[session/store] skipping unknown record at ${path}:${i + 1}`);
  }

  if (!meta) throw new Error(`session ${sessionId} for agent ${agentId} has no meta record`);
  return { meta, messages };
}

/** Index-style listing for an agent: latest meta only, sorted by mtime desc. */
export interface SessionListEntry {
  meta: SessionMetaRecord;
  updatedAt: Date;
}

export async function listForAgent(agentId: string): Promise<SessionListEntry[]> {
  const dir = agentDir(agentId);
  if (!existsSync(dir)) return [];

  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  const entries: SessionListEntry[] = [];

  for (const f of files) {
    const path = join(dir, f);
    try {
      const meta = await readFirstMeta(path);
      if (!meta) continue;
      const st = await stat(path);
      entries.push({ meta, updatedAt: st.mtime });
    } catch (err) {
      console.warn(`[session/store] failed to read ${path}:`, err);
    }
  }

  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return entries;
}

/** Read just enough of a file to extract the first meta line. */
async function readFirstMeta(path: string): Promise<SessionMetaRecord | null> {
  const fh = await open(path, 'r');
  try {
    // Read a single chunk; first line is typically <300 bytes for meta.
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return null;
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    const firstLine = newline >= 0 ? text.slice(0, newline) : text;
    const parsed = parseLine(firstLine);
    return isMeta(parsed) ? parsed : null;
  } finally {
    await fh.close();
  }
}

/**
 * Atomic title rewrite: read the whole file, replace the first meta line,
 * write to a temp file and rename. The rename is atomic on POSIX; on Windows
 * it's atomic when the target is on the same volume (which it always is here).
 * Returns the new meta.
 */
export async function updateTitle(
  meta: Pick<SessionMetaRecord, 'agentId' | 'id'>,
  title: string,
): Promise<SessionMetaRecord> {
  const path = sessionPath(meta.agentId, meta.id);
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');

  // Find and update the first meta line. Trailing meta records (if any) are
  // left as-is — readSession() walks all of them and the latest wins, but
  // the canonical state is "first line = current meta", which we maintain.
  let updated = false;
  let newMeta: SessionMetaRecord | null = null;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]!);
    if (isMeta(parsed)) {
      newMeta = { ...parsed, title };
      lines[i] = JSON.stringify(newMeta);
      updated = true;
      break;
    }
  }
  if (!updated || !newMeta) throw new Error(`session ${meta.id} has no meta to update`);

  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, lines.join('\n'), { mode: 0o600 });
  await rename(tmp, path);
  return newMeta;
}

/** Persist the Claude Code session id by appending a fresh meta line
 *  (readSession picks the latest meta; listForAgent keeps using the first). */
export async function updateClaudeSessionId(
  meta: Pick<SessionMetaRecord, 'agentId' | 'id'>,
  claudeSessionId: string,
): Promise<void> {
  const current = await readSession(meta.agentId, meta.id);
  const record: SessionMetaRecord = { ...current.meta, claudeSessionId };
  const path = sessionPath(meta.agentId, meta.id);
  await appendFile(path, serialize(record), { mode: 0o600 });
}

export async function deleteSession(agentId: string, sessionId: string): Promise<void> {
  const path = sessionPath(agentId, sessionId);
  await rm(path, { force: true });
  const attDir = attachmentsDir(sessionId);
  await rm(attDir, { recursive: true, force: true });
}

// ─── Message builders ───────────────────────────────────────────────────────

export function userMessage(
  content: string,
  opts?: { id?: string; createdAt?: string; attachments?: ToolAttachmentRecord[] },
): MessageRecord {
  return {
    v: 1,
    type: 'message',
    id: opts?.id ?? randomUUID(),
    role: 'user',
    content,
    ...(opts?.attachments ? { attachments: opts.attachments } : {}),
    createdAt: opts?.createdAt ?? nowIso(),
  };
}

export function assistantMessage(
  parts: AssistantPart[],
  usage?: AssistantUsage,
  opts?: { id?: string; createdAt?: string },
): MessageRecord {
  const content = textConcat(parts);
  return {
    v: 1,
    type: 'message',
    id: opts?.id ?? randomUUID(),
    role: 'assistant',
    content,
    parts,
    ...(usage ? { usage } : {}),
    createdAt: opts?.createdAt ?? nowIso(),
  };
}

export function attachmentsDir(sessionId: string): string {
  return join(dataDir(), 'attachments', sessionId);
}

export async function saveAttachment(
  sessionId: string,
  data: Buffer,
  extension: string,
): Promise<string> {
  const uuid = randomUUID();
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const id = `${uuid}${ext}`;
  const dir = attachmentsDir(sessionId);
  await ensureDir(dir);
  await writeFile(join(dir, id), data);
  return id;
}

export async function readAttachment(sessionId: string, id: string): Promise<Buffer> {
  const path = join(attachmentsDir(sessionId), id);
  return await readFile(path);
}

export function toolMessage(
  toolCallId: string,
  content: string,
  attachments?: ToolAttachmentRecord[],
  opts?: { id?: string; createdAt?: string },
): MessageRecord {
  return {
    v: 1,
    type: 'message',
    id: opts?.id ?? randomUUID(),
    role: 'tool',
    toolCallId,
    content,
    ...(attachments ? { attachments } : {}),
    createdAt: opts?.createdAt ?? nowIso(),
  };
}

// ─── For tests / introspection ──────────────────────────────────────────────

export const __forTesting = { sessionPath, agentDir, readFirstMeta };
