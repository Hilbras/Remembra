import { Memory, SearchQuery, SearchResults, RetrievalExplanation, TrustLevel, MemoryType } from "./types.js";
import { cosine } from "./embeddings.js";
import { logEvent } from "./log.js";

// ---------------------------------------------------------------------------
// V4.2.0: Advanced Retrieval Engine (plan §5). Multi-stage pipeline with
// keyword + vector signals fused via Reciprocal Rank Fusion, standing-
// instruction gate, pluggable reranker, lightweight MMR diversity, and
// optional per-memory explanation output.
// ---------------------------------------------------------------------------

/** Additive trust weights (plan §4.5 / 4.1.0-Q3). `unverified` sinks but stays findable. */
export const TRUST_POINTS: Record<TrustLevel, number> = {
  system: 8,
  verified: 6,
  trusted: 2,
  unverified: -8,
};

/** Roles/instructions allowed to steer responses — trust ≥ trusted (§4.9). */
function isStandingInstruction(m: Memory, requireTrust = true): boolean {
  return (m.type === "role" || m.type === "instruction") && (!requireTrust || m.trust !== "unverified");
}

export interface RetrievalPolicyOptions {
  /** Require trusted/verified/system trust for standing-instruction promotion. */
  requireRoleTrust?: boolean;
  /** Apply bounded MMR diversity when a query vector is available. */
  diversity?: boolean;
  /** Reserved for a future non-identity reranker; preserved in the policy contract. */
  reranking?: boolean;
}

// =============================================================================
//  [1] Normalize + temporal extraction
// =============================================================================

const TEMPORAL_RE =
  /^(?:latest(?:\s+(\d+))|recent(?:\s+(\d+))|before\s+(.+)|after\s+(.+))$/i;

/** Parse a query string into structured terms + temporal qualifiers. */
export function extractQuery(raw: string | undefined): {
  terms: string[];
  temporal: {
    latestCount?: number;
    recentCount?: number;
    beforeMs?: number | null;
    afterMs?: number | null;
  };
} {
  const q = (raw ?? "").trim();
  if (!q) return { terms: [], temporal: {} };
  // Check for a leading temporal qualifier first.
  const tempMatch = q.match(TEMPORAL_RE);
  const temporal = tempMatch
    ? {
        ...(tempMatch[1] ? { latestCount: Number(tempMatch[1]) } : {}),
        ...(tempMatch[2] ? { recentCount: Number(tempMatch[2]) } : {}),
        ...(tempMatch[3]
          ? { beforeMs: parseDateToken(tempMatch[3].trim()) }
          : {}),
        ...(tempMatch[4]
          ? { afterMs: parseDateToken(tempMatch[4].trim()) }
          : {}),
      }
    : {};
  // The remainder after the qualifier (if any) provides the keyword terms.
  const body = tempMatch ? q.slice(tempMatch[0].length).trim() : q;
  const terms = body
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && /^[a-z0-9]+$/u.test(t));
  return { terms, temporal };
}

function parseDateToken(tok: string): number | null {
  // "today", "yesterday", "last week", bare ISO date, "+ N d/y/w", "- N d/y/w"
  const now = Date.now();
  const dayMs = 86_400_000;
  const weekMs = dayMs * 7;
  const yearMs = dayMs * 365;
  if (/^today$/i.test(tok)) return now;
  if (/^yesterday$/i.test(tok)) return now - dayMs;
  const n = Number(tok);
  if (!Number.isNaN(n) && tok.match(/^[+\-]?\d+(\sd|sw|sy)$/i)) {
    const [, num, unit] = tok.toLowerCase().match(/^([+\-]?\d+)\s*([dwy])$/) ?? [];
    const mult = unit === "d" ? dayMs : unit === "w" ? weekMs : yearMs;
    return now + n * mult;
  }
  const iso = Date.parse(tok);
  if (Number.isFinite(iso)) return iso;
  return null;
}

// =============================================================================
//  [2] Hard filters (scope isolation)
// =============================================================================

/**
 * Returns `0` (ineligible) for foreign-scope memories; otherwise the base
 * scope bonus used by scoring. Mirrors the pre-4.2 filter exactly.
 */
export function applyScopeFilter(
  m: Memory,
  queryScope: string | undefined,
): 0 | 100 | 150 {
  if (queryScope && m.scope !== queryScope && m.scope !== "global") return 0;
  if (m.scope === "global") return 100;
  if (queryScope && m.scope === queryScope) return 150;
  return 100;
}

// =============================================================================
//  [4] Keyword scoring — BM25-lite (TF-IDF heuristic clamped to [0, 60])
// =============================================================================

