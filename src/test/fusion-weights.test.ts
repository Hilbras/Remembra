/**
 * V5.7.0 T07 — configurable fusion weights (roadmap §34).
 *
 * §34 requires the lexical, semantic, metadata, recency and confidence weights to
 * be configurable. They were hardcoded, so a deployment could not express "this
 * corpus is keyword-shaped" or "recency does not matter here".
 *
 * The test that matters most is T07-001: **the defaults must reproduce the
 * pre-existing ranking exactly.** A weight whose default is wrong is a silent
 * behaviour change shipped as a feature, and it would not fail any test written
 * after the fact.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FUSION_WEIGHTS, rrfFuse, searchQ, type FusionWeights } from "../retrieval.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "../eval.js";
import { isRemembraError, RemembraError } from "../errors.js";
import { defaultMemoryPolicy, loadMemoryPolicy } from "../policy.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import type { Memory } from "../types.js";

let seq = 0;
function mem(over: Partial<Memory> = {}): Memory {
  seq++;
  return {
    id: over.id ?? `m${String(seq).padStart(3, "0")}`,
    type: "fact",
    content: "some memory",
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "import" },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A corpus where the keyword ranking and the semantic ranking genuinely disagree.
 *
 * My first two attempts at this did not discriminate at all — in the first, each
 * memory ranked first in its own single list so RRF tied them, and in the second
 * every memory shared the same recency and provenance so zeroing those weights
 * moved all of them equally. A corpus that cannot express the difference proves
 * nothing about the weights.
 */
const QUERY = "alpha";
const QUERY_VEC = [1, 0, 0];
function disagreeingCorpus(): Memory[] {
  return [
    // Keyword rank 1, semantic rank 3.
    mem({ id: "kw-strong", content: "alpha appears here", embedding: [0, 1, 0] }),
    // In both lists, middling.
    mem({ id: "middle", content: "beta only", embedding: [0, 0.6, 0.8] }),
    // No keyword hit, semantic rank 1.
    mem({ id: "vec-strong", content: "gamma only", embedding: [1, 0, 0] }),
  ];
}

/** The reported fusion component for one memory, which is where a weight must land. */
const fusionOf = (corpus: Memory[], weights: Partial<FusionWeights> | undefined, id: string): number => {
  const results = searchQ(corpus, { query: QUERY, explain: true }, QUERY_VEC, {
    diversity: false,
    ...(weights ? { fusionWeights: weights } : {}),
  });
  return (results.explanations ?? []).find((e) => e.id === id)?.components.fusion ?? -1;
};

/** The reported total score for one memory. */
const scoreOf = (corpus: Memory[], weights: Partial<FusionWeights> | undefined, id: string): number => {
  const results = searchQ(corpus, { query: QUERY, explain: true }, QUERY_VEC, {
    diversity: false,
    ...(weights ? { fusionWeights: weights } : {}),
  });
  return (results.explanations ?? []).find((e) => e.id === id)?.totalScore ?? Number.NaN;
};

/** A comparator for values that are equal up to the two-decimal reporting rounding. */
const assertApprox = (actual: number, expected: number, message: string): void =>
  assert.ok(Math.abs(actual - expected) < 0.02, `${message}: ${actual} vs ${expected}`);

const rank = (
  corpus: Memory[],
  weights?: Partial<FusionWeights>,
  queryVec: number[] | null = QUERY_VEC,
  query = QUERY,
): string[] => searchQ(corpus, { query }, queryVec, { diversity: false, ...(weights ? { fusionWeights: weights } : {}) }).results.map((m) => m.id);

// --- The property that matters most ----------------------------------------

test("T07-001: the defaults reproduce the pre-existing ranking exactly", () => {
  // Every default is 1 except rrfK (1.6) and fusionScale (50), which are today's
  // literals. A wrong default here is a behaviour change shipped as a feature.
  assert.deepEqual(
    { ...DEFAULT_FUSION_WEIGHTS },
    { keyword: 1, semantic: 1, metadata: 1, recency: 1, confidence: 1, rrfK: 1.6, fusionScale: 50 },
  );

  // A corpus where every axis differs, so any weight that failed to default to 1
  // would reorder it.
  const corpus: Memory[] = [
    mem({ id: "a", content: "alpha fresh", embedding: [0, 1, 0], confidence: 0.1, importance: 1, updatedAt: "2020-01-01T00:00:00.000Z" }),
    mem({ id: "b", content: "alpha stale confident", embedding: [0.9, 0.1, 0], confidence: 1, importance: 5, updatedAt: "2030-01-01T00:00:00.000Z" }),
    mem({ id: "c", content: "unrelated", embedding: [1, 0, 0], confidence: 0.5, importance: 3, updatedAt: "2025-01-01T00:00:00.000Z" }),
  ];
  const unweighted = rank(corpus, undefined);
  assert.deepEqual(rank(corpus, {}), unweighted, "an empty weight object means the defaults");
  assert.deepEqual(
    rank(corpus, { ...DEFAULT_FUSION_WEIGHTS }),
    unweighted,
    "naming every default explicitly gives the same ranking",
  );
  assert.ok(unweighted.length === 3, "and all three are returned, so the comparison is real");
});

