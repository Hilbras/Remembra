import { test } from "node:test";
import assert from "node:assert/strict";
import { search, searchQ, rrfFuse, mmrDedup, expandRelationCandidates } from "../retrieval.js";
import { embedCached, clearEmbedCache, clearEmbedCachePartition } from "../embeddings.js";
import { Memory } from "../types.js";

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

const store: Memory[] = [
  mem({ id: "role1", type: "role", content: "Answer briefly", scope: "global" }),
  mem({ id: "db", content: "Uses PostgreSQL", embedding: [1, 0] }),
  mem({ id: "ui", content: "Uses React", embedding: [0, 1] }),
  mem({ id: "secret", content: "Other project secret", scope: "/other" }),
];

test("keyword mode (no queryVec) matches v1 behavior", () => {
  const results = search(store, { query: "postgres", scope: "global" });
  assert.equal(results[0].id, "role1"); // roles always surface first (v1 rule)
  assert.equal(results[1].id, "db"); // best keyword match next
  assert.ok(results.every((m) => m.scope !== "/other"));
});

test("semantic mode: query vector ranks by cosine, roles still first", () => {
  const results = search(store, { query: "db", scope: "/global" }, [1, 0]);
  assert.equal(results[0].id, "role1"); // role gate is absolute
  assert.equal(results[1].id, "db"); // cosine 1.0
  const uiIdx = results.findIndex((m) => m.id === "ui");
  const dbIdx = results.findIndex((m) => m.id === "db");
  assert.ok(uiIdx > dbIdx);
});

test("scope gate holds in semantic mode", () => {
  const results = search(store, { query: "anything", scope: "/repo" }, [1, 0]);
  assert.ok(results.every((m) => m.scope === "global" || m.scope === "/repo"));
  assert.ok(!results.some((m) => m.id === "secret"));
});

test("semantic: irrelevant scoped memory filtered by similarity gate", () => {
  const scoped = [
    mem({ id: "repo-fact", content: "uses kubernetes", scope: "/repo" }),
  ];
  const results = search(scoped, { query: "cooking recipes", scope: "/elsewhere" }, [0, 1]);
  // different scope → excluded regardless
  assert.equal(results.length, 0);
  const sameScope = search(scoped, { query: "cooking recipes", scope: "/repo" }, [0, 1]);
  // same scope survives but ranks low; role/global handled elsewhere
  assert.equal(sameScope.length, 1);
});

test("memory without vector falls back to keywords in semantic mode", () => {
  const mixed = [
    mem({ id: "novec", content: "special keyword here", scope: "/repo" }),
    mem({ id: "vec", content: "unrelated text", scope: "/repo", embedding: [1, 0] }),
  ];
  const results = search(mixed, { query: "special keyword", scope: "/repo" }, [0, 1]);
  assert.equal(results[0].id, "novec");
});

// ---------------------------------------------------------------------------
// V4.2.0 — Retrieval Engine
// ---------------------------------------------------------------------------

test("explain:true returns per-memory score breakdown summing to totalScore", () => {
  const store = [
    mem({ id: "a", content: "keyword match", tags: ["foo"] }),
    mem({ id: "b", content: "other thing" }),
  ];
  const r = searchQ(store, { query: "keyword", explain: true });
  assert.ok(r.explanations, "explanations present when explain:true");
  assert.equal(r.explanations!.length, 2);
  for (const e of r.explanations!) {
    const sum = Object.values(e.components).reduce((a: number, b: number) => a + b, 0);
    assert.ok(Math.abs(sum - e.totalScore) < 0.01, `${e.id}: components sum to totalScore`);
    assert.ok(e.reasons.length > 0, `${e.id}: has reasons`);
  }
  // Without explain, explanations field is absent.
  const r2 = searchQ(store, { query: "keyword" });
  assert.ok(r2.explanations === undefined, "explanations omitted when explain:false");
});

test("RRF gives tied-score items equal contribution (no positional bias)", () => {
  const now = Date.now();
  const tie = Array.from({ length: 4 }, (_, i) =>
    mem({ id: `t${i}`, content: "same word here", updatedAt: new Date(now).toISOString() }),
  );
  // All have identical kwScore; RRF must not break ties by id-order.
  const r = searchQ(tie, { query: "same word" });
  // The top-2 order should be stable across repeated calls with different input orders.
  const r2 = searchQ([...tie].reverse(), { query: "same word" });
  // With equal modifiers and equal RRF, order is by id (deterministic).
  assert.deepEqual(
    r.results.map((m: Memory) => m.id),
    r2.results.map((m: Memory) => m.id),
    "RRF tie handling is order-independent",
  );
});

