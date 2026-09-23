import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { ExtractedMemory } from "../llm.js";

async function tempStore(): Promise<MemoryStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v3-"));
  return new MemoryStore(dir);
}

const oldDate = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function agedMemory(
  store: MemoryStore,
  over: { updatedAt?: string; lastSeen?: string; archivedAt?: string },
) {
  const m = await store.store({ type: "fact", content: `aged ${Math.random()}`, scope: "global", tags: [], importance: 3, source: undefined } as never);
  // Directly rewrite the file with aged timestamps.
  const file = await findFile(store, m.id);
  let text = await fs.readFile(file, "utf8");
  if (over.updatedAt) text = text.replace(/updated: .*/, `updated: ${over.updatedAt}`);
  if (over.lastSeen) text = text.replace("created:", `lastSeen: ${over.lastSeen}\ncreated:`);
  if (over.archivedAt) text = text.replace("created:", `archivedAt: ${over.archivedAt}\ncreated:`);
  await fs.writeFile(file, text, "utf8");
  return m;
}

async function findFile(store: MemoryStore, id: string): Promise<string> {
  const root = (store as unknown as { root: string }).root;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === `${id}.md`) return full;
    }
  }
  throw new Error(`file for ${id} not found`);
}

// --- decay lifecycle ---

test("unused active memory gets archived, fresh one stays", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { archiveAfterDays: 90, archiveTtlDays: 365 });
  const old = await agedMemory(store, { updatedAt: oldDate(120) });
  const fresh = await store.store({ type: "fact", content: "fresh", scope: "global", tags: [], importance: 3, source: undefined } as never);

  const result = await svc.maintain();
  assert.ok(result.archived.includes(old.id));
  assert.ok(!result.archived.includes(fresh.id));

  // Archived memory is out of active search but visible with flag.
  const active = await store.all();
  assert.ok(!active.some((m) => m.id === old.id));
  const all = await store.all(true);
  assert.ok(all.some((m) => m.id === old.id && m.archivedAt));
  const { memories } = await svc.list({ includeArchived: true });
  assert.ok(memories.some((m) => m.id === old.id && m.archivedAt));
});

test("search-hit refreshes the decay clock (lastSeen bumped)", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { decayIntervalMs: 0 });
  const m = await agedMemory(store, { updatedAt: oldDate(100), lastSeen: oldDate(100) });
  await svc.search({ query: "aged", scope: "global" });
  // touch is fire-and-forget — give it a tick.
  await new Promise((r) => setTimeout(r, 50));
  const after = await store.get(m.id);
  assert.ok(after?.lastSeen);
  assert.ok(Date.now() - Date.parse(after.lastSeen!) < 60_000);
});

test("roles never decay", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { archiveAfterDays: 90, archiveTtlDays: 365 });
  const role = await store.store({ type: "role", content: "Be brief", scope: "global", tags: [], importance: 5, source: undefined } as never);
  // Age the role itself to well past the cutoff.
  const file = await findFile(store, role.id);
  let text = await fs.readFile(file, "utf8");
  text = text.replace(/updated: .*/, `updated: ${oldDate(400)}`);
  await fs.writeFile(file, text, "utf8");

  const result = await svc.maintain();
  assert.ok(!result.archived.includes(role.id));
  assert.ok((await store.get(role.id)) !== null);
});

test("archived memory past TTL gets auto-deleted", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { archiveAfterDays: 90, archiveTtlDays: 365 });
  const m = await store.store({ type: "fact", content: "doomed", scope: "global", tags: [], importance: 3, source: undefined } as never);
  // Archive normally, then backdate archivedAt in the moved file.
  await store.archive(m.id);
  const file = await findFile(store, m.id);
  let text = await fs.readFile(file, "utf8");
  text = text.replace(/archivedAt: .*/, `archivedAt: ${oldDate(400)}`);
  await fs.writeFile(file, text, "utf8");

  const result = await svc.maintain();
  assert.ok(result.deleted.includes(m.id));
  assert.equal(await store.get(m.id), null);
});

test("archived memory within TTL survives maintenance", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { archiveAfterDays: 90, archiveTtlDays: 365 });
  const m = await store.store({ type: "fact", content: "recently archived", scope: "global", tags: [], importance: 3, source: undefined } as never);
  await store.archive(m.id);
  const result = await svc.maintain();
  assert.ok(!result.deleted.includes(m.id));
  assert.ok((await store.get(m.id)) !== null);
});

