import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTenantMigration, planTenantMigration } from "../tenant-migration-runner.js";
import { MemoryStore } from "../store.js";
import { verifyTenantMigrationManifest } from "../tenant-migration.js";
import type { Memory } from "../types.js";

function memory(id: string, overrides: Partial<Memory> = {}): Memory {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    type: "fact",
    content: `legacy ${id}`,
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    owner: "global",
    access: "global",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const key = Buffer.from("migration runner test key");
const mappings = {
  organizationMappings: [{ sourceNamespace: "legacy-root", destination: "org-a" }],
  entityMappings: {
    users: [{ source: "user-old", destination: "user-a" }],
    projects: [{ source: "project-old", destination: "project-a" }],
    agents: [{ source: "agent-old", destination: "agent-a" }],
  },
  aclMappings: [{
    sourceOwner: "user" as const,
    sourceAccess: "private" as const,
    destinationOwner: "user" as const,
    destinationAccess: "private" as const,
  }],
};

test("tenant migration runner signs, verifies, maps, and idempotently applies records", async () => {
  const source = [
    memory("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      projectId: "project-old",
      userId: "user-old",
      agentId: "agent-old",
      owner: "user",
      access: "private",
    }),
    memory("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { relations: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "related" }] }),
  ];
  const plan = planTenantMigration({
    source,
    sourceSchemaVersion: 3,
    ...mappings,
  }, key);
  assert.equal(plan.manifest.records.length, 2);
  assert.equal(plan.manifest.references.length, 1);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-migration-runner-"));
  const destination = new MemoryStore(root);
  const first = await applyTenantMigration(plan, destination, key);
  assert.deepEqual(first, { imported: 2, skipped: 0 });
  const loaded = await destination.get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { organizationId: "org-a", projectId: "project-a" });
  assert.equal(loaded?.tenantId, "org-a");
  assert.equal(loaded?.projectId, "project-a");
  assert.equal(loaded?.userId, "user-a");
  assert.equal(loaded?.agentId, "agent-a");
  assert.equal(loaded?.access, "private");

  const retry = await applyTenantMigration(plan, destination, key);
  assert.deepEqual(retry, { imported: 0, skipped: 2 });
  await fs.rm(root, { recursive: true, force: true });
});

test("migration runner rejects foreign references and source tampering before writing", async () => {
  const source = [memory("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { relations: [{ id: "foreign", kind: "related" }] })];
  assert.throws(
    () => planTenantMigration({ source, sourceSchemaVersion: 3, ...mappings }, key),
    /outside the source set/,
  );

  const validSource = [memory("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
  const plan = planTenantMigration({ source: validSource, sourceSchemaVersion: 3, ...mappings }, key);
  validSource[0].content = "tampered after planning";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-migration-tamper-"));
  const destination = new MemoryStore(root);
  await assert.rejects(() => applyTenantMigration(plan, destination, key), /checksum mismatch/);
  assert.equal((await destination.all(true, { organizationId: "org-a" })).length, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("migration manifest signature is required by the runner", () => {
  const source = [memory("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
  const plan = planTenantMigration({ source, sourceSchemaVersion: 3, ...mappings }, key);
  const { signature: _signature, ...unsigned } = plan.manifest;
  assert.throws(
    () => verifyTenantMigrationManifest(unsigned, key),
    /required|signature/i,
  );
});