test("T07-002: lexical and semantic weights are independently effective", () => {
  const corpus = disagreeingCorpus();
  const defaults = rank(corpus);
  assert.deepEqual(defaults, ["kw-strong", "vec-strong", "middle"], "the corpus does discriminate");

  const lexical = rank(corpus, { keyword: 8, semantic: 0.1 });
  const semantic = rank(corpus, { keyword: 0.1, semantic: 8 });
  assert.equal(lexical[0], "kw-strong", "weighting lexical above semantic keeps the keyword match on top");
  assert.equal(semantic[0], "vec-strong", "and the reverse promotes the semantic match instead");
  assert.notDeepEqual(semantic, defaults, "so the change is observable in the ordering");
  // The reported component is rounded to two decimals, so this is a near-exact
  // multiple rather than an exact one; assert within that rounding, not beyond.
  assertApprox(
    fusionOf(corpus, { keyword: 8 }, "kw-strong"),
    fusionOf(corpus, undefined, "kw-strong") * 8,
    "the lexical weight scales the keyword contribution",
  );
});

test("T07-003: the fusion contribution actually carries the weight", () => {
  // The wiring, not just the ordering: a weight that reached the ordering but not
  // the score component would pass T07-002 while explaining the wrong number.
  const corpus = disagreeingCorpus();
  const heavyFusion = fusionOf(corpus, { keyword: 8 }, "kw-strong");
  const plainFusion = fusionOf(corpus, undefined, "kw-strong");
  assert.ok(plainFusion > 0, "the baseline has a fusion contribution to compare against");
  assert.ok(
    heavyFusion > plainFusion * 4,
    `the keyword weight reaches the reported fusion score: ${heavyFusion} vs ${plainFusion}`,
  );
});

test("T07-004: weights are partial — only what is supplied changes", () => {
  const corpus = disagreeingCorpus();
  const base = rank(corpus);
  assert.deepEqual(rank(corpus, { keyword: 2 }), rank(corpus, { keyword: 2, semantic: 1, metadata: 1, recency: 1, confidence: 1, rrfK: 1.6, fusionScale: 50 }), "a partial weight set equals the same set spelled out in full");
  assert.equal(
    fusionOf(corpus, { keyword: 2 }, "kw-strong"),
    fusionOf(corpus, undefined, "kw-strong") * 2,
    "and the single supplied weight is the only thing that moved",
  );
  assert.equal(
    fusionOf(corpus, { keyword: 2 }, "vec-strong"),
    fusionOf(corpus, undefined, "vec-strong"),
    "while a weight nobody supplied left the other signal untouched",
  );
  void base;
});

// --- The modifier weights, on a corpus that differs on each axis -----------

test("T07-005: the recency weight is effective", () => {
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const corpus = [
    // Distinct content is required: T04's default-on deduplication collapses
    // identical text, so a corpus varying only recency silently returns one result.
    mem({ id: "fresh", content: "alpha happened recently", updatedAt: new Date(now - 1_000).toISOString() }),
    mem({ id: "stale", content: "alpha happened long ago", updatedAt: new Date(now - 400 * 86_400_000).toISOString() }),
  ];
  const freshFirst = searchQ(corpus, { query: QUERY }, null, { diversity: false }).results[0]!.id;
  assert.equal(freshFirst, "fresh", "recency favours the fresh copy by default");

  // Zeroing recency removes the score contribution. It does not have to change the
  // *order*: the deterministic tie-break is itself recency-ordered, so a 400-day
  // gap collapsing to a tie lands back on the same winner. The score is the
  // honest thing to assert on.
  const gap = (weights: Partial<FusionWeights> | undefined) =>
    Math.abs(scoreOf(corpus, weights, "fresh") - scoreOf(corpus, weights, "stale"));
  assert.ok(gap(undefined) > 0, "by default recency separates the two");
  assertApprox(gap({ recency: 0 }), 0, "with recency zeroed the score gap is gone");
  assert.equal(
    searchQ(corpus, { query: QUERY }, null, { diversity: false, fusionWeights: { recency: 0 } }).results.length,
    2,
    "and zeroing a signal hides nothing — both memories still come back",
  );
});

