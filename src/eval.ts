/**
 * Retrieval evaluation harness (V4.6.0, plan §9).
 *
 * Computes standard IR metrics: Precision@K, Recall@K, MRR, NDCG@K,
 * Hit Rate@K, and latency percentiles. Designed for benchmark regression
 * testing — run against a corpus, compare scores over time.
 */

import { Memory } from "./types.js";

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
  };
}

export interface EvaluateOpts {
  k: number;
  queries: EvalQuery[];
  searchFn: (query: string) => Promise<Memory[]>;
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export async function evaluate(opts: EvaluateOpts): Promise<EvalResult> {
  const perQuery: EvalResult["queries"] = [];
  const latencies: number[] = [];

  for (const q of opts.queries) {
    const t0 = performance.now();
    const results = await opts.searchFn(q.text);
    latencies.push(performance.now() - t0);

    const relSet = new Set(q.relevantIds);
    const irrSet = new Set(q.irrelevantIds ?? []);
    const m = computeQueryMetrics(results.map((m) => m.id), relSet, irrSet, opts.k);

    perQuery.push({
      id: q.id,
      ...m,
      latency_ms: Math.round((performance.now() - t0) * 10) / 10,
      top_ids: results.slice(0, opts.k).map((m) => m.id),
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
    },
  };
}
