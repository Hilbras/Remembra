/**
 * Memory lifecycle & multi-signal decay (V4.5.0, plan §8).
 *
 * Replaces the single time-threshold archive rule with a composite health
 * score that considers age, last-seen recency, importance, confidence, trust,
 * and relation strength. Memories below the aging threshold enter the "aging"
 * state (dimmed in search); below the archive threshold they are archived.
 *
 * Public API:
 *   - computeHealth(memory, context) → health score 0..1
 *   - getLifecycleState(memory, context) → LifecycleState
 *   - AgingContext — what the caller supplies about recent usage
 */

import { Memory, TrustLevel } from "./types.js";

/** Current lifecycle state of a memory. */
export type LifecycleState = "active" | "aging" | "archived" | "quarantined" | "deleted";

/** Signals available for health-score computation. */
export interface AgingContext {
  /** How many times this memory surfaced in searches over the evaluation window. */
  retrievalCount?: number;
  /** ISO timestamp of the last successful validation (if any). */
  lastValidatedAt?: string;
  /** Number of typed relations pointing to/from this memory. */
  relationCount?: number;
  /** Whether the memory was part of a detected contradiction pair. */
  contradicted?: boolean;
}

/** Per-signal weight configuration. */
export interface DecayWeights {
  age: number;
  lastSeen: number;
  importance: number;
  confidence: number;
  retrieval: number;
  trust: number;
  relations: number;
}

const DEFAULT_WEIGHTS: DecayWeights = {
  age: 0.15,
  lastSeen: 0.25,
  importance: 0.20,
  confidence: 0.10,
  retrieval: 0.15,
  trust: 0.10,
  relations: 0.05,
};

/** Read weights from REMEMBRA_DECAY_WEIGHTS (semicolon-separated key=value). */
export function parseDecayWeights(): DecayWeights {
  const raw = process.env.REMEMBRA_DECAY_WEIGHTS;
  if (!raw) return { ...DEFAULT_WEIGHTS };
  const out: Partial<DecayWeights> = {};
  for (const pair of raw.split(";")) {
    const [k, v] = pair.trim().split("=");
    if (!k || !v) continue;
    const num = Number(v);
    if (Number.isFinite(num) && num >= 0 && num <= 1) {
      if (k in DEFAULT_WEIGHTS) (out as Record<string, unknown>)[k] = num;
    }
  }
  // Renormalize so weights still sum close to 1.0.
  const total = Object.values(out).reduce((s, v) => s + (v as number), 0);
  const missing = Object.keys(DEFAULT_WEIGHTS).filter((k) => !(k in out));
  const distribute = total > 0 ? (1 - total) / missing.length : 0;
  for (const k of missing) (out as Record<string, unknown>)[k] = distribute;
  return { ...DEFAULT_WEIGHTS, ...out } as DecayWeights;
}

function readWeight(key: keyof DecayWeights, weights: DecayWeights): number {
  return weights[key];
}

/** Score component for age (0 = brand new, 1 = very old). */
function ageScore(createdAt: string, nowMs: number): number {
  const ageDays = (nowMs - Date.parse(createdAt)) / 86_400_000;
  // Half-life of 90 days: score = exp(-ln2 * ageDays / 90)
  return Math.exp(-(Math.LN2 * ageDays) / 90);
}

/** Score component for last-seen recency (0 = never seen, 1 = recently seen). */
function lastSeenScore(lastSeen: string | undefined, updatedAt: string, nowMs: number): number {
  const ref = lastSeen ?? updatedAt;
  const agoMs = nowMs - Date.parse(ref);
  if (isNaN(agoMs) || agoMs < 0) return 1;
  const days = agoMs / 86_400_000;
  // Same half-life as age.
  return Math.exp(-(Math.LN2 * days) / 90);
}

/** Score component for trust. */
function trustScore(trust: TrustLevel): number {
  switch (trust) {
    case "system": return 1.0;
    case "verified": return 0.95;
    case "trusted": return 0.8;
    case "unverified": return 0.4;
  }
}

/** Score component for retrieval frequency (normalized per-90-day window). */
function retrievalScore(count: number | undefined): number {
  if (count === undefined || count === 0) return 0.2; // unseen = low but not zero
  // Logarithmic scaling: 1→0.5, 5→0.7, 20→0.85, 100→0.95
  return Math.min(1, 0.5 + 0.45 * (Math.log(count + 1) / Math.log(100)));
}

/** Score component for relation strength. */
function relationScore(count: number | undefined): number {
  if (count === undefined || count === 0) return 0.3;
  return Math.min(1, 0.4 + 0.6 * Math.min(count / 10, 1));
}

/**
 * Compute a composite health score in [0, 1].
 * Higher = healthier (less likely to age/archive).
 */
export function computeHealth(
  memory: Memory,
  ctx: AgingContext = {},
  weights: DecayWeights = parseDecayWeights(),
): number {
  const nowMs = Date.now();
  const w = weights;

  const age = ageScore(memory.createdAt, nowMs) * w.age;
  const ls = lastSeenScore(ctx.retrievalCount !== undefined ? undefined : memory.lastSeen,
    memory.updatedAt, nowMs) * w.lastSeen;
  const imp = ((memory.importance ?? 3) / 5) * w.importance;
  const conf = ((memory.confidence ?? 0.7) ?? 0.7) * w.confidence;
  const ret = retrievalScore(ctx.retrievalCount) * w.retrieval;
  const tru = trustScore(memory.trust) * w.trust;
  const rel = relationScore(ctx.relationCount) * w.relations;

  return age + ls + imp + conf + ret + tru + rel;
}

/**
 * Determine the lifecycle state of a memory based on its health score
 * and retention mode.
 */
export function getLifecycleState(
  memory: Memory,
  ctx: AgingContext = {},
  opts?: {
    healthAgingThreshold?: number;
    healthArchiveThreshold?: number;
    ageAgingDays?: number;
  },
): LifecycleState {
  if (memory.archivedAt) return "archived";
  if (memory.meta?.quarantined) return "quarantined";

  const health = computeHealth(memory, ctx, parseDecayWeights());
  const agingThreshold = opts?.healthAgingThreshold ?? Number(process.env.REMEMBRA_HEALTH_AGE_THRESHOLD ?? 0.35);
  const archiveThreshold = opts?.healthArchiveThreshold ?? Number(process.env.REMEMBRA_HEALTH_ARCHIVE_THRESHOLD ?? 0.15);
  const ageAgingDays = opts?.ageAgingDays ?? Number(process.env.REMEMBRA_AGE_THRESHOLD_DAYS ?? 30);

  // Standing instructions and pinned memories are effectively immortal.
  if (memory.retention === "pinned" || memory.retention === "neverExpire") return "active";
  if (memory.type === "role" || memory.type === "instruction") return "active";

  // Age-based aging gate: even high-health memories age after long disuse.
  const lastActive = Date.parse(memory.lastSeen ?? memory.updatedAt);
  const daysSinceActive = lastActive > 0 ? (Date.now() - lastActive) / 86_400_000 : Infinity;
  if (daysSinceActive > ageAgingDays * 3 && health < 0.6) return "aging";

  if (health < archiveThreshold) return "aging"; // will be archived by maintain
  if (health < agingThreshold) return "aging";
  return "active";
}

/**
 * The aging penalty applied to search ranking for aging memories.
 */
export function agingScorePenalty(state: LifecycleState): number {
  if (state !== "aging") return 0;
  return Number(process.env.REMEMBRA_AGING_BOOST ?? -50);
}