test("T07-006: the confidence weight is effective", () => {
  const corpus = [
    mem({ id: "unsure", content: "alpha is probably right", confidence: 0.1 }),
    mem({ id: "sure", content: "alpha is definitely right", confidence: 1 }),
  ];
  const byDefault = searchQ(corpus, { query: QUERY }, null, { diversity: false }).results[0]!.id;
  assert.equal(byDefault, "sure", "confidence favours the certain copy by default");

  // Confidence of 1 vs 0.1 is a 0.9 x 20 = 18 point gap by default.
  assertApprox(scoreOf(corpus, undefined, "sure") - scoreOf(corpus, undefined, "unsure"), 18, "confidence separates them by default");
  assertApprox(
    scoreOf(corpus, { confidence: 0 }, "sure"),
    scoreOf(corpus, { confidence: 0 }, "unsure"),
    "with confidence zeroed the score gap is gone",
  );
});

test("T07-007: the metadata weight covers provenance, trust, retention and importance together", () => {
  // One knob for the §34 "metadata" signal, so a deployment that does not care
  // about provenance or pinning has one control rather than four — and cannot move
  // one of them by accident.
  const corpus = [
    mem({ id: "rich", content: "alpha was written by hand", provenance: { sourceType: "manual" }, trust: "system", retention: "pinned", importance: 5 }),
    mem({ id: "plain", content: "alpha was extracted automatically", provenance: { sourceType: "import" }, trust: "unverified", importance: 1 }),
  ];
  const byDefault = searchQ(corpus, { query: QUERY }, null, { diversity: false }).results[0]!.id;
  assert.equal(byDefault, "rich", "the manual, pinned, trusted copy leads by default");

  assert.ok(
    scoreOf(corpus, undefined, "rich") > scoreOf(corpus, undefined, "plain"),
    "the manual, pinned, trusted copy scores higher by default",
  );
  assertApprox(
    scoreOf(corpus, { metadata: 0 }, "rich"),
    scoreOf(corpus, { metadata: 0 }, "plain"),
    "with metadata zeroed the score gap is gone, so all four metadata signals really are under this one knob",
  );
});

// --- The two numeric knobs -------------------------------------------------

/**
 * Corpora for the two numeric knobs, which are harder to exercise than the signal
 * weights — a fact I got wrong on the first attempt and which is worth recording.
 *
 * `rrfK` is monotone in rank, so it can never *reorder* a list: it sets how
 * steeply score falls off with rank. Asking for a reordering asserts something
 * impossible. (I also wasted attempts looking for one, and on corpora where the
 * items were tied at the same rank, where k changes every magnitude by the same
 * factor and not even the ratio moves.) So the assertion is on the ratio between
 * the best and worst keyword rank, which is precisely what k controls.
 *
 * `fusionScale` is a common multiplier on the fused score, so on a corpus where
 * the signals agree it cannot reorder either. It exists to shift balance between
 * the fusion term and the modifier term, so the corpus has to make those two
 * disagree — which takes an extreme value to actually cross.
 */
const TERM_QUERY = "alpha beta gamma";
/** Descending term coverage, so the keyword ranks are 1, 2, 3 rather than tied. */
const rankSpread = (): Memory[] => [
  mem({ id: "r1", content: "alpha beta gamma" }),
  mem({ id: "r2", content: "alpha beta" }),
  mem({ id: "r3", content: "alpha" }),
];

/** Fusion of rank 1 divided by fusion of rank 3 — the compression that k governs. */
const rankCompression = (rrfK: number): number => {
  const results = searchQ(rankSpread(), { query: TERM_QUERY, explain: true }, null, {
    diversity: false,
    fusionWeights: { rrfK },
  });
  const of = (id: string) => (results.explanations ?? []).find((e) => e.id === id)?.components.fusion ?? 0;
  return of("r1") / of("r3");
};

test("T07-008: rrfK sets how steeply score falls off with rank", () => {
  const steep = rankCompression(0.05);
  const standard = rankCompression(1.6);
  const flat = rankCompression(100);
  assert.ok(steep > standard, `a small k rewards rank heavily: ${steep} > ${standard}`);
  assert.ok(standard > flat, `a large k flattens ranks toward a tie: ${standard} > ${flat}`);
  // The default is the standard RRF constant, and it must be the default.
  assertApprox(standard, rankCompression(DEFAULT_FUSION_WEIGHTS.rrfK), "rrfK defaults to 1.6");
  assert.ok(flat > 1, "even fully flattened, the better rank still leads");
});

