/**
 * V5.7.0 T01 — the two evaluation metrics roadmap §38 required and V4.6.0 did
 * not have: token efficiency and duplicate rate.
 *
 * The property that matters most is that **each metric can fail**. A ratio that
 * returns a comfortable number whatever the retriever does is not a measurement,
 * and the whole reason this task precedes the deduplication work is that
 * duplicate rate is the guardrail for it. So every test here includes a case
 * where the metric is *supposed* to look bad, and asserts that it does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type EvalQuery } from "../eval.js";
import { duplicateKey, isExactDuplicate } from "../retrieval.js";
import { defaultTokenCounter } from "../context.js";
import type { Memory } from "../types.js";

let seq = 0;
function mem(content: string, over: Partial<Memory> = {}): Memory {
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
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A counter proportional to size, so token ratios are exact arithmetic.
 *
 * The first version of this file used a flat cost per non-empty result, which made
 * three of these tests pass or fail for the wrong reason: with a fixed cost, a
 * 400-character result and a 5-character result weigh the same, so "padding wastes
 * context" cannot be observed at all. A metric that cannot see size is not
 * measuring context.
 */
const fixedCounter = { id: "per-character", count: (text: string) => text.length };

async function run(results: Memory[], relevantIds: string[], counter = fixedCounter) {
  const queries: EvalQuery[] = [{ id: "q1", text: "anything", relevantIds }];
  return evaluate({ k: 10, queries, searchFn: async () => results, tokenCounter: counter });
}

// --- Duplicate rate --------------------------------------------------------

test("T01-001: duplicate rate is zero when nothing repeats, and rises when it does", async () => {
  const distinct = [mem("alpha"), mem("beta"), mem("gamma"), mem("delta")];
  const clean = await run(distinct, [distinct[0]!.id]);
  assert.equal(clean.aggregate.duplicate_rate, 0, "four distinct memories repeat nothing");
  assert.equal(clean.aggregate.duplicates, 0);

  // The same four, with two exact duplicates among them.
  const dirty = [mem("alpha"), mem("beta"), mem("alpha"), mem("beta")];
  const dupes = await run(dirty, [dirty[0]!.id]);
  assert.equal(dupes.aggregate.duplicates, 2, "two of the four repeat an earlier result");
  assert.equal(dupes.aggregate.duplicate_rate, 0.5, "so half the context is wasted");
  assert.equal(dupes.aggregate.returned, 4, "the raw count is reported too, so the rate is checkable");
  assert.equal(
    dupes.aggregate.duplicates / dupes.aggregate.returned,
    0.5,
    "with one query they coincide — see T01-011 for where they do not",
  );
});

test("T01-002: duplicate rate is a ratio, so it is comparable across result counts", async () => {
  // A raw duplicate count would make a 10-result query look worse than a 3-result
  // one with the same problem. The ratio is what the gate will threshold on.
  // 1 duplicate in 3 and 3 duplicates in 9 are the same rate; 1-in-3 and 2-in-10
  // are not, and asserting they were would have been my arithmetic, not the
  // metric's behaviour.
  const three = await run([mem("a"), mem("a"), mem("b")], []);
  const nine = await run(Array.from({ length: 9 }, (_, i) => mem(i < 4 ? "same" : `u${i}`)), []);
  assert.equal(three.queries[0]!.duplicate_rate, 1 / 3);
  // Four identical results produce **three** duplicates: the first occurrence is
  // the original, not a repetition. Reading it as 4/9 was an off-by-one on my part
  // and is exactly the kind of thing the ratio has to be checked against.
  assert.equal(nine.queries[0]!.duplicate_rate, 3 / 9);
  assert.ok(
    Math.abs(three.aggregate.duplicate_rate - nine.aggregate.duplicate_rate) < 1e-9,
    "the same duplicate rate reads the same at two different result counts",
  );
  // A raw count would not: 1 and 3 are not comparable, 1/3 and 3/9 are.
  assert.notEqual(three.aggregate.duplicates, nine.aggregate.duplicates);
});

test("T01-003: duplicate detection survives the normalisation a human would expect", async () => {
  // Case, reflowed whitespace, and trailing punctuation are the same memory.
  const a = mem("The deploy failed at midnight");
  const b = mem("  the DEPLOY failed   at midnight.  ");
  assert.equal(duplicateKey(a), duplicateKey(b));
  assert.equal(isExactDuplicate(a, b), true);
  // Genuinely different text is not merged, which is the cost that matters.
  assert.equal(isExactDuplicate(a, mem("The deploy failed at dawn")), false);
  // A memory is not a duplicate of itself.
  assert.equal(isExactDuplicate(a, a), false);
  // Internal punctuation is kept, so distinct memories do not collapse.
  assert.equal(isExactDuplicate(mem("use redis, not postgres"), mem("use redis not postgres")), false);
});

