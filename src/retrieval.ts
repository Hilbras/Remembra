import { Memory, SearchQuery } from "./types.js";
import { cosine } from "./embeddings.js";

/**
 * Layered retrieval (decisions Q4 + v2-Q3, Phase 4 quality pass):
 *
 * Hard gates (never bypassed by scores):
 *   - roles always pass (+1000)
 *   - other scopes' memories are excluded entirely
 *
 * Ranking (additive terms are identical in keyword and semantic mode so a
 * memory ranks consistently whether embeddings are on or off — audit #2):
 *   - provenance: deliberate `explicit` stores +10 over auto-extracted (#4)
 *   - importance: importance × 4 (both modes)
 *   - recency: exponential decay, ~30-day half-life, no cliff (#1)
 *   - keywords (keyword mode) / cosine similarity (semantic mode)
 */
export function search(memories: Memory[], q: SearchQuery, queryVec?: number[] | null): Memory[] {
  const now = Date.now();
  const terms = (q.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const scored = memories
    .filter((m) => (q.type ? m.type === q.type : true))
    .map((m) => ({ m, score: score(m, terms, q.scope, now, queryVec) }))
    .filter(({ m, score }) => m.type === "role" || score > 0)
    .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt));

  return scored.slice(0, q.limit ?? 10).map(({ m }) => m);
}

/** Scored exposed for tests — the full layered formula for one memory. */
export function score(
  m: Memory,
  terms: string[],
  scope: string | undefined,
  now: number,
  queryVec?: number[] | null,
): number {
  let s = 0;

  // --- hard gates ---
  if (m.type === "role") s += 1000;
  if (scope && m.scope !== scope && m.scope !== "global") return 0; // no cross-project leaks

  if (m.scope === "global") s += 100;
  if (scope && m.scope === scope) s += 150;

  // --- provenance (Phase 4 / audit #4): deliberate stores beat auto-extracts ---
  if (m.provenance === "explicit") s += 10;

  // --- semantic mode (embeddings on) ---
  if (queryVec && queryVec.length > 0) {
    if (m.embedding && m.embedding.length > 0) {
      // Primary signal: cosine similarity (0..1 → up to +100).
      const sim = Math.max(0, cosine(queryVec, m.embedding));
      s += sim * 100;
      // Similarity gate: near-zero matches only survive on role/scope strength.
      if (sim < 0.05 && m.type !== "role" && m.scope !== "global" && scope !== m.scope) return 0;
    } else {
      // Memory without a vector: fall back to keyword scoring for it.
      s += keywordScore(m, terms);
    }
    // Modifiers — same weights as keyword mode (normalized, audit #2).
    s += m.importance * 4;
    s += recencyScore(m, now) * 0.5;
    return s;
  }

  // --- keyword mode (embeddings off — v1 behavior) ---
  s += m.importance * 4;
  s += recencyScore(m, now);
  if (terms.length > 0) s += keywordScore(m, terms);
  else s += 10; // no query: everything eligible scores a little
  return s;
}

/**
 * Exponential recency decay (audit #20): ~30-day half-life, never a hard
 * cutoff — a 60-day-old memory keeps ~5 points instead of dropping to 0.
 */
export function recencyScore(m: Memory, now: number): number {
  const ageDays = (now - Date.parse(m.updatedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0;
  const age = Math.max(0, ageDays); // future-dated files count as fresh
  return 20 * Math.pow(2, -age / 30);
}

function keywordScore(m: Memory, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = (m.content + " " + m.tags.join(" ")).toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return (hits / terms.length) * 60;
}
