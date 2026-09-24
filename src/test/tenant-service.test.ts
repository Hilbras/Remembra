import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { createTenantContext } from "../tenant.js";
import { createSignedSnapshot } from "../snapshot-integrity.js";
import { RemembraError } from "../errors.js";

function context(organizationId: string, projectId: string) {
  return createTenantContext({
    organizationId,
    projectId,
    membershipVersion: "membership-1",
    scopes: [`project/${projectId}`],
    capabilities: ["tenant:read", "tenant:write"],
  });
}

async function strictService() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-service-"));
  const store = new MemoryStore(root);
  return {
    root,
    store,
    service: new MemoryService(store, {
      tenantMode: "strict",
      embeddingProvider: "none",
      snapshotKey: Buffer.from("test snapshot key"),
    }),
  };
}

test("strict service requires opaque context and isolates core memory operations", async () => {
  const { root, service } = await strictService();
  const tenantA = context("org-a", "p1");
  const tenantB = context("org-b", "p1");
  const a = await service.store({ type: "fact", content: "Tenant A private fact", scope: "project/p1" }, { tenant: tenantA });
  const b = await service.store({ type: "fact", content: "Tenant B private fact", scope: "project/p1" }, { tenant: tenantB });
  assert.equal(a.memory.tenantId, "org-a");
  assert.equal(b.memory.tenantId, "org-b");
  await assert.rejects(
    () => service.store({ type: "fact", content: "foreign reference", meta: { compressedFrom: [b.id] } }, { tenant: tenantA }),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );

  await assert.rejects(
    () => service.search({ query: "fact" }),
    (error: unknown) => error instanceof RemembraError && error.code === "TENANT_REQUIRED",
  );
  await assert.rejects(
    () => service.get(a.id, { tenant: { organizationId: "org-a" } as never }),
    (error: unknown) => error instanceof RemembraError && error.code === "TENANT_REQUIRED",
  );
  assert.equal((await service.search({ query: "fact", tenant: tenantA })).results.length, 1);
  assert.equal((await service.search({ query: "fact", tenant: tenantB })).results[0].id, b.id);
  await assert.rejects(
    () => service.get(a.id, { tenant: tenantB }),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );

  const updated = await service.update(a.id, { content: "Tenant A updated" }, { tenant: tenantA });
  assert.equal(updated.memory.content, "Tenant A updated");
  await assert.rejects(
    () => service.update(a.id, { content: "cross" }, { tenant: tenantB }),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );
  assert.equal((await service.context({ query: "updated", maxTokens: 200 }, { tenant: tenantA })).memories[0].id, a.id);
  assert.notEqual((await service.context({ query: "updated", maxTokens: 200 }, { tenant: tenantB })).memories[0]?.id, a.id);
  assert.equal((await service.history({ id: a.id }, { tenant: tenantA })).versions.length, 2);
  await assert.rejects(
    () => service.relate({ id: a.id, related: [b.id], action: "add" }, { tenant: tenantA }),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );

  const snapshot = await service.exportSnapshot({ tenant: tenantA });
  assert.equal(snapshot.version, 4);
  assert.equal(snapshot.memories.length, 1);
  await assert.rejects(
    () => service.importSnapshot(snapshot, { tenant: tenantB }),
    (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
  );
  await assert.rejects(
    () => service.importSnapshot(createSignedSnapshot({
      format: snapshot.format,
      version: snapshot.version,
      exportedAt: snapshot.exportedAt,
      memories: [{
        ...a.memory,
        id: "42345678-1234-4234-8234-123456789abc",
        relations: [{ id: b.id, kind: "related" }],
      }],
    }, Buffer.from("test snapshot key")), { tenant: tenantA }),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );
  assert.throws(() => service.db, (error: unknown) => error instanceof RemembraError && error.code === "TENANT_REQUIRED");
  await fs.rm(root, { recursive: true, force: true });
});

test("queued tenant work rechecks membership before provider/write side effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-job-"));
  let valid = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tenant = context("org-a", "p1");
  let embedCalls = 0;
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embeddingProvider: "none",
    embedFn: async () => {
      embedCalls++;
      return [0.1, 0.2];
    },
    verifyTenantContext: async () => {
      await gate;
      return valid;
    },
  });
  const stored = await service.store({ type: "fact", content: "queued tenant memory", scope: "project/p1" }, { tenant });
  const callsBeforeJob = embedCalls;
  const job = service.enqueueEmbedding(stored.id, { tenant });
  await Promise.resolve();
  valid = false;
  release();
  const result = await job.done;
  assert.equal(result.state, "failed");
  assert.ok(result.error instanceof RemembraError);
  assert.equal((result.error as RemembraError).code, "TENANT_REQUIRED");
  const unchanged = await service.get(stored.id, { tenant });
  assert.equal(embedCalls, callsBeforeJob);
  assert.deepEqual(unchanged.memory.embedding, [0.1, 0.2]);
  await service.shutdownBackgroundJobs();
  await fs.rm(root, { recursive: true, force: true });
});

test("strict SQLite search passes tenant predicates through the service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-service-sqlite-"));
  const service = new MemoryService(new SqliteBackend({ root }), { tenantMode: "strict", embeddingProvider: "none" });
  const tenantA = context("org-a", "p1");
  const tenantB = context("org-b", "p1");
  await service.store({ type: "fact", content: "needle A", scope: "project/p1" }, { tenant: tenantA });
  await service.store({ type: "fact", content: "needle B", scope: "project/p1" }, { tenant: tenantB });
  const results = await service.search({ query: "needle", tenant: tenantA });
  assert.equal(results.results.length, 1);
  assert.equal(results.results[0].tenantId, "org-a");
  await fs.rm(root, { recursive: true, force: true });
});
