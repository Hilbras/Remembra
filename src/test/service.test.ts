import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";

async function tempService(): Promise<MemoryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-svc-"));
  return new MemoryService(new MemoryStore(dir));
}

test("store returns id and message", async () => {
  const svc = await tempService();
  const result = await svc.store({ type: "fact", content: "hello" });
  assert.ok(result.id);
  assert.match(result.message, /Stored fact memory/);
});

test("store rejects invalid input", async () => {
  const svc = await tempService();
  await assert.rejects(() => svc.store({ type: "banana", content: "x" }));
});

test("search returns formatted text and results", async () => {
  const svc = await tempService();
  await svc.store({ type: "decision", content: "Chose X over Y", scope: "global" });
  const { text, results } = await svc.search({ query: "chose", scope: "global" });
  assert.equal(results.length, 1);
  assert.match(text, /DECISION/);
});

test("search uses complete candidate pages and falls back on partial pages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-candidates-"));
  const store = new MemoryStore(dir);
  const stored = await store.store({
    type: "fact",
    content: "candidate needle",
    scope: "global",
    tags: [],
    importance: 3,
  });
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });

  let allCalls = 0;
  const originalAll = store.all.bind(store);
  store.all = async (includeArchived?: boolean) => {
    allCalls++;
    return originalAll(includeArchived);
  };
  (store as any).searchCandidates = async () => ({
    memories: [stored],
    coverage: "complete" as const,
    source: "file" as const,
    totalDocs: 1,
  });

  const optimized = await svc.search({ query: "needle", limit: 1 });
  assert.equal(optimized.results[0]?.id, stored.id);
  assert.equal(allCalls, 0);

  (store as any).searchCandidates = async () => ({
    memories: [],
    coverage: "partial" as const,
    source: "none" as const,
  });
  const fallback = await svc.search({ query: "needle", limit: 1 });
  assert.equal(fallback.results[0]?.id, stored.id);
  assert.equal(allCalls, 1);
});

test("maintenance can run through the bounded background queue", async () => {
  const svc = await tempService();
  const handle = svc.enqueueMaintenance();
  const result = await handle.done;
  assert.equal(result.state, "completed");
  assert.equal(result.value?.archived.length, 0);
  await svc.shutdownBackgroundJobs();
});

test("background jobs cover embedding, validation, and archiving", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-jobs-"));
  const store = new MemoryStore(dir);
  const svc = new MemoryService(store, {
    embedFn: async (text) => [text.length],
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  const memory = await store.store({
    type: "fact",
    content: "job memory",
    scope: "global",
    tags: [],
    importance: 3,
  });
  const embedded = await svc.enqueueEmbedding(memory.id).done;
  assert.deepEqual(embedded.value, { id: memory.id, embedded: true });
  const validated = await svc.enqueueValidation().done;
  assert.equal(validated.value?.checked, 1);
  const archived = await svc.enqueueArchive(memory.id).done;
  assert.deepEqual(archived.value, { id: memory.id, archived: true });
  await svc.shutdownBackgroundJobs();
});

test("list filters by type and scope", async () => {
  const svc = await tempService();
  await svc.store({ type: "fact", content: "a", scope: "global" });
  await svc.store({ type: "role", content: "b", scope: "/p" });
  const { memories } = await svc.list({ type: "role" });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].type, "role");
});

test("forget reports missing ids", async () => {
  const svc = await tempService();
  const res = await svc.forget("doesnotexist");
  assert.equal(res.ok, false);
  assert.match(res.text, /No memory/);
});
