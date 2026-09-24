import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import { canonicalJson } from "./tenant-migration.js";
import { SnapshotInput, type SnapshotInput as Snapshot } from "./types.js";

export const SNAPSHOT_INTEGRITY_ALGORITHM = "HMAC-SHA256" as const;

const integritySchema = z
  .object({
    algorithm: z.literal(SNAPSHOT_INTEGRITY_ALGORITHM),
    value: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export type SnapshotIntegrity = z.infer<typeof integritySchema>;
export type SignedSnapshot = Snapshot & { integrity: SnapshotIntegrity };

function invalid(message: string): never {
  throw new RemembraError("SNAPSHOT_INVALID", `snapshot integrity: ${message}`);
}

function sign(body: Snapshot, key: Buffer): SnapshotIntegrity {
  if (key.length === 0) invalid("HMAC key is empty");
  return {
    algorithm: SNAPSHOT_INTEGRITY_ALGORITHM,
    value: createHmac("sha256", key).update(canonicalJson(body), "utf8").digest("base64url"),
  };
}

/** Create a signed, canonical snapshot envelope without retaining the key. */
export function createSignedSnapshot(value: unknown, key: Buffer | Uint8Array): SignedSnapshot {
  const parsed = SnapshotInput.safeParse(value);
  if (!parsed.success) invalid("invalid snapshot body");
  if (parsed.data.integrity) invalid("snapshot is already signed");
  const body = parsed.data;
  return Object.freeze({ ...body, integrity: sign(body, Buffer.from(key)) });
}

/** Verify a signed snapshot before any caller uses its records. */
export function verifySignedSnapshot(value: unknown, key: Buffer | Uint8Array): SignedSnapshot {
  if (!value || typeof value !== "object") invalid("snapshot must be an object");
  const raw = value as Record<string, unknown>;
  const integrity = integritySchema.safeParse(raw.integrity);
  if (!integrity.success) invalid("signature is missing or malformed");
  const { integrity: _integrity, ...bodyInput } = raw;
  let body: Snapshot;
  try {
    body = SnapshotInput.parse(bodyInput);
  } catch {
    invalid("invalid snapshot body");
  }
  const expected = sign(body, Buffer.from(key));
  const actualBytes = Buffer.from(integrity.data.value, "base64url");
  const expectedBytes = Buffer.from(expected.value, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    invalid("signature verification failed");
  }
  return Object.freeze({ ...body, integrity: integrity.data });
}

export function isSignedSnapshot(value: unknown): value is SignedSnapshot {
  return integritySchema.safeParse((value as { integrity?: unknown } | null)?.integrity).success;
}