test("T01-004: the metric and the detector share one function", async () => {
  // If these diverged, duplicate rate would read 0.0 after a deduplication change
  // while appearing to be measured — the failure mode this task exists to prevent.
  const a = mem("Deploy failed at midnight");
  const b = mem("deploy failed at midnight");
  assert.equal(duplicateKey(a), duplicateKey(b), "the metric and detector are the same call");
  const result = await run([a, b], [a.id]);
  assert.equal(result.aggregate.duplicate_rate, 0.5, "and the metric observes exactly what the detector would remove");
});

test("T01-005: an empty result set reports 0 duplicates, not a divide-by-zero", async () => {
  const empty = await run([], ["missing"]);
  assert.equal(empty.aggregate.duplicate_rate, 0, "nothing came back, so nothing repeated");
  assert.equal(empty.queries[0]!.returned, 0);
  assert.equal(empty.aggregate.tokens_total, 0);
});

// --- Token efficiency ------------------------------------------------------

test("T01-006: token efficiency is 1 for an all-relevant context and falls with padding", async () => {
  const relevant = [mem("one"), mem("two")];
  const all = await run(relevant, [relevant[0]!.id, relevant[1]!.id]);
  assert.equal(all.aggregate.token_efficiency, 1, "every token belonged to a relevant result");
  assert.equal(all.aggregate.tokens_relevant, all.aggregate.tokens_total, "all tokens relevant");
  assert.equal(all.aggregate.tokens_total, 6, '"one" and "two" are six characters');

  // Same relevant results, padded with irrelevant ones of the same size.
  const padded = [relevant[0]!, relevant[1]!, mem("junk"), mem("more junk")];
  const p = await run(padded, [relevant[0]!.id, relevant[1]!.id]);
  assert.equal(p.aggregate.tokens_total, 6 + 4 + 9, "every returned character is counted");
  assert.equal(p.aggregate.tokens_relevant, 6, "only the relevant ones");
  assert.equal(p.aggregate.token_efficiency, 6 / 19);
});

test("T01-007: token efficiency separates 'more relevant' from 'merely longer'", async () => {
  // Precision@k cannot tell these apart: both return exactly one relevant result
  // in the top 2. Token efficiency can, which is the reason it exists.
  const tight = await run([mem("the answer", { id: "rel" }), mem("short")], ["rel"]);
  const padded = await run([mem("the answer", { id: "rel" }), mem("x".repeat(400))], ["rel"]);
  assert.equal(
    tight.aggregate.precision_at_k,
    padded.aggregate.precision_at_k,
    "identical precision — the padding is invisible to it",
  );
  assert.ok(
    tight.aggregate.token_efficiency > padded.aggregate.token_efficiency,
    `token efficiency separates them: ${tight.aggregate.token_efficiency.toFixed(3)} vs ${padded.aggregate.token_efficiency.toFixed(4)}`,
  );
});

test("T01-008: token efficiency weights by size, so a long irrelevant result costs more", async () => {
  // Counting results instead of tokens would report these as equal.
  const small = await run([mem("rel", { id: "r" }), mem("x")], ["r"]);
  const large = await run([mem("rel", { id: "r" }), mem("x".repeat(300))], ["r"]);
  assert.ok(
    small.aggregate.token_efficiency > large.aggregate.token_efficiency,
    "one short irrelevant result wastes less context than one long one",
  );
});

test("T01-009: an empty result set reports efficiency 1, because nothing was wasted", async () => {
  // The only reading that is true when nothing came back. Returning 0 here would
  // make a retriever that returns nothing look maximally efficient.
  const empty = await run([], ["missing"]);
  assert.equal(empty.aggregate.token_efficiency, 1);
});

// --- The metrics are real measurements, not decoration ---------------------

test("T01-010: defaults to the same counter the context assembler uses", async () => {
  // "Token efficiency" has to mean the same thing here as when the memories are
  // actually handed to a model, or the number is about a different unit.
  const results = [mem("one two three"), mem("four five")];
  const queries: EvalQuery[] = [{ id: "q", text: "t", relevantIds: [results[0]!.id] }];
  const withDefault = await evaluate({ k: 10, queries, searchFn: async () => results });
  const expectedRelevant = defaultTokenCounter.count(results[0]!.content);
  const expectedTotal = results.reduce((s, m) => s + defaultTokenCounter.count(m.content), 0);
  assert.equal(withDefault.aggregate.tokens_relevant, expectedRelevant);
  assert.equal(withDefault.aggregate.tokens_total, expectedTotal);
  assert.ok(expectedTotal > 0, "the default counter actually counts something");
});

