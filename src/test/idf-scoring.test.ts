/**
 * V5.7.0 T03 — real inverse document frequency.
 *
 * The old factor was computed from **the document being scored** — how many of the
 * query's terms that document happened to contain — so it was a coverage discount
 * wearing the name of IDF, and it could not tell a rare term from a common one.
 * These tests hold coverage fixed and vary only corpus rarity, which is the
 * property the old one lacked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEXICAL_WEIGHTS,
  buildTermStatistics,
  keywordScore,
  searchQ,
  type TermStatistics,
} from "../retrieval.js";
import type { Memory } from "../types.js";

let seq = 0;
function mem(content: string, tags: string[] = []): Memory {
  seq++;
  return {
    id: `m${String(seq).padStart(3, "0")}`,
    type: "fact",
    content,
    scope: "global",
    tags,
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const score = (m: Memory, terms: string[], stats?: TermStatistics) =>
  keywordScore(m, terms, DEFAULT_LEXICAL_WEIGHTS, stats);

/** A corpus of `count` documents, all containing `common`, plus `extra` rare ones. */
function corpus(common: string, count: number, extra: Memory[] = []): Memory[] {
  return [...Array.from({ length: count }, (_, i) => mem(`${common} note ${i}`)), ...extra];
}

// --- The property the old factor did not have -----------------------------

test("T03-001: with coverage held constant, a rarer term outranks a common one", () => {
  // Two documents, each containing exactly one query term. The only difference is
  // how common that term is in the corpus, so any difference in score is IDF
  // doing its job.
  const terms = ["quokka", "commonword"];

  const rareCorpus = corpus("commonword", 900, [mem("a quokka lives here")]);
  const rareStats = buildTermStatistics(rareCorpus, terms);
  const rareScore = score(mem("a quokka lives here"), terms, rareStats);

  const commonCorpus = corpus("commonword", 900, [mem("a quokka lives here")]);
  const commonStats = buildTermStatistics(commonCorpus, ["quokka"]);
  const commonScore = score(mem("a commonword lives here"), ["commonword"], commonStats);

  // Sanity: the rare term is genuinely rare and the common one genuinely common.
  assert.equal(rareStats.documentFrequency.get("quokka"), 1, "appears in one document");
  assert.equal(rareStats.documentFrequency.get("commonword"), 900, "appears in nearly all of them");

  assert.ok(
    rareScore > commonScore,
    `equal coverage, different rarity: ${rareScore.toFixed(2)} vs ${commonScore.toFixed(2)}`,
  );
});

test("T03-002: the old factor could not do this — coverage alone decided the score", () => {
  // The audit's S2 finding, as a contrast. Two documents covering the same
  // fraction of a query scored identically before, whatever the terms' rarity.
  // With statistics they do not.
  const terms = ["alpha", "beta", "gamma", "delta"];
  const shared = corpus("alpha beta gamma delta", 500);
  const stats = buildTermStatistics(shared, terms);
  assert.equal(stats.documentFrequency.get("alpha"), 500, "every term is equally common");

  // A document with the same coverage, but in a corpus where only one is rare.
  const mixed = [
    ...Array.from({ length: 500 }, (_, i) => mem(`alpha beta gamma note ${i}`)),
    mem("alpha beta gamma delta"),
  ];
  const mixedStats = buildTermStatistics(mixed, terms);
  assert.ok(
    (mixedStats.documentFrequency.get("delta") ?? 0) < (mixedStats.documentFrequency.get("alpha") ?? 0),
    "delta is the rarer term here",
  );
  const withRare = score(mem("alpha beta gamma delta"), terms, mixedStats);
  const allCommon = score(mem("alpha beta gamma delta"), terms, stats);
  assert.ok(
    withRare > allCommon,
    `the same document scores higher where one of its terms is rarer: ${withRare.toFixed(2)} vs ${allCommon.toFixed(2)}`,
  );
});

// --- The old coverage ordering must survive -------------------------------

