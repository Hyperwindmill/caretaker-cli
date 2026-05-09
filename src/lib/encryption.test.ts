import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, isEncrypted, maskToken } from "./encryption.js";

describe("encryption (with key)", () => {
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
    // Flip a bit in the ciphertext.
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
    assert.equal(isEncrypted("aaaa:bbbb:cccc"), false); // wrong iv length
  });
});

describe("encryption (no key configured)", () => {
  let prevKey: string | undefined;

  before(() => {
    prevKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
  });

  after(() => {
    if (prevKey !== undefined) process.env.ENCRYPTION_KEY = prevKey;
  });

  it("still round-trips with the all-zero fallback key", () => {
    // The fallback is intentionally not secure — but it keeps the rest of the
    // system functional in dev. We assert the contract, not the security.
    const plain = "dev-token";
    const blob = encrypt(plain);
    assert.equal(decrypt(blob), plain);
  });

  it("rejects an env var with the wrong length", () => {
    process.env.ENCRYPTION_KEY = "deadbeef"; // 8 chars, not 64
    assert.throws(() => encrypt("x"), /64-char hex/);
    delete process.env.ENCRYPTION_KEY;
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
