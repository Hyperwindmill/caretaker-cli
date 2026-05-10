// AES-256-GCM symmetric encryption for sensitive values stored on disk
// (today: git auth tokens in plugins.json; soon: MCP HTTP auth headers).
// Mirrors the server implementation at src/lib/encryption.ts so blobs are
// wire-compatible if you ever copy state between the two.
//
// Key resolution (first match wins):
//   1. process.env.ENCRYPTION_KEY  — 64-char hex string (32 bytes).
//      Useful in CI and for forcing a known key across hosts.
//   2. <dataDir>/encryption.key    — 32 raw bytes, chmod 0600. Auto-generated
//      atomically the first time a key is needed.
//
// dataDir() honors CARETAKER_HOME so tests can isolate the keystore.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_BYTES = 32;

function dataDir(): string {
  return process.env.CARETAKER_HOME ?? join(homedir(), ".caretaker");
}

/** Resolve the on-disk path of the encryption key. Exported for diagnostics
 *  and tests; runtime code should not need it. */
export function encryptionKeyPath(): string {
  return join(dataDir(), "encryption.key");
}

function loadOrCreateOnDiskKey(): Buffer {
  const dir = dataDir();
  const path = encryptionKeyPath();

  if (existsSync(path)) {
    const buf = readFileSync(path);
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `encryption.key at ${path} must be exactly ${KEY_BYTES} bytes (found ${buf.length})`,
      );
    }
    return buf;
  }

  // First-boot generation: produce a fresh 32-byte key and persist it
  // atomically under restrictive permissions. The data dir is created with
  // 0700 (mirrors store/json.ts ensureDataDir) and the key file with 0600.
  // Tmp + rename keeps a partial write from leaving an empty file in place.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort — directory already exists with looser perms on some setups */
  }

  const key = randomBytes(KEY_BYTES);
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, key, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* same caveat as the dir chmod */
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
  return key;
}

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, "hex");
    if (buf.length !== KEY_BYTES) {
      throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
    }
    return buf;
  }
  return loadOrCreateOnDiskKey();
}

/** Encrypt plaintext, return a hex-encoded blob `iv:tag:ciphertext`. */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Decrypt a blob produced by encrypt(). Throws on tampered input. */
export function decrypt(blob: string): string {
  const key = getKey();
  const parts = blob.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted token format");
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString("utf8") + decipher.final("utf8");
}

/** Heuristic: does this string look like an encrypt() blob? */
export function isEncrypted(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts[0].length === IV_LENGTH * 2 && parts[1].length === TAG_LENGTH * 2;
}

/** Mask a token in user-facing UI: keep only the last 4 characters. */
export function maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return `****${token.slice(-4)}`;
}
