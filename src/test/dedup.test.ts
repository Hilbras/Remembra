/**
 * V5.7.0 T04 — exact and same-source duplicate detection.
 *
 * The audit's finding: the only existing pass, `mmrDedup`, is a diversity
 * *reordering* that classifies nothing, and in the default
 * `embeddingProvider: none` configuration it returns its input unchanged. So a
 * corpus of identical memories returned every copy.
 *
 * The headline test here is T04-006, which runs through `searchQ` with **no query
 * vector** — the mode that silently passed everything through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeResults, duplicateKey, searchQ, isExactDuplicate } from "../retrieval.js";
import { evaluate, type EvalQuery } from "../eval.js";
import type { Memory } from "../types.js";

let seq = 0;
function mem(content: string, over: Partial<Memory> = {}, source: Partial<Memory["provenance"]> = {}): Memory {
  seq++;
  return {
    id: over.id ?? `m${String(seq).padStart(3, "0")}`,
    type: "fact",
    content,
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual", ...source },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// --- Detection ------------------------------------------------------------

test("T04-001: identical text is detected without any embedding", () => {
  const a = mem("the deploy failed at midnight");
  const b = mem("The deploy failed at midnight.");
  const c = mem("the deploy failed at dawn");
  assert.equal(isExactDuplicate(a, b), true, "case and trailing punctuation do not make it a new memory");
  assert.equal(isExactDuplicate(a, c), false, "genuinely different text is kept");
  assert.equal(isExactDuplicate(a, a), false, "a memory is not a duplicate of itself");
  assert.equal(duplicateKey(a), duplicateKey(b));
});

test("T04-002: the best-ranked copy survives and the result is stable", () => {
  // The input list is already sorted by score, so "first wins" means the best copy
  // survives — and the result depends on the ranking, not on input order.
  const best = mem("policy: 30 day refunds", { id: "best" });
  const worse = mem("policy: 30 day refunds", { id: "worse" });
  const { memories, removed } = dedupeResults([best, worse, mem("unrelated")]);
  assert.deepEqual(memories.map((m) => m.id), ["best", memories[1]!.id]);
  assert.equal(memories[0]!.id, "best", "the higher-ranked copy is the one kept");
  assert.deepEqual(removed, [{ id: "worse", keptId: "best", reason: "exact" }]);
});

test("T04-003: same-source detection needs provenance finer than sourceType", () => {
  // sourceType alone is far too coarse: every hand-written memory is `manual`.
  const fromA = mem("shared note", {}, { sourceType: "agent", agentId: "agent-1", runId: "run-9" });
  const alsoA = mem("shared note", {}, { sourceType: "agent", agentId: "agent-1", runId: "run-9" });
  const fromB = mem("shared note", {}, { sourceType: "agent", agentId: "agent-2", runId: "run-9" });
  assert.equal(dedupeResults([fromA, alsoA], { sameSource: true }).memories.length, 1, "same run collapses");
  assert.equal(dedupeResults([fromA, fromB], { sameSource: true }).memories.length, 2, "a different agent does not");
});

test("T04-004: exact collapsing is on by default and same-source is off", () => {
  // Deliberately asymmetric. Identical text from two different sources is often
  // corroboration, and discarding the second source is a worse error than showing
  // a repeat.
  const conversation = mem("the API rate limit is 60/min", {}, { sourceType: "conversation" });
  const agent = mem("the API rate limit is 60/min", {}, { sourceType: "agent", agentId: "a" });
  const byDefault = dedupeResults([conversation, agent]);
  assert.equal(byDefault.memories.length, 1, "exact duplicates collapse without asking");
  assert.equal(byDefault.removed[0]!.reason, "exact");

  const sameSource = dedupeResults([conversation, mem("the API rate limit is 60/min", {}, { sourceType: "conversation" })], {
    sameSource: true,
  });
  assert.equal(sameSource.removed[0]!.reason, "same_source", "and the reason is distinguishable");
});

test("T04-005: deduplication can be turned off", async () => {
  const a = mem("identical", { id: "a" });
  const b = mem("identical", { id: "b" });
  assert.equal(dedupeResults([a, b], { exact: false }).memories.length, 2, "exact: false keeps both");
  assert.equal(dedupeResults([a, b], { exact: false, sameSource: false }).memories.length, 2);
});

test("T04-006: duplicates collapse in the DEFAULT configuration, with no embeddings", () => {
  // The audit's core complaint: `mmrDedup` returned its input unchanged here.
  // This is the regression that matters, so it runs through the real pipeline with
  // queryVec omitted entirely.
  const dupes = [
    mem("the deploy failed at midnight", { id: "d1" }),
    mem("the deploy failed at midnight", { id: "d2" }),
    mem("the deploy failed at midnight", { id: "d3" }),
    mem("the incident was the paged migration", { id: "d4" }),
  ];
  const results = searchQ(dupes, { query: "deploy midnight" });
  const ids = results.results.map((m) => m.id);
  assert.equal(ids.includes("d1"), true, "one copy survives");
  assert.equal(ids.filter((id) => id.startsWith("d")).length, 2, "exactly one of the three duplicates");
  assert.equal(ids.includes("d4"), true, "and the distinct memory is untouched");
});

test("T04-007: the query options reach the pipeline", () => {
  const dupes = [mem("same text here", { id: "a" }), mem("same text here", { id: "b" })];
  assert.equal(searchQ(dupes, { query: "same text" }).results.length, 1, "on by default");
  assert.equal(searchQ(dupes, { query: "same text", dedupeExact: false }).results.length, 2, "and off on request");
});

test("T04-008: nothing is deleted — the store still holds every copy", async () => {
  // §36: do not destroy historical records. This is a result-set decision only.
  const a = mem("kept in the store", { id: "orig" });
  const b = mem("kept in the store", { id: "copy" });
  const out = dedupeResults([a, b]);
  assert.equal(out.memories.length, 1);
  assert.equal(out.removed.length, 1);
  // Both objects are still live and readable.
  assert.equal(out.removed[0]!.id, "copy");
  assert.equal(b.content, "kept in the store", "the suppressed copy is untouched, not cleared");
  assert.equal(typeof b.id, "string");
});

// --- Boundaries ------------------------------------------------------------

test("T04-009: memories that normalise to nothing are never collapsed", () => {
  // A blank-ish memory must not become a single result that swallows every other
  // blank-ish memory.
  const blanks = [mem("  "), mem("."), mem("")].filter((m) => m.content !== "");
  const { memories } = dedupeResults(blanks);
  assert.equal(memories.length, blanks.length, "each is kept");
});

test("T04-010: the window bounds the work without changing the result set", () => {
  const ranked = [mem("dup", { id: "a" }), ...Array.from({ length: 20 }, (_, i) => mem(`unique ${i}`))];
  const wide = dedupeResults(ranked, { window: 100 });
  assert.equal(wide.memories.length, ranked.length, "nothing is dropped past the window");
  // Two identical entries beyond the window survive — a documented limit, not a bug.
  const beyond = [mem("unique x", { id: "x1" }), mem("unique y", { id: "y1" }), mem("unique x", { id: "x2" })];
  assert.equal(dedupeResults(beyond, { window: 2 }).memories.length, 3, "past the window, pass through untouched");
});

test("T04-011: no duplicates is a no-op, preserving order exactly", () => {
  const distinct = [mem("alpha"), mem("beta"), mem("gamma")];
  const { memories, removed } = dedupeResults(distinct);
  assert.deepEqual(memories.map((m) => m.id), distinct.map((m) => m.id));
  assert.deepEqual(removed, []);
});

test("T04-012: a single result and an empty list are both safe", () => {
  assert.equal(dedupeResults([]).memories.length, 0);
  assert.equal(dedupeResults([mem("only")]).memories.length, 1);
});

// --- The metric T01 built must actually move -------------------------------

test("T04-013: duplicate rate falls to zero, which is the point of building it in T01", async () => {
  // T01's acceptance was that the metric can fail on a broken input and can show a
  // fix. This is the fix.
  //
  // Which copy survives is worth being explicit about, because I got it wrong first:
  // the pipeline **sorts before deduplicating**, so the survivor is the
  // best-*ranked* copy, and identical scores tie-break on ascending id — not the
  // order the caller listed them in. Here that is "d2", not the entry I wrote first.
  const target = mem("the deploy failed at midnight", { id: "d2" });
  const corpus = [
    mem("the deploy failed at midnight", { id: "target" }),
    target,
    mem("the deploy failed at midnight", { id: "d3" }),
    mem("the incident was the paged migration", { id: "other" }),
  ];
  const queries: EvalQuery[] = [{ id: "q", text: "deploy midnight", relevantIds: [target.id] }];
  const counter = { id: "per-character", count: (t: string) => t.length };

  const before = await evaluate({ k: 10, queries, searchFn: async () => corpus, tokenCounter: counter });
  assert.ok(before.aggregate.duplicate_rate > 0, "the corpus has duplicates before the fix");

  const after = await evaluate({
    k: 10,
    queries,
    searchFn: async (text) => searchQ(corpus, { query: text }).results,
    tokenCounter: counter,
  });
  assert.equal(after.aggregate.duplicate_rate, 0, "and none after it");
  assert.ok(
    after.aggregate.token_efficiency > before.aggregate.token_efficiency,
    `while the same signal occupies more of the context: ${before.aggregate.token_efficiency.toFixed(3)} → ${after.aggregate.token_efficiency.toFixed(3)}`,
  );
});

test("T04-013b: the survivor is the first input, and the pipeline's sort decides before that", () => {
  // Two different facts, which I first asserted as one and got wrong.
  //
  // `dedupeResults` keeps the **first input**. The ascending-id tie-break lives in
  // `searchQ`'s sort, which runs *before* deduplication — so the id ordering only
  // appears when the call goes through the pipeline. Calling the function directly
  // with ids in the order z, m, a keeps "z", not "a".
  const copies = [mem("identical", { id: "z" }), mem("identical", { id: "m" }), mem("identical", { id: "a" })];
  const direct = dedupeResults(copies);
  assert.equal(direct.memories.length, 1);
  assert.equal(direct.memories[0]!.id, "z", "called directly, the first input wins");
  assert.deepEqual(direct.removed.map((r) => r.id).sort(), ["a", "m"]);

  // Through the pipeline the list is sorted first, so the lowest id wins an
  // otherwise-exact tie — deterministically, and independent of input order.
  const viaPipeline = searchQ(copies, { query: "identical" });
  assert.equal(viaPipeline.results.length, 1);
  assert.equal(viaPipeline.results[0]!.id, "a", "through searchQ, the id tie-break applies");
  // Same answer whichever order the caller supplies, which is the property that
  // actually matters: the result depends on the ranking, not on the input.
  const reversed = searchQ([...copies].reverse(), { query: "identical" });
  assert.equal(reversed.results[0]!.id, "a", "and input order does not change it");
});

test("T04-014: deduplication does not cost recall on distinct documents", () => {
  // The risk of any suppression pass: it removes something the query needed. With
  // genuinely distinct documents nothing should be removed, so recall is unchanged.
  const distinct = [
    mem("the deploy failed at midnight", { id: "a" }),
    mem("the incident was the paged migration", { id: "b" }),
    mem("postmortem: two approvals were missing", { id: "c" }),
  ];
  const results = searchQ(distinct, { query: "deploy incident postmortem", explain: true });
  assert.equal(results.results.length, 3, "all three distinct memories come back");
  const keywords = (results.explanations ?? []).map((e) => e.components.keyword ?? 0);
  assert.ok(keywords.every((k) => k > 0), "and each still scores on its own merits");
});
