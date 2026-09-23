import { Memory, SearchQuery } from "./types.js";

/**
 * Layered retrieval (decision from Q4):
 *   1. Roles always pass (they are instructions).
 *   2. Scope match (global + current scope beat other scopes).
 *   3. Importance, recency, and keyword overlap contribute to the score.
 *
 * Embeddings can replace the keyword part later without changing callers.
 */
export function search(memories: Memory[], q: SearchQuery): Memory[] {
  const now = Date.now();
  const terms = (q.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const scored = memories
    .filter((m) => (q.type ? m.type === q.type : true))
    .map((m) => ({ m, score: score(m, terms, q.scope, now) }))
    .filter(({ m, score }) => m.type === "role" || score > 0)
    .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt));

  return scored.slice(0, q.limit ?? 10).map(({ m }) => m);
}

function score(m: Memory, terms: string[], scope: string | undefined, now: number): number {
  let s = 0;

  if (m.type === "role") s += 1000;
  if (m.scope === "global") s += 100;
  if (scope && m.scope === scope) s += 150;
  if (scope && m.scope !== scope && m.scope !== "global") return 0; // other projects' memories don't leak in

  s += m.importance * 10;

  // Recency: half-life of ~30 days.
  const ageDays = (now - Date.parse(m.updatedAt)) / 86_400_000;
  if (!Number.isNaN(ageDays)) s += Math.max(0, 20 - ageDays / 3);

  // Keyword overlap over content + tags.
  if (terms.length > 0) {
    const hay = (m.content + " " + m.tags.join(" ")).toLowerCase();
    let hits = 0;
    for (const t of terms) if (hay.includes(t)) hits++;
    s += (hits / terms.length) * 60;
  } else {
    s += 10; // no query: everything eligible scores a little
  }

  return s;
}