/**
 * BM25-lite term overlap: tf·idf-style score, identical ceiling (60) to the
 * v4.1.x keyword heuristic so regression tests remain satisfied.
 */
export function keywordScore(m: Memory, terms: string[], totalDocs: number): number {
  if (terms.length === 0) return 0;
  const hay = (m.content + " " + m.tags.join(" ")).toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  const tfRatio = hits / terms.length;
  // Simple idf proxy: rarer terms score higher.
  const idf = Math.log(1 + totalDocs / Math.max(1, hits));
  return Math.min(60, tfRatio * 60 * (0.5 + 0.5 * Math.min(1, idf)));
}

// =============================================================================
//  [5] Vector scoring — cosine similarity scaled to [0, 100]
// =============================================================================

export function vectorScore(m: Memory, queryVec: number[]): number {
  if (!m.embedding || m.embedding.length === 0) return 0;
  if (m.embedding.length !== queryVec.length) return 0;
  const sim = Math.max(0, cosine(queryVec, m.embedding));
  return sim * 100;
}

// =============================================================================
//  [6] Reciprocal Rank Fusion
// =============================================================================

const RRF_K = 1.6; // standard RRF constant (rec.combined/)

/**
 * Fuse two ranked lists (keyword, vector) via Reciprocal Rank Fusion.
 * Tied scores receive the same (average) rank so positional bias doesn't
 * compete with later modifier layers.
 */
export function rrfFuse(
  kwRank: ReadonlyArray<{ id: string; score: number }>,
  vecRank: ReadonlyArray<{ id: string; score: number }>,
): Map<string, number> {
  const fuse = new Map<string, number>();
  const addList = (list: ReadonlyArray<{ id: string; score: number }>) => {
    let i = 0;
    while (i < list.length) {
      let j = i + 1;
      while (j < list.length && list[j].score === list[i].score) j++;
      // Average 1-indexed rank for items i..j-1 (handles ties fairly).
      const avgRank = (i + 1 + j) / 2;
      for (let k = i; k < j; k++) {
        const key = list[k].id;
        fuse.set(key, (fuse.get(key) ?? 0) + 1 / (RRF_K + avgRank));
      }
      i = j;
    }
  };
  addList(kwRank);
  addList(vecRank);
  return fuse;
}

// =============================================================================
//  [7] Ranking modifiers (additive, post-fusion)
// =============================================================================

/**
 * Exponential recency decay (audit #20): ~30-day half-life, never a hard
 * cutoff — a 60-day-old memory keeps ~5 points instead of dropping to 0.
 */
