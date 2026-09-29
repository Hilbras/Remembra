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
  /** Expand only through already-authorized pool relations. */
  relationExpansion?: boolean;
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
/**
 * The key two memories share when they are the same text.
 *
 * This lives here rather than in the dedup pass because the evaluation metric and
 * the detector must use **one** function. If the metric normalises differently
 * from the detector, duplicate rate stays at zero after a deduplication change and
 * the guardrail silently measures nothing — which is worse than not having it.
 *
 * Normalisation is deliberately conservative, because the cost of a false
 * duplicate is a memory the user asked for and did not get:
 *   - case-folded, so "Deploy" and "deploy" are the same memory;
 *   - internal whitespace collapsed, so reflowing is not a new memory;
 *   - trailing punctuation stripped, so "deploy." and "deploy" are the same;
 *   - nothing else. Punctuation *inside* text is kept, tags are not folded in, and
 *     no stemming or synonym handling happens here, because each of those would
 *     merge genuinely different memories.
 */
export function duplicateKey(m: Memory): string {
  return m.content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "");
}

/** True when two memories carry the same text. Exact, not near. */
export function isExactDuplicate(a: Memory, b: Memory): boolean {
  return a.id !== b.id && duplicateKey(a) === duplicateKey(b);
}

/**
 * The provenance a memory was recorded from, for same-source grouping.
 *
 * `sourceType` alone is far too coarse — every hand-written memory is `manual`,
 * so grouping on it would collapse unrelated notes that happen to read the same.
 * The finer identifiers are included when present, so "the same agent in the same
 * run" and "the same conversation" are distinguishable from "some agent".
 */
function sourceKey(m: Memory): string {
  const p = m.provenance;
  return [p.sourceType, p.agentId ?? "", p.conversationId ?? "", p.sessionId ?? "", p.runId ?? ""].join("|");
}

export interface DedupOptions {
  /**
   * Collapse memories with identical text. On by default, because two records of
   * the same statement are one answer to a question, and returning both spends
   * context on a repeat.
   */
  exact?: boolean;
  /**
   * Additionally collapse identical text recorded from the *same* provenance.
   *
   * Off by default, and deliberately asymmetric: identical text from two different
   * sources is often two genuine memories — the same fact independently recorded by
   * a conversation and an agent is corroboration, not duplication. Collapsing it
   * would discard the second source, which is a worse error than showing a repeat.
   */
  sameSource?: boolean;
  /**
   * Maximum entries considered. The pass is O(n) over the ranked list, but a caller
   * asking for 10 results should not have 10,000 deduplicated to find them.
   */
  window?: number;
}

const DEFAULT_DEDUP_WINDOW = 200;

export interface DedupResult {
  memories: Memory[];
  /** Ids removed, in the order they were removed. */
  removed: Array<{ id: string; keptId: string; reason: "exact" | "same_source" }>;
}

/**
 * Remove duplicate results. Suppresses, never deletes.
 *
 * The audit found that the only existing pass — `mmrDedup` — is a diversity
 * *reordering* that classifies nothing, and in the default
 * `embeddingProvider: none` configuration it returns its input unchanged. This is
 * detection instead, and it needs no embeddings, so it works in the mode most
 * deployments actually run.
 *
 * The **first** occurrence wins, and the list is already sorted by score, so the
 * surviving copy is the best-ranked one. That makes the result stable for a given
 * ranking rather than dependent on input order.
 */
