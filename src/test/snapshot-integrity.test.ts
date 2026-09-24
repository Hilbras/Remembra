import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignedSnapshot, isSignedSnapshot, verifySignedSnapshot } from "../snapshot-integrity.js";
import { RemembraError } from "../errors.js";

const snapshot = {
  format: "remembra-export" as const,
  version: 4,
  exportedAt: "2026-01-01T00:00:00.000Z",
  memories: [{
    id: "12345678-1234-4234-8234-123456789abc",
    type: "fact" as const,
    content: "signed snapshot",
    scope: "global",
    tags: [],
    importance: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }],
};

test("snapshot HMAC envelope verifies after JSON round-trip", () => {
  const key = Buffer.from("snapshot signing key");
  const signed = createSignedSnapshot(snapshot, key);
  assert.equal(isSignedSnapshot(signed), true);
  const verified = verifySignedSnapshot(JSON.parse(JSON.stringify(signed)), key);
  assert.equal(verified.memories[0].content, "signed snapshot");
});

test("snapshot verification fails closed on tampering, missing signature, or wrong key", () => {
  const key = Buffer.from("snapshot signing key");
  const signed = createSignedSnapshot(snapshot, key);
  const tampered = structuredClone(signed);
  tampered.memories[0].content = "tampered";
  for (const value of [tampered, snapshot]) {
    assert.throws(
      () => verifySignedSnapshot(value, key),
      (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
    );
  }
  assert.throws(
    () => verifySignedSnapshot(signed, Buffer.from("wrong key")),
    (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
  );
});