export function recencyScore(m: Memory, now: number): number {
  const ageDays = (now - Date.parse(m.updatedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0;
  const age = Math.max(0, ageDays);
  return 20 * Math.pow(2, -age / 30);
}

export function modifierScore(
  m: Memory,
  temporalOverride: { latestCount?: number; recentCount?: number },
  now: number,
): number {
  let s = 0;
  // Provenance: deliberate manual stores beat auto-extracts (audit #4).
  if (m.provenance?.sourceType === "manual") s += 10;
  // Trust layer (plan §4.5 / 4.1.0-Q3): additive, retunable.
  s += TRUST_POINTS[m.trust];
  // Retention: pinned surfaces near the top regardless of age (plan §4.8).
  if (m.retention === "pinned") s += 50;
  // Importance (both modes): multiplicative boost.
  s += m.importance * 4;
  // Confidence (V4.2.0 — integrate now per user decision): direct signal.
  s += (m.confidence ?? 1) * 20;
  // Recency (modulated by temporal qualifiers).
  if (temporalOverride.latestCount !== undefined || temporalOverride.recentCount !== undefined) {
    // Temporal mode boosts recent heavily; use a linear factor based on rank.
    s += recencyScore(m, now) * 2;
  } else {
    s += recencyScore(m, now) * 0.5;
  }
  return s;
}

// =============================================================================
//  [8] Standing-instruction absolute gate
// =============================================================================

/** Apply the +1000 standing-instruction gate (unchanged from v4.1 semantics). */
export function applyStandingGate(score: number, m: Memory, requireTrust = true): number {
  if (isStandingInstruction(m, requireTrust)) return score + 1000;
  return score;
}

// =============================================================================
//  [9] Reranker abstraction
// =============================================================================

export interface Reranker {
  rerank(
    query: string,
    candidates: Memory[],
    queryVec: number[] | null,
  ): Promise<Memory[]>;
}

/** Identity reranker — returns candidates in current pipeline order. */
export const identityReranker: Reranker = {
  rerank: (_q, candidates) => Promise.resolve(candidates),
};

/**
 * Embedding-based re-reranker: re-scores candidates against the query embedding
 * (when available), breaking ties among equally-fused items by cosine relevance.
 * Falls back to identity when no query vector is present.
 */
export class EmbedReranker implements Reranker {
  async rerank(_q: string, candidates: Memory[], queryVec: number[] | null): Promise<Memory[]> {
    if (!queryVec || queryVec.length === 0) return candidates;
    return [...candidates].sort((a, b) => {
      const va = a.embedding && a.embedding.length === queryVec.length
        ? cosine(queryVec, a.embedding)
        : -1;
      const vb = b.embedding && b.embedding.length === queryVec.length
        ? cosine(queryVec, b.embedding)
        : -1;
      return vb - va;
    });
  }
}

// =============================================================================
//  [10] MMR diversity (lightweight)
// =============================================================================

/**
 * Maximal Marginal Relevance pass — given scored candidates, iteratively pick
 * the item whose max-relevance-to-selected − λ·avg-self-sim is greatest
 * (λ = 0.5). Skips items without an embedding (self-sim treated as 0).
 */
export function mmrDedup(
  candidates: Memory[],
  queryVec: number[] | null,
  limit: number,
  lambda = 0.5,
): Memory[] {
  if (candidates.length <= limit || !queryVec || queryVec.length === 0)
    return candidates.slice(0, limit);
  const selected: Memory[] = [];
  const queue = [...candidates];
  while (selected.length < limit && queue.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < queue.length; i++) {
      const m = queue[i];
      if (!m.embedding || m.embedding.length !== queryVec.length) {
        // No embedding → self-sim = 0; relevance to selected candidates also 0.
        const val = 0 - lambda * 0;
        if (val > bestVal) {
          bestVal = val;
          bestIdx = i;
        }
        continue;
      }
      let maxRel = 0;
      let avgSelf = 0;
      for (const s of selected) {
        if (s.embedding && s.embedding.length === queryVec.length) {
          const rel = cosine(queryVec, s.embedding);
          maxRel = Math.max(maxRel, rel);
          avgSelf += cosine(m.embedding, s.embedding);
        }
      }
      if (selected.length > 0) avgSelf /= selected.length;
      const val = maxRel - lambda * avgSelf;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    selected.push(queue.splice(bestIdx, 1)[0]);
  }
  return selected;
}

// =============================================================================
//  [11] Explanation builder
// =============================================================================

function buildExplanation(
  m: Memory,
  components: Record<string, number>,
  reasons: string[],
): RetrievalExplanation {
  const totalScore = Object.values(components).reduce((a, b) => a + b, 0);
  return { id: m.id, components, totalScore, reasons };
}

// =============================================================================
//  Main pipeline entry
// =============================================================================

/**
 * Full staged retrieval pipeline (V4.2.0). Returns both ranked results and
 * — when `explain: true` — per-memory explanations.
 *
 * @param memories   Full (in-scope, non-archived) memory collection to rank.
 * @param q          Search query (may include `explain`).
 * @param queryVec   Pre-computed embedding of the query text (null for keyword mode).
 */
export function searchQ(
  memories: Memory[],
  q: SearchQuery,
  queryVec: number[] | null = null,
  policy: RetrievalPolicyOptions = {},
): SearchResults {
  const now = Date.now();
  const requireRoleTrust = policy.requireRoleTrust ?? true;
  const diversity = policy.diversity ?? true;
  const { terms, temporal } = extractQuery(q.query);
  const effectiveLimit = q.limit ?? 10;
  const explain = q.explain ?? false;

  // Step 2: filter + compute per-mem keyword / vector component scores.
  type ScoredEntry = {
    m: Memory;
    kwScore: number;
    vecScore: number;
    scopeScore: 0 | 100 | 150;
    reasons: string[];
  };
  const scored: ScoredEntry[] = [];
  for (const m of memories) {
    // Scope gate (step 2): foreign scope = drop immediately.
    const scopeScore = applyScopeFilter(m, q.scope);
    if (scopeScore === 0) continue;
    const reasons: string[] = ["scope_match"];
    if (m.scope === "global") reasons.push("global");
    if (q.scope && m.scope === q.scope) reasons.push("scope_exact");
    const kwScore = keywordScore(m, terms, q.totalDocs ?? memories.length);
    if (kwScore > 0) reasons.push("keyword_hit");
    const vecScore = queryVec ? vectorScore(m, queryVec) : 0;
    if (vecScore > 0) reasons.push("semantic_hit");
    if (vecScore > 0 && vecScore < 5 && !isStandingInstruction(m, requireRoleTrust) && m.scope !== "global" && !(q.scope && m.scope === q.scope)) {
      // Near-zero similarity gate for scoped memories without scope strength.
      continue;
    }
    scored.push({ m, kwScore, vecScore, scopeScore, reasons });
  }

  // Step 3: candidate generation (pre-seeded override, plan §5.7 deferred — hook here for future).
  if (q.candidates && q.candidates.length > 0) {
    const candidateIds = new Set(q.candidates);
    // Keep only scored entries that match the seed list.
    // (If none match, fall through with the full set — graceful degradation.)
    const remaining = scored.filter((e) => candidateIds.has(e.m.id));
    if (remaining.length > 0) scored.length = 0;
    scored.push(...remaining);
  }

  // Steps 4–6: keyword list, vector list, RRF fusion.
  // Only items with a real signal (score > 0) participate in RRF; pure-modifier
  // items keep their fused score of 0 and rank on modifiers alone. This avoids
  // input-order bias when all keyword / vector scores happen to be zero.
  const kwRanked = scored
    .filter((e) => e.kwScore > 0)
    .map((e) => ({ id: e.m.id, score: e.kwScore }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const vecRanked = scored
    .filter((e) => e.vecScore > 0)
    .map((e) => ({ id: e.m.id, score: e.vecScore }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // Short-circuit RRF when only one signal is present — no fusion needed.
  const singleListRanks = (list: ReadonlyArray<{ id: string; score: number }>) => {
    // Same average-rank logic as rrfFuse but for a single list.
    const out = new Map<string, number>();
    let i = 0;
    while (i < list.length) {
      let j = i + 1;
      while (j < list.length && list[j].score === list[i].score) j++;
      const avgRank = (i + 1 + j) / 2;
      for (let k = i; k < j; k++) out.set(list[k].id, 1 / (RRF_K + avgRank));
      i = j;
    }
    return out;
  };
  const fuseScores =
    kwRanked.length === 0
      ? singleListRanks(vecRanked)
      : vecRanked.length === 0
        ? singleListRanks(kwRanked)
        : rrfFuse(kwRanked, vecRanked);

  // Step 7: modifiers on top of RRF.
  type Merged = { m: Memory; fuse: number; mod: number; final: number; comp: Record<string, number>; reasons: string[] };
  const merged: Merged[] = scored.map((e) => {
    const fuse = fuseScores.get(e.m.id) ?? 0;
    const mod = modifierScore(e.m, temporal, now);
    const finalScore = (fuse * 50) + mod + e.scopeScore;
    const comp: Record<string, number> = {
      scope: e.scopeScore,
      fusion: Math.round(fuse * 50 * 100) / 100,
      modifiers: mod,
    };
    if (e.kwScore > 0) comp.keyword = e.kwScore;
    if (e.vecScore > 0) comp.semantic = e.vecScore;
    return { m: e.m, fuse, mod, final: finalScore, comp, reasons: e.reasons };
  });

  // Step 8: standing-instruction gate (+1000 absolute).
  const gated = merged.map((e) => ({
    ...e,
    final: applyStandingGate(e.final, e.m, requireRoleTrust),
    comp: { ...e.comp, ...(isStandingInstruction(e.m, requireRoleTrust) ? { standing_gate: 1000 } : {}) },
    reasons: [...e.reasons, ...(isStandingInstruction(e.m, requireRoleTrust) ? ["role_gate"] : [])],
  }));

  // Sort by final score desc, then updatedAt desc, then id for determinism.
  gated.sort((a, b) => b.final - a.final || b.m.updatedAt.localeCompare(a.m.updatedAt) || a.m.id.localeCompare(b.m.id));

  // Step 9: reranker hook point — identity is the default. The EmbedReranker
  // and full Reranker interface are exported for callers that wish to compose
  // a custom pass, but the pipeline itself preserves the fused ranking order.
  let ranked = gated.map((e) => e.m);
  if (policy.reranking && queryVec && queryVec.length > 0) {
    ranked = rerankWithEmbed(queryVec, ranked);
  }

  // Step 10: MMR diversity (semantic mode with multiple vectors).
  // Cap the MMR candidate pool to `limit * 10` (min 100) to keep the
  // O(K·pool) loop bounded — full N-scan is prohibitively expensive at
  // audit scale (10K memories × 768-dim vectors).
  let finalRanked: Memory[];
  if (diversity && queryVec && queryVec.length > 0 && ranked.length > 1) {
    const mmrCap = Math.max(effectiveLimit * 10, 100);
    finalRanked = mmrDedup(ranked.slice(0, mmrCap), queryVec, effectiveLimit);
  } else {
    finalRanked = ranked.slice(0, effectiveLimit);
  }

  // Step 11: explanations (optional, off by default).
  const explanations = explain
    ? gated
        .filter((e) => finalRanked.some((m) => m.id === e.m.id))
        .map((e) =>
          buildExplanation(e.m, e.comp, e.reasons),
        )
    : undefined;

  // V4.6: structured debug trace (emit only when REMEMBRA_DEBUG_RETRIEVAL=1).
  if (process.env.REMEMBRA_DEBUG_RETRIEVAL === "1") {
    const pipeline = {
      normalize: { terms, temporal },
      candidate_generation: { total: scored.length },
      keyword_scoring: scored.filter((e) => e.kwScore > 0).slice(0, 5).map((e) => ({ id: e.m.id, score: e.kwScore })),
      vector_scoring: scored.filter((e) => e.vecScore > 0).slice(0, 5).map((e) => ({ id: e.m.id, score: e.vecScore })),
      rrf_fusion: { method: "reciprocal_rank", k: 60 },
      ranking_modifiers: { recency_boost: true, importance_boost: true, aging_penalty: process.env.REMEMBRA_AGING_BOOST ?? "-50" },
      standing_instruction_gate: { skipped: [], promoted: gated.filter((e) => isStandingInstruction(e.m, requireRoleTrust)).map((e) => e.m.id) },
      mmr_diversity: { lambda: 0.5, removed_duplicates: ranked.length - finalRanked.length },
      final_context_selection: { max_tokens: 4000, memories_selected: finalRanked.length },
    };
    logEvent("debug", "retrieval.debug", { query: q.query, pipeline, latency_ms: Date.now() - now }, "Remembra: retrieval debug trace");
  }

  return { results: finalRanked, explanations };
}

/**
 * Lightweight reranker helper: when the embed reranker is active, re-order
 * by embedding cosine without rebuilding the full pipeline. Returns a new array.
 */
function rerankWithEmbed(
  queryVec: number[],
  ranked: Memory[],
): Memory[] {
  return [...ranked].sort((a, b) => {
    const va = a.embedding && a.embedding.length === queryVec.length
      ? cosine(queryVec, a.embedding)
      : -1;
    const vb = b.embedding && b.embedding.length === queryVec.length
      ? cosine(queryVec, b.embedding)
      : -1;
    return vb - va;
  });
}

/**
 * Legacy single-memory scorer (kept for phase4.test.ts regression harness).
 * Same semantics as v4.1.x: hard gates first, then additive modifiers.
 */
export function score(
  m: Memory,
  terms: string[],
  scope: string | undefined,
  now: number,
  queryVec?: number[] | null,
): number {
  let s = 0;
  // --- hard gates ---
  if (isStandingInstruction(m)) s += 1000;
  if (scope && m.scope !== scope && m.scope !== "global") return 0;
  if (m.scope === "global") s += 100;
  if (scope && m.scope === scope) s += 150;
  // --- provenance (audit #4): deliberate stores beat auto-extracts ---
  if (m.provenance?.sourceType === "manual") s += 10;
  // --- trust layer (plan §4.5 / 4.1.0-Q3) ---
  s += TRUST_POINTS[m.trust];
  // --- retention (plan §4.8): pinned surfaces near the top regardless of age ---
  if (m.retention === "pinned") s += 50;
  // --- semantic mode (embeddings on) ---
  if (queryVec && queryVec.length > 0) {
    if (m.embedding && m.embedding.length > 0) {
      const sim = Math.max(0, cosine(queryVec, m.embedding));
      s += sim * 100;
      if (sim < 0.05 && !isStandingInstruction(m) && m.scope !== "global" && scope !== m.scope) return 0;
    } else {
      s += keywordScoreV1(m, terms);
    }
    s += m.importance * 4;
    s += recencyScore(m, now) * 0.5;
    return s;
  }
  // --- keyword mode (v1 behavior) ---
  s += m.importance * 4;
  s += recencyScore(m, now);
  if (terms.length > 0) s += keywordScoreV1(m, terms);
  else s += 10;
  return s;
}

/** v1 keyword scoring (unchanged from 4.1.x for regression parity). */
function keywordScoreV1(m: Memory, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = (m.content + " " + m.tags.join(" ")).toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return (hits / terms.length) * 60;
}

// =============================================================================
//  Backward-compat wrapper: search() delegates to searchQ() with explain:false
// =============================================================================

/**
 * Legacy search entry point (kept for backward compatibility). Delegates to
 * `searchQ` with `explain: false`.
 */
export function search(memories: Memory[], q: SearchQuery, queryVec?: number[] | null): Memory[] {
  return searchQ(memories, q, queryVec).results;
}
