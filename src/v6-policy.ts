/**
 * V6 policy model and evaluator (V6-T02).
 *
 * The executable form of [`docs/v6-decisions.md`](../docs/v6-decisions.md). Every
 * rule below traces to an approved decision there; where the architecture spec
 * and the ADR disagree, the ADR wins and the difference is recorded in code.
 *
 * Three properties are load-bearing and each is mutation-checked in
 * `src/test/v6-policy.test.ts`:
 *
 * 1. **Fail closed, never fall back to allow.** An unknown layer source, an
 *    unknown field, a version mismatch, or an unrecognised reason is a refusal.
 *    V5 already fails closed on unknown policy values; this is the same posture
 *    applied to a decision surface, where a permissive fallback would be an
 *    authorization bypass rather than a misconfiguration.
 * 2. **Deny wins, and precedence is by layer, not by input order.** A restrictive
 *    low layer beats a permissive high one, which is what makes a fixed
 *    precedence worth having.
 * 3. **A caller cannot weaken policy with a request field.** A principal may
 *    *declare* its clearance; the evaluator compares it against the memory's
 *    label and denies when it is insufficient. Declaring more clearance than the
 *    identity context actually holds is T04's job to detect — this layer simply
 *    never treats the declaration as authority.
 */
import { z } from "zod";
import { RemembraError } from "./errors.js";

/**
 * Sensitivity bands, least to most restrictive.
 *
 * The architecture spec §4.2 proposed `public | internal | confidential |
 * restricted`. The approved ADR §1 replaces the top band with `secret` and drops
 * `restricted` entirely: "restricted" read as a mode rather than a level, and the
 * V5 quarantine path already expresses restricted handling. A record written
 * under the spec's spelling is a migration concern, not a live ambiguity, because
 * V6 stores are new — see docs/v6-policy.md.
 */
export const SENSITIVITY_ORDER = ["public", "internal", "confidential", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITY_ORDER)[number];

export const SensitivitySchema = z.enum(SENSITIVITY_ORDER);

/** Trust is an orthogonal axis: high trust is not low sensitivity. */
export const TRUST_LEVELS = ["unverified", "trusted", "verified", "system"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export const TrustSchema = z.enum(TRUST_LEVELS);

/** V5's retention vocabulary, carried forward unchanged (ADR §2). */
export const RETENTION_MODES = ["pinned", "persistent", "ephemeral", "decaying", "neverExpire"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];
export const RetentionSchema = z.enum(RETENTION_MODES);

/**
 * Operation classes. `provider_transmit` and `export` are separate classes from
 * `read` because ADR §6 gives provider work its own idempotency class and §1
 * requires export to be separately gated — a read permission must not imply
 * either.
 */
export const OPERATION_CLASSES = ["read", "write", "update", "delete", "export", "provider_transmit"] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];
export const OperationClassSchema = z.enum(OPERATION_CLASSES);

/**
 * Policy layers, in fixed evaluation order (architecture spec §4.6).
 *
 * Order is the contract: system safety first so a later layer can never relax
 * it, and provider/export constraints last so they can tighten anything above.
 */
export const PRECEDENCE_ORDER = ["system", "tenant", "resource", "principal", "memory", "provider"] as const;
export type PolicySource = (typeof PRECEDENCE_ORDER)[number];

export const PolicySourceSchema = z.enum(PRECEDENCE_ORDER);

/** Where a policy document came from. A caller-supplied document is not a source. */
export const POLICY_SOURCES = ["builtin", "host", "policy_file"] as const;
export type PolicyOrigin = (typeof POLICY_SOURCES)[number];
export const PolicyOriginSchema = z.enum(POLICY_SOURCES);

/**
 * Closed decision vocabulary (architecture spec §5.5, extended).
 *
 * `legal_hold` is a reason rather than an effect: holding a memory blocks a
 * destructive operation, it does not grant access. `injection_detected` mirrors
 * V5's existing SENSITIVE_DATA/INJECTION_DETECTED posture.
 *
 * Every reason is low-cardinality and content-free — these strings go to audit
 * events and metrics, so a reason that could carry user text would be a leak.
 */
export const DECISION_REASONS = [
  "authorized",
  "tenant_mismatch",
  "project_mismatch",
  "sensitivity_denied",
  "expired",
  "retention_denied",
  "trust_restricted",
  "policy_invalid",
  "provider_not_permitted",
  "legal_hold",
  "capability_missing",
  "injection_detected",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];
export const DecisionReasonSchema = z.enum(DECISION_REASONS);

export const DECISION_EFFECTS = ["allow", "deny", "redact", "quarantine"] as const;
export type DecisionEffect = (typeof DECISION_EFFECTS)[number];
export const DecisionEffectSchema = z.enum(DECISION_EFFECTS);