test("T03-003: more matched terms still beats fewer", () => {
  // The audit's S2 measurement that was *correct* and had to be preserved: a
  // document covering all four terms outranks one covering one, with or without
  // statistics.
  const terms = ["alpha", "beta", "gamma", "delta"];
  const stats = buildTermStatistics(corpus("alpha beta gamma delta", 100), terms);
  const all = score(mem("alpha beta gamma delta"), terms, stats);
  const one = score(mem("alpha only here"), terms, stats);
  assert.ok(all > one, `coverage ordering preserved: ${all.toFixed(2)} vs ${one.toFixed(2)}`);
});

test("T03-004: coverage ordering also holds with no statistics at all", () => {
  const terms = ["alpha", "beta", "gamma", "delta"];
  const all = score(mem("alpha beta gamma delta"), terms);
  const one = score(mem("alpha only here"), terms);
  assert.ok(all > one, "the fallback is not a flat score");
});

// --- Behaviour at the extremes --------------------------------------------

test("T03-005: a term in every document contributes almost nothing", () => {
  // A stopword appears in all 1000 documents. It must not be able to make a result
  // look relevant on its own.
  const stats = buildTermStatistics(corpus("the", 1000), ["the"]);
  assert.equal(stats.documentFrequency.get("the"), 1000);
  const only = score(mem("the"), ["the"], stats);
  assert.ok(only < 5, `a ubiquitous term scores almost nothing: ${only.toFixed(2)}`);

  // And it cannot outrank a rare term in the same query.
  const mixed = buildTermStatistics(
    [...Array.from({ length: 1000 }, (_, i) => mem(`the note ${i}`)), mem("quokka")],
    ["the", "quokka"],
  );
  const rare = score(mem("quokka"), ["the", "quokka"], mixed);
  const common = score(mem("the"), ["the", "quokka"], mixed);
  assert.ok(rare > common, "the rare term wins even though it matched once");
});

test("T03-006: a term with no recorded frequency is treated as common, not rare", () => {
  // Assuming a term is rare when it is actually common is how a stopword ends up
  // dominating a result set, so an unrecorded term must not get a free pass.
  const stats = buildTermStatistics(corpus("something", 100), ["absent"]);
  assert.equal(stats.documentFrequency.get("absent"), undefined);
  const unrecorded = score(mem("absent"), ["absent"], stats);
  const noStatistics = score(mem("absent"), ["absent"]);
  assert.ok(
    unrecorded < noStatistics,
    `an unrecorded term is discounted, not credited with rarity: ${unrecorded.toFixed(2)} vs ${noStatistics.toFixed(2)}`,
  );
  // A seam worth pinning: *no* statistics is neutral, while statistics that do not
  // mention the term are evidence it is common. Different inputs, different answers.
  assert.ok(
    noStatistics > unrecorded,
    "so having no statistics at all is not the same as having statistics that omit the term",
  );
});

test("T03-007: an empty corpus or no terms degrades without dividing by zero", () => {
  const empty = buildTermStatistics([], ["alpha"]);
  // Not zero: an empty corpus carries no information about rarity, so the term is
  // weighted neutrally and the document scores on coverage alone. My first
  // expectation of 0 was wrong about the intent.
  const degenerate = score(mem("alpha"), ["alpha"], empty);
  assert.ok(Number.isFinite(degenerate) && degenerate > 0, `neutral rather than zero: ${degenerate}`);
  assert.equal(degenerate, score(mem("alpha"), ["alpha"]), "identical to passing no statistics");

  const noTerms = buildTermStatistics(corpus("alpha", 10), []);
  assert.equal(noTerms.documentFrequency.size, 0);
  assert.equal(score(mem("alpha"), [], noTerms), 0, "an empty term list scores zero");

  const single = buildTermStatistics(corpus("alpha", 1), ["alpha"]);
  assert.ok(Number.isFinite(score(mem("alpha"), ["alpha"], single)), "a one-document corpus is finite");
});

// --- Statistics are counted correctly -------------------------------------

