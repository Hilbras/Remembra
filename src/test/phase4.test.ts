import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { recencyScore, score, search } from "../retrieval.js";
import type { Memory } from "../types.js";

async function tempStore(): Promise<MemoryStore> {
  return new MemoryStore(await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p4-")));
}

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

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

const aged = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

// --- exponential recency (audit: linear decay / 60-day cliff) ---

test("recency is exponential with a ~30d half-life and no cliff", () => {
  const now = Date.now();
  const at = (days: number) => recencyScore(mem({ updatedAt: aged(days) }), now);

  assert.ok(Math.abs(at(0) - 20) < 0.01, "fresh = 20");
  assert.ok(Math.abs(at(30) - 10) < 0.01, "half-life at 30d = 10");
  assert.ok(Math.abs(at(60) - 5) < 0.01, "60d ≈ 5 — the old formula gave 0 here");
  assert.ok(at(90) > 0 && at(180) > 0, "never hard-cuts to zero");
  // strictly decreasing
  let prev = Infinity;
  for (const d of [0, 7, 30, 61, 90, 180, 365]) {
    const v = at(d);
    assert.ok(v < prev, `decreasing at ${d}d`);
    prev = v;
  }
  // guards
  assert.ok(at(-5) <= 20, "future-dated clamps to fresh");
  assert.equal(recencyScore(mem({ updatedAt: "not-a-date" }), now), 0, "invalid date = 0");
});

// --- importance normalization across modes (audit: ×10 vs ×4 asymmetry) ---

test("importance delta is identical in keyword and semantic mode", () => {
  const now = Date.now();
  const terms: string[] = []; // no query — isolates the importance term
  const low = mem({ content: "some fact", importance: 1, embedding: [1, 0] });
  const high = mem({ content: "some fact", importance: 5, embedding: [1, 0] });

  const keywordDelta = score(high, terms, undefined, now) - score(low, terms, undefined, now);
  const semanticDelta = score(high, terms, undefined, now, [1, 0]) - score(low, terms, undefined, now, [1, 0]);

  assert.equal(keywordDelta, semanticDelta, "same memory must weigh the same in both modes");
  assert.equal(keywordDelta, (5 - 1) * 4, "importance × 4 in both modes");
});

// --- provenance weighting (audit: source stored but never ranked) ---

test("explicit provenance adds the same +10 in both modes", () => {
  const now = Date.now();
  const terms: string[] = [];
  // Trust held constant (both trusted) so this isolates the provenance layer;
  // the trust layer itself is exercised in the 4.1.0 model tests.
  const auto = mem({ content: "a fact", embedding: [1, 0], provenance: { sourceType: "conversation" } });
  const explicit = mem({ content: "a fact", embedding: [1, 0], provenance: { sourceType: "manual" } });

  const keywordDelta =
    score(explicit, terms, undefined, now) - score(auto, terms, undefined, now);
  const semanticDelta =
    score(explicit, terms, undefined, now, [1, 0]) - score(auto, terms, undefined, now, [1, 0]);
  assert.equal(keywordDelta, 10);
  assert.equal(semanticDelta, 10);
});

test("an older explicit store outranks a fresh auto-extract", () => {
  const store = [
    mem({ id: "auto", content: "auto extracted fact", updatedAt: aged(0), provenance: { sourceType: "conversation" } }),
    mem({ id: "explicit", content: "deliberately stored", updatedAt: aged(5), provenance: { sourceType: "manual" } }),
  ];
  const results = search(store, {});
  assert.equal(results[0].id, "explicit", "+10 provenance beats 5 days of recency");
  assert.equal(results[1].id, "auto");
});

test("direct stores stamp manual/trusted, digests stamp conversation/unverified (persisted)", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [
      { type: "fact" as const, content: "extracted automatically", tags: [], importance: 3, scope: "global" },
    ],
  });

  const direct = await svc.store(storeInput("stored on purpose"));
  assert.deepEqual(direct.memory.provenance, { sourceType: "manual" });
  assert.equal(direct.memory.trust, "trusted");
  const raw = await fs.readFile(
    path.join(store["root"], "global", `${direct.memory.id}.md`),
    "utf8",
  );
  assert.match(raw, /^trust: trusted$/m, "trust persisted in frontmatter");
  assert.match(raw, /^ {2}sourceType: manual$/m, "provenance object serialized as YAML");

  const digested = await svc.digest({ transcript: "session" });
  assert.equal(digested.stored[0].provenance?.sourceType, "conversation");
  assert.equal(digested.stored[0].trust, "unverified", "digest extraction is never trusted by itself (§4.9)");
  const reloaded = await store.get(digested.stored[0].id);
  assert.equal(reloaded?.trust, "unverified", "survives a file round trip");
});