test("T07-009: fusionScale shifts the balance between fusion and modifiers", () => {
  // These two memories disagree: one leads on fused rank and trails on metadata,
  // the other the reverse. Only that disagreement makes the knob observable.
  const corpus: Memory[] = [
    mem({ id: "hi-fuse", content: "alpha beta gamma", confidence: 0, importance: 1, trust: "unverified", provenance: { sourceType: "import" } }),
    mem({ id: "hi-mod", content: "delta epsilon", confidence: 1, importance: 5, trust: "system", retention: "pinned", provenance: { sourceType: "manual" } }),
  ];
  const vec = [1, 0, 0.2];
  const order = (fusionScale: number) =>
    searchQ(corpus, { query: TERM_QUERY }, vec, { diversity: false, fusionWeights: { fusionScale } }).results.map((m) => m.id);

  assert.deepEqual(order(DEFAULT_FUSION_WEIGHTS.fusionScale), ["hi-mod", "hi-fuse"], "by default the modifiers decide");
  assert.deepEqual(order(2000), ["hi-fuse", "hi-mod"], "and at a high scale the fused rank decides instead");

  // The knob is a plain multiplier, so that is exactly what it does to the score.
  const reported = (fusionScale: number) =>
    searchQ(corpus, { query: TERM_QUERY, explain: true }, vec, { diversity: false, fusionWeights: { fusionScale } })
      .explanations?.find((e) => e.id === "hi-fuse")?.components.fusion ?? 0;
  assertApprox(reported(10), reported(DEFAULT_FUSION_WEIGHTS.fusionScale) / 5, "halving the scale halves the fused contribution");
});