// --- vector backfill ---

test("maintain backfills missing vectors when embeddings enabled", async () => {
  const store = await tempStore();
  let embedCalls = 0;
  const svc = new MemoryService(store, {
    embedFn: async () => {
      embedCalls++;
      return [1, 0, 0];
    },
    embeddingProvider: "openai" as never,
  });
  // Store one without vector (simulating embeddings-off era).
  await store.store({ type: "fact", content: "old memory", scope: "global", tags: [], importance: 3, source: undefined } as never);
  assert.equal(embedCalls, 0);

  const result = await svc.maintain();
  assert.equal(result.embedded, 1);
  assert.equal(embedCalls, 1);

  // Second run: nothing to backfill.
  const again = await svc.maintain();
  assert.equal(again.embedded, 0);
});

// --- contradiction merge ---

function svcWithExtractMerge(
  extract: (t: string) => Promise<ExtractedMemory[]>,
  merge?: (n: string, e: { type: string; content: string }) => Promise<{ action: string; content?: string }>,
) {
  return tempStore().then(
    (store) =>
      new MemoryService(store, {
        extractFn: extract,
        mergeFn: merge as never,
        embeddingProvider: "none",
      }),
  );
}

test("digest merges evolved fact and preserves superseded note", async () => {
  const merge = async (): Promise<{ action: string; content?: string }> => ({
    action: "merge",
    content: "API rate limit is 500 rpm",
  });
  const svc = await svcWithExtractMerge(
    async () => [{ type: "fact", content: "API rate limit is 500 rpm", tags: [], importance: 3 }],
    merge,
  );
  // Seed the old fact — same type/scope, similar keywords → candidate.
  await svc.store({ type: "fact", content: "API rate limit is 100 rpm", scope: "global" });

  const res = await svc.digest({ transcript: "we raised the limit" });
  assert.equal(res.merged, 1);
  assert.equal(res.stored.length, 0);
  assert.equal(res.skippedDuplicates, 0);

  const all = await svc.db.all();
  const merged = all.find((m) => m.content.includes("500"));
  assert.ok(merged);
  assert.match(merged.content, /superseded \(\d{4}-\d{2}-\d{2}\): API rate limit is 100 rpm/);
});

test("digest skip decision counts as duplicate", async () => {
  const merge = async () => ({ action: "skip" as const });
  const svc = await svcWithExtractMerge(
    async () => [{ type: "fact", content: "Postgres limit is one hundred rpm", tags: [], importance: 3 }],
    merge,
  );
  await svc.store({ type: "fact", content: "Postgres limit is 100 requests per minute", scope: "global" });
  const res = await svc.digest({ transcript: "t" });
  assert.equal(res.skippedDuplicates, 1);
  assert.equal(res.stored.length, 0);
});

test("digest store decision stores fresh alongside candidate", async () => {
  const merge = async () => ({ action: "store" as const });
  const svc = await svcWithExtractMerge(
    async () => [{ type: "fact", content: "Postgres also handles caching now", tags: [], importance: 3 }],
    merge,
  );
  await svc.store({ type: "fact", content: "Postgres stores all events", scope: "global" });
  const res = await svc.digest({ transcript: "t" });
  assert.equal(res.stored.length, 1);
  assert.equal(res.merged, 0);
});

test("no candidate → no merge call, item stored directly", async () => {
  let mergeCalls = 0;
  const merge = async () => {
    mergeCalls++;
    return { action: "skip" as const };
  };
  const svc = await svcWithExtractMerge(
    async () => [{ type: "fact", content: "completely unrelated zebras topic", tags: [], importance: 3 }],
    merge,
  );
  await svc.store({ type: "fact", content: "Postgres stores all events", scope: "global" });
  const res = await svc.digest({ transcript: "t" });
  assert.equal(mergeCalls, 0);
  assert.equal(res.stored.length, 1);
});

test("digest revives archived exact duplicate", async () => {
  const svc = await svcWithExtractMerge(async () => [
    { type: "fact", content: "Decayed but returning fact", tags: [], importance: 3 },
  ]);
  const { memory } = await svc.store({ type: "fact", content: "Decayed but returning fact", scope: "global" });
  await svc.db.archive(memory.id);
  assert.equal((await svc.db.all()).length, 0);

  const res = await svc.digest({ transcript: "t" });
  assert.equal(res.merged, 1);
  const active = await svc.db.all();
  assert.ok(active.some((m) => m.id === memory.id));
});
