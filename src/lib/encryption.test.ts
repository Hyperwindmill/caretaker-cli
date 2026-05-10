import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  encrypt,
  decrypt,
  isEncrypted,
  maskToken,
  encryptionKeyPath,
} from "./encryption.js";

describe("encryption (env key)", () => {
  let prevKey: string | undefined;

  before(() => {
    prevKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  });

  after(() => {
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prevKey;
  });

  it("encrypt then decrypt returns the original plaintext", () => {
    const plain = "ghp_abcdef1234567890";
    const blob = encrypt(plain);
    assert.equal(decrypt(blob), plain);
  });

  it("encrypt produces a fresh blob each call (random IV)", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    assert.notEqual(a, b);
    assert.equal(decrypt(a), "same");
    assert.equal(decrypt(b), "same");
  });

  it("decrypt throws on tampered ciphertext (GCM auth tag check)", () => {
    const blob = encrypt("payload");
    const [iv, tag, ct] = blob.split(":");
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === "00" ? "01" : "00");
    assert.throws(() => decrypt(`${iv}:${tag}:${flipped}`));
  });

  it("decrypt throws on malformed input", () => {
    assert.throws(() => decrypt("not-a-blob"));
    assert.throws(() => decrypt("only:two"));
  });

  it("isEncrypted recognizes encrypt() output", () => {
    const blob = encrypt("x");
    assert.equal(isEncrypted(blob), true);
    assert.equal(isEncrypted("plaintext"), false);
    assert.equal(isEncrypted("aaaa:bbbb:cccc"), false);
  });

  it("rejects an env var with the wrong length", () => {
    const orig = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "deadbeef";
    try {
      assert.throws(() => encrypt("x"), /64-char hex/);
    } finally {
      process.env.ENCRYPTION_KEY = orig;
    }
  });
});

describe("encryption (on-disk key)", () => {
  let prevKey: string | undefined;
  let prevHome: string | undefined;
  let home: string;

  before(() => {
    prevKey = process.env.ENCRYPTION_KEY;
    prevHome = process.env.CARETAKER_HOME;
    delete process.env.ENCRYPTION_KEY;
  });

  after(() => {
    if (prevKey !== undefined) process.env.ENCRYPTION_KEY = prevKey;
    if (prevHome === undefined) delete process.env.CARETAKER_HOME;
    else process.env.CARETAKER_HOME = prevHome;
  });

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "caretaker-enc-"));
    process.env.CARETAKER_HOME = home;
  });

  it("generates encryption.key on first use with chmod 0600 and 32 bytes", () => {
    const keyFile = encryptionKeyPath();
    assert.equal(existsSync(keyFile), false);

    encrypt("first call");

    assert.equal(existsSync(keyFile), true);
    const buf = readFileSync(keyFile);
    assert.equal(buf.length, 32);

    // Permission check (POSIX). We accept "0600" exactly — anything looser is
    // a regression worth surfacing.
    if (process.platform !== "win32") {
      const mode = statSync(keyFile).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }
  });

  it("reuses the same key across calls (round-trip across encrypt/decrypt pairs)", () => {
    const blob = encrypt("payload");
    // A second encrypt call must read the same key file rather than
    // generating a new one — otherwise decrypt below would fail.
    const key1 = readFileSync(encryptionKeyPath());
    const blob2 = encrypt("other");
    const key2 = readFileSync(encryptionKeyPath());
    assert.deepEqual(key1, key2);

    assert.equal(decrypt(blob), "payload");
    assert.equal(decrypt(blob2), "other");
  });

  it("rejects an existing key file of wrong size", async () => {
    const keyFile = encryptionKeyPath();
    // Seed a 16-byte file (looks vaguely keyish but is invalid).
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(home, { recursive: true });
    await writeFile(keyFile, randomBytes(16), { mode: 0o600 });

    assert.throws(() => encrypt("x"), /must be exactly 32 bytes/);
  });

  it("env var overrides the on-disk key when both are present", async () => {
    // Force on-disk key creation, then set a different env key.
    encrypt("seed"); // creates the file
    const onDiskKey = readFileSync(encryptionKeyPath());

    const envKey = randomBytes(32);
    // Make sure they differ — astronomically unlikely otherwise but cheap to assert.
    assert.notDeepEqual(onDiskKey, envKey);

    process.env.ENCRYPTION_KEY = envKey.toString("hex");
    try {
      const blob = encrypt("payload-with-env");
      assert.equal(decrypt(blob), "payload-with-env");

      // A blob produced under the env key must NOT decrypt under the on-disk
      // key (sanity check that the override actually took effect).
      delete process.env.ENCRYPTION_KEY;
      assert.throws(() => decrypt(blob));
    } finally {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  // Always clean up the per-test home so the next iteration gets a fresh dir.
  after(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });
});

describe("maskToken", () => {
  it("returns **** for short tokens", () => {
    assert.equal(maskToken("abcd"), "****");
    assert.equal(maskToken(""), "****");
  });

  it("keeps only the last 4 chars for longer tokens", () => {
    assert.equal(maskToken("ghp_abcdef1234567890"), "****7890");
  });
});
