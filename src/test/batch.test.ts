import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { MAX_BATCH_ITEMS, MAX_BATCH_BYTES, MAX_BATCH_SEARCH_RESULTS } from "../types.js";
import { createTenantContext } from "../tenant.js";

async function service(): Promise<MemoryService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-batch-"));
  return new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
}

function expectCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

test("batch validates the complete request before writing", async () => {
  const svc = await service();
  await assert.rejects(() => svc.batch({ operation: "unknown", items: [] }), expectCode("INVALID_INPUT"));
  await assert.rejects(() => svc.batch({ operation: "store", items: [] }), expectCode("INVALID_INPUT"));
  await assert.rejects(
    () => svc.batch({ operation: "store", items: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({ type: "fact", content: "x" })) }),
    expectCode("INVALID_INPUT"),
  );
  await assert.rejects(
    () => svc.batch({ operation: "delete", ids: ["same", "same"] }),
    expectCode("INVALID_INPUT"),
  );
  await assert.rejects(
    () => svc.batch({ operation: "update", items: [{ id: "missing", expectedVersion: 1 }] }),
    expectCode("INVALID_INPUT"),
  );
  await assert.rejects(
    () => svc.batch({ operation: "store", items: [{ type: "fact", content: "x".repeat(MAX_BATCH_BYTES) }] }),
    expectCode("INVALID_INPUT"),
  );
  await assert.rejects(
    () => svc.batch({ operation: "search", items: [] }),
    expectCode("INVALID_INPUT"),
  );
  await assert.rejects(
    () => svc.batch({
      operation: "search",
      items: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({ query: "x" })),
    }),
    expectCode("INVALID_INPUT"),
  );
  await assert.rejects(
    () => svc.batch({
      operation: "search",
      items: Array.from({ length: Math.floor(MAX_BATCH_SEARCH_RESULTS / 50) + 1 }, () => ({ limit: 50 })),
    }),
    expectCode("INVALID_INPUT"),
  );
  assert.equal((await svc.list({})).memories.length, 0);
});

test("batch store precomputes embeddings within the bounded provider path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-batch-embed-"));
  const calls: string[] = [];
  const svc = new MemoryService(new MemoryStore(root), {
    embedFn: async (text) => {
      calls.push(text);
      return [text.length];
    },
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  const result = await svc.batch({
    operation: "store",
    items: [
      { type: "fact", content: "embed one" },
      { type: "fact", content: "embed two" },
    ],
  });
  assert.equal(result.summary.succeeded, 2);
  assert.deepEqual(calls.sort(), ["embed one", "embed two"]);
  const memories = (await svc.list({})).memories;
  assert.ok(memories.every((memory) => memory.embedding?.length === 1));
});

test("batch store returns ordered outcomes and preserves duplicate inputs", async () => {
  const svc = await service();
  const result = await svc.batch({
    operation: "store",
    items: [
      { type: "fact", content: "first" },
      { type: "decision", content: "second", importance: 5 },
      { type: "fact", content: "first" },
    ],
  });
  assert.deepEqual(result.summary, { requested: 3, succeeded: 3, failed: 0 });
  assert.deepEqual(result.results.map((item) => item.index), [0, 1, 2]);
  assert.equal(new Set(result.results.map((item) => item.ok ? (item.result as { id: string }).id : "")).size, 3);
  assert.equal((await svc.list({})).memories.length, 3);
});

test("batch update and delete report item-local failures", async () => {
  const svc = await service();
  const first = await svc.store({ type: "fact", content: "before" });
  const second = await svc.store({ type: "fact", content: "other" });
  const updated = await svc.batch({
    operation: "update",
    items: [
      { id: first.id, content: "after", expectedVersion: 1 },
      { id: "does-not-exist", content: "missing" },
      { id: second.id, content: "stale", expectedVersion: 99 },
    ],
  });
  assert.equal(updated.operation, "update");
  assert.deepEqual(updated.execution, { transactionPolicy: "per-item", idempotency: "unsupported" });
  if (updated.operation !== "update") return;
  assert.deepEqual(updated.summary, { requested: 3, succeeded: 1, failed: 2 });
  assert.equal(updated.results[0].ok, true);
  assert.equal(updated.results[1].ok, false);
  assert.equal((updated.results[1] as { error: { code: string } }).error.code, "NOT_FOUND");
  assert.equal((updated.results[2] as { error: { code: string } }).error.code, "CONFLICT");

  const deleted = await svc.batch({ operation: "delete", ids: [first.id, "does-not-exist"] });
  assert.deepEqual(deleted.summary, { requested: 2, succeeded: 1, failed: 1 });
  assert.deepEqual(deleted.execution, { transactionPolicy: "per-item", idempotency: "unsupported" });
  assert.equal(deleted.results[1].ok, false);
  await assert.rejects(() => svc.get(first.id), expectCode("NOT_FOUND"));
});

