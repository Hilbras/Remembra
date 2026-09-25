import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createTenantContext } from "../tenant.js";
import { createSignedSnapshot } from "../snapshot-integrity.js";
import { planTenantMigration } from "../tenant-migration-runner.js";
import { SNAPSHOT_FORMAT, StoreInput } from "../types.js";
import { RemembraError } from "../errors.js";
import { FileBatchIdempotencyStore } from "../batch-idempotency-store.js";

const key = Buffer.from("v501 snapshot key");
const tenant = createTenantContext({
  organizationId: "org-a",
  membershipVersion: "membership-1",
  scopes: ["global"],
  capabilities: ["tenant:read", "tenant:write"],
});

function tenantlessSnapshot() {
  return createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 4,
    exportedAt: new Date().toISOString(),
    memories: [{
      id: "42345678-1234-4234-8234-123456789abc",
      type: "fact",
      content: "tenantless secret",
      scope: "global",
      tags: [],
      importance: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, key);
}

test("SEC-SNAPSHOT-001: strict restore rejects a signed tenantless snapshot before writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-snapshot-"));
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: key,
  });
  const snapshot = tenantlessSnapshot();
  try {
    await assert.rejects(
      () => service.previewSnapshot(snapshot, { tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
    );
    await assert.rejects(
      () => service.importSnapshot(snapshot, { tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
    );
    assert.equal((await service.search({ query: "tenantless", tenant })).results.length, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-SNAPSHOT-001: signed migration requires a healthy restore-gate ledger", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-no-ledger-source-"));
  const sourceStore = new MemoryStore(sourceRoot);
  const source = await sourceStore.store(StoreInput.parse({ type: "fact", content: "must stay gated" }));
  const snapshot = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: [source],
  }, key);
  const plan = planTenantMigration({
    source: [source],
    sourceSchemaVersion: 3,
    organizationMappings: [{ sourceNamespace: "legacy-root", destination: "org-a" }],
  }, key);
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-no-ledger-target-"));
  const service = new MemoryService(new MemoryStore(targetRoot), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: key,
  });
  try {
    await assert.rejects(
      () => service.migrateSnapshot(snapshot, plan, key, { tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SERVICE_UNAVAILABLE",
    );
    assert.equal((await service.search({ query: "gated", tenant })).results.length, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test("SEC-SNAPSHOT-001: explicit signed migration applies only through a target-bound plan", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-source-"));
  const sourceStore = new MemoryStore(sourceRoot);
  const source = await sourceStore.store(StoreInput.parse({ type: "fact", content: "migrate me" }));
  const snapshot = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: [source],
  }, key);
  const plan = planTenantMigration({
    source: [source],
    sourceSchemaVersion: 3,
    organizationMappings: [{ sourceNamespace: "legacy-root", destination: "org-a" }],
  }, key);
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-target-"));
  const service = new MemoryService(new MemoryStore(targetRoot), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: key,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(targetRoot, "claims")),
  });
  try {
    const dryRun = await service.migrateSnapshot(snapshot, plan, key, { tenant, dryRun: true });
    assert.deepEqual(dryRun, { total: 1, planned: 1, imported: 0, skipped: 0, dryRun: true });
    assert.equal((await service.search({ query: "migrate", tenant })).results.length, 0);
    const applied = await service.migrateSnapshot(snapshot, plan, key, { tenant });
    assert.equal(applied.imported, 1);
    assert.equal((await service.search({ query: "migrate", tenant })).results.length, 1);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});
