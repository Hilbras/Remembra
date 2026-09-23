/**
 * Encrypted storage mode (audit Phase 8).
 *
 * Opt-in: `REMEMBRA_ENCRYPT_KEY` set → memory files are written as
 * AES-256-GCM ciphertext (node:crypto — zero dependencies) and decrypted
 * transparently on read. Unset → plain markdown, exactly as before.
 *
 * Key material: a 64-hex-char (32-byte) key, used directly — no KDF, no
 * salt (a high-entropy symmetric key needs neither; per-file random nonces
 * provide uniqueness). Generate one with:
 *   node -p 'require("node:crypto").randomBytes(32).toString("hex")'
 *
 * On-disk format (files keep their .md names; detection is by magic bytes):
 *   MAGIC(7) "RMBENC1" | nonce(12) | tag(16) | ciphertext
 * The AAD is empty — files move between trees (archive/revive) freely.
 *
 * Failure mode without the key: reading an encrypted file throws
 * `ENCRYPTED_NO_KEY` (HTTP 503, health `storage: ENCRYPTED_NO_KEY`) instead
 * of warn-skipping — a store you cannot read must fail loudly, never
 * silently serve partial data.
 *
 * Migration: `remembra encrypt` / `remembra decrypt` rewrite the tree under
 * the storage lock (idempotent; already-converted files are skipped).
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { RemembraError } from "./errors.js";

const MAGIC = Buffer.from("RMBENC1", "ascii");
const NONCE_LEN = 12;
const TAG_LEN = 16;

export function encryptionEnabled(): boolean {
  return (process.env.REMEMBRA_ENCRYPT_KEY ?? "").length > 0;
}

function rawKey(): Buffer {
  const hex = process.env.REMEMBRA_ENCRYPT_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new RemembraError(
      "INVALID_INPUT",
      "REMEMBRA_ENCRYPT_KEY must be 64 hex chars (32 bytes). Generate one: " +
        `node -p 'require("node:crypto").randomBytes(32).toString("hex")'`,
    );
  }
  return Buffer.from(hex, "hex");
}

/** Cheap detection: does this file already hold ciphertext? */
export function isEncrypted(buf: Buffer): boolean {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptBuffer(plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", rawKey(), nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ct]);
}

/**
 * Decrypt a file buffer. Throws `ENCRYPTED_NO_KEY` when the key is missing
 * or wrong (GCM authentication failure covers both — a tampered file must
 * fail identically).
 */
export function decryptBuffer(buf: Buffer): Buffer {
  if (!isEncrypted(buf)) return buf; // plain file first: plain mode must never throw
  if (!encryptionEnabled()) {
    throw new RemembraError(
      "ENCRYPTED_NO_KEY",
      "storage contains encrypted memories but REMEMBRA_ENCRYPT_KEY is not set",
    );
  }
  if (buf.length < MAGIC.length + NONCE_LEN + TAG_LEN + 1) {
    throw new RemembraError("ENCRYPTED_NO_KEY", "encrypted file is truncated");
  }
  const nonce = buf.subarray(MAGIC.length, MAGIC.length + NONCE_LEN);
  const tag = buf.subarray(MAGIC.length + NONCE_LEN, MAGIC.length + NONCE_LEN + TAG_LEN);
  const ct = buf.subarray(MAGIC.length + NONCE_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", rawKey(), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new RemembraError(
      "ENCRYPTED_NO_KEY",
      "cannot decrypt: wrong REMEMBRA_ENCRYPT_KEY or corrupted file",
    );
  }
}
