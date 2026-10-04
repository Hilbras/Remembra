/**
 * V6 policy decision audit and redaction (V6-T08).
 *
 * A decision log that records *who asked what and what was refused* is exactly the
 * surface where a memory id, a content snippet or a credential would end up being
 * written. V5's `memory_audit` table is keyed by `memory_id`, so a decision log built
 * the same way would leak existence: "access denied to `secret-key-42`" is a
 * disclosure in a log a lower-privilege reader may see.
 *
 * So this log is keyed by **decision**, with no resource identifier at all. What it
 * carries is the actor, the tenant, the operation, the policy version, the effect, the
 * reason, and the *class* of resource — never which resource.
 *
 * Three properties, each mutation-checked:
 *
 *  1. **Content-free.** No content, no resource id, no secret, no provider payload.
 *     The schema is `.strict()`, so an added content field fails validation instead of
 *     being silently accepted into a log.
 *  2. **Bounded.** Correlation ids are opaque handles with a length ceiling; the log
 *     itself is bounded, and the drop count is reported rather than silent — an audit
 *     log that quietly discards evidence is worse than a small one, because it is
 *     trusted.
 *  3. **Tenant-filtered and paginated.** A query without an organization is refused
 *     rather than returning everything, and pages neither overlap nor skip.
 */
import { z } from "zod";
import { RemembraError } from "./errors.js";
import { DECISION_EFFECTS, DECISION_REASONS, POLICY_VERSION } from "./v6-policy.js";
import type { V6EvaluationResult } from "./v6-policy-evaluator.js";
import type { V6RequestContext } from "./v6-request-context.js";
import type { V6DirectOperation } from "./v6-service-policy.js";

/**
 * The class of resource a decision was about, never the resource.
 *
 * Deliberately coarse: "tenant-memory" tells an operator enough to investigate and
 * nothing that would confirm a record exists. `secret-key-42` would do the latter.
 */
export const ResourceClass = [
  "tenant-memory",
  "memory-export",
  "provider-request",
  "policy-document",
  "recovery-operation",
] as const;
export type ResourceClassName = (typeof ResourceClass)[number];

/** Correlation ids are opaque handles: bounded length *and* a handle alphabet. */
export const MAX_CORRELATION_ID = 64;
const CORRELATION_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Credential shapes that a length limit and a character class cannot catch.
 *
 * A bounded field is still a field: 23 characters of a real key fit comfortably, and
 * `sk-abc123def456ghi789jkl` is a perfectly legal handle by charset. So the guard is
 * a shape denylist, not a length check — the same shapes `redactForLog` recognises,
 * applied before the value is stored rather than after.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/i,
  /\bBearer\s/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

/** A page is bounded, and the ceiling is itself small enough to be a real limit. */
export const MAX_AUDIT_PAGE = 200;
const DEFAULT_MAX_EVENTS = 10_000;

/** The bounded, content-free event. `.strict()` — it is written to a log. */
export const V6_POLICY_AUDIT_SCHEMA = z
  .object({
    at: z.number().int().min(0),
    organizationId: z.string().min(1).max(128),
    projectId: z.string().max(128).optional(),
    userId: z.string().max(128).optional(),
    agentId: z.string().max(128).optional(),
    operation: z.enum([
      "store", "read", "update", "delete", "archive", "revive", "history", "relate", "batch", "snapshot",
    ] as const satisfies readonly V6DirectOperation[]),
    effect: z.enum(DECISION_EFFECTS),
    reason: z.enum(DECISION_REASONS),
    policyVersion: z.string().regex(/^v6-policy\/\d+\.\d+\.\d+$/),
    resourceClass: z.enum(ResourceClass),
    authMethod: z.string().min(1).max(32),
    correlationId: z.string().min(1).max(MAX_CORRELATION_ID).regex(CORRELATION_RE).optional(),
  })
  .strict();
export type V6PolicyAuditEvent = z.infer<typeof V6_POLICY_AUDIT_SCHEMA>;

function invalid(detail: string): never {
  throw new RemembraError("INVALID_INPUT", `v6 audit: ${detail}`);
}

/**
 * Redact content and credential shapes from any text bound for a log.
 *
 * The patterns are the same shapes `SensitiveDataDetector` already recognises, so
 * the two cannot disagree about what counts as a secret. Applied to free text —
 * error messages, provider diagnostics — where no schema can guarantee a field name.
 */
export function redactForLog(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:API_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:AWS_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[REDACTED:GITHUB_TOKEN]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, "[REDACTED:EMAIL]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED:SSN]")
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, "[REDACTED:CARD]")
    .replace(/\bBearer\s+\S+/gi, "[REDACTED:AUTH]");
}

export interface AuditEventInput {
  decision: V6EvaluationResult;
  operation: V6DirectOperation;
  context: V6RequestContext;
  resourceClass: ResourceClassName;
  now: number;
  correlationId?: string;
}

/**
 * Build one audit event.
 *
 * Everything is validated on the way out, so a malformed decision or a content-shaped
 * correlation id fails here rather than at a query time when nobody is watching.
 */
