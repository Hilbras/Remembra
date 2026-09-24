import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../store.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { planTenantMigration } from "../tenant-migration-runner.js";
import {
  FileMigrationStateStore,
  publishTenantMigration,
  runDurableTenantMigration,
} from "../migration-state.js";
import type { Memory } from "../types.js";

const key = Buffer.from("durable migration state key");

function memory(id: string): Memory {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    type: "fact",
    content: id,
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function plan() {
  return planTenantMigration({
    source: [memory("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), memory("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
    sourceSchemaVersion: 3,
    organizationMappings: [{ sourceNamespace: "legacy-root", destination: "org-a" }],
  }, key);
}

test("durable migration checkpoints, retries idempotently, and publishes explicitly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-migration-state-"));
  const statePath = path.join(root, "migration.json");
  const stateStore = new FileMigrationStateStore(statePath);
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true });
  const destination = new MemoryStore(dataRoot);
  const migrationPlan = plan();
  await assert.rejects(
    () => runDurableTenantMigration(migrationPlan, destination, key, { stateStore, checkpointEvery: 0 }),
    /positive integer/,
  );
  const first = await runDurableTenantMigration(migrationPlan, destination, key, { stateStore, checkpointEvery: 1 });
  assert.equal(first.state.status, "applied");
  assert.equal(first.imported, 2);
  const retry = await runDurableTenantMigration(migrationPlan, destination, key, { stateStore });
  assert.equal(retry.state.status, "applied");
  assert.equal(retry.imported, 2);
  assert.equal(retry.skipped, 0);
  const published = await publishTenantMigration(first.state.planId, stateStore);
  assert.equal(published.status, "published");
  assert.equal((await stateStore.load(first.state.planId))?.status, "published");
  await fs.rm(root, { recursive: true, force: true });
});

test("durable migration resumes after a partial checkpoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-migration-partial-"));
  const statePath = path.join(root, "migration.json");
  const stateStore = new FileMigrationStateStore(statePath);
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true });
  const destination = new MemoryStore(dataRoot);
  const original = destination.importMemory.bind(destination);
  let calls = 0;
  destination.importMemory = async (...args) => {
    calls++;
    if (calls === 2) throw new Error("interrupted after checkpoint");
    return original(...args);
  };
  const migrationPlan = plan();
  await assert.rejects(
    () => runDurableTenantMigration(migrationPlan, destination, key, { stateStore, checkpointEvery: 1 }),
    /interrupted after checkpoint/,
  );
  const stateRaw = JSON.parse(await fs.readFile(statePath, "utf8")) as { planId: string; processed: number };
  assert.equal(stateRaw.processed, 1);
  const resumed = await runDurableTenantMigration(migrationPlan, destination, key, { stateStore, checkpointEvery: 1 });
  assert.equal(resumed.state.status, "applied");
  assert.equal(resumed.imported, 2);
  assert.equal(calls, 3);
  await fs.rm(root, { recursive: true, force: true });
});

test("durable migration state works with the SQLite backend", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-migration-sqlite-"));
  const stateStore = new FileMigrationStateStore(path.join(root, "migration.json"));
  const dataRoot = path.join(root, "sqlite");
  await fs.mkdir(dataRoot, { recursive: true });
  const destination = new SqliteBackend({ root: dataRoot });
  const result = await runDurableTenantMigration(plan(), destination, key, { stateStore });
  assert.equal(result.state.status, "applied");
  assert.equal((await destination.get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { organizationId: "org-a" }))?.tenantId, "org-a");
  destination.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("durable migration records a failed checkpoint and resumes after retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-migration-retry-"));
  const statePath = path.join(root, "migration.json");
  const stateStore = new FileMigrationStateStore(statePath);
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true });
  const destination = new MemoryStore(dataRoot);
  const original = destination.importMemory.bind(destination);
  let fail = true;
  destination.importMemory = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error("simulated interrupted migration");
    }
    return original(...args);
  };
  const migrationPlan = plan();
  await assert.rejects(
    () => runDurableTenantMigration(migrationPlan, destination, key, { stateStore }),
    /simulated interrupted migration/,
  );
  const stateRaw = JSON.parse(await fs.readFile(statePath, "utf8")) as { planId: string };
  const failed = await stateStore.load(stateRaw.planId);
  assert.equal(failed?.status, "failed");
  const resumed = await runDurableTenantMigration(migrationPlan, destination, key, { stateStore });
  assert.equal(resumed.state.status, "applied");
  assert.equal(resumed.imported + resumed.skipped, 2);
  await fs.rm(root, { recursive: true, force: true });
});