// --- fuzzy dedup fast path (audit: exact-match only) ---

test("near-identical variants (punctuation + typo) are skipped, quantities are not", async () => {
  const store = await tempStore();
  let llmCalls = 0;
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [
      // punctuation-only difference → fuzzy skip
      { type: "fact" as const, content: "Deploy pipeline runs on every push to main branch!", tags: [], importance: 3, scope: "global" },
      // one-character typo → fuzzy skip (no numbers involved)
      { type: "fact" as const, content: "Deploys pipeline runs on every push to main branch", tags: [], importance: 3, scope: "global" },
      // changed quantity → NOT a duplicate; must reach the LLM merge
      { type: "fact" as const, content: "API rate limit is 500 rpm", tags: [], importance: 3, scope: "global" },
    ],
    mergeFn: async (newContent) => {
      llmCalls++;
      return newContent.includes("500") ? { action: "store" } : { action: "skip" };
    },
  });
  await svc.store(storeInput("Deploy pipeline runs on every push to main branch"));
  await svc.store(storeInput("API rate limit is 100 rpm"));

  const res = await svc.digest({ transcript: "updates" });
  assert.equal(res.skippedDuplicates, 2, "punctuation + typo variants skipped");
  assert.equal(res.stored.length, 1, "only the changed quantity stored");
  assert.equal(llmCalls, 1, "LLM consulted exactly once — for the quantity change");
  assert.equal((await store.all()).length, 3, "original×2 + new quantity fact");
});

test("fuzzy dedup works within a single digest batch", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [
      { type: "fact" as const, content: "The staging cluster runs eighteen pods", tags: [], importance: 3, scope: "global" },
      { type: "fact" as const, content: "The staging cluster runs eighteen pods.", tags: [], importance: 3, scope: "global" },
    ],
  });
  const res = await svc.digest({ transcript: "batch" });
  assert.equal(res.stored.length, 1, "second item deduped against the first");
  assert.equal(res.skippedDuplicates, 1);
  assert.equal((await store.all()).length, 1);
});

test("near-identical match against an ARCHIVED memory revives it", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { memory } = await svc.store(storeInput("Remember to rotate the encryption keys monthly"));
  await store.archive(memory.id);
  assert.ok((await store.get(memory.id))?.archivedAt);

  const digester = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [
      // same words, punctuation differs → exact key misses, fuzzy catches it
      { type: "fact" as const, content: "Remember to rotate the encryption keys monthly!", tags: [], importance: 3, scope: "global" },
    ],
    mergeFn: async () => {
      throw new Error("fuzzy path must not consult the LLM");
    },
  });
  const res = await digester.digest({ transcript: "reminder again" });
  assert.equal(res.merged, 1, "counted as a revival");
  assert.equal(res.stored.length, 0);
  assert.equal((await store.get(memory.id))?.archivedAt, undefined, "back in the active tree");
});

test("near-duplicates across different scopes are NOT deduped", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  await svc.store(storeInput("The deploy window is Tuesday morning", { scope: "/proj/a" }));
  const scoped = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [
      // identical text, different scope → a different fact; must be stored
      { type: "fact" as const, content: "The deploy window is Tuesday morning!", tags: [], importance: 3, scope: "/proj/b" },
    ],
    mergeFn: async () => {
      throw new Error("different scopes must never reach the LLM");
    },
  });
  const res = await scoped.digest({ transcript: "other project" });
  assert.equal(res.stored.length, 1, "stored under its own scope");
  assert.equal((await store.all()).length, 2, "one per scope");
});

// --- snapshot round trip preserves provenance ---

test("export/import round trip keeps provenance", async () => {
  const src = await tempStore();
  const dst = await tempStore();
  const auto = await new MemoryService(src, { embeddingProvider: "none" }).store(
    storeInput("auto memory", { provenance: { sourceType: "conversation" } }),
  );
  const snapshot = await new MemoryService(src, { embeddingProvider: "none" }).exportSnapshot();
  assert.deepEqual(snapshot.memories[0].provenance, { sourceType: "conversation" });

  await new MemoryService(dst, { embeddingProvider: "none" }).importSnapshot(snapshot);
  assert.deepEqual((await dst.get(auto.memory.id))?.provenance, { sourceType: "conversation" });
});