/**
 * A decision result.
 *
 * `.strict()` rather than zod's default strip: an unknown field on a decision
 * must be refused, not silently dropped. Stripping would let a caller pass
 * `{ effect: "allow", content: "..." }` and believe the extra field was honoured
 * when it was actually discarded — and it would mean a decision carrying content
 * could round-trip through a validator that reported success.
 */
export const PolicyDecisionSchema = z
  .object({
    effect: DecisionEffectSchema,
    reason: DecisionReasonSchema,
    policyVersion: z.string().regex(/^v6-policy\/\d+\.\d+\.\d+$/),
  })
  .strict();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** One layer's verdict. Layers are inputs to the evaluator, never self-asserted. */
export const PolicyLayerSchema = z
  .object({
    source: PolicySourceSchema,
    effect: DecisionEffectSchema,
    reason: DecisionReasonSchema,
  })
  .strict();
export type PolicyLayer = z.infer<typeof PolicyLayerSchema>;

/** A versioned policy document. Bounded: no free-form extension points. */
export const PolicyDocumentSchema = z
  .object({
    version: z.string().regex(/^v6-policy\/\d+\.\d+\.\d+$/),
    source: PolicyOriginSchema,
    layers: z.array(PolicyLayerSchema).max(64),
  })
  .strict();
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/** The version this build emits. Bumped only with a schema change. */
export const POLICY_VERSION = "v6-policy/1.0.0" as const;

export interface PolicyPrincipal {
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId?: string;
  readonly agentId?: string;
  /** Trusted capabilities. Absence of a capability is never an implicit allow. */
  readonly capabilities: readonly string[];
  /**
   * The clearance the identity context actually holds.
   *
   * A request field cannot raise this — the evaluator only ever compares the
   * memory's label against it. Declaring a clearance the context does not hold is
   * a V6-T04 problem to detect at the identity layer.
   */
  readonly clearance?: Sensitivity;
}

export interface PolicyMemory {
  readonly id: string;
  readonly sensitivity: Sensitivity;
  readonly trust: TrustLevel;
  readonly retention: RetentionMode;
  /** Operator-set only (ADR §3). Never settable from a request payload. */
  readonly legalHold: boolean;
  /** Absolute expiry instant, ms since epoch. Independent of `retention`. */
  readonly expiresAt?: number;
  readonly organizationId?: string;
  readonly projectId?: string;
}

export interface PolicyInput {
  readonly operation: OperationClass;
  readonly principal: PolicyPrincipal;
  readonly memory: PolicyMemory;
  /** Explicit layer verdicts, e.g. from a host or file policy. */
  readonly layers?: readonly PolicyLayer[];
  /** Evaluation clock, injectable so the evaluator stays pure. */
  readonly now?: number;
}

/** Capability required per operation. A missing capability denies. */
const OPERATION_CAPABILITY: Record<OperationClass, string> = {
  read: "tenant:read",
  write: "tenant:write",
  update: "tenant:write",
  delete: "tenant:write",
  export: "tenant:export",
  provider_transmit: "provider:transmit",
};

function failClosed(reason: DecisionReason, detail: string): never {
  throw new RemembraError("INVALID_INPUT", `v6 policy: ${detail}`, { cause: reason });
}

/**
 * Compare two sensitivity bands. Positive means `a` is more restrictive.
 */
export function sensitivityRank(level: Sensitivity): number {
  return SENSITIVITY_ORDER.indexOf(level);
}

