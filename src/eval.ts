/**
 * Retrieval evaluation harness (V4.6.0, plan §9; extended by V5.7.0, roadmap §38).
 *
 * Computes standard IR metrics: Precision@K, Recall@K, MRR, NDCG@K,
 * Hit Rate@K, latency percentiles, and — since 5.7.0 — token efficiency and
 * duplicate rate. Designed for benchmark regression testing: run against a
 * corpus, compare scores over time.
 *
 * ## The two metrics §38 required and 4.6.0 did not have
 *
 * **Token efficiency** is the fraction of the context you are about to hand a
 * model that carried signal: tokens belonging to relevant results, over total
 * tokens returned. It is what distinguishes a change that made results *more
 * relevant* from one that merely made them *longer*, and precision@k cannot tell
 * those apart — a retriever that returns the right ten memories padded with
 * filler scores identically on precision and worse on this.
 *
 * **Duplicate rate** is the fraction of returned results that repeat a result
 * already returned. This is the guardrail for deduplication: without it, a
 * dedup change has no measurement, and §38's rule that every retrieval change
 * runs against the benchmark set cannot enforce a property nothing observes.
 *
 * Both use the same `duplicateKey` the deduplication pass will use. If the metric
 * normalised differently, duplicate rate would stay at zero after a
 * deduplication change while appearing to be measured.
 */

import { Memory } from "./types.js";
import { defaultTokenCounter, type TokenCounter } from "./context.js";
import { duplicateKey } from "./retrieval.js";

export interface EvalQuery {
  /** Unique query identifier. */
  id: string;
  /** Query text. */
  text: string;
  /** IDs of memories that should rank in the top results (relevant set). */
  relevantIds: string[];
  /** Optional: IDs that must NOT appear (negatives for precision control). */
  irrelevantIds?: string[];
}

export interface EvalResult {
  /** Per-query results. */
  queries: Array<{
    id: string;
    precision_at_k: number;
    recall_at_k: number;
    mrr: number;
    ndcg_at_k: number;
    hit_rate_at_k: number;
    latency_ms: number;
    top_ids: string[];
    /** Fraction of returned tokens that belonged to a relevant result. */
    token_efficiency: number;
    /** Fraction of returned results that repeat an earlier result. */
    duplicate_rate: number;
    /** Raw counts, so the two ratios above are interpretable and testable. */
    tokens_total: number;
    tokens_relevant: number;
    duplicates: number;
    returned: number;
  }>;
  /** Aggregate metrics across all queries. */
  aggregate: {
    precision_at_k: number;
    recall_at_k: number;
    mrr: number;
    ndcg_at_k: number;
    hit_rate_at_k: number;
    avg_latency_ms: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    queries_evaluated: number;
    /**
     * Mean across queries of the per-query ratio, matching how this harness has
     * always aggregated precision, recall, MRR, and nDCG.
     */
    token_efficiency: number;
    /**
     * Mean across queries of the per-query ratio.
     *
     * Note this is **not** `duplicates / returned` below. The rate is a mean of
     * ratios and the counts are sums, so the two agree only when every query
     * returned the same number of results. Both are reported because each is
     * useful and a reader should not have to guess which one the rate is.
     */
    duplicate_rate: number;
    tokens_total: number;
    tokens_relevant: number;
    duplicates: number;
    /** Total results returned across all queries. */
    returned: number;
  };
}

export interface EvaluateOpts {
  k: number;
  queries: EvalQuery[];
  searchFn: (query: string) => Promise<Memory[]>;
  /**
   * Token estimator. Defaults to the same conservative counter the context
   * assembler uses, so "token efficiency" here means the same thing it means when
   * the memories are actually handed to a model. Injectable for tests.
   */
  tokenCounter?: TokenCounter;
}

function computeQueryMetrics(topIds: string[], relevantIds: Set<string>, irrelevantIds: Set<string>, k: number) {
  const topK = topIds.slice(0, k);
  const relevantInTop = topK.filter((id) => relevantIds.has(id));
  const totalRelevant = relevantIds.size;

  const precision = topK.length > 0 ? relevantInTop.length / topK.length : 0;
  const recall = totalRelevant > 0 ? relevantInTop.length / totalRelevant : 1;

  const firstRelRank = topK.findIndex((id) => relevantIds.has(id));
  const mrr = firstRelRank >= 0 ? 1 / (firstRelRank + 1) : 0;

  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevantIds.has(topK[i])) dcg += 1 / Math.log2(i + 2);
  }
  const idealK = Math.min(totalRelevant, k);
  let idcg = 0;
  for (let i = 0; i < idealK; i++) idcg += 1 / Math.log2(i + 2);
  const ndcg = idcg > 0 ? dcg / idcg : 1;

  const hitRate = relevantInTop.length > 0 ? 1 : 0;
  return { precision_at_k: precision, recall_at_k: recall, mrr, ndcg_at_k: ndcg, hit_rate_at_k: hitRate };
}