export function buildPolicyAuditEvent(input: AuditEventInput): V6PolicyAuditEvent {
  if (input.correlationId !== undefined) {
    if (input.correlationId.length > MAX_CORRELATION_ID) {
      invalid(`correlation id exceeds ${MAX_CORRELATION_ID} characters`);
    }
    if (!CORRELATION_RE.test(input.correlationId)) {
      invalid("correlation id must be an opaque handle: letters, digits, dot, underscore, colon or dash");
    }
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.test(input.correlationId)) {
        // Redacted form is a last resort, but a correlation id is opaque by contract,
        // so a value that matches a credential shape is a mistake rather than a
        // recoverable one.
        invalid(`correlation id must be an opaque handle, but it matched a credential shape (${redactForLog(input.correlationId)})`);
      }
    }
  }
  const p = input.context.principal;
  const candidate = {
    at: input.now,
    organizationId: p.organizationId,
    ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
    ...(p.userId !== undefined ? { userId: p.userId } : {}),
    ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
    operation: input.operation,
    effect: input.decision.effect,
    reason: input.decision.reason,
    policyVersion: input.decision.policyVersion || POLICY_VERSION,
    resourceClass: input.resourceClass,
    authMethod: input.context.authMethod,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
  const parsed = V6_POLICY_AUDIT_SCHEMA.safeParse(candidate);
  if (!parsed.success) {
    invalid(parsed.error.issues.map((i) => `${i.path.join(".") || "event"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

/**
 * An operator-facing explanation.
 *
 * Two fixed sentences from closed vocabularies. It cannot carry a resource id or any
 * content because there is nowhere in it to put one — which is the property that
 * makes it safe to return from an API to a user with a lower clearance than the
 * resource.
 */
export function explainDecision(
  decision: V6EvaluationResult,
  options: { resourceClass?: ResourceClassName } = {},
): string {
  const verb = decision.effect === "allow" ? "permitted" : decision.effect === "deny" ? "refused" : `handled as ${decision.effect}`;
  const scope = options.resourceClass ? ` for a ${options.resourceClass} resource` : "";
  return (
    `V6 policy ${decision.effect}${scope}: ${decision.reason} under ${decision.policyVersion}. ` +
    `The decision is recorded without any resource identifier or content, so this ` +
    `explanation cannot confirm whether a specific record exists.`
  );
}

export interface AuditQuery {
  readonly organizationId: string;
  readonly limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
}

export interface AuditQueryResult {
  readonly events: readonly V6PolicyAuditEvent[];
  readonly nextCursor?: string;
  /** How many events the log holds for this tenant, regardless of page. */
  readonly totalRetained: number;
  /** How many were discarded by the retention ceiling. Never silent. */
  readonly dropped: number;
}

/**
 * A bounded, tenant-scoped decision log.
 *
 * Retention is a ring: the oldest events are dropped once `maxEvents` is reached, and
 * `dropped` counts them. Silently truncating an audit log would leave a reader
 * believing the record is complete when it is not, which is worse than a short log
 * that admits its own gap.
 */
export class PolicyAuditLog {
  readonly #events: V6PolicyAuditEvent[] = [];
  readonly #maxEvents: number;
  #dropped = 0;

  constructor(options: { maxEvents?: number } = {}) {
    const max = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isInteger(max) || max < 1) invalid("maxEvents must be a positive integer");
    this.#maxEvents = max;
  }

  /** Record a decision. Validation already happened in `buildPolicyAuditEvent`. */
  append(event: V6PolicyAuditEvent): void {
    const parsed = V6_POLICY_AUDIT_SCHEMA.safeParse(event);
    if (!parsed.success) invalid("refusing to append an event that does not satisfy the audit schema");
    this.#events.push(parsed.data);
    while (this.#events.length > this.#maxEvents) {
      this.#events.shift();
      this.#dropped++;
    }
  }

  get dropped(): number {
    return this.#dropped;
  }

  /**
   * Query, newest first.
   *
   * The organization filter is mandatory and applied *before* paging, so a page size
   * can never leak rows belonging to another tenant.
   */
  query(q: AuditQuery): AuditQueryResult {
    if (!q.organizationId) invalid("an audit query requires an organizationId");
    const limit = q.limit ?? MAX_AUDIT_PAGE;
    if (!Number.isInteger(limit) || limit < 1) invalid("limit must be a positive integer");
    if (limit > MAX_AUDIT_PAGE) invalid(`limit exceeds the page ceiling of ${MAX_AUDIT_PAGE}`);

    const scoped = this.#events
      .filter((e) => e.organizationId === q.organizationId)
      .slice()
      .sort((a, b) => b.at - a.at);

    const start = q.cursor === undefined ? 0 : Number(q.cursor);
    if (!Number.isInteger(start) || start < 0 || start > scoped.length) invalid("cursor is not a valid offset");
    const page = scoped.slice(start, start + limit);
    const next = start + page.length;

    return {
      events: page,
      ...(next < scoped.length ? { nextCursor: String(next) } : {}),
      totalRetained: scoped.length,
      dropped: this.#dropped,
    };
  }
}