test("configured embedding reranking breaks fused ties deterministically", () => {
  const updatedAt = "2026-01-01T00:00:00.000Z";
  const tied = [
    mem({ id: "a", content: "same keyword", embedding: [0, 1], updatedAt }),
    mem({ id: "z", content: "same keyword", embedding: [1, 0], updatedAt }),
  ];
  const baseline = searchQ(tied, { query: "same keyword", limit: 2 }, [1, 0], { diversity: false });
  const reranked = searchQ(tied, { query: "same keyword", limit: 2 }, [1, 0], { diversity: false, reranking: true });
  assert.deepEqual(reranked.results.map((m) => m.id), ["z", "a"]);
  assert.deepEqual(
    reranked.results.map((m) => m.id),
    searchQ(tied, { query: "same keyword", limit: 2 }, [1, 0], { diversity: false, reranking: true }).results.map((m) => m.id),
  );
  assert.ok(baseline.results.length === 2);
});

test("temporal: latest N surfaces most-recent memories first", () => {
  const base = Date.now();
  const store = [
    mem({ id: "old", content: "ancient fact", updatedAt: new Date(base - 10 * 86400000).toISOString() }),
    mem({ id: "new", content: "recent fact", updatedAt: new Date(base - 1 * 86400000).toISOString() }),
    mem({ id: "mid", content: "middle fact", updatedAt: new Date(base - 5 * 86400000).toISOString() }),
  ];
  const r = searchQ(store, { query: "latest 2" });
  // "latest 2" boosts recency; newest should rank highest among matches.
  assert.equal(r.results[0].id, "new");
  assert.equal(r.results[1].id, "mid");
});

test("temporal: before/after ISO date filters by updatedAt", () => {
  const base = Date.now();
  const store = [
    mem({ id: "before", content: "old stuff", updatedAt: new Date(base - 10 * 86400000).toISOString() }),
    mem({ id: "after", content: "new stuff", updatedAt: new Date(base - 1 * 86400000).toISOString() }),
  ];
  // Query with a cutoff between the two dates.
  const cutoff = new Date(base - 5 * 86400000).toISOString();
  const r = searchQ(store, { query: `after ${cutoff.slice(0, 10)}` });
  // Only the newer memory is after the cutoff.
  assert.equal(r.results[0].id, "after");
});

test("MMR reduces redundancy: two near-identical vectors don't both rank top", () => {
  const similar = [
    mem({ id: "sim1", content: "similar text one", embedding: [0.9, 0.1] }),
    mem({ id: "sim2", content: "similar text two", embedding: [0.85, 0.15] }),
    mem({ id: "diff", content: "different topic entirely", embedding: [-0.5, 0.8] }),
  ];
  const r = searchQ(similar, { query: "similar topic", limit: 2 }, [1, 0]);
  // MMR should pick sim1 and diff, not sim1+sim2.
  const ids = r.results.map((m: Memory) => m.id);
  assert.ok(ids.includes("sim1"));
  assert.ok(ids.includes("diff"));
  assert.ok(!ids.includes("sim2"), "MMR dedupes near-duplicate embeddings");
});

test("relation expansion is pool-bounded and does not follow foreign IDs", () => {
  const pool = [
    mem({ id: "seed", relations: [{ id: "neighbor", kind: "related" }, { id: "foreign", kind: "related" }] }),
    mem({ id: "neighbor" }),
    mem({ id: "other" }),
  ];
  const expanded = expandRelationCandidates(pool, [pool[0]], { maxDepth: 1, maxEdges: 8 });
  assert.deepEqual(expanded.map((m) => m.id), ["seed", "neighbor"]);
  const capped = expandRelationCandidates(pool, [pool[0]], { maxDepth: 2, maxEdges: 0 });
  assert.deepEqual(capped.map((m) => m.id), ["seed"]);
});

test("embedding cache partitions and purges are tenant-safe", async () => {
  clearEmbedCache();
  let calls = 0;
  const adapter = {
    id: "test-embedding",
    embed: async () => {
      calls++;
      return [1, 0];
    },
  };
  await embedCached("same query", "openai", { adapter, cachePartition: "org-a" });
  await embedCached("same query", "openai", { adapter, cachePartition: "org-a" });
  await embedCached("same query", "openai", { adapter, cachePartition: "org-b" });
  assert.equal(calls, 2);
  clearEmbedCachePartition("org-a");
  await embedCached("same query", "openai", { adapter, cachePartition: "org-a" });
  assert.equal(calls, 3);
});

test("embedding cache exports are callable", () => {
  assert(typeof embedCached === "function", "embedCached is exported");
  assert(typeof clearEmbedCache === "function", "clearEmbedCache is exported");
  clearEmbedCache(); // clean slate
});