test("batch search fans out through the authorized read path with ordered results", async () => {
  const svc = await service();
  await svc.store({ type: "fact", content: "Redis is the queue backend" });
  await svc.store({ type: "fact", content: "Postgres stores durable data" });
  const result = await svc.batch({
    operation: "search",
    items: [
      { query: "Redis", limit: 5 },
      { query: "Postgres", limit: 5 },
    ],
  });
  if (result.operation !== "search") assert.fail("expected search result");
  assert.deepEqual(result.summary, { requested: 2, succeeded: 2, failed: 0 });
  assert.deepEqual(result.execution, { transactionPolicy: "read-only", idempotency: "read-only" });
  assert.deepEqual(result.results.map((item) => item.index), [0, 1]);
  const first = result.results[0];
  const second = result.results[1];
  if (!first?.ok || !second.ok) assert.fail("expected both searches to succeed");
  assert.equal(first.result.results[0]?.content.includes("Redis"), true);
  assert.equal(second.result.results[0]?.content.includes("Postgres"), true);
});

test("batch search omits internal embeddings from public results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-batch-search-public-"));
  const svc = new MemoryService(new MemoryStore(root), {
    embedFn: async () => [0.1, 0.2, 0.3],
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  try {
    await svc.store({ type: "fact", content: "public batch search result" });
    const result = await svc.batch({ operation: "search", items: [{ query: "public" }] });
    if (result.operation !== "search" || !result.results[0]?.ok) assert.fail("expected search result");
    assert.equal(result.results[0].result.results[0]?.embedding, undefined);
  } finally {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch search stops before fan-out when its caller is already cancelled", async () => {
  const svc = await service();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => svc.batch({ operation: "search", items: [{ query: "cancelled" }] }, { signal: controller.signal }),
    expectCode("SERVICE_UNAVAILABLE"),
  );
});

test("batch search rechecks tenant authorization before each item", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-batch-search-auth-"));
  let authorizationChecks = 0;
  let embeddingCalls = 0;
  const svc = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embedFn: async () => {
      embeddingCalls++;
      return [1];
    },
    verifyTenantContext: () => {
      authorizationChecks++;
      return authorizationChecks < 2;
    },
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  const writer = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write"],
  });
  const reader = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read"],
  });
  try {
    await svc.store({ type: "fact", content: "tenant batch search secret" }, { tenant: writer });
    authorizationChecks = 0;
    embeddingCalls = 0;

    const result = await svc.batch({
      operation: "search",
      items: [{ query: "secret", limit: 5 }, { query: "secret", limit: 5 }],
    }, { tenant: reader });
    if (result.operation !== "search") assert.fail("expected search result");
    assert.deepEqual(result.summary, { requested: 2, succeeded: 1, failed: 1 });
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].ok, false);
    if (result.results[1].ok) assert.fail("expected the second authorization check to fail");
    assert.equal(result.results[1].error.code, "TENANT_REQUIRED");
    assert.equal(authorizationChecks, 2);
    assert.equal(embeddingCalls, 1);
  } finally {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch search caps its serialized response at the shared batch limit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-batch-search-size-"));
  const svc = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  try {
    await svc.store({
      type: "fact",
      content: "x".repeat(Math.floor(MAX_BATCH_BYTES / 2) + 1024),
    });
    await assert.rejects(
      () => svc.batch({ operation: "search", items: [{ limit: 1 }] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "INVALID_INPUT");
        assert.match((error as { message?: string }).message ?? "", /batch search response exceeds/);
        return true;
      },
    );
  } finally {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch export caps the final signed response envelope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-batch-export-size-"));
  const svc = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    snapshotKey: Buffer.from("v54 batch export response size key"),
  });
  try {
    const stored = await svc.store({
      type: "fact",
      content: "x".repeat(MAX_BATCH_BYTES - 450),
    });
    await assert.rejects(
      () => svc.batch({ operation: "export", ids: [stored.id] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "INVALID_INPUT");
        assert.match((error as { message?: string }).message ?? "", /batch export response exceeds/);
        return true;
      },
    );
  } finally {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch export selects visible records and remains import-compatible", async () => {
  const svc = await service();
  const first = await svc.store({ type: "fact", content: "selected" });
  const second = await svc.store({ type: "fact", content: "unselected" });
  await svc.relate({ id: first.id, related: [second.id] });
  const result = await svc.batch({ operation: "export", ids: [first.id] });
  if (result.operation !== "export") assert.fail("expected export result");
  assert.deepEqual(result.summary, { requested: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(result.execution, { transactionPolicy: "read-only", idempotency: "read-only" });
  assert.deepEqual(result.memories.map((memory) => memory.id), [first.id]);
  assert.equal(result.memories[0].relations, undefined);
  const imported = await service();
  const restore = await imported.importSnapshot(result);
  assert.equal(restore.imported, 1);
  assert.equal((await imported.get(first.id)).memory.id, first.id);
});
