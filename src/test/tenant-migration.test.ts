import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TENANT_MIGRATION_FORMAT,
  TENANT_MIGRATION_VERSION,
  createTenantMigrationManifest,
  verifyTenantMigrationManifest,
} from "../tenant-migration.js";
import { TENANT_SCHEMA_VERSION } from "../types.js";
import { RemembraError } from "../errors.js";

const input = {
  sourceSchemaVersion: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  organizationMappings: [{ sourceNamespace: "legacy-root", destination: "org_01" }],
  entityMappings: {
    users: [{ source: "legacy-user", destination: "user-1" }],
    projects: [{ source: "legacy-project", destination: "project-alpha" }],
    agents: [{ source: "legacy-agent", destination: "agent-writer" }],
    scopes: [{ source: "global", destination: "global" }],
  },
  aclMappings: [],
  counts: { memories: 1, relations: 0, history: 0, audit: 0 },
  records: [
    {
      organizationId: "org_01",
      id: "12345678-1234-4234-8234-123456789abc",
      sha256: "a".repeat(64),
    },
  ],
  references: [],
};

test("tenant migration manifest is canonical and HMAC-verifiable", () => {
  const key = Buffer.from("test migration key");
  const manifest = createTenantMigrationManifest(input, key);
  assert.equal(manifest.format, TENANT_MIGRATION_FORMAT);
  assert.equal(manifest.manifestVersion, TENANT_MIGRATION_VERSION);
  assert.equal(manifest.destinationSchemaVersion, TENANT_SCHEMA_VERSION);
  assert.equal(manifest.signature.algorithm, "HMAC-SHA256");
  verifyTenantMigrationManifest(manifest, key);
  verifyTenantMigrationManifest(JSON.parse(JSON.stringify(manifest)), key);
});

test("manifest verification fails closed on tampering or wrong key", () => {
  const key = Buffer.from("test migration key");
  const manifest = createTenantMigrationManifest(input, key);
  const tampered = structuredClone(manifest);
  tampered.records[0].sha256 = "b".repeat(64);
  assert.throws(
    () => verifyTenantMigrationManifest(tampered, key),
    (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
  );
  assert.throws(
    () => verifyTenantMigrationManifest(manifest, Buffer.from("wrong key")),
    (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
  );
});

test("manifest rejects unresolved/duplicate mappings and count mismatches", () => {
  const key = Buffer.from("test migration key");
  assert.throws(
    () => createTenantMigrationManifest({
      ...input,
      organizationMappings: [
        { sourceNamespace: "same", destination: "org-a" },
        { sourceNamespace: "same", destination: "org-b" },
      ],
    }, key),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => createTenantMigrationManifest({ ...input, counts: { ...input.counts, memories: 2 } }, key),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
});