export function dedupeResults(ranked: readonly Memory[], options: DedupOptions = {}): DedupResult {
  const exact = options.exact ?? true;
  const sameSource = options.sameSource ?? false;
  if (!exact && !sameSource) return { memories: [...ranked], removed: [] };

  const window = Math.max(1, options.window ?? DEFAULT_DEDUP_WINDOW);
  const seenText = new Map<string, Memory>();
  const seenTextAndSource = new Map<string, Memory>();
  const kept: Memory[] = [];
  const removed: DedupResult["removed"] = [];

  for (const memory of ranked.slice(0, window)) {
    const text = duplicateKey(memory);
    // An empty normalised key would collapse every blank-ish memory together.
    if (text === "") {
      kept.push(memory);
      continue;
    }
    const source = sameSource ? sourceKey(memory) : "";
    const pairKey = `${source}\u0000${text}`;
    const priorPair = sameSource ? seenTextAndSource.get(pairKey) : undefined;
    if (priorPair) {
      removed.push({ id: memory.id, keptId: priorPair.id, reason: "same_source" });
      continue;
    }
    const priorText = seenText.get(text);
    if (priorText) {
      // Same text, different source: corroboration, kept when sameSource is off.
      if (!sameSource) {
        removed.push({ id: memory.id, keptId: priorText.id, reason: "exact" });
        continue;
      }
    }
    if (!seenText.has(text)) seenText.set(text, memory);
    if (sameSource && !seenTextAndSource.has(pairKey)) seenTextAndSource.set(pairKey, memory);
    kept.push(memory);
  }

  // Anything past the window is passed through untouched rather than silently
  // dropped: the window bounds the work, it does not define the result set.
  kept.push(...ranked.slice(window));
  return { memories: kept, removed };
}

/**
 * Relative credit for each lexical signal. Fractions are relative to a field's
 * exact-match credit, so a tag or a prefix hit is worth a *fraction* of the same
 * term matching prose, not an independently calibrated number.
 */
export interface LexicalWeights {
  /**
   * Credit for a term matching a whole token in the content.
   *
   * This is the **unit** the other weights are expressed against, so scaling it
   * changes nothing: the numerator and the coverage denominator both move with it.
   * That is deliberate rather than an oversight — `tags`, `prefix`, and `phrase`
   * are the meaningful knobs, and an uncalibrated `content` would only make them
   * harder to reason about. T02-012 pins the consequence so nobody later reads the
   * field as tunable.
   */
  content: number;
  /** Credit for a term matching a whole token in a tag. */
  tags: number;
  /**
   * Credit for a term matching only the *start* of a token, as a fraction of that
   * field's exact credit.
   *
   * A prefix hit is a real lexical signal — someone searching `deploy` wants
   * `deployment` — but it must score strictly below an exact hit. That is what
   * demotes `"concatenate the streams"` for the query `cat` instead of promoting
   * it: the old substring test could not tell the two apart at all, and both
   * scored 60.00.
   */
  prefix: number;
  /**
   * Multiplier applied to the exact credits of terms that appear **adjacently and
   * in order** in the content. 1.5 means a phrase match earns its terms plus half
   * again.
   *
   * Phrases are scored, never filtered: dropping a document for containing the
   * words in the wrong order would lose a result the user asked for.
   */
  phrase: number;
}

export const DEFAULT_LEXICAL_WEIGHTS: Readonly<LexicalWeights> = Object.freeze({
  content: 1,
  tags: 0.5,
  prefix: 0.35,
  phrase: 1.5,
});

/**
 * Fixed headroom for the coverage denominator. See `keywordScore`.
 *
 * At the default weights the best conceivable match is: every term exact in the
 * content (1.0 each), every term also in a tag (0.5 each), and the terms as a
 * phrase (a further 0.5 each) — 2.0 per term.
 */
const LEXICAL_HEADROOM = 2;

const CJK_RANGE =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/**
 * Split text into comparable tokens.
 *
 * Alphanumeric runs become one token, and each CJK character becomes its own token
 * because CJK is not space-delimited: without this a Chinese query would only ever
 * match an entire run of characters.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (run === "") continue;
    if (CJK_RANGE.test(run)) {
      for (const char of run) out.push(char);
    } else {
      out.push(run);
    }
  }
  return out;
}

/**
 * Corpus term statistics for one search.
 *
 * The previous implementation derived its "idf" from **the document being
 * scored** — how many of the query's terms that document happened to contain — so
 * the factor was a coverage discount, not inverse document frequency, and it could
 * not distinguish a rare term from a common one. Real IDF needs the corpus.
 *
 * Built once per search by `buildTermStatistics`; recomputing it per document would
 * make scoring quadratic in the candidate count.
 */
