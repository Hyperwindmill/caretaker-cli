// AES-256-GCM symmetric encryption for sensitive values stored on disk
// (today: git auth tokens in plugins.json). Mirrors the server implementation
// at src/lib/encryption.ts so blobs are wire-compatible if you ever copy
// state between the two.
//
// Key source: process.env.ENCRYPTION_KEY (64-char hex = 32 bytes). When the
// env var is missing the implementation falls back to an all-zero key so
// the rest of the system still works in plaintext-equivalent mode — useful
// for local dev. A future commit will add auto-generation + on-disk storage
// of the key under the user's data dir; until then plaintext fallback is
// the contract.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return Buffer.alloc(32, 0);
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  return buf;
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