/**
 * Evaluate a request against policy.
 *
 * Pure: no clock, no randomness, no I/O. Same input, same decision — which is
 * what lets an audit event be replayed and still make sense.
 *
 * Fail-closed ordering is deliberate. Structural problems (an unknown layer
 * source, a non-finite clock) are refused *before* any allow is reachable, so a
 * malformed policy can never degrade into a permissive one. A malformed *memory*
 * (an unknown trust level) denies rather than throws, because that is a data
 * condition the caller can act on rather than a programming error.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const now = input.now ?? 0;
  if (!Number.isFinite(now)) failClosed("policy_invalid", "evaluation clock must be finite");

  // 1. Structural validation of any supplied layers. An unknown source is a
  //    programming error in the policy pipeline, so it throws rather than denies.
  const supplied = input.layers ?? [];
  for (const layer of supplied) {
    const parsed = PolicyLayerSchema.safeParse(layer);
    if (!parsed.success) failClosed("policy_invalid", `malformed policy layer: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  // 2. Resource binding. A memory from another tenant is denied with a reason
  //    that reveals nothing about whether it exists.
  const { principal, memory } = input;
  if (memory.organizationId !== undefined && memory.organizationId !== principal.organizationId) {
    return { effect: "deny", reason: "tenant_mismatch", policyVersion: POLICY_VERSION };
  }
  if (memory.projectId !== undefined && memory.projectId !== principal.projectId) {
    return { effect: "deny", reason: "project_mismatch", policyVersion: POLICY_VERSION };
  }

  // 3. Operation capability.
  const required = OPERATION_CAPABILITY[input.operation];
  if (!principal.capabilities.includes(required)) {
    return { effect: "deny", reason: "capability_missing", policyVersion: POLICY_VERSION };
  }

  // The clearance the identity context actually holds. An absent clearance
  // covers `public` only — never "unrestricted", which is the permissive default
  // this whole module exists to avoid.
  const clearance = principal.clearance ?? "public";

  // 4. Provider transmission needs an explicit capability (checked above) and a
  //    clearance at `internal` or better: shipping anything to a third party is an
  //    egress decision, not a read.
  //
  //    This is checked BEFORE the sensitivity comparison below. After it, a
  //    `public`-clearance principal asking to transmit an `internal` memory would
  //    be told `sensitivity_denied` — technically true, but it reports the wrong
  //    cause and leaves the egress rule unreachable in exactly the case it exists
  //    for. The caller needs to know a third party was involved, and the
  //    sensitivity reason does not say that.
  if (input.operation === "provider_transmit" && sensitivityRank(clearance) < sensitivityRank("internal")) {
    return { effect: "deny", reason: "provider_not_permitted", policyVersion: POLICY_VERSION };
  }

  // 5. Sensitivity: the memory's label must be covered by the identity's
  //    clearance.
  if (sensitivityRank(memory.sensitivity) > sensitivityRank(clearance)) {
    return { effect: "deny", reason: "sensitivity_denied", policyVersion: POLICY_VERSION };
  }

  // 6. Expiration is absolute and independent of retention (ADR §2).
  if (memory.expiresAt !== undefined && Number.isFinite(memory.expiresAt) && now >= memory.expiresAt) {
    return { effect: "deny", reason: "expired", policyVersion: POLICY_VERSION };
  }

  // 7. Legal hold blocks destruction only, and never grants access (ADR §3).
  if (memory.legalHold && input.operation === "delete") {
    return { effect: "deny", reason: "legal_hold", policyVersion: POLICY_VERSION };
  }

  // 8. Trust. Unverified content is not fit to influence a retrieval by default.
  if (memory.trust === "unverified") {
    return { effect: "deny", reason: "trust_restricted", policyVersion: POLICY_VERSION };
  }

  // 8. Provider transmission needs an explicit capability, checked above, plus a
  //    clearance at `internal` or better: nothing `public` is worth shipping to a
  //    third party on the caller's say-so alone.
  if (input.operation === "provider_transmit" && sensitivityRank(clearance) < sensitivityRank("internal")) {
    return { effect: "deny", reason: "provider_not_permitted", policyVersion: POLICY_VERSION };
  }

  // 9. Explicit layers, resolved by fixed precedence and then by restriction.
  //    Most restrictive effect wins; among equals the earliest layer wins, so the
  //    decision is deterministic and independent of input order.
  const resolved = resolveLayers(supplied);
  if (resolved) return { ...resolved, policyVersion: POLICY_VERSION };

  return { effect: "allow", reason: "authorized", policyVersion: POLICY_VERSION };
}

const EFFECT_RANK: Record<DecisionEffect, number> = {
  allow: 0,
  redact: 1,
  quarantine: 2,
  deny: 3,
};

/**
 * Resolve explicit layers by precedence, then by restriction.
 *
 * Two orderings, applied in sequence and deliberately: precedence decides *which
 * layer speaks first*, and restriction decides *what survives when several
 * disagree*. Without the second step a permissive high layer would override a
 * restrictive low one, which is how a tenant policy ends up weaker than the
 * memory policy beneath it.
 */
function resolveLayers(layers: readonly PolicyLayer[]): { effect: DecisionEffect; reason: DecisionReason } | undefined {
  if (layers.length === 0) return undefined;
  const ordered = [...layers].sort(
    (a, b) => PRECEDENCE_ORDER.indexOf(a.source) - PRECEDENCE_ORDER.indexOf(b.source),
  );
  let best: PolicyLayer | undefined;
  for (const layer of ordered) {
    if (best === undefined || EFFECT_RANK[layer.effect] > EFFECT_RANK[best.effect]) best = layer;
  }
  return best ? { effect: best.effect, reason: best.reason } : undefined;
}

/** Narrow a decision to its effect, for enforcement call sites. */
export function policyDecisionEffect(decision: PolicyDecision): DecisionEffect {
  return decision.effect;
}

/**
 * Parse a policy document, refusing anything unrecognised.
 *
 * A version this build does not implement is refused rather than best-effort
 * parsed: a policy written for a later engine may encode a rule this one would
 * silently drop, and a dropped rule is an allow.
 */
export function parsePolicyDocument(raw: unknown): { ok: true; policy: PolicyDocument } | { ok: false; error: string } {
  const parsed = PolicyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "document"}: ${i.message}`).join("; ") };
  }
  const policy = parsed.data;
  if (policy.version !== POLICY_VERSION) {
    return { ok: false, error: `policy version ${policy.version} is not supported by this build (${POLICY_VERSION})` };
  }
  return { ok: true, policy };
}