export interface TermStatistics {
  /** Lowercased term → how many documents in the corpus contain it. */
  readonly documentFrequency: ReadonlyMap<string, number>;
  /** How many documents the statistics were computed over. */
  readonly documentCount: number;
}

/**
 * Count, for each query term, how many documents contain it.
 *
 * Bounded to the query's own terms rather than the whole corpus vocabulary: a
 * memory set of 100k memories with 60k distinct terms would otherwise cost a Map
 * nobody reads, since only the query's terms are ever scored.
 *
 * Tags count as content for this purpose. A term that appears in many tags is
 * genuinely common in the corpus, and treating it as rare would inflate exactly the
 * documents least likely to be useful.
 */
export function buildTermStatistics(
  memories: readonly Memory[],
  terms: readonly string[],
  documentCount: number = memories.length,
): TermStatistics {
  const wanted = new Set(terms.map((t) => t.toLowerCase()).filter((t) => t !== ""));
  const documentFrequency = new Map<string, number>();
  if (wanted.size === 0) return { documentFrequency, documentCount };

  for (const memory of memories) {
    const seen = new Set<string>();
    for (const token of tokenize(memory.content)) {
      if (wanted.has(token)) seen.add(token);
    }
    if (memory.tags.length > 0) {
      for (const token of memory.tags.flatMap((tag) => tokenize(tag))) {
        if (wanted.has(token)) seen.add(token);
      }
    }
    for (const token of seen) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return { documentFrequency, documentCount };
}

/**
 * Normalised IDF for one term, in (0, 1].
 *
 * Normalised against `log(1 + documentCount)` — the value a term appearing in
 * exactly one document would get — so a term in every document contributes almost
 * nothing and a rare one approaches 1. Normalising rather than using raw IDF is
 * what keeps the coverage denominator fixed: a term's weight then never exceeds the
 * exact-match credit, so `phrase` and the 60-point cap behave as documented
 * instead of being rescaled by whichever term happens to be rarest.
 *
 * A term with no recorded frequency is treated as appearing in every document, the
 * conservative choice: assuming a term is rare when it is actually common is how a
 * stopword ends up dominating a result set.
 */
function normalisedIdf(term: string, stats: TermStatistics | undefined): number {
  if (!stats || stats.documentCount <= 0) return 1;
  const df = stats.documentFrequency.get(term);
  const frequency = df === undefined ? stats.documentCount : Math.max(1, df);
  const ceiling = Math.log(1 + stats.documentCount);
  if (ceiling <= 0) return 1;
  return Math.max(0, Math.min(1, Math.log(1 + stats.documentCount / frequency) / ceiling));
}

/**
 * Lexical relevance of a memory for a set of query terms.
 *
 * Three things this fixes, each of which was a single `String.includes` before:
 *
 *  1. **Token boundaries.** A term matches a whole token. `"concatenate"` no longer
 *     scores identically to `"cat"` for the query `cat`.
 *  2. **Phrase.** Terms adjacent and in order earn a bonus, so `"the red car"`
 *     outranks `"car the red"` and both outrank a document that merely contains
 *     one of the words.
 *  3. **Field weights.** Content and tags are scored separately. Previously they
 *     were concatenated into one string, so a tag mention was worth exactly as
 *     much as prose.
 *
 * The scale is unchanged (capped at 60) and the idf factor is still the placeholder
 * T03 replaces, so downstream ranking shape and the `keyword_hit` explanation flag
 * — which tests `> 0` — keep working.
 */
export function keywordScore(
  m: Memory,
  terms: string[],
  weights: Readonly<LexicalWeights> = DEFAULT_LEXICAL_WEIGHTS,
  stats?: TermStatistics,
): number {
  if (terms.length === 0) return 0;

  const contentTokens = tokenize(m.content);
  const contentSet = new Set(contentTokens);
  const tagTokens = m.tags.flatMap((tag) => tokenize(tag));
  const tagSet = new Set(tagTokens);

  let matched = 0;
  let exactContentCredits = 0;

  for (const rawTerm of terms) {
    const term = rawTerm.toLowerCase();
    if (term === "") continue;
    const isPrefix = (token: string): boolean => token.length > term.length && token.startsWith(term);

    // The term's rarity scales everything it earns, so a document covering the
    // same fraction of a query scores differently depending on how rare the shared
    // terms are — which is the entire point of the factor the old code mislabelled.
    const idf = normalisedIdf(term, stats);
    let credit = 0;
    if (contentSet.has(term)) {
      credit += weights.content * idf;
      exactContentCredits += weights.content * idf;
    } else if (contentTokens.some(isPrefix)) {
      credit += weights.content * weights.prefix * idf;
    }
    if (tagSet.has(term)) {
      credit += weights.tags * idf;
    } else if (tagTokens.some(isPrefix)) {
      credit += weights.tags * weights.prefix * idf;
    }
    matched += credit;
  }

  // Phrase: the query's terms, adjacent and in order, in the content.
  if (terms.length > 1 && exactContentCredits > 0) {
    const ordered = terms.map((term) => term.toLowerCase());
    for (let start = 0; start + ordered.length <= contentTokens.length; start++) {
      let hit = true;
      for (let offset = 0; offset < ordered.length; offset++) {
        if (contentTokens[start + offset] !== ordered[offset]) {
          hit = false;
          break;
        }
      }
      if (hit) {
        matched += exactContentCredits * (weights.phrase - 1);
        break;
      }
    }
  }

  // Coverage against the best conceivable match, so the result stays on the 0..1
  // scale the downstream 60-point cap expects.
  //
  // The denominator is deliberately a **fixed** headroom factor rather than a
  // function of `weights.phrase`. Two earlier attempts failed here, both by making
  // the weights unobservable:
  //
  //   - Leaving the phrase bonus out let coverage exceed 1 for any query whose
  //     terms all matched, so the 60 cap saturated and flattened exactly the
  //     distinctions this change introduces: `"the red car"` and `"car the red"`
  //     both scored 60.00.
  //   - Putting `phrase` *into* the denominator fixed the saturation but made the
  //     weight mathematically inert — numerator and denominator scaled together, so
  //     phrase = 1, 1.5, 2, and 3 all produced an identical score. A weight nobody
  //     can move is not a configurable weight.
  //
  // So: a constant 2, which is exactly the best conceivable result at the default
  // weights (every term exact in content + in a tag + a phrase bonus). Every
  // default-weight case lands at or below 1, and moving any weight moves the score.
  // Extreme settings can still saturate at the 60 cap, which is the intended
  // ceiling rather than a hidden one.
  const maxPossible = terms.length * weights.content * LEXICAL_HEADROOM;
  if (maxPossible <= 0) return 0;
  const coverage = matched / maxPossible;
  if (coverage <= 0) return 0;
  if (coverage >= 1) return 60;
  return coverage * 60;
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

export interface RelationExpansionOptions {
  maxDepth?: number;
  maxEdges?: number;
}

/**
 * Expand only through relations whose target is already in the authorized
 * candidate pool. Depth and edge budgets are hard caps; no backend or
 * cross-tenant lookup is performed here.
 */
export function expandRelationCandidates(
  pool: readonly Memory[],
  seeds: readonly Memory[],
  options: RelationExpansionOptions = {},
): Memory[] {
  const maxDepth = Math.max(0, Math.min(2, Math.floor(options.maxDepth ?? 1)));
  const maxEdges = Math.max(0, Math.min(128, Math.floor(options.maxEdges ?? 32)));
  if (maxDepth === 0 || maxEdges === 0) return dedupeMemories(seeds);
  const byId = new Map(pool.map((memory) => [memory.id, memory]));
  const incoming = new Map<string, string[]>();
  for (const memory of pool) {
    for (const relation of memory.relations ?? []) {
      const list = incoming.get(relation.id) ?? [];
      list.push(memory.id);
      incoming.set(relation.id, list);
    }
  }
  const selected = dedupeMemories(seeds);
  const visited = new Set(selected.map((memory) => memory.id));
  let frontier = selected.slice();
  let edges = 0;
  for (let depth = 0; depth < maxDepth && frontier.length > 0 && edges < maxEdges; depth++) {
    const next: Memory[] = [];
    for (const current of frontier) {
      const neighborIds = [
        ...(current.relations ?? []).map((relation) => relation.id),
        ...(incoming.get(current.id) ?? []),
      ];
      for (const id of neighborIds) {
        if (edges >= maxEdges) break;
        edges++;
        if (visited.has(id)) continue;
        const neighbor = byId.get(id);
        if (!neighbor) continue;
        visited.add(id);
        selected.push(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return selected;
}

function dedupeMemories(memories: readonly Memory[]): Memory[] {
  const seen = new Set<string>();
  const output: Memory[] = [];
  for (const memory of memories) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    output.push(memory);
  }
  return output;
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
  // Built once, not per document: recomputing document frequencies inside the
  // scoring loop would make a search quadratic in the candidate count. The count is
  // the backend's total where it knows one, so a paginated candidate set still gets
  // common terms discounted against the real corpus.
  const termStats = buildTermStatistics(memories, terms, q.totalDocs ?? memories.length);
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
    const kwScore = keywordScore(m, terms, DEFAULT_LEXICAL_WEIGHTS, termStats);
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

  // Step 10a: duplicate suppression. Runs *before* MMR and on the already-sorted
  // list, so the surviving copy of a duplicate is the best-ranked one and the
  // result is stable for a given ranking. It needs no embeddings, which is the
  // point: the audit found the previous pass returned its input unchanged in the
  // default `embeddingProvider: none` configuration.
  // Step 9b: superseded suppression. Deliberately *after* the sort and *before*
  // dedup, and only when the replacement is actually available: suppressing a copy
  // whose superseder is missing, archived, or filtered out of this pool would replace
  // a stale answer with no answer, which is the wrong direction to fail in.
  if (q.includeSuperseded !== true) {
    const available = new Set(memories.map((m) => m.id));
    ranked = ranked.filter((m) => {
      const replacement = m.supersededBy;
      if (!replacement) return true;
      if (!available.has(replacement)) return true;
      // No chain handling is needed, and an attempt at it was actively wrong: I had
      // suppressed a copy only when its superseder was *not itself* superseded, which
      // meant a v1 → v2 → v3 line returned both v1 and v3. Chains resolve on their
      // own — v1 is suppressed because v2 is available, and v2 is suppressed because
      // v3 is — so the newest link is what survives.
      return false;
    });
  }

  const dedupe = dedupeResults(ranked, {
    exact: q.dedupeExact ?? true,
    sameSource: q.dedupeSameSource ?? false,
    window: Math.max(effectiveLimit * 10, 100),
  });
  ranked = dedupe.memories;

  // Step 10b: MMR diversity (semantic mode with multiple vectors).
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
    // Query text follows the same rule as everywhere else: it is only ever
    // logged under REMEMBRA_DEBUG, not merely because the trace is enabled.
    logEvent(
      "debug",
      "retrieval.debug",
      { ...(process.env.REMEMBRA_DEBUG && q.query ? { query: q.query } : {}), pipeline, latency_ms: Date.now() - now },
      "Remembra: retrieval debug trace",
    );
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
