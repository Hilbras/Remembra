/**
 * V6 policy evaluator (V6-T05).
 *
 * The pure, deterministic decision function that sits between a request context
 * (V6-T04) and any memory or retrieval result. It is the *whole* of policy
 * evaluation: T02 defined the vocabulary and a single-layer resolver, this
 * composes every axis into one decision with a stated precedence.
 *
 * Three properties, each mutation-checked rather than asserted:
 *
 * 1. **Side-effect free and deterministic.** No clock, no I/O, no randomness; the
 *    clock is a parameter. The same input yields the same decision, which is what
 *    lets an audit event be replayed and still make sense.
 * 2. **Deny wins, and the reported reason is deterministic under conflict.** When
 *    several axes deny at once the reason is a *fixed* function of the input, not
 *    whichever check ran first — otherwise an operator cannot read a denial and an
 *    audit cannot group them.
 * 3. **Nothing private in the output.** The result carries an effect, a reason and
 *    a policy version, and nothing else. These objects are written to audit events
 *    and metrics, so a field carrying content would be a leak that validates clean.
 */
import { z } from "zod";
import {
  DECISION_EFFECTS,
  DECISION_REASONS,
  PRECEDENCE_ORDER,
  RETENTION_MODES,
  SENSITIVITY_ORDER,
  TRUST_LEVELS,
  POLICY_VERSION,
  type DecisionEffect,
  type DecisionReason,
  type Sensitivity,
  type TrustLevel,
} from "./v6-policy.js";
import { isValidTenantId } from "./types.js";
import type { V6OperationClass } from "./v6-request-context.js";

/** The bounded result. `.strict()` — an audit event is written from this. */
export const V6EvaluationResultSchema = z
  .object({
    effect: z.enum(DECISION_EFFECTS),
    reason: z.enum(DECISION_REASONS),
    policyVersion: z.string().regex(/^v6-policy\/\d+\.\d+\.\d+$/),
  })
  .strict();
export type V6EvaluationResult = z.infer<typeof V6EvaluationResultSchema>;

export interface V6EvaluationPrincipal {
  readonly organizationId: string;
  readonly projectId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly capabilities: readonly string[];
  /** The clearance the identity actually holds. A request cannot raise it. */
  readonly clearance?: Sensitivity;
}

export interface V6EvaluationMemory {
  readonly id: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly sensitivity: Sensitivity;
  readonly trust: TrustLevel;
  readonly retention: (typeof RETENTION_MODES)[number];
  readonly legalHold: boolean;
  /** Absolute expiry instant, ms since epoch. Independent of `retention`. */
  readonly expiresAt?: number;
}

export interface V6EvaluationInput {
  readonly operation: V6OperationClass;
  readonly principal: V6EvaluationPrincipal;
  readonly memory: V6EvaluationMemory;
  /** Explicit policy layer verdicts, e.g. from a host or file policy. */
  readonly policy?: ReadonlyArray<{ source: (typeof PRECEDENCE_ORDER)[number]; effect: DecisionEffect; reason: DecisionReason }>;
  /** Evaluation clock. Injected, so the evaluator is pure. */
  readonly now: number;
}

const OPERATION_CAPABILITY: Record<V6OperationClass, string> = {
  read: "tenant:read",
  context_read: "tenant:read",
  history_read: "tenant:read",
  write: "tenant:write",
  update: "tenant:write",
  delete: "tenant:write",
  relation_write: "tenant:write",
  export: "tenant:export",
  snapshot_export: "tenant:export",
  provider_transmit: "provider:transmit",
  policy_admin: "policy:admin",
};

/** Effects ordered by how restrictive they are; `deny` wins every conflict. */
const EFFECT_RANK: Record<DecisionEffect, number> = {
  allow: 0,
  redact: 1,
  quarantine: 2,
  deny: 3,
};

function rank(level: Sensitivity): number {
  return SENSITIVITY_ORDER.indexOf(level);
}

function allow(reason: DecisionReason = "authorized"): V6EvaluationResult {
  return { effect: "allow", reason, policyVersion: POLICY_VERSION };
}

function refuse(reason: DecisionReason): V6EvaluationResult {
  return { effect: "deny", reason, policyVersion: POLICY_VERSION };
}

/**
 * Reject a malformed *input* rather than a malformed policy.
 *
 * A memory whose sensitivity or trust is not a declared value is a data problem the
 * caller can act on, so it denies with `policy_invalid` — it does not throw, because
 * a throwing evaluator is a 500 where a refusal is a correct answer.
 */