test("T01-011: aggregate counts are consistent with the per-query rows", async () => {
  // A metric whose parts do not add up to its total is worse than no metric.
  // Two queries returning *different* result counts, so the mean of ratios and the
  // total over total genuinely differ. My first version returned the same four
  // results for both, which made the two agree and the assertion vacuous.
  const small = [mem("alpha"), mem("alpha"), mem("beta")];
  const large = [mem("gamma"), mem("delta"), mem("epsilon"), mem("zeta"), mem("eta"), mem("theta")];
  large[3]!.supersededBy = large[4]!.id;
  // Give the large set one duplicate by reusing a key.
  const largeWithDup = [...large];
  largeWithDup[5] = mem("gamma");
  // searchFn is handed the query *text*, not the query, so the two have to be
  // distinguishable by text. My first version dispatched on a condition that was
  // always true and both queries silently got the same three results.
  const queries: EvalQuery[] = [
    { id: "q1", text: "few", relevantIds: [small[0]!.id] },
    { id: "q2", text: "many", relevantIds: [largeWithDup[0]!.id] },
  ];
  const result = await evaluate({
    k: 10,
    queries,
    searchFn: async (text) => (text === "few" ? small : largeWithDup),
    tokenCounter: fixedCounter,
  });
  assert.equal(result.aggregate.queries_evaluated, 2);
  assert.equal(result.queries[0]!.returned, 3, "three results on the first query");
  assert.equal(result.queries[1]!.returned, 6, "six on the second");
  assert.equal(
    result.aggregate.duplicates,
    result.queries.reduce((s, q) => s + q.duplicates, 0),
    "total duplicates is the sum of the per-query counts",
  );
  assert.equal(
    result.aggregate.tokens_total,
    result.queries.reduce((s, q) => s + q.tokens_total, 0),
  );
  assert.equal(
    result.aggregate.duplicate_rate,
    result.queries.reduce((s, q) => s + q.duplicate_rate, 0) / result.queries.length,
    "and the rate is the mean of the per-query rates",
  );
  // The aggregate rate is a mean of ratios while the counts are sums, so the two
  // only coincide when every query returned the same number of results. Pinned
  // here so a future "simplification" to total-over-total is a deliberate change
  // rather than an accident.
  assert.equal(result.aggregate.returned, 9, "3 + 6");
  assert.equal(
    result.aggregate.duplicate_rate,
    (result.queries[0]!.duplicate_rate + result.queries[1]!.duplicate_rate) / 2,
    "the rate is the mean of the per-query rates, as precision and recall already are",
  );
  assert.notEqual(
    result.aggregate.duplicate_rate,
    result.aggregate.duplicates / result.aggregate.returned,
    "and it is deliberately NOT the total over the total, which is why both are reported",
  );

  // The pre-existing metrics must be untouched by any of this.
  assert.equal(result.queries[0]!.precision_at_k, 1 / 3);
  assert.ok(result.aggregate.mrr > 0, "mrr still computed");
  assert.ok(result.aggregate.p95_latency_ms >= 0, "latency percentiles still computed");
});

test("T01-012: a regression a gate would catch is visible in the new metrics", async () => {
  // The shape T04 will produce: a deduplicating retriever. If this pair of
  // numbers does not move, T04 has no way to prove it worked.
  const original = mem("deploy failed");
  // The after-set reuses the same memory objects. Built from fresh mem() calls its
  // ids differ from the relevant id, and token efficiency then reads 0 rather
  // than higher — which is how this test failed the first time.
  const before = [original, mem("deploy failed"), mem("deploy failed"), mem("unrelated")];
  const after = [original, mem("unrelated")];
  const q = [{ id: "q", text: "deploy", relevantIds: [original.id] }];
  const b = await evaluate({ k: 10, queries: q, searchFn: async () => before, tokenCounter: fixedCounter });
  const a = await evaluate({ k: 10, queries: q, searchFn: async () => after, tokenCounter: fixedCounter });
  assert.equal(b.aggregate.duplicate_rate, 0.5);
  assert.equal(a.aggregate.duplicate_rate, 0, "deduplication drives it to zero");
  assert.ok(
    a.aggregate.token_efficiency > b.aggregate.token_efficiency,
    "and it raises token efficiency, because the same signal now occupies more of the context",
  );
});
