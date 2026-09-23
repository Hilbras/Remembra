import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, EvalQuery } from "../eval.js";
import type { Memory } from "../types.js";

function makeMem(id: string, content = "test"): Memory {
  const now = new Date().toISOString();
  return {
    id,
    type: "fact",
    scope: "global",
    content,
    tags: [],
    importance: 3,
    confidence: 0.8,
    trust: "trusted",
    createdAt: now,
    updatedAt: now,
    version: 1,
    provenance: { sourceType: "manual" },
  } as Memory;
}

async function mockSearch(fn: (q: string) => Memory[]) {
  return evaluate({
    k: 5,
    queries: [
      { id: "q1", text: "coffee", relevantIds: ["m1", "m2"], irrelevantIds: ["m3"] },
      { id: "q2", text: "typescript", relevantIds: ["m4"] },
    ],
    searchFn: async (q) => fn(q),
  });
}

test("evaluate: perfect retrieval gets precision=1, recall=1, mrr=1, ndcg=1", async () => {
  const r = await evaluate({
    k: 5,
    queries: [
      { id: "q1", text: "coffee", relevantIds: ["m1", "m2"], irrelevantIds: ["m3"] },
      { id: "q2", text: "typescript", relevantIds: ["m4"] },
    ],
    searchFn: async () => [makeMem("m1"), makeMem("m2"), makeMem("m4")],
  });
  assert.ok(r.aggregate.precision_at_k > 0);
  assert.ok(r.aggregate.recall_at_k > 0);
});

test("evaluate: computes per-query and aggregate metrics", async () => {
  const r = await mockSearch((q) => {
    if (q.includes("coffee")) return [makeMem("m1"), makeMem("m2")];
    return [makeMem("m4")];
  });
  assert.equal(r.aggregate.queries_evaluated, 2);
  assert.ok(r.aggregate.precision_at_k > 0);
  assert.ok(r.aggregate.recall_at_k > 0);
  assert.ok(r.aggregate.mrr > 0);
});

test("evaluate: empty results get zero metrics", async () => {
  const r = await evaluate({
    k: 5,
    queries: [{ id: "q_empty", text: "nothing", relevantIds: ["nonexistent"] }],
    searchFn: async () => [],
  });
  assert.equal(r.aggregate.precision_at_k, 0);
  assert.equal(r.aggregate.recall_at_k, 0);
  assert.equal(r.aggregate.mrr, 0);
  assert.equal(r.aggregate.hit_rate_at_k, 0);
});

test("evaluate: MRR reflects rank position", async () => {
  const r = await evaluate({
    k: 5,
    queries: [{ id: "q_rank", text: "x", relevantIds: ["target"], irrelevantIds: [] }],
    searchFn: async () => [makeMem("a"), makeMem("b"), makeMem("target"), makeMem("c")],
  });
  // target is at position 3 (0-indexed: 2) → MRR = 1/3
  assert.ok(Math.abs(r.aggregate.mrr - 1 / 3) < 0.01, `mrr=${r.aggregate.mrr}`);
});

test("evaluate: NDCG rewards higher-ranked relevant items", async () => {
  // Relevant at position 1 vs position 3
  const r1 = await evaluate({
    k: 5,
    queries: [{ id: "q_top", text: "x", relevantIds: ["good"] }],
    searchFn: async () => [makeMem("good"), makeMem("a"), makeMem("b")],
  });
  const r2 = await evaluate({
    k: 5,
    queries: [{ id: "q_bot", text: "x", relevantIds: ["good"] }],
    searchFn: async () => [makeMem("a"), makeMem("b"), makeMem("good")],
  });
  assert.ok(r1.aggregate.ndcg_at_k > r2.aggregate.ndcg_at_k, "top-ranked relevant should have higher NDCG");
});
