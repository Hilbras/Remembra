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

test("SEC-SNAPSHOT-002: an interrupted tenant migration stays resumable under its own gate", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-resume-source-"));
  const sourceStore = new MemoryStore(sourceRoot);
  const source = await sourceStore.store(StoreInput.parse({ type: "fact", content: "resume me" }));
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
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-resume-target-"));
  const service = new MemoryService(new MemoryStore(targetRoot), {
    tenantMode: "strict",
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    snapshotKey: key,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(targetRoot, "claims")),
  });
  try {
    await service.initializeRecovery();
    // An interrupted migration leaves its own gate behind.
    await service.beginBatchRestore("migration");
    assert.equal(service.batchIdempotencyRestorePending, true);
    assert.equal(service.batchIdempotencyRestoreReason, "migration");

    // Resuming applies the plan and publishes the gate.
    const applied = await service.migrateSnapshot(snapshot, plan, key, { tenant });
    assert.equal(applied.imported, 1);
    assert.equal(service.batchIdempotencyRestorePending, false);
    assert.equal((await service.search({ query: "resume", tenant })).results.length, 1);

    // A later migration starts its own gate and clears it again.
    const second = await service.migrateSnapshot(snapshot, plan, key, { tenant });
    assert.equal(second.skipped, 1);
    assert.equal(second.imported, 0);
    assert.equal(service.batchIdempotencyRestorePending, false);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("SEC-SNAPSHOT-004: a migration that does not land every record keeps its gate", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-incomplete-source-"));
  const sourceStore = new MemoryStore(sourceRoot);
  const sources = [];
  for (let index = 0; index < 2; index++) {
    sources.push(await sourceStore.store(StoreInput.parse({ type: "fact", content: `incomplete ${index}` })));
  }
  const snapshot = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: sources,
  }, key);
  const plan = planTenantMigration({
    source: sources,
    sourceSchemaVersion: 3,
    organizationMappings: [{ sourceNamespace: "legacy-root", destination: "org-a" }],
  }, key);
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-incomplete-target-"));
  const targetStore = new MemoryStore(targetRoot);
  const service = new MemoryService(targetStore, {
    tenantMode: "strict",
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    snapshotKey: key,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(targetRoot, "claims")),
  });
  try {
    await service.initializeRecovery();
    // A destination write that silently drops records must not be published.
    const original = targetStore.importMemory.bind(targetStore);
    let dropped = false;
    (targetStore as unknown as { importMemory: typeof original }).importMemory = async (memory, filter) => {
      if (!dropped) {
        dropped = true;
        return false;
      }
      return original(memory, filter);
    };
    await assert.rejects(
      () => service.migrateSnapshot(snapshot, plan, key, { tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SERVICE_UNAVAILABLE",
    );
    assert.equal(service.batchIdempotencyRestorePending, true);
    assert.equal(service.batchIdempotencyRestoreReason, "migration");

    // Resuming under the retained gate completes the migration.
    (targetStore as unknown as { importMemory: typeof original }).importMemory = original;
    const resumed = await service.migrateSnapshot(snapshot, plan, key, { tenant });
    assert.equal(resumed.imported, 1);
    assert.equal(resumed.skipped, 1);
    assert.equal(service.batchIdempotencyRestorePending, false);
    assert.equal((await service.search({ query: "incomplete", tenant })).results.length, 2);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("SEC-SNAPSHOT-003: a data restore gate is never resumed as a migration", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-restore-source-"));
  const sourceStore = new MemoryStore(sourceRoot);
  const source = await sourceStore.store(StoreInput.parse({ type: "fact", content: "restore gate wins" }));
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
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-migration-restore-target-"));
  const service = new MemoryService(new MemoryStore(targetRoot), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: key,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(targetRoot, "claims")),
  });
  try {
    await service.initializeRecovery();
    await service.beginBatchRestore("restore");
    assert.equal(service.batchIdempotencyRestoreReason, "restore");
    await assert.rejects(
      () => service.migrateSnapshot(snapshot, plan, key, { tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SERVICE_UNAVAILABLE",
    );
    // The restore gate is untouched and still blocks ordinary reads.
    assert.equal(service.batchIdempotencyRestorePending, true);
    await assert.rejects(
      () => service.search({ query: "restore", tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SERVICE_UNAVAILABLE",
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
