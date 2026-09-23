import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import { ListInput } from "../types.js";
import { search } from "../retrieval.js";
import type { Memory } from "../types.js";
import type http from "node:http";

async function tempStore(cacheSize?: number): Promise<{ store: MemoryStore; root: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p5-"));
  return { store: new MemoryStore(dir, cacheSize !== undefined ? { cacheSize } : {}), root: dir };
}

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

async function startServer(store: MemoryStore): Promise<{ server: http.Server; base: string }> {
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

// --- parse cache: validation (correctness must not depend on the cache) ---

test("cache: external file edit is picked up (mtime+size validation)", async () => {
  const { store, root } = await tempStore();
  const memory = await store.store(storeInput("original content"));
  const file = path.join(root, "global", `${memory.id}.md`);

  assert.equal((await store.all())[0]?.content, "original content"); // warm

  const raw = await fs.readFile(file, "utf8");
  await fs.writeFile(file, raw.replace("original content", "REWRITTEN by another process entirely"), "utf8");

  const fresh = await store.get(memory.id);
  assert.equal(fresh?.content, "REWRITTEN by another process entirely", "stale cache must not serve old bytes");
});

test("cache: second store instance sees updates from the first (cross-process coherence)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p5b-"));
  const a = new MemoryStore(dir);
  const b = new MemoryStore(dir);
  const memory = await a.store(storeInput("v1 content"));
  await b.all(); // instance B warms its cache with v1

  await a.update({ ...memory, content: "v2 content — changed under B's feet" });
  const seenByB = await b.get(memory.id);
  assert.equal(seenByB?.content, "v2 content — changed under B's feet");
});

test("cache: validated hits skip the file read entirely", async () => {
  const { store, root } = await tempStore();
  const memory = await store.store(storeInput("read me without touching the disk"));
  await store.all(); // warm

  const file = path.join(root, "global", `${memory.id}.md`);
  await fs.chmod(file, 0o000); // a re-read would fail with EACCES…
  try {
    const again = await store.all();
    assert.equal(again.find((m) => m.id === memory.id)?.content, "read me without touching the disk");
    assert.ok(store.cacheStats().size > 0, "cache populated");
  } finally {
    await fs.chmod(file, 0o600);
  }
});

test("cache: LRU capacity bounds entries; 0 disables caching", async () => {
  const { store } = await tempStore(2);
  for (const c of ["one", "two", "three"]) await store.store(storeInput(c));
  assert.equal((await store.all()).length, 3);
  const stats = store.cacheStats();
  assert.equal(stats.capacity, 2);
  assert.ok(stats.size <= 2, `evicted to capacity, got ${stats.size}`);

  const off = await tempStore(0);
  await off.store.store(storeInput("a"));
  await off.store.store(storeInput("b"));
  assert.equal((await off.store.all()).length, 2, "disabled cache still reads everything");
  assert.equal(off.store.cacheStats().size, 0, "nothing remembered");
});

// --- pagination ---

test("list pagination: opt-in, totals, and page math", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  for (let i = 0; i < 5; i++) await svc.store(storeInput(`memory number ${i}`));

  const full = await svc.list({});
  assert.equal(full.memories.length, 5, "no offset/limit → unchanged full list");
  assert.equal(full.total, 5);
  assert.ok(!full.text.startsWith("Showing"), "no pagination header when unpaginated");

  const page1 = await svc.list({ limit: 2 });
  assert.equal(page1.memories.length, 2);
  assert.equal(page1.total, 5);
  assert.ok(page1.text.startsWith("Showing 1–2 of 5"));

  const page3 = await svc.list({ offset: 4, limit: 2 });
  assert.equal(page3.memories.length, 1, "last page clamps");
  assert.ok(page3.text.startsWith("Showing 5–5 of 5"));

  const beyond = await svc.list({ offset: 99 });
  assert.equal(beyond.memories.length, 0);
  assert.equal(beyond.total, 5, "total still reports the full count");
  assert.match(beyond.text, /No memories at this offset/);

  // MCP-side schema accepts the new fields and rejects nonsense
  assert.equal(ListInput.parse({ offset: 0, limit: 500 }).limit, 500);
  assert.throws(() => ListInput.parse({ offset: -1 }));
  assert.throws(() => ListInput.parse({ limit: 0 }));
});

test("HTTP pagination: query params flow through, bad params ignored", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  for (let i = 0; i < 5; i++) await svc.store(storeInput(`http memory ${i}`));
  const { server, base } = await startServer(store);
  try {
    const page = await (
      await fetch(`${base}/memories?offset=1&limit=2`)
    ).json();
    assert.equal(page.memories.length, 2);
    assert.equal(page.total, 5);
    assert.equal(page.offset, 1);
    assert.equal(page.limit, 2);

    const bad = await (await fetch(`${base}/memories?offset=-1&limit=abc`)).json();
    assert.equal(bad.memories.length, 5, "invalid params fall back to the full list");
    assert.equal(bad.offset, undefined);
  } finally {
    server.close();
  }
});

// --- streaming (large responses → chunked transfer) ---

test("HTTP: large list/search responses stream as chunked JSON", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const big = "lorem ipsum dolor sit amet ".repeat(80); // ~2.2 KB each
  for (let i = 0; i < 40; i++) await svc.store(storeInput(`${big} #${i}`)); // ~90 KB total
  const { server, base } = await startServer(store);
  try {
    const listRes = await fetch(`${base}/memories`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get("transfer-encoding"), "chunked", "large body switches to chunked");
    assert.equal(listRes.headers.get("content-length"), null, "no length when streaming");
    const list = await listRes.json();
    assert.equal(list.memories.length, 40);
    assert.equal(list.total, 40);

    const searchRes = await fetch(`${base}/memories/search?limit=40&query=lorem`);
    assert.equal(searchRes.headers.get("transfer-encoding"), "chunked");
    const found = await searchRes.json();
    assert.equal(found.results.length, 40);
    assert.ok(typeof found.text === "string" && found.text.length > 0);

    // small responses keep the Phase-1 Content-Length shape
    const smallRes = await fetch(`${base}/health`);
    assert.ok(Number(smallRes.headers.get("content-length")) > 0);
    assert.equal(smallRes.headers.get("transfer-encoding"), null);
  } finally {
    server.close();
  }
});

// --- vector-index decision: brute force at the audit's own target scale ---

function mem(over: Partial<Memory>): Memory {
  return {
    id: Math.random().toString(36).slice(2, 8),
    type: "fact",
    content: "",
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

test("brute-force cosine at audit scale: 10K memories × 768-dim vectors", (t) => {
  const N = 10_000;
  const D = 768;
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const memories: Memory[] = [];
  for (let i = 0; i < N; i++) {
    const v = new Array<number>(D);
    for (let d = 0; d < D; d++) v[d] = rnd();
    memories.push(mem({ id: `m${String(i).padStart(6, "0")}`, content: `memory ${i}`, embedding: v }));
  }
  const q = new Array<number>(D);
  for (let d = 0; d < D; d++) q[d] = rnd();

  const started = performance.now();
  const results = search(memories, { query: "", limit: 10 }, q);
  const elapsed = performance.now() - started;
  t.diagnostic(`brute-force search over ${N}×${D}: ${elapsed.toFixed(1)}ms`);

  assert.equal(results.length, 10);
  assert.ok(elapsed < 1000, `expected <1000ms at audit scale, took ${elapsed.toFixed(1)}ms`);
});