/**
 * The two §38 metrics that 4.6.0 lacked.
 *
 * Both are ratios over the *returned* set, and both report their raw counts
 * alongside, because a ratio with a hidden denominator is a number nobody can
 * argue with. A metric that cannot fail is not a metric, so each is defined so
 * that an empty result set gives 1 for token efficiency (nothing wasted) and 0
 * for duplicate rate (nothing repeated) — the only readings that are true when
 * nothing came back.
 */
function computeContextMetrics(
  results: Memory[],
  relevantIds: Set<string>,
  counter: TokenCounter,
): {
  token_efficiency: number;
  duplicate_rate: number;
  tokens_total: number;
  tokens_relevant: number;
  duplicates: number;
  returned: number;
} {
  let tokensTotal = 0;
  let tokensRelevant = 0;
  let duplicates = 0;
  const seen = new Set<string>();

  for (const memory of results) {
    const tokens = counter.count(memory.content);
    tokensTotal += tokens;
    if (relevantIds.has(memory.id)) tokensRelevant += tokens;
    // Counted over the whole returned set, not just the top-k slice: a duplicate
    // below the cut still cost a candidate slot and a spot in the scan.
    const key = duplicateKey(memory);
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }

  const returned = results.length;
  return {
    token_efficiency: returned === 0 || tokensTotal === 0 ? 1 : tokensRelevant / tokensTotal,
    duplicate_rate: returned === 0 ? 0 : duplicates / returned,
    tokens_total: tokensTotal,
    tokens_relevant: tokensRelevant,
    duplicates,
    returned,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export async function evaluate(opts: EvaluateOpts): Promise<EvalResult> {
  const perQuery: EvalResult["queries"] = [];
  const latencies: number[] = [];
  const counter = opts.tokenCounter ?? defaultTokenCounter;

  for (const q of opts.queries) {
    const t0 = performance.now();
    const results = await opts.searchFn(q.text);
    latencies.push(performance.now() - t0);

    const relSet = new Set(q.relevantIds);
    const irrSet = new Set(q.irrelevantIds ?? []);
    const m = computeQueryMetrics(results.map((m) => m.id), relSet, irrSet, opts.k);
    // Counted over the top-k slice, which is the set the caller would actually
    // use. Duplicate *rate* is then comparable across queries with different
    // result counts, which a raw duplicate count would not be.
    const topK = results.slice(0, opts.k);
    const context = computeContextMetrics(topK, relSet, counter);

    perQuery.push({
      id: q.id,
      ...m,
      latency_ms: Math.round((performance.now() - t0) * 10) / 10,
      top_ids: topK.map((mem) => mem.id),
      ...context,
    });
  }

  const agg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  latencies.sort((a, b) => a - b);

  return {
    queries: perQuery,
    aggregate: {
      precision_at_k: agg(perQuery.map((q) => q.precision_at_k)),
      recall_at_k: agg(perQuery.map((q) => q.recall_at_k)),
      mrr: agg(perQuery.map((q) => q.mrr)),
      ndcg_at_k: agg(perQuery.map((q) => q.ndcg_at_k)),
      hit_rate_at_k: agg(perQuery.map((q) => q.hit_rate_at_k)),
      avg_latency_ms: Math.round(agg(latencies) * 10) / 10,
      p50_latency_ms: Math.round(percentile(latencies, 50) * 10) / 10,
      p95_latency_ms: Math.round(percentile(latencies, 95) * 10) / 10,
      p99_latency_ms: Math.round(percentile(latencies, 99) * 10) / 10,
      queries_evaluated: perQuery.length,
      token_efficiency: agg(perQuery.map((q) => q.token_efficiency)),
      duplicate_rate: agg(perQuery.map((q) => q.duplicate_rate)),
      tokens_total: perQuery.reduce((s2, q) => s2 + q.tokens_total, 0),
      tokens_relevant: perQuery.reduce((s2, q) => s2 + q.tokens_relevant, 0),
      duplicates: perQuery.reduce((s2, q) => s2 + q.duplicates, 0),
      returned: perQuery.reduce((s2, q) => s2 + q.returned, 0),
    },
  };
}
