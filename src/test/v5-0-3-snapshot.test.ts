import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSnapshotSemantics } from "../snapshot-validation.js";
import { SnapshotInput } from "../types.js";

function memory(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345678-1234-4234-8234-123456789abc",
    type: "fact" as const,
    content: "snapshot memory",
    scope: "global",
    tags: [],
    importance: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(records: ReturnType<typeof memory>[], overrides: Record<string, unknown> = {}) {
  return SnapshotInput.parse({
    format: "remembra-export",
    version: 3,
    exportedAt: "2026-01-02T00:00:00.000Z",
    memories: records,
    ...overrides,
  });
}

test("REC-SNAP-001: semantic validation rejects malformed timestamps and ordering", () => {
  assert.throws(
    () => validateSnapshotSemantics(snapshot([memory({ createdAt: "not-a-date" })])),
    (error: unknown) => (error as { code?: string }).code === "SNAPSHOT_INVALID",
  );
  assert.throws(
    () => validateSnapshotSemantics(snapshot([memory({ createdAt: "2026-01-03T00:00:00.000Z" })])),
    (error: unknown) => (error as { code?: string }).code === "SNAPSHOT_INVALID",
  );
});

test("REC-SNAP-001: duplicate IDs and self-references are rejected", () => {
  assert.throws(
    () => validateSnapshotSemantics(snapshot([memory(), memory()])),
    (error: unknown) => (error as { code?: string }).code === "SNAPSHOT_INVALID",
  );
  const id = memory().id;
  assert.throws(
    () => validateSnapshotSemantics(snapshot([memory({ relations: [{ id, kind: "related" }] })], { strictTenant: true })),
    (error: unknown) => (error as { code?: string }).code === "SNAPSHOT_INVALID",
  );
});

test("REC-SNAP-001: strict tenant validation checks dimensions and references", () => {
  assert.throws(
    () => validateSnapshotSemantics(snapshot([memory({ projectId: "project-a" })]), { strictTenant: true }),
    (error: unknown) => (error as { code?: string }).code === "SNAPSHOT_INVALID",
  );
  assert.throws(
    () => validateSnapshotSemantics(
      snapshot([memory({ tenantId: "org-a", relations: [{ id: "82345678-1234-4234-8234-123456789abc", kind: "related" }] })]),
      { strictTenant: true },
    ),
    (error: unknown) => (error as { code?: string }).code === "SNAPSHOT_INVALID",
  );
  assert.doesNotThrow(() => validateSnapshotSemantics(
    snapshot([memory({ related: ["82345678-1234-4234-8234-123456789abc"] })]),
  ));
});

test("REC-SNAP-001: serialized size limits are enforced before writes", () => {
  assert.throws(
    () => validateSnapshotSemantics(snapshot([memory()]), { maxBytes: 10 }),
    (error: unknown) => (error as { code?: string }).code === "SNAPSHOT_INVALID",
  );
});