test("T03-008: document frequency counts documents, not occurrences", () => {
  // "alpha alpha alpha" in one document is one document containing alpha.
  const stats = buildTermStatistics([mem("alpha alpha alpha"), mem("alpha beta")], ["alpha", "beta"]);
  assert.equal(stats.documentFrequency.get("alpha"), 2, "two documents contain it");
  assert.equal(stats.documentFrequency.get("beta"), 1);
});

test("T03-009: tags count toward document frequency", () => {
  // A term in many tags is genuinely common, and treating it as rare would inflate
  // exactly the documents least likely to be useful.
  const stats = buildTermStatistics([mem("alpha", ["beta"]), mem("gamma", ["beta"])], ["beta"]);
  assert.equal(stats.documentFrequency.get("beta"), 2, "two documents contain beta via tags");
});

test("T03-010: the corpus count can exceed the loaded candidates", () => {
  // The backend knows the true total even when it has paged one window of it.
  // Discounting against the page size would make common terms look rare.
  const page = corpus("alpha", 10);
  const stats = buildTermStatistics(page, ["alpha"], 10_000);
  assert.equal(stats.documentCount, 10_000, "the true corpus count is used, not the page size");
  const againstPage = score(mem("alpha"), ["alpha"], buildTermStatistics(page, ["alpha"]));
  const againstTotal = score(mem("alpha"), ["alpha"], stats);
  // Ten occurrences in ten documents is *everywhere*; ten in ten thousand is rare.
  // I had this backwards when writing it, and the implementation was right.
  assert.ok(
    againstTotal > againstPage,
    `the true corpus count makes a page-frequent term look rare: ${againstTotal.toFixed(2)} vs ${againstPage.toFixed(2)}`,
  );
});

test("T03-011: terms are matched case-insensitively in the statistics too", () => {
  const stats = buildTermStatistics([mem("Alpha here"), mem("alpha there")], ["ALPHA"]);
  assert.equal(stats.documentFrequency.get("alpha"), 2, "the query's casing does not matter");
});

// --- The scale is still the one downstream expects ------------------------

test("T03-012: the score stays within 0..60 and 0 still means no evidence", () => {
  const terms = ["alpha", "beta"];
  const stats = buildTermStatistics(corpus("alpha beta", 50), terms);
  for (const m of [mem("alpha beta"), mem("alpha"), mem("alpha beta alpha beta", ["alpha", "beta"])]) {
    const value = score(m, terms, stats);
    assert.ok(value >= 0 && value <= 60, `within range: ${value}`);
  }
  assert.equal(score(mem("nothing relevant"), terms, stats), 0, "no evidence is still exactly zero");
  assert.equal(score(mem("nothing relevant"), terms), 0);
});

test("T03-013: IDF is applied to every field, not just the content", () => {
  // A rare term in a tag must be discounted the same way a rare term in prose is,
  // or the field weighting and the rarity weighting quietly disagree.
  // My first version put "widget" in 900 and 901 documents respectively, so both
  // were discounted almost identically and the comparison was vacuous. The term has
  // to actually be rare in one corpus for this to test anything.
  const common = buildTermStatistics(corpus("widget", 900), ["widget"]);
  const rare = buildTermStatistics([...corpus("elsewhere", 900), mem("gizmo", ["widget"])], ["widget"]);
  assert.equal(common.documentFrequency.get("widget"), 900, "ubiquitous");
  assert.equal(rare.documentFrequency.get("widget"), 1, "genuinely rare");
  const tagCommon = score(mem("nothing here", ["widget"]), ["widget"], common);
  const tagRare = score(mem("nothing here", ["widget"]), ["widget"], rare);
  assert.ok(
    tagRare > tagCommon,
    `rarity lifts a tag hit too: ${tagRare.toFixed(2)} vs ${tagCommon.toFixed(2)}`,
  );
});