test("T07-010: rrfK 0 is refused", () => {
  // k = 0 makes every RRF contribution identical, collapsing the whole ranking to
  // a tie-break on recency. A silent tie would look like a working query.
  assert.throws(
    () => searchQ(rankSpread(), { query: TERM_QUERY }, null, { diversity: false, fusionWeights: { rrfK: 0 } }),
    (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
  );
});

test("T07-011: negative and non-finite weights are rejected", () => {
  const corpus = disagreeingCorpus();
  for (const fusionWeights of [{ keyword: -1 }, { recency: Number.NaN }, { confidence: Number.POSITIVE_INFINITY }]) {
    assert.throws(
      () => searchQ(corpus, { query: QUERY }, QUERY_VEC, { diversity: false, fusionWeights }),
      (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
      `rejected: ${JSON.stringify(fusionWeights)}`,
    );
  }
});

test("T07-012: zero is a legal weight — turning a signal off is the point", () => {
  const corpus = disagreeingCorpus();
  const off = rank(corpus, { semantic: 0 });
  assert.equal(off[0], "kw-strong", "with semantic off only the keyword signal can contribute");
  assert.notDeepEqual(off, rank(corpus), "and that is different from the default");
});

test("T07-013: a keyword-only query is unaffected when semantic has nothing to add", () => {
  // The single-list path has its own fusion helper; if that one ignored the
  // weights, a query with no vector would silently use different arithmetic from
  // one with a vector.
  const corpus = [
    mem({ id: "one", content: "alpha first" }),
    mem({ id: "two", content: "alpha second" }),
  ];
  // The order is deliberately NOT the assertion here: on a single list the weight
  // is a common multiplier, so it cannot reorder however it is wired. The score is
  // what actually distinguishes a wired path from an unwired one.
  const singleListFusion = (weights: Partial<FusionWeights> | undefined) =>
    searchQ(corpus, { query: QUERY, explain: true }, null, {
      diversity: false,
      ...(weights ? { fusionWeights: weights } : {}),
    }).explanations?.[0]?.components.fusion ?? 0;

  const withDefault = searchQ(corpus, { query: QUERY }, null, { diversity: false }).results.map((m) => m.id);
  assert.deepEqual(
    searchQ(corpus, { query: QUERY }, null, { diversity: false, fusionWeights: { keyword: 3 } }).results.map((m) => m.id),
    withDefault,
    "no vector means no semantic contribution, so the order is unchanged",
  );
  assertApprox(
    singleListFusion({ keyword: 3 }),
    singleListFusion(undefined) * 3,
    "but the single-list path does apply the keyword weight to the reported fusion",
  );
  assertApprox(
    singleListFusion({}),
    singleListFusion(undefined),
    "and it honours the defaults when given an empty weight object",
  );
});

test("T07-014: the defaults are frozen, so a caller cannot mutate them", () => {
  assert.throws(() => {
    (DEFAULT_FUSION_WEIGHTS as { keyword: number }).keyword = 99;
  });
});

test("T07-015: rrfFuse itself applies the RRF constant and both list weights", () => {
  // Mutation-testing this file found that rrfK was untested in the *two-list*
  // path: every rrfK corpus above is a single-list query, so routing rrfFuse back
  // to the hardcoded constant changed nothing observable. rrfFuse is exported, so
  // the formula is pinned directly rather than through a pipeline.
  //
  // kwRank: a(1), b(2). vecRank: a(1), c(2). With rrfK=10, keyword=2, semantic=3:
  //   a = 2/11 + 3/11 = 5/11, b = 2/12, c = 3/12
  const weights = { keyword: 2, semantic: 3, metadata: 1, recency: 1, confidence: 1, rrfK: 10, fusionScale: 50 };
  const fused = rrfFuse(
    [{ id: "a", score: 1 }, { id: "b", score: 0.5 }],
    [{ id: "a", score: 1 }, { id: "c", score: 0.5 }],
    weights,
  );
  assertApprox(fused.get("a") ?? -1, 5 / 11, "a appears in both lists, so both weights sum");
  assertApprox(fused.get("b") ?? -1, 2 / 12, "b is keyword-only at rank 2");
  assertApprox(fused.get("c") ?? -1, 3 / 12, "c is semantic-only at rank 2");
  assert.equal(fused.size, 3);

  // A different rrfK must move these numbers, which is what the mutation above
  // removed without any test noticing.
  const other = rrfFuse(
    [{ id: "a", score: 1 }, { id: "b", score: 0.5 }],
    [{ id: "a", score: 1 }, { id: "c", score: 0.5 }],
    { ...weights, rrfK: 1.6 },
  );
  assert.ok(Math.abs((other.get("a") ?? 0) - (fused.get("a") ?? 0)) > 0.5, "rrfK reaches the two-list fusion");

  // And the exported defaults are what an unweighted caller gets.
  const defaulted = rrfFuse([{ id: "a", score: 1 }], [{ id: "a", score: 1 }]);
  assertApprox(defaulted.get("a") ?? -1, 2 / (DEFAULT_FUSION_WEIGHTS.rrfK + 1), "an omitted weight set means the defaults");
});

/**
 * T07's acceptance is a claim about the benchmark set, not about a toy corpus: "a
 * deployment that weights lexical above semantic gets a measurably different
 * ranking on the benchmark set, and the defaults reproduce today's ranking."
 *
 * The set below is built so each query's gold answer matches on exactly one signal
 * while its decoy matches on the other, and it is balanced two-and-two so neither
 * weight wins by construction. Two earlier versions of this fixture measured
 * nothing: the first was saturated at MRR 1.0, and the second was three
 * keyword-gold to one semantic-gold, so "lexical-heavy" merely reproduced the
 * default score. A fixture that cannot express the difference proves nothing.
 *
 * Division of labour, since these overlap on purpose: T07-001 proves the defaults
 * are today's behaviour, T07-002/003/004/015 prove each weight is actually
 * *wired* to a score, and this one proves only that a reweighting is
 * *observable* end to end. It deliberately does not pin absolute numbers — that
 * is T08's benchmark gate's job, and a test that freezes today's metrics would
 * make the gate's regressions resurface here first with less context.
 */
const BENCH_NOW = "2026-01-01T00:00:00.000Z";
const benchMem = (id: string, content: string, embedding: number[]): Memory => ({
  id,
  type: "fact",
  content,
  scope: "global",
  tags: [],
  importance: 3,
  confidence: 0.9,
  trust: "trusted",
  provenance: { sourceType: "manual" },
  version: 1,
  createdAt: BENCH_NOW,
  updatedAt: BENCH_NOW,
  embedding,
});

const BENCH_CORPUS: Memory[] = [
  // Keyword-gold: the query's words appear verbatim, the vector is elsewhere.
  benchMem("kw-1", "kubernetes deployment", [0, 0, 0, 1]),
  benchMem("kw-2", "postgres database", [0, 0, 1, 0]),
  // Semantic-gold: no shared vocabulary, the vector is the query's vector.
  benchMem("vec-1", "clusters run the shipped artefacts", [1, 0, 0, 0]),
  benchMem("vec-2", "rows live in an engine", [0, 0, 0, 1]),
  benchMem("vec-3", "a scheduler decides where work runs", [1, 0, 0, 0]),
  benchMem("vec-4", "the retrospective on the failed run", [1, 0, 0, 0]),
  // Keyword decoys for the semantic-gold queries: the right words, the wrong answer.
  benchMem("kw-3", "workload placement rules", [0, 1, 0, 0]),
  benchMem("kw-4", "outage incident notes", [0, 0, 1, 0]),
];

const BENCH_CASES = [
  { id: "q1", text: "kubernetes deployment", gold: "kw-1", semantic: false },
  { id: "q2", text: "postgres database", gold: "kw-2", semantic: false },
  { id: "q3", text: "how are workloads placed", gold: "vec-3", semantic: true },
  { id: "q4", text: "the writeup after an outage", gold: "vec-4", semantic: true },
];

/** Run the eval harness over BENCH_CORPUS with the given weights. */
const benchRun = async (fusionWeights?: Partial<FusionWeights>) => {
  const r = await evaluate({
    k: 4,
    queries: BENCH_CASES.map((c) => ({ id: c.id, text: c.text, relevantIds: [c.gold] })),
    searchFn: async (text) => {
      const c = BENCH_CASES.find((x) => x.text === text)!;
      const res = searchQ(BENCH_CORPUS, { query: text }, c.semantic ? [1, 0, 0, 0] : [0, 0, 1, 0], {
        diversity: false,
        ...(fusionWeights ? { fusionWeights } : {}),
      });
      return res.results.map((m) => BENCH_CORPUS.find((x) => x.id === m.id)!).filter(Boolean);
    },
  });
  return r;
};

test("T07-016: a reweighting is measurably different on the benchmark set", async () => {
  const base = await benchRun();
  const lexical = await benchRun({ keyword: 8, semantic: 0.1 });
  const semantic = await benchRun({ keyword: 0.1, semantic: 8 });

  // The ranking itself, which is what the acceptance names.
  const topTwo = (r: Awaited<ReturnType<typeof benchRun>>) => r.queries.map((q) => q.top_ids.slice(0, 2).join("|"));
  assert.notDeepEqual(topTwo(lexical), topTwo(base), "weighting lexical above semantic reorders the benchmark set");
  assert.notDeepEqual(topTwo(semantic), topTwo(base), "and so does the reverse");

  // And the aggregate quality, so the change is a real measurement and not a
  // cosmetic reshuffle of equally-good results.
  assert.ok(
    Math.abs(lexical.aggregate.mrr - base.aggregate.mrr) > 0.01,
    `lexical-heavy moves MRR: ${lexical.aggregate.mrr} vs ${base.aggregate.mrr}`,
  );
  assert.ok(
    Math.abs(semantic.aggregate.mrr - base.aggregate.mrr) > 0.01,
    `semantic-heavy moves MRR: ${semantic.aggregate.mrr} vs ${base.aggregate.mrr}`,
  );
  // The defaults are today's tuning, so on a neutral fixture they should be the
  // best of the three. Asserted so a later weight default cannot quietly cost
  // quality on a set where nothing is trying to favour it.
  assert.ok(
    base.aggregate.mrr >= lexical.aggregate.mrr && base.aggregate.mrr >= semantic.aggregate.mrr,
    `the defaults are not beaten by either reweighting: ${base.aggregate.mrr} vs ${lexical.aggregate.mrr} / ${semantic.aggregate.mrr}`,
  );
});

/**
 * §34 says the weights must be configurable, and an internal-only option is not
 * configurable — it is only reachable from the test file. So they also load from
 * the policy file and the environment, which is where every other retrieval
 * setting already comes from.
 */
describe("T07: deployment configuration", () => {
  const load = (env: Record<string, string>) =>
    loadMemoryPolicy({ env: env as NodeJS.ProcessEnv }).retrieval.fusionWeights;

  test("T07-017: unconfigured leaves the weights absent, not zeroed", () => {
    // Absent matters: `searchQ` treats an absent set as "use the defaults", so
    // pre-filling the object here would make a second, drifting copy of them.
    assert.equal(load({}), undefined);
    assert.equal(loadMemoryPolicy({ env: {} as NodeJS.ProcessEnv }).retrieval.fusionWeights, undefined);
  });

  test("T07-018: a single weight can be set from the environment", () => {
    assert.deepEqual(load({ REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: "keyword=2" }), { keyword: 2 });
    // Zero is legal and is the whole point of a weight: it turns a signal off.
    assert.deepEqual(load({ REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: "recency=0" }), { recency: 0 });
  });

  test("T07-019: several weights set at once, with whitespace tolerated", () => {
    assert.deepEqual(load({ REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: "keyword=2, semantic=0.5 , recency=0" }), {
      keyword: 2,
      semantic: 0.5,
      recency: 0,
    });
  });

  test("T07-020: a bad weight is rejected loudly rather than defaulted", () => {
    // The failure this guards against is silent: an unknown or misspelled name
    // that leaves the deployment on stock defaults while its config says otherwise.
    for (const value of ["keyworde=2", "keyword", "=2", "keyword=-1", "keyword=abc", "rrfK=0", "keyword=Infinity", "keyword=NaN"]) {
      assert.throws(
        () => load({ REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: value }),
        (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
        `rejected: ${value}`,
      );
    }
    // The env parser and the zod schema both reject an unknown name. They overlap
    // deliberately: the schema is the backstop, and the parser is what turns a
    // typo into a message naming the typo. Assert the message, so the overlap
    // cannot quietly degrade into one layer rejecting with "unrecognized key".
    assert.throws(
      () => load({ REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: "keyworde=2" }),
      (error: unknown) =>
        error instanceof RemembraError && /unknown weight "keyworde"/.test(error.message) && /keyword/.test(error.message),
      "the env parser explains the typo instead of letting the schema report a bare unknown key",
    );
  });

  test("T07-021: the policy file can set the weights", () => {
    const policy = loadMemoryPolicy({
      env: { REMEMBRA_POLICY_FILE: "/etc/remembra/policy.yaml" } as NodeJS.ProcessEnv,
      readFile: () => "retrieval:\n  fusionWeights:\n    keyword: 3\n    recency: 0\n",
    });
    assert.deepEqual(policy.retrieval.fusionWeights, { keyword: 3, recency: 0 });
  });

  test("T07-025: a non-finite weight in the policy file is rejected", () => {
    // YAML spells both of these, so this is reachable, not theoretical:
    //   fusionWeights:
    //     keyword: .inf
    // A NaN weight sorts nowhere and an Infinity weight swamps every other signal,
    // and `z.number()` alone accepts both. A score of NaN is worse than a wrong
    // score: the query returns results in a meaningless order and reports success.
    for (const literal of [".inf", "-.inf", ".nan"]) {
      assert.throws(
        () =>
          loadMemoryPolicy({
            env: { REMEMBRA_POLICY_FILE: "/trusted/policy.yml" } as NodeJS.ProcessEnv,
            readFile: () => `retrieval:\n  fusionWeights:\n    keyword: ${literal}\n`,
          }),
        (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
        `rejected: keyword: ${literal}`,
      );
    }
  });

  test("T07-022: an unknown weight name in the policy file is rejected", () => {
    // `.strict()` on the weights object, for the same reason the env parser is
    // strict: a typo must not read as "configured, therefore in effect".
    assert.throws(
      () =>
        loadMemoryPolicy({
          env: { REMEMBRA_POLICY_FILE: "/etc/remembra/policy.yaml" } as NodeJS.ProcessEnv,
          readFile: () => "retrieval:\n  fusionWeights:\n    keyword: 3\n    keywordWeight: 4\n",
        }),
      (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
    );
  });

  test("T07-023: the environment overrides the policy file", () => {
    const policy = loadMemoryPolicy({
      env: {
        REMEMBRA_POLICY_FILE: "/etc/remembra/policy.yaml",
        REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: "keyword=9",
      } as NodeJS.ProcessEnv,
      readFile: () => "retrieval:\n  fusionWeights:\n    keyword: 3\n    recency: 0\n",
    });
    // The whole object is replaced, matching how the other env overrides replace
    // their whole section rather than deep-merging. Documented rather than
    // accidental: mixing the two sources for one option is how a deployment ends
    // up with a half-applied profile nobody wrote.
    assert.deepEqual(policy.retrieval.fusionWeights, { keyword: 9 });
  });
});

/**
 * The end-to-end claim: an operator edits a policy file and the ranking changes.
 *
 * T07-016 proves the weights reweight a search and T07-017..023 prove the policy
 * loads them, but the line in service.ts that carries the configured weights into
 * the search call is what makes this a *deployment* feature rather than an
 * internal one — and nothing else would notice if that line were dropped.
 */
test("T07-024: a policy-configured weight reaches the ranking end to end", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-weights-"));
  try {
    /** Two memories identical except that one is pinned, which is a +50 metadata bonus. */
    const build = async (name: string, yaml: string) => {
      const policy = loadMemoryPolicy({
        env: { REMEMBRA_POLICY_FILE: "/trusted/policy.yml" } as NodeJS.ProcessEnv,
        readFile: () => yaml,
      });
      const storeDir = path.join(dir, name);
      await fs.mkdir(storeDir, { recursive: true });
      const service = new MemoryService(new MemoryStore(storeDir), { policy });
      const pinned = await service.store({ type: "fact", content: "the release ships on tuesday", retention: "pinned" });
      const plain = await service.store({ type: "fact", content: "the retro happened back in march" });
      const hits = await service.search({ query: "tuesday", limit: 5, explain: true });
      const modifiersOf = (id: string) =>
        (hits.explanations ?? []).find((e) => e.id === id)?.components.modifiers ?? Number.NaN;
      return {
        configured: policy.retrieval.fusionWeights,
        pinned: pinned.memory.id,
        plain: plain.memory.id,
        returned: hits.results.map((m) => m.id),
        modifierGap: () => modifiersOf(pinned.memory.id) - modifiersOf(plain.memory.id),
      };
    };

    const baseline = await build("a", "retrieval:\n  diversity: false\n");
    const noMetadata = await build("b", "retrieval:\n  diversity: false\n  fusionWeights:\n    metadata: 0\n");

    assert.equal(baseline.configured, undefined, "an unconfigured deployment carries no weights at all");
    assert.deepEqual(noMetadata.configured, { metadata: 0 }, "and a configured one carries exactly what the file says");

    // The ordering alone would not show this: the pinned copy also holds the only
    // keyword hit, so it leads either way. The modifier gap is the part the
    // configured weight actually governs — 50 points of pinning by default, none.
    assertApprox(baseline.modifierGap(), 50, "pinning is worth 50 metadata points by default");
    assertApprox(noMetadata.modifierGap(), 0, "and nothing at all with metadata weighted out");

    assert.equal(baseline.returned.length, 2, "a zero weight hides nothing — both memories still come back");
    assert.deepEqual(
      new Set(noMetadata.returned),
      new Set([noMetadata.pinned, noMetadata.plain]),
      "from the same corpus the default deployment searched",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
});

/**
 * The relation-expansion re-rank is a *second* search over the expanded pool, and
 * it is easy for a configured weight to apply to the first ranking and silently
 * not the second — which reorders results only on the paths that happen to use
 * relations, so nothing else would notice. Both call sites now build one shared
 * policy object; this pins that the second one really does honour it.
 */
test("T07-026: the relation-expansion re-rank honours the configured weights", async () => {
  const build = async (name: string, fusionWeights?: { metadata: number }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-rerank-weights-"));
    const policy = defaultMemoryPolicy();
    policy.retrieval.relationExpansion = true;
    policy.retrieval.diversity = false;
    if (fusionWeights) policy.retrieval.fusionWeights = fusionWeights;
    const service = new MemoryService(new MemoryStore(root), { embeddingProvider: "none", policy });
    const seed = await service.store({ type: "fact", content: "needle seed" });
    // Reachable only through the relation, and its entire lead is metadata:
    // pinned (+50) plus importance 5 (+20).
    const neighbour = await service.store({
      type: "fact",
      content: "related neighbour",
      importance: 5,
      retention: "pinned",
    });
    await service.relate({ id: seed.id, related: [neighbour.id], action: "add" });
    for (let i = 0; i < 12; i++) {
      await service.store({ type: "observation", content: `unrelated ${i}`, importance: 1, source: `old-${i}` });
    }
    const hits = await service.search({ query: "needle", limit: 3, explain: true });
    const neighbourExplanation = (hits.explanations ?? []).find((e) => e.id === neighbour.id);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
    return {
      top: hits.results.map((m) => m.id),
      neighbourId: neighbour.id,
      // Present only if the expanded copy survived the re-rank.
      neighbourMods: neighbourExplanation?.components.modifiers ?? null,
    };
  };

  const baseline = await build("a");
  assert.equal(baseline.top[0], baseline.neighbourId, "the relation-expanded neighbour leads by default");
  assert.ok((baseline.neighbourMods ?? 0) > 100, "on a lead built almost entirely from metadata");

  const withoutMetadata = await build("b", { metadata: 0 });
  assert.notEqual(
    withoutMetadata.top[0],
    withoutMetadata.neighbourId,
    "with metadata weighted out the expanded neighbour loses the top slot — so the re-rank re-scored it",
  );
  assert.ok(
    (withoutMetadata.neighbourMods ?? 0) < 100,
    `and the re-ranked copy really lost the metadata bonus: ${withoutMetadata.neighbourMods}`,
  );
});
