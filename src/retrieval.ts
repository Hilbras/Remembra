import { Memory, SearchQuery, TrustLevel } from "./types.js";
import { cosine } from "./embeddings.js";

/** Additive trust weights (plan §4.5 / 4.1.0-Q3). `unverified` sinks but stays findable. */
export const TRUST_POINTS: Record<TrustLevel, number> = {
  system: 8,
  verified: 6,
  trusted: 2,
  unverified: -8,
};

/** Role/instruction allowed to steer responses — trust ≥ trusted (plan §4.9). */
function isStandingInstruction(m: Memory): boolean {
  return (m.type === "role" || m.type === "instruction") && m.trust !== "unverified";
}

/**
 * Layered retrieval (decisions Q4 + v2-Q3, Phase 4 quality pass, plan §4.5):
 *
 * Hard gates (never bypassed by scores):
 *   - standing instructions (role + instruction) at trust ≥ trusted always
 *     pass (+1000); unverified ones (digest-extracted, not yet approved —
 *     plan §4.9) rank like ordinary memories instead
 *   - foreign-scope memories are excluded entirely (isolation beats
 *     instructions)
 *
 * Ranking (additive terms are identical in keyword and semantic mode so a
 * memory ranks consistently whether embeddings are on or off — audit #2):
 *   - provenance: manual stores +10 over everything else (#4)
 *   - trust: additive layer — system +8, verified +6, trusted +2, unverified
 *     −8 (4.1.0-Q3; retunable in 4.2.0's retrieval engine)
 *   - retention: pinned +50 (plan §4.8 — pins surface near the top)
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
    // score() already gates roles too: an in-scope role scores ≥1000 while a
    // foreign-scope role scores 0. Re-including roles here (the old
    // `m.type === "role" ||` clause) leaked other projects' role instructions
    // into every search — Phase 6 isolation property caught it.
    .filter(({ score }) => score > 0)
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
  if (isStandingInstruction(m)) s += 1000; // §4.9: unverified instructions never gate
  if (scope && m.scope !== scope && m.scope !== "global") return 0; // no cross-project leaks

  if (m.scope === "global") s += 100;
  if (scope && m.scope === scope) s += 150;

  // --- provenance (Phase 4 / audit #4): deliberate stores beat auto-extracts ---
  if (m.provenance?.sourceType === "manual") s += 10;

  // --- trust layer (plan §4.5 / 4.1.0-Q3): additive, retunable in 4.2.0 ---
  s += TRUST_POINTS[m.trust];

  // --- retention (plan §4.8): pinned surfaces near the top regardless of age ---
  if (m.retention === "pinned") s += 50;

  // --- semantic mode (embeddings on) ---
  if (queryVec && queryVec.length > 0) {
    if (m.embedding && m.embedding.length > 0) {
      // Primary signal: cosine similarity (0..1 → up to +100).
      const sim = Math.max(0, cosine(queryVec, m.embedding));
      s += sim * 100;
      // Similarity gate: near-zero matches only survive on role/scope strength.
      if (sim < 0.05 && !isStandingInstruction(m) && m.scope !== "global" && scope !== m.scope) return 0;
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