// --- End to end ----------------------------------------------------------
//
// The tests above call `keywordScore` with statistics they built themselves, so
// they verify the scorer honours them and nothing more. Mutation testing showed
// that is not enough: breaking the *call site* — never passing the statistics,
// halving the rarity influence, ignoring the corpus count — failed none of them.
// The scorer could be perfect and the feature entirely disconnected.
//
// These go through `searchQ`, so the wiring is under test too.

test("T03-014: rarity reorders real results, not just a unit-level score", () => {
  // Two candidates, each matching one of the query's two terms, so coverage is
  // identical. Only corpus rarity separates them.
  const rare = mem("quokka sighting confirmed");
  const common = [
    ...Array.from({ length: 500 }, (_, i) => mem(`beaver note ${i}`)),
    rare,
  ];
  // Every beaver note matches "beaver", so the result set is the default limit of
  // ten rather than the two documents I first asserted on.
  const results = searchQ(common, { query: "quokka beaver", explain: true });
  assert.ok(results.results.length >= 2, "both candidates match one term each");
  assert.ok(
    results.results.some((m) => m.id === common[0]!.id),
    "and the common-term candidate is in the set, so this is a real comparison",
  );
  assert.equal(
    results.results[0]!.id,
    rare.id,
    "the document holding the rare term ranks first, despite equal coverage",
  );
  const explanations = results.explanations ?? [];
  const rareScore = explanations.find((e) => e.id === rare.id)?.components?.keyword ?? 0;
  const commonScore = explanations.find((e) => e.id === common[0]!.id)?.components?.keyword ?? 0;
  assert.ok(
    rareScore > commonScore * 1.5,
    `and not narrowly: ${rareScore.toFixed(2)} vs ${commonScore.toFixed(2)}`,
  );
});

test("T03-015: a paginated candidate set discounts against the true corpus size", () => {
  // The backend knows the real total even when it has paged one window. Scoring
  // against the page size would make a term that appears in most of the corpus look
  // rare, and inflate the very documents least likely to be useful.
  // A term appearing in exactly one document is maximally rare at *any* corpus
  // size, so normalising by log(1+N) makes df=1 scale-invariant — my first choice
  // of term showed no difference at all. A term appearing five times does.
  const page = [...Array.from({ length: 20 }, (_, i) => mem(`quokka note ${i}`))];
  const target = mem("quokka sighting confirmed");
  page.push(target);

  const againstPage = searchQ(page, { query: "quokka", explain: true });
  const againstTrueTotal = searchQ(page, { query: "quokka", totalDocs: 10_000, explain: true });
  // Explanations are only built for results inside the final top-k, and all 21
  // documents here are equivalent, so `target` is not among them. Reading its
  // explanation gave 0 for both corpus sizes and the comparison was vacuous.
  const keywordOf = (r: { explanations?: { components?: Record<string, number> }[] }): number =>
    (r.explanations ?? []).find((e) => e.components?.keyword !== undefined)?.components?.keyword ?? 0;
  const pageScore = keywordOf(againstPage);
  const trueScore = keywordOf(againstTrueTotal);
  assert.ok(pageScore > 0 && trueScore > 0, "both readings are real scores, not absent ones");
  assert.ok(
    trueScore > pageScore,
    `knowing the corpus is 10,000 documents makes "quokka" rarer than 20-of-20 suggests: ${trueScore.toFixed(2)} vs ${pageScore.toFixed(2)}`,
  );
});

test("T03-016: the wiring is what makes rarity matter, and it is exercised", () => {
  // A guard on the guard. If `searchQ` stopped passing the statistics, every test
  // above would still pass, so this asserts the one thing that changes: the
  // *relative* order of two equal-coverage candidates.
  // One build. Calling build() twice created a *different* rare memory each time,
  // so the id comparison could never hold — which is why this failed first.
  const rare = mem("quokka sighting confirmed");
  const corpus = [...Array.from({ length: 500 }, (_, i) => mem(`beaver note ${i}`)), rare];
  const order = searchQ(corpus, { query: "quokka beaver" }).results.map((m) => m.id);
  assert.equal(order[0], rare.id, "rare term wins when the other is common");
});
