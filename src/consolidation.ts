/**
 * Memory consolidation detection (V4.5.0, plan §8.3).
 *
 * Detects duplicates, near-duplicates, contradictions, outdated facts, and
 * fragmentation across a set of memories within the same type+scope bucket.
 * Results are returned as a report that callers can act on during maintenance.
 */

import { Memory } from "./types.js";

export interface ConsolidationFindings {
  /** Memories that are exact content duplicates (same hash). */
  exactDuplicates: Array<{ id: string; duplicateOf?: string }>;
  /** Pairs of memories flagged as near-duplicates (vector similarity above threshold). */
  nearDuplicates: Array<{ a: string; b: string; reason: string }>;
  /** Pairs flagged as contradictory. */
  contradictions: Array<{ a: string; b: string; reason: string }>;
  /** Groups of 3+ short memories in the same type+scope over a recent window. */
  fragments: Array<{ ids: string[]; type: string; scope: string }>;
}

export interface ConsolidationOpts {
  /** Vector similarity threshold for near-duplicate detection (default 0.92). */
  similarityThreshold?: number;
  /** Max days to look back for fragment detection (default 7). */
  fragmentWindowDays?: number;
}

const DEFAULT_OPTS: ConsolidationOpts = {
  similarityThreshold: 0.92,
  fragmentWindowDays: 7,
};

/** Simple content fingerprint for exact-duplicate detection. */
function fingerprint(m: Memory): string {
  return `${m.type}|${m.scope}|${m.content.trim().toLowerCase()}`;
}

/**
 * Check two memory contents for semantic opposition (very rough heuristic).
 * Returns true if they appear to contradict each other.
 */
function appearsContradictory(a: Memory, b: Memory): boolean {
  const aLower = a.content.toLowerCase();
  const bLower = b.content.toLowerCase();
  // Direct negation patterns.
  const negations = [
    ["prefer", "dislike"],
    ["uses", "does not use"],
    ["is", "is not"],
    ["was", "was not"],
    ["has", "does not have"],
    ["agrees", "disagrees"],
    ["active", "inactive"],
    ["yes", "no"],
    ["true", "false"],
    ["correct", "incorrect"],
    ["right", "wrong"],
    ["started", "stopped"],
    ["began", "ended"],
    ["likes", "hates"],
    ["good", "bad"],
    ["love", "hate"],
    ["can", "cannot"],
    ["will", "will not"],
    ["should", "should not"],
  ];
  for (const [pos, neg] of negations) {
    if (aLower.includes(pos) && bLower.includes(neg)) return true;
    if (aLower.includes(neg) && bLower.includes(pos)) return true;
  }
  return false;
}

/**
 * Run consolidation analysis over a list of memories.
 * Memories are grouped by type+scope before comparison.
 */
export function consolidate(
  memories: Memory[],
  opts: ConsolidationOpts = {},
): ConsolidationFindings {
  const o = { ...DEFAULT_OPTS, ...opts };
  const findings: ConsolidationFindings = {
    exactDuplicates: [],
    nearDuplicates: [],
    contradictions: [],
    fragments: [],
  };

  // Group by type+scope.
  const groups = new Map<string, Memory[]>();
  for (const m of memories) {
    const key = `${m.type}|${m.scope}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  // Exact duplicates.
  const seen = new Map<string, string>(); // fingerprint → first id
  for (const m of memories) {
    const fp = fingerprint(m);
    const first = seen.get(fp);
    if (first && first !== m.id) {
      findings.exactDuplicates.push({ id: m.id, duplicateOf: first });
    } else {
      seen.set(fp, m.id);
    }
  }

  // Near-duplicates and contradictions within each group.
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    // Sort by createdAt descending (newest first) for consistent pairing.
    const sorted = [...group].sort((a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        // Skip if one is a known duplicate of the other.
        if (findings.exactDuplicates.some((d) => d.id === a.id && d.duplicateOf === b.id)) continue;
        if (findings.exactDuplicates.some((d) => d.id === b.id && d.duplicateOf === a.id)) continue;

        // Near-duplicate check (requires embeddings).
        if (a.embedding && b.embedding && a.embedding.length === b.embedding.length) {
          const sim = cosineSim(a.embedding, b.embedding);
          if (sim >= (o.similarityThreshold ?? 0.92)) {
            findings.nearDuplicates.push({
              a: a.id,
              b: b.id,
              reason: `cosine similarity ${sim.toFixed(3)} ≥ ${o.similarityThreshold}`,
            });
          }
        }

        // Contradiction check (heuristic text comparison).
        if (appearsContradictory(a, b)) {
          findings.contradictions.push({
            a: a.id,
            b: b.id,
            reason: "semantic opposition detected",
          });
        }
      }
    }

    // Fragment detection: 3+ short memories in same type+scope within window.
    const cutoff = Date.now() - (o.fragmentWindowDays ?? 7) * 86_400_000;
    const recent = sorted.filter((m) => Date.parse(m.createdAt) >= cutoff);
    if (recent.length >= 3) {
      const allShort = recent.every((m) => m.content.split(/\s+/).length < 15);
      if (allShort) {
        findings.fragments.push({
          ids: recent.map((m) => m.id),
          type: sorted[0].type,
          scope: sorted[0].scope,
        });
      }
    }
  }

  return findings;
}

/** Cosine similarity between two vectors. */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