function validate(input: V6EvaluationInput): V6EvaluationResult | undefined {
  if (!Number.isFinite(input.now)) return refuse("policy_invalid");
  if (!isValidTenantId(input.principal.organizationId)) return refuse("policy_invalid");
  // `includes`, not `hasOwnProperty`: an array's own keys are indices, so
  // `hasOwnProperty("secret")` is false for every *value* in it. The first version
  // of this line did that, and the effect was that every request denied with
  // `policy_invalid` -- a fail-closed bug, which is the hardest kind to notice
  // because the tests that assert refusals all passed.
  if (!(SENSITIVITY_ORDER as readonly string[]).includes(input.principal.clearance ?? "public")) {
    return refuse("policy_invalid");
  }
  if (!(SENSITIVITY_ORDER as readonly string[]).includes(input.memory.sensitivity)) return refuse("policy_invalid");
  if (!(TRUST_LEVELS as readonly string[]).includes(input.memory.trust)) return refuse("policy_invalid");
  if (!(RETENTION_MODES as readonly string[]).includes(input.memory.retention)) return refuse("policy_invalid");
  if (input.memory.expiresAt !== undefined && !Number.isFinite(input.memory.expiresAt)) return refuse("policy_invalid");
  return undefined;
}

/**
 * Evaluate. The single decision function.
 *
 * The order below is the contract, and two entries are counter-intuitive enough to
 * be worth stating:
 *
 *  - **Expiration precedes trust.** An expired memory is unusable for a different
 *    reason than an untrusted one, and reporting `trust_restricted` for a stale
 *    memory misattributes the cause an operator then has to chase.
 *  - **Provider egress precedes sensitivity.** Reported as `provider_not_permitted`
 *    rather than `sensitivity_denied`, because the caller needs to know a third
 *    party was involved. `sensitivity_denied` does not say that. The weakest egress
 *    rule is unchanged — a `secret` memory still needs `secret` clearance — so this
 *    changes which reason is reported, never whether the operation is permitted.
 */
export function evaluateV6Policy(input: V6EvaluationInput): V6EvaluationResult {
  const malformed = validate(input);
  if (malformed) return malformed;

  const { principal, memory, operation } = input;
  const clearance = principal.clearance ?? "public";

  // 1. Resource binding. Reported without revealing whether the record exists.
  if (memory.organizationId !== undefined && memory.organizationId !== principal.organizationId) {
    return refuse("tenant_mismatch");
  }
  if (memory.projectId !== undefined && memory.projectId !== principal.projectId) {
    return refuse("project_mismatch");
  }

  // 2. Explicit policy layers are resolved FIRST, so a system-layer deny is never
  //    softened by anything computed below it. Within the layers, precedence
  //    decides who speaks and restriction decides what survives.
  const layer = resolveLayers(input.policy);
  if (layer && layer.effect === "deny") return refuse(layer.reason);

  // 3. Operation capability. A missing capability is never an implicit allow.
  const required = OPERATION_CAPABILITY[operation];
  if (!principal.capabilities.includes(required)) return refuse("capability_missing");

  // 4. Provider egress: sending data to a third party needs `internal` or better.
  if (operation === "provider_transmit" && rank(clearance) < rank("internal")) {
    return refuse("provider_not_permitted");
  }

  // 5. Expiration, before trust and retention — see the header note.
  if (memory.expiresAt !== undefined && input.now >= memory.expiresAt) return refuse("expired");

  // 6. Sensitivity. An absent clearance covers `public` only.
  if (rank(memory.sensitivity) > rank(clearance)) return refuse("sensitivity_denied");

  // 7. Legal hold blocks destruction only, and never grants access.
  if (memory.legalHold && operation === "delete") return refuse("legal_hold");

  // 8. Trust.
  if (memory.trust === "unverified") return refuse("trust_restricted");

  // A non-deny layer (redact/quarantine) still narrows the result.
  if (layer) return { effect: layer.effect, reason: layer.reason, policyVersion: POLICY_VERSION };
  return allow();
}

/**
 * Resolve explicit layers: precedence first, then restriction.
 *
 * Without the second step a permissive high layer would override a restrictive low
 * one, which is how a tenant policy ends up weaker than the memory policy beneath
 * it. On a tie the earlier layer wins, so the outcome does not depend on the order
 * the caller supplied.
 */
function resolveLayers(
  layers: V6EvaluationInput["policy"],
): { effect: DecisionEffect; reason: DecisionReason } | undefined {
  if (!layers || layers.length === 0) return undefined;
  const ordered = [...layers].sort(
    (a, b) => PRECEDENCE_ORDER.indexOf(a.source) - PRECEDENCE_ORDER.indexOf(b.source),
  );
  let best: (typeof ordered)[number] | undefined;
  for (const layer of ordered) {
    if (best === undefined || EFFECT_RANK[layer.effect] > EFFECT_RANK[best.effect]) best = layer;
  }
  return best ? { effect: best.effect, reason: best.reason } : undefined;
}

/**
 * A short, stable, content-free explanation.
 *
 * Bounded by construction: two fixed sentences from closed vocabularies, so it
 * cannot carry a tenant id, a memory id, or content no matter what the decision was.
 * That is the property that makes it safe to log, and it is why this returns a
 * string rather than a structured object a caller could extend with anything.
 */
export function explainV6Decision(decision: V6EvaluationResult): string {
  const permitted =
    decision.effect === "allow"
      ? `permitted by policy ${decision.policyVersion}`
      : `refused by policy ${decision.policyVersion}: ${decision.reason}`;
  return `V6 decision ${decision.effect} (${decision.reason}) — ${permitted}. No memory content is included in this explanation.`;
}