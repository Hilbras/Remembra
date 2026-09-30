/**
 * The §38 benchmark set: a labelled corpus and query set that runs through the
 * real retrieval pipeline.
 *
 * §38 requires that every retrieval-engine change be measured against a benchmark
 * set. Until now that was a rule people followed by intention, which is to say it
 * was a rule people could forget. `src/benchmark-gate.test.ts` and
 * `scripts/benchmark-gate.mjs` make it mechanical.
 *
 * Three properties matter, and each one was arrived at by getting it wrong first.
 *
 * **It runs the real pipeline.** The pre-existing `benchmark.test.ts` passes a
 * hand-written `searchFn` — a substring filter — so it measures the harness and
 * not the engine. A gate over that cannot detect a broken ranker, because the
 * ranker is not in the loop.
 *
 * **The vector side is synthetic but not trivially similar to the keyword side.**
 * A benchmark where the "semantic" signal is the keyword signal wearing a hat
 * cannot see a fusion change, which is most of what §34 is about. So the
 * embedding here is a hashed bag of terms: it shares vocabulary with the lexical
 * path, but it ignores IDF, ignores field weighting, and weights raw term
 * frequency, so the two signals genuinely disagree and their fusion is a real
 * decision. It is hermetic — no provider, no network, no nondeterminism — which
 * is what makes the numbers comparable to a committed baseline.
 *
 * **Every scenario names the regression it guards.** A scenario with no stated
 * failure mode is a scenario nobody knows how to break, so the gate would pass
 * for reasons nobody could reconstruct. The `guards` field is required, not
 * documentation.
 */
import { evaluate, type EvalResult } from "./eval.js";
import { searchQ, type RetrievalPolicyOptions } from "./retrieval.js";
import type { Memory, SearchQuery } from "./types.js";

/** Fixed clock. Nothing in the gate may depend on today's date. */
const EPOCH = "2026-03-01T00:00:00.000Z";

/**
 * 256 dimensions, not fewer. At 96 the hashed bag collided often enough that
 * unrelated documents shared vector mass, and the semantic path degenerated into
 * noise. A smaller space would have made the gate quieter and its numbers less
 * meaningful.
 */
const EMBED_DIMS = 256;

/**
 * A deterministic stand-in for an embedding model.
 *
 * It hashes **character trigrams** rather than whole words. Whole-word hashing was
 * tried first and made paraphrase untestable: a query that shares no vocabulary
 * with its answer had a similarity of exactly zero, so there was no such thing as
 * a semantic-only scenario and the "semantic" signal was the keyword signal with
 * different arithmetic. Trigrams give a crude but real fuzzy match — "deploy",
 * "deployment" and "deployed" overlap — which is different enough from the
 * lexical path to be worth fusing with, and close enough that a paraphrase can be
 * expressed.
 *
 * It is still a stand-in and the benchmark says so. What it buys is determinism:
 * a gate compared against a committed baseline cannot tolerate a run that varies
 * by machine, and a provider call would.
 */
export function benchmarkEmbed(text: string): number[] {
  const vector = new Array<number>(EMBED_DIMS).fill(0);
  // Padded so a word contributes its boundary trigrams too, which is what makes
  // "rate" and "rates" overlap at all.
  const padded = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  for (let i = 0; i + 3 <= padded.length; i++) {
    const gram = padded.slice(i, i + 3);
    if (gram.trim().length === 0) continue;
    let hash = 0x811c9dc5;
    for (let k = 0; k < gram.length; k++) {
      hash ^= gram.charCodeAt(k);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    vector[hash % EMBED_DIMS] = (vector[hash % EMBED_DIMS] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

function mem(id: string, content: string, over: Partial<Memory> = {}): Memory {
  return {
    id,
    type: "fact",
    content,
    scope: "global",
    tags: [],
    // Uniform by default. A scenario that means to vary metadata passes it
    // explicitly, so the uniformity cannot be undone by a later edit that just
    // happens to set importance.
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "import" },
    version: 1,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    embedding: benchmarkEmbed(`${content} ${(over.tags ?? []).join(" ")}`),
    ...over,
  } as Memory;
}

/**
 * The corpus. Grouped by the failure it is there to expose, because a corpus
 * presented as one undifferentiated list tends to drift into "whatever was handy".
 */
export const BENCHMARK_CORPUS: Memory[] = [
  // --- Tokenisation (T02). Boundaries, not just substrings. -----------------
  mem("tok-plain", "the tenant gateway rejects traffic"),
  mem("tok-hyphen", "multi-tenant isolation is enforced at the gateway"),
  mem("tok-underscore", "the max_latency_ms budget is applied per query"),
  mem("tok-camel", "parseUserRequest validates the bearer token"),
  mem("tok-camel-split", "parse the user request before authenticating"),
  // A near-miss that a boundary-blind tokeniser would fold together with the above.
  mem("tok-decoy", "parser uses request validation helpers"),

  // --- Phrases (T02). Order must matter, not just co-occurrence. -------------


  // --- Inverse document frequency (T03). -----------------------------------
  // "deployment" appears in nearly every document; "canary" in one. A ranker that
  // ignores IDF puts the common term first forever.


  // --- Field weights (T02). A tag must count for more than buried body text.
  mem("field-tag", "retention policy", { tags: ["runbook", "retention"] }),
  mem("field-body", "the runbook mentions retention once in passing and never again"),

  // --- Deduplication (T04). ----------------------------------------------
  // Two byte-identical copies: a re-ingest, not corroboration.
  mem("dup-exact-a", "the vault key rotates every ninety days"),
  mem("dup-exact-b", "the vault key rotates every ninety days"),
  // Same text, different source: corroboration, and must survive by default.
  mem("dup-cross-a", "the backup window is four hours", { provenance: { sourceType: "manual" } }),
  mem("dup-cross-b", "the backup window is four hours", { provenance: { sourceType: "import" } }),

  // --- Supersession (T05). -------------------------------------------------
  mem("sup-old", "the api rate limit is sixty requests per minute", { supersededBy: "sup-new" }),
  mem("sup-new", "the api rate limit is six hundred requests per minute"),

  // --- Metadata modifiers (§34, via T07). ---------------------------------
  // meta-thin holds the query's terms in the weighted `tags` field and is close
  // behind on relevance; meta-rich holds the metadata advantage. Comparable
  // relevance is the point — see the scenario's `guards` for what that does and does
  // not prove, which is a correction rather than a design.
  //
  // Deliberately *not* pinned. A pinned memory is worth +50 on its own, enough to
  // outrank every query in the set including ones it has nothing to do with —
  // correct behaviour, but it turns the whole benchmark into a measurement of
  // pinning. Importance, trust and provenance give a ~30-point spread instead:
  // enough to decide this scenario, small enough that a genuine keyword match
  // elsewhere still wins.
  mem("meta-rich", "the escalation path pages the on-call engineer", {
    provenance: { sourceType: "manual" },
    trust: "system",
    importance: 5,
  }),
  mem("meta-thin", "the wiki page for the escalation path runbook", {
    tags: ["escalation", "path", "on-call", "engineer"],
    provenance: { sourceType: "import" },
    trust: "unverified",
    importance: 1,
  }),
  // --- Hard cases. --------------------------------------------------------
  // Every other scenario has an unambiguous winner, which means it can only ever
  // detect a *catastrophic* regression: gold moves from rank 1 out of the window,
  // not from 1 to 2. These are the cases a real corpus is full of — a plausible
  // wrong answer that scores well for reasons that are not wrong, just not what the
  // question was about. They give the gate room to notice a ranking that drifts by
  // a place or two, which is how regressions actually arrive.
  //
  // The gold lands at rank 2 or 3 under correct behaviour. That is the point: these
  // are not failures to be fixed, they are the shape of a corpus that is hard. A
  // gold outside the window would be worse than useless — it would be
  // indistinguishable from a broken query, which is why BENCH-GATE-004 exists.
  mem("hard-decoy-1", "deploy the service to the cluster with the deploy pipeline", { tags: ["deploy"] }),
  mem("hard-gold-1", "a deploy is only finished once the health check passes"),
  mem("hard-decoy-2", "the token refreshes when the session expires"),
  mem("hard-gold-2", "a refresh token should be rotated on every single use"),
  mem("hard-decoy-3", "the index rebuild reads the whole table"),
  mem("hard-gold-3", "rebuilding an index incrementally avoids the full table scan"),

  // --- Breadth, so a ranking change has somewhere to show up. ---------------
  mem("misc-0", "the build cache is keyed on the lockfile hash"),
  mem("misc-1", "feature flags are evaluated once per request"),
  mem("misc-2", "the staging database is reset nightly"),
  mem("misc-3", "logs are sampled at ten percent in production"),
  mem("misc-4", "the mobile client polls every thirty seconds"),
  mem("misc-5", "schema migrations run in a transaction"),
  mem("misc-6", "the scheduler skips maintenance windows"),
  mem("misc-7", "images are compressed before upload"),


];

export interface BenchmarkScenario {
  id: string;
  /**
   * The regression this scenario exists to catch. Required, so a scenario that
   * nobody can break is noticed in review rather than in production.
   */
  guards: string;
  query: string;
  /** Everything that answers the question, in no particular order. */
  relevantIds: string[];
  /** Query-level options, where a scenario needs one. */
  queryOptions?: Partial<SearchQuery>;
  /** Policy overrides, where a scenario needs one. */
  policy?: RetrievalPolicyOptions;
  /** Scenario-grouping, so a regression can be reported against a subsystem. */
  group: string;
  /**
   * A private corpus for this scenario, used *instead of* the shared one.
   *
   * This exists because some behaviours cannot be expressed in a shared corpus at
   * all. A pinned document is worth +50 on its own, which is more than the entire
   * spread between any two fused scores, so in a shared corpus it is
   * unconditionally first and wins every query, including the ones it is not
   * about. Two attempts failed before this one worked:
   *
   * - Putting the pinned pair in the shared corpus produced a benchmark where one
   *   memory topped all 19 scenarios, which measures pinning and nothing else.
   * - Making the pair *additive* to the shared corpus was not enough either: a
   *   high-metadata document from the shared corpus still outranked the private
   *   pair, so the confidence scenario scored MRR 0.5 for reasons that had nothing
   *   to do with confidence.
   *
   * So it replaces. The trade is that a private scenario no longer exercises
   * interaction with the rest of the corpus, which is the right trade: the point of
   * these scenarios is that exactly one modifier decides the ranking.
   */
  corpus?: Memory[];
}

/**
 * The single-modifier pairs, built on demand so each lives only in its own
 * scenario's corpus. Each pair differs from its partner in exactly one field: a
 * pair differing in several modifiers at once cannot detect a sign error or a
 * dropped term in any one of them, because the others still outvote it. That is
 * not a theoretical worry — inverting trust in a three-field pair changed nothing,
 * and only mutation testing showed it.
 */
/**
 * Private corpora for scenarios that cannot be expressed in the shared one.
 *
 * Two independent reasons, both found by measurement:
 *
 * - **Metadata interference.** The shared corpus contains a high-metadata document
 *   (`meta-rich`) that outranks documents with weak relevance. That is correct
 *   behaviour and it quietly breaks any scenario whose gold is a weak match: a
 *   zero-relevance document at +58 modifiers beats a relevant one at +34, no matter
 *   how well the latter matches. The CJK scenario failed for exactly this reason.
 * - **Scale.** Normalised IDF is bounded at 1.0 for a term in one document, so in a
 *   38-document corpus even a term in four documents is still worth ~0.64 and two of
 *   them outrank one rare term. Rarity only dominates when the common term is common
 *   relative to a *small* corpus, which means the corpus has to be small.
 */
/**
 * Prefix matching. The gold's tokens are *longer* than the query terms, so nothing
 * matches exactly and all of its credit comes from the prefix weight. A gold with
 * any exact match keeps winning when the weight is zero, which is how the first
 * attempt at this ended up insensitive. The decoy earns a single exact tag match
 * (0.5) — between zero and the gold's 0.7 — so the gold leads by a margin that
 * exists only while the prefix weight does.
 */
const prefixGold = (): Memory => mem("prefix-gold", "the deployments and migrations are current", { tags: ["reference"] });
const prefixDecoy = (): Memory => mem("prefix-decoy", "the release checklist is short", { tags: ["deploy"] });

/**
 * Phrase adjacency, isolated.
 *
 * Three things had to be arranged. The set has to be a *pair*: a third overlapping
 * document in the shared corpus was ranked between them on vector score, so the
 * phrase bonus was not what decided. Neither document may carry an embedding, or
 * the synthetic vectors rank the ordered one first for reasons unrelated to
 * adjacency — which is what the shared corpus did. And the *decoy* must hold the id
 * that sorts first, because with the bonus removed the two score identically and
 * the id tie-break decides; sorting the right answer first hid the mutation.
 */
const phraseOrdered = (): Memory =>
  mem("phrase-1-ordered", "the release train ships on fridays", { embedding: undefined });
const phraseInverted = (): Memory =>
  mem("phrase-0-inverted", "on fridays the train for release departs", { embedding: undefined });

/**
 * Rarity that actually dominates, which needs a small corpus to be expressible.
 *
 * None of these documents carries an embedding, and that is load-bearing. The
 * fillers are near-identical in wording, so their trigram vectors are nearly
 * identical to each other and to the query's — with the semantic path open they
 * crowd the gold out on vector score alone, and the scenario reports MRR 0.5 for a
 * reason that has nothing to do with IDF. Leaving the vector path empty makes the
 * IDF-weighted lexical ranking the only thing deciding, which is the point.
 */
const idfGold = (): Memory => mem("idf-rare-gold", "the canary build reached production", { embedding: undefined });
const idfDecoy = (): Memory => mem("idf-decoy", "the scheduler polls the index every minute", { embedding: undefined });
const idfFiller = (i: number): Memory =>
  mem(`idf-filler-${i}`, `the scheduler updates the index during batch ${i}`, { embedding: undefined });

/** Case folding, isolated for the same reason as CJK: metadata interference. */
const caseGold = (): Memory => mem("tok-case", "The Deployment Pipeline Is Documented", { tags: ["RUNBOOK"] });
const caseDecoy = (): Memory => mem("tok-case-decoy", "the release checklist is short", { tags: ["reference"] });


const modTrustHigh = (): Memory => mem("mod-trust-high", "the cache is purged on the ninth of every month", { trust: "system" });
const modTrustLow = (): Memory =>
  mem("mod-trust-low", "the wiki note about purging the cache on the ninth", {
    tags: ["cache", "purged", "ninth", "month"],
    trust: "unverified",
  });

/** Tilted: the low-importance document holds the stronger lexical match. */
const modImportanceHigh = (): Memory => mem("mod-importance-high", "the audit log is rotated daily", { importance: 5 });
const modImportanceLow = (): Memory =>
  mem("mod-importance-low", "daily rotation of the audit log", {
    tags: ["audit", "log", "rotated", "daily"],
    importance: 1,
  });

const modConfidenceHigh = (): Memory => mem("mod-confidence-high", "the replica is rebuilt from the snapshot");
const modConfidenceLow = (): Memory =>
  mem("mod-confidence-low", "the wiki note about rebuilding the replica from the snapshot", {
    tags: ["replica", "rebuilt", "snapshot"],
    confidence: 0.1,
  });

/**
 * Recency: two documents of *equal* relevance that differ only in age.
 *
 * Equal relevance has to be arranged rather than assumed. Two earlier attempts
 * failed: the pair differed by one word, which was enough to put the older
 * document a rank ahead on the fused score, and a single rank is worth ~27 points
 * while recency in the default path is capped at 20 x 0.5 = 10. Recency cannot
 * overcome a rank difference here — it can only break a tie.
 *
 * So the pair carries identical explicit embeddings, which ties the semantic
 * signal, and content whose only difference is a word absent from the query, which
 * ties the lexical signal. The fused score is then equal and the recency modifier
 * is the only thing that decides, which is what makes the scenario able to detect
 * a dropped, inverted or mis-scaled recency term at all.
 */
const RECENCY_PAIR_EMBEDDING = [1, 0, 0, 0, 0, 0, 0, 0];
// The ids are deliberately not "new/old" shaped. I first tried to make a dropped
// recency term detectable by naming the stale document so it won the id tie-break,
// and it still was not: `updatedAt` is consulted before `id`. The names here just
// say which is which without implying an age ordering the id does not encode.
const modRecencyNew = (): Memory =>
  mem("mod-recency-9-fresh", "the digest is emailed every morning", {
    updatedAt: "2026-08-15T00:00:00.000Z",
    embedding: RECENCY_PAIR_EMBEDDING,
  });
const modRecencyOld = (): Memory =>
  mem("mod-recency-0-stale", "the digest is emailed every evening", {
    updatedAt: "2024-08-15T00:00:00.000Z",
    embedding: RECENCY_PAIR_EMBEDDING,
  });

/** Pinned is worth +50, so this pair is only expressible in a private corpus. */
const modPinnedHigh = (): Memory => mem("mod-pinned-high", "the incident bridge opens on the incident channel", { retention: "pinned" });
const modPinnedLow = (): Memory =>
  mem("mod-pinned-low", "the wiki note about the incident bridge channel", {
    tags: ["incident", "bridge", "opens", "channel"],
  });

export const BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  {
    id: "token-boundary-hyphen",
    guards: "T02: 'multi-tenant' must match as one term and not also as 'multi' and 'tenant'",
    group: "tokenisation",
    query: "multi-tenant isolation",
    relevantIds: ["tok-hyphen"],
  },
  {
    id: "token-boundary-underscore",
    guards: "T02: 'max_latency_ms' must survive an underscore in either position",
    group: "tokenisation",
    query: "max_latency_ms budget",
    relevantIds: ["tok-underscore"],
  },
  {
    id: "token-boundary-camel",
    guards: "T02: 'parseUserRequest' must be reachable both as one token and split",
    group: "tokenisation",
    query: "parseUserRequest",
    relevantIds: ["tok-camel", "tok-camel-split"],
  },
  {
    id: "token-decoy-not-matched",
    guards: "T02: 'parser' must not satisfy a query for 'parse'",
    group: "tokenisation",
    query: "parse the request",
    relevantIds: ["tok-camel-split"],
  },
  {
    id: "phrase-order-matters",
    guards: "T02: 'release train' beats the same words in another order",
    group: "phrases",
    query: "release train",
    relevantIds: ["phrase-1-ordered"],
    corpus: [phraseOrdered(), phraseInverted()],
  },
  {
    id: "idf-rare-term-wins",
    guards:
      "T03: one rare term must outweigh two common ones. The decoy matches both common terms and the " +
      "gold matches only the rare one, so with every term weighted equally the decoy's extra coverage wins. " +
      "Fails if IDF is neutralised or inverted",
    group: "idf",
    query: "scheduler canary index",
    relevantIds: ["idf-rare-gold"],
    // Six fillers: in a ten-document corpus a term in eight of them is worth ~0.34,
    // so two common matches (0.68) lose to one rare match (1.0). With every term
    // weighted equally the decoy's extra coverage wins instead.
    corpus: [idfGold(), idfDecoy(), ...[0, 1, 2, 3, 4, 5].map(idfFiller)],
  },
  {
    id: "field-weight-beats-body",
    guards: "T02: a tag match must outrank the same word buried in body text",
    group: "field-weights",
    query: "retention runbook",
    relevantIds: ["field-tag"],
  },
  {
    id: "dedup-exact-removed",
    guards: "T04: a byte-identical re-ingest must not occupy two result slots",
    group: "dedup",
    query: "vault key rotates",
    relevantIds: ["dup-exact-a"],
  },
  {
    id: "dedup-cross-source-kept",
    guards: "T04: identical text from two sources is corroboration and both survive",
    group: "dedup",
    query: "backup window",
    relevantIds: ["dup-cross-a", "dup-cross-b"],
  },
  {
    id: "superseded-suppressed",
    guards: "T05: a memory with an available replacement must not be returned",
    group: "superseded",
    query: "api rate limit",
    relevantIds: ["sup-new"],
  },
  {
    id: "metadata-modifier-applies",
    // Stated as what this actually detects, after mutation testing showed the
    // stronger claim was false. Zeroing every metadata weight does NOT fail this
    // scenario: the two documents have comparable relevance, so removing the
    // metadata advantage turns a decisive win into a *tie* that still returns a
    // relevant document first. MRR stays 1.0. A tie is not a regression, and
    // inventing a lexical edge strong enough to flip the order would have meant
    // labelling the weaker match as the answer, which is not what this corpus is
    // for. What this catches is metadata ceasing to apply where relevance is close
    // — e.g. a modifier sign error that inverts the preference.
    guards:
      "§34: where two documents are comparably relevant, the metadata modifiers decide, and the " +
      "trusted, manual, important one is preferred",
    group: "modifiers",
    query: "escalation path on-call engineer",
    relevantIds: ["meta-rich"],
  },
  {
    id: "modifier-trust-decides",
    guards:
      "V4.9 trust: between two comparably relevant documents that differ only in trust, the trusted one " +
      "is preferred. Fails if TRUST_POINTS is inverted, dropped, or signed wrongly",
    group: "modifiers",
    query: "cache purged ninth",
    relevantIds: ["mod-trust-high"],
    corpus: [modTrustHigh(), modTrustLow()],
  },
  {
    id: "modifier-importance-decides",
    guards:
      "§34 metadata: between two comparably relevant documents the low-importance one holds the stronger " +
      "lexical match, so the importance bonus is the only thing that decides. Fails if the importance term " +
      "is dropped, inverted, or mis-scaled",
    group: "modifiers",
    query: "audit log rotated",
    relevantIds: ["mod-importance-high"],
    corpus: [modImportanceHigh(), modImportanceLow()],
  },
  {
    id: "modifier-confidence-decides",
    guards:
      "V4.2 confidence: between two comparably relevant documents, the more certain one is preferred. " +
      "Fails if the confidence term is dropped, inverted, or mis-scaled",
    group: "modifiers",
    query: "replica rebuilt snapshot",
    relevantIds: ["mod-confidence-high"],
    corpus: [modConfidenceHigh(), modConfidenceLow()],
  },
  {
    id: "modifier-pinned-decides",
    guards:
      "§34 metadata: retention pinning outranks an equal-relevance unpinned document. Fails if the pinned " +
      "bonus is dropped, inverted, or mis-scaled",
    group: "modifiers",
    query: "incident bridge channel",
    relevantIds: ["mod-pinned-high"],
    corpus: [modPinnedHigh(), modPinnedLow()],
  },
  {
    id: "modifier-recency-decides",
    // What this detects, and what it cannot. Both limits are properties of the
    // ranking rather than gaps in the scenario, and both were found by mutation
    // testing rather than reasoning.
    //
    // *Scaling* recency cannot be detected. Recency is monotone in age and the
    // scale is a positive multiplier on both sides, so no scale reorders a pair
    // that is already ordered correctly.
    //
    // *Removing* recency cannot be detected either, and for a reassuring reason:
    // the deterministic tie-break is `final`, then `updatedAt` descending, then
    // id. Two documents that tie on score are still ordered newest-first, so
    // deleting the recency modifier leaves the answer unchanged. Renaming the pair
    // to exploit the id tie-break did not help, because `updatedAt` is consulted
    // first. The code is more robust here than the gate can measure, which is the
    // right way round.
    guards:
      "§34 recency: between two documents of equal relevance, the more recently updated one is preferred. " +
      "Fails if the recency term or its sign is inverted (mod-recency-9-fresh loses). Cannot detect a " +
      "mis-scaled or removed recency term: scaling a monotone term cannot reorder a consistent pair, and " +
      "the updatedAt tie-break preserves recency ordering even with the modifier gone",
    group: "modifiers",
    query: "digest emailed",
    relevantIds: ["mod-recency-9-fresh"],
    corpus: [modRecencyNew(), modRecencyOld()],
  },
  {
    id: "prefix-partial-word",
    guards:
      "T02: a query term that is a prefix of a document's token still matches, at the prefix weight rather " +
      "than the full one. Fails if the prefix weight is zeroed",
    group: "tokenisation",
    query: "deploy migration",
    relevantIds: ["prefix-gold"],
    corpus: [prefixGold(), prefixDecoy()],
  },
  {
    id: "token-case-folded",
    guards: "T02: matching folds case in both content and tags",
    group: "tokenisation",
    query: "deployment pipeline",
    relevantIds: ["tok-case"],
    corpus: [caseGold(), caseDecoy()],
  },
  {
    id: "hard-decoy-denser",
    guards: "ranking: a document repeating the query's words is not thereby the answer",
    group: "hard",
    query: "deploy the service",
    relevantIds: ["hard-gold-1"],
  },
  {
    id: "hard-refresh-token",
    guards: "ranking: rotation advice must beat the document that merely mentions expiry",
    group: "hard",
    query: "refresh token",
    relevantIds: ["hard-gold-2"],
  },
  {
    id: "hard-incremental-index",
    guards: "ranking: the specific answer must beat the general one on a narrow question",
    group: "hard",
    query: "rebuild the index",
    relevantIds: ["hard-gold-3"],
  },
  {
    id: "breadth-ranking",
    guards: "general: the correct document is first on an ordinary question",
    group: "breadth",
    query: "feature flags evaluated",
    relevantIds: ["misc-1"],
  },
  {
    id: "breadth-schema",
    guards: "general: the correct document is first on a second ordinary question",
    group: "breadth",
    query: "schema migrations transaction",
    relevantIds: ["misc-5"],
  },
];

export interface BenchmarkRun {
  /** The eval harness output, including the T01 metrics. */
  result: EvalResult;
  /** Top ids per scenario, so a regression can be reported concretely. */
  topIds: Record<string, string[]>;
  /** Queries the harness marked as having found nothing relevant. */
  misses: string[];
}

/**
 * The result window the gate is measured over.
 *
 * This was the corpus size in the first draft, which quietly destroyed two of the
 * six gated metrics: with every document returned, `precision_at_k` is always
 * `relevant / corpus` and can never move. Five is a realistic window and leaves
 * headroom for a ranker to be wrong in a way the gate can see.
 */
const GATE_K = 5;

/**
 * Run the whole set through the real pipeline.
 *
 * Recall is measured against a perfect ranking in the same window, so a ranker
 * cannot look good by burying every relevant document just below the cut.
 */
export async function runRetrievalBenchmark(): Promise<BenchmarkRun> {
  const topIds: Record<string, string[]> = {};
  const byText = new Map<string, BenchmarkScenario>();
  for (const scenario of BENCHMARK_SCENARIOS) byText.set(scenario.query, scenario);

  const result = await evaluate({
    k: GATE_K,
    queries: BENCHMARK_SCENARIOS.map((s) => ({ id: s.id, text: s.query, relevantIds: s.relevantIds })),
    searchFn: async (text) => {
      const scenario = byText.get(text);
      if (!scenario) throw new Error(`benchmark: query not in the scenario set: ${text}`);
      const corpus = scenario.corpus ?? BENCHMARK_CORPUS;
      const hits = searchQ(
        corpus,
        { query: scenario.query, explain: true, ...scenario.queryOptions },
        benchmarkEmbed(scenario.query),
        { diversity: false, ...scenario.policy },
      );
      topIds[scenario.id] = hits.results.map((m) => m.id);
      return hits.results;
    },
  });

  return {
    result,
    topIds,
    misses: result.queries.filter((q) => q.hit_rate_at_k === 0).map((q) => q.id),
  };
}

/** The metrics the gate holds a baseline for, with the direction that counts as a regression. */
export const GATED_METRICS = [
  { key: "precision_at_k", label: "precision@k", worse: "down" },
  { key: "recall_at_k", label: "recall@k", worse: "down" },
  { key: "mrr", label: "MRR", worse: "down" },
  { key: "ndcg_at_k", label: "nDCG@k", worse: "down" },
  { key: "token_efficiency", label: "token efficiency", worse: "down" },
  { key: "duplicate_rate", label: "duplicate rate", worse: "up" },
] as const satisfies ReadonlyArray<{ key: keyof EvalResult["aggregate"]; label: string; worse: "up" | "down" }>;

/** Latency percentiles are gated too, but only when the benchmark runs alone. */
export const GATED_LATENCY = [
  { key: "p50_latency_ms", label: "p50 latency", worse: "up" },
  { key: "p95_latency_ms", label: "p95 latency", worse: "up" },
] as const;

/**
 * How a regression is judged.
 *
 * `quality` is a mean across scenarios of a per-scenario ratio, so one scenario
 * out of sixteen moving by 0.5 moves the aggregate by ~0.03. The tolerance is
 * well below that, so a single scenario drifting is caught rather than averaged
 * away — which is the whole reason for having scenarios at all.
 *
 * `duplicateRate` is one-sided: any increase is a regression, and the direction
 * field records that so the gate does not have to hardcode per-metric rules.
 */
export const GATE_TOLERANCE = {
  /** Absolute drop tolerated on precision, recall, MRR, nDCG, token efficiency. */
  quality: 0.005,
  /** Absolute rise tolerated on the duplicate rate. */
  duplicateRate: 0.001,
  /**
   * Per-scenario tolerance. The benchmark is fully deterministic — fixed clock, no
   * provider, no network, no wall-clock input to the quality metrics — so there is
   * nothing to absorb here, and a scenario that moves has genuinely moved.
   */
  perScenario: 0.001,
} as const;

/**
 * Latency is judged on its own terms and only when the benchmark runs alone.
 *
 * Two bounds, because one is not enough. The *relative* bound catches a real
 * slowdown against a committed baseline, and is deliberately loose (2.5x) because
 * that baseline was measured on a different machine from yours. The *absolute*
 * ceiling catches the pathological case — a lost index, an accidental O(n^2) —
 * which no amount of machine variation could explain away.
 *
 * A p95 wall-clock assertion inside `npm test` would be worse than useless: the
 * suite runs files in parallel under load, so the number it measured would be
 * about scheduling rather than about retrieval. `src/test/benchmark-gate.test.ts`
 * therefore checks quality only, and `scripts/benchmark-gate.mjs` checks this too.
 */
export const GATE_LATENCY = {
  /** Current p95 must not exceed the baseline's by more than this factor. */
  relativeFactor: 2.5,
  /** ...nor exceed this, whatever the baseline says. */
  absoluteCeilingMs: 1000,
} as const;

export interface BenchmarkBaseline {
  /** Recorded so a baseline from a different set is rejected rather than compared. */
  corpus: number;
  scenarios: number;
  k: number;
  /** Guard against comparing against a baseline whose scenario list has moved. */
  scenarioIds: string[];
  aggregate: EvalResult["aggregate"];
  perScenario: Array<{ id: string; mrr: number; ndcg_at_k: number }>;
}

export interface GateFinding {
  scope: string;
  metric: string;
  baseline: number;
  current: number;
  detail: string;
}

export interface GateReport {
  ok: boolean;
  /** Regressions beyond tolerance. Any entry means the gate fails. */
  regressions: GateFinding[];
  /**
   * Movement in the improving direction. Not a failure — the change is good — but
   * reported so the baseline is updated deliberately rather than left stale.
   */
  improvements: GateFinding[];
  /** The measured values, so a report can be reproduced from a failing run. */
  current: BenchmarkBaseline;
}

/** Format a number for a gate message: enough digits to act on, few enough to read. */
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(4));

/**
 * Compare a measured run against a baseline.
 *
 * `includeLatency` exists because the two callers differ: the test runs inside a
 * loaded suite and must not assert wall-clock numbers it cannot control, and the
 * release gate runs alone and must. Both call this, so the two can never disagree
 * about what counts as a regression.
 */
export function compareToBaseline(
  baseline: BenchmarkBaseline,
  current: BenchmarkBaseline,
  options: { includeLatency?: boolean } = {},
): GateReport {
  const regressions: GateFinding[] = [];
  const improvements: GateFinding[] = [];

  // The baseline and the code must be describing the same benchmark, or every
  // number below is a comparison between two different questions.
  if (baseline.corpus !== current.corpus || baseline.k !== current.k || baseline.scenarios !== current.scenarios) {
    return {
      ok: false,
      regressions: [
        {
          scope: "benchmark",
          metric: "shape",
          baseline: baseline.corpus,
          current: current.corpus,
          detail:
            `the benchmark changed shape: baseline was ${baseline.corpus} documents over k=${baseline.k} ` +
            `with ${baseline.scenarios} scenarios, this run has ${current.corpus} over k=${current.k} ` +
            `with ${current.scenarios}. Re-record the baseline deliberately (\`npm run bench:gate -- --update\`).`,
        },
      ],
      improvements: [],
      current,
    };
  }
  const missing = baseline.scenarioIds.filter((id) => !current.scenarioIds.includes(id));
  const added = current.scenarioIds.filter((id) => !baseline.scenarioIds.includes(id));
  if (missing.length > 0 || added.length > 0) {
    return {
      ok: false,
      regressions: [
        {
          scope: "benchmark",
          metric: "scenarios",
          baseline: baseline.scenarioIds.length,
          current: current.scenarioIds.length,
          detail:
            `the scenario list changed (missing: ${missing.join(", ") || "none"}; ` +
            `added: ${added.join(", ") || "none"}). Re-record the baseline deliberately.`,
        },
      ],
      improvements: [],
      current,
    };
  }

  for (const metric of GATED_METRICS) {
    const tolerance = metric.key === "duplicate_rate" ? GATE_TOLERANCE.duplicateRate : GATE_TOLERANCE.quality;
    const was = baseline.aggregate[metric.key] as number;
    const now = current.aggregate[metric.key] as number;
    const delta = now - was;
    if (metric.worse === "down" && delta < -tolerance) {
      regressions.push({
        scope: "aggregate",
        metric: metric.label,
        baseline: was,
        current: now,
        detail: `${metric.label} fell from ${fmt(was)} to ${fmt(now)} (tolerance ${tolerance})`,
      });
    } else if (metric.worse === "down" && delta > tolerance) {
      improvements.push({
        scope: "aggregate",
        metric: metric.label,
        baseline: was,
        current: now,
        detail: `${metric.label} rose from ${fmt(was)} to ${fmt(now)}`,
      });
    } else if (metric.worse === "up" && delta > tolerance) {
      regressions.push({
        scope: "aggregate",
        metric: metric.label,
        baseline: was,
        current: now,
        detail: `${metric.label} rose from ${fmt(was)} to ${fmt(now)} (tolerance ${tolerance})`,
      });
    } else if (metric.worse === "up" && delta < -tolerance) {
      improvements.push({
        scope: "aggregate",
        metric: metric.label,
        baseline: was,
        current: now,
        detail: `${metric.label} fell from ${fmt(was)} to ${fmt(now)}`,
      });
    }
  }

  // Per-scenario, so a failure names the behaviour that broke rather than
  // reporting one averaged number and leaving the search for the cause.
  const wasById = new Map(baseline.perScenario.map((s) => [s.id, s]));
  for (const now of current.perScenario) {
    const was = wasById.get(now.id);
    if (!was) continue;
    for (const [key, label] of [["mrr", "MRR"], ["ndcg_at_k", "nDCG@k"]] as const) {
      const delta = (now[key] as number) - (was[key] as number);
      if (delta < -GATE_TOLERANCE.perScenario) {
        regressions.push({
          scope: `scenario ${now.id}`,
          metric: label,
          baseline: was[key] as number,
          current: now[key] as number,
          detail: `${label} for "${now.id}" fell from ${fmt(was[key] as number)} to ${fmt(now[key] as number)}`,
        });
      } else if (delta > GATE_TOLERANCE.perScenario) {
        improvements.push({
          scope: `scenario ${now.id}`,
          metric: label,
          baseline: was[key] as number,
          current: now[key] as number,
          detail: `${label} for "${now.id}" rose from ${fmt(was[key] as number)} to ${fmt(now[key] as number)}`,
        });
      }
    }
  }

  if (options.includeLatency) {
    for (const metric of GATED_LATENCY) {
      const was = baseline.aggregate[metric.key];
      const now = current.aggregate[metric.key];
      const ceiling = Math.max(baseline.aggregate.p95_latency_ms * GATE_LATENCY.relativeFactor, GATE_LATENCY.absoluteCeilingMs);
      if (now > ceiling) {
        regressions.push({
          scope: "aggregate",
          metric: metric.label,
          baseline: was,
          current: now,
          detail:
            `${metric.label} is ${fmt(now)}ms, over the ${fmt(ceiling)}ms ceiling ` +
            `(baseline ${fmt(was)}ms x${GATE_LATENCY.relativeFactor}, or the ${GATE_LATENCY.absoluteCeilingMs}ms floor)`,
        });
      }
    }
  }

  return { ok: regressions.length === 0, regressions, improvements, current };
}

/** Shape a measured run into the comparable form. */
export function toBaseline(run: BenchmarkRun): BenchmarkBaseline {
  return {
    corpus: BENCHMARK_CORPUS.length,
    scenarios: BENCHMARK_SCENARIOS.length,
    k: GATE_K,
    scenarioIds: BENCHMARK_SCENARIOS.map((s) => s.id),
    aggregate: run.result.aggregate,
    perScenario: run.result.queries.map((q) => ({ id: q.id, mrr: q.mrr, ndcg_at_k: q.ndcg_at_k })),
  };
}
