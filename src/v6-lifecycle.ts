/**
 * V6 expiration and lifecycle orchestration (V6-T11).
 *
 * Five things here all sound like "the memory is gone" — retention, legal hold,
 * archive, deletion, supersession — and the failure mode is not a wrong answer but a
 * *destructive* wrong one. Deleting a record under a retention policy when a legal hold
 * applied is unrecoverable, and no test that inspects a return value will catch it.
 * So the design keeps them separate by construction and reports which one happened.
 *
 * The clock is a parameter, never ambient. A module reading `Date.now()` internally
 * cannot be tested at a boundary, and boundaries are the only interesting part.
 *
 * Two decisions worth stating outright:
 *
 *  - **Expiry is an instant in UTC milliseconds, and a malformed timestamp is refused
 *    rather than coerced.** Coercing to `NaN` or `0` turns a typo into "expires
 *    immediately" or "never expires" — both silent corruption of retention intent.
 *  - **A legal hold is absolute here.** There is deliberately no `force` flag. An
 *    operator override is a legitimate need, but it belongs in a separate, audited path
 *    with its own audit trail; burying a bypass in a job parameter is how holds stop
 *    meaning anything.
 */
import { RemembraError } from "./errors.js";

/**
 * Lifecycle failures carry an existing `ErrorCode` rather than a private vocabulary.
 *
 * `INVALID_INPUT` and `NOT_FOUND` already exist and already map to HTTP 400 and 404;
 * inventing `INVALID_TIMESTAMP`/`RECORD_NOT_FOUND` would have given the same two
 * situations two codes, and left the HTTP layer with no mapping for either.
 */
export class LifecycleError extends RemembraError {
  constructor(code: "INVALID_INPUT" | "NOT_FOUND", message: string) {
    super(code, message);
    this.name = "LifecycleError";
  }
}

/** Closed expiry vocabulary. No "unknown" state — an unparseable record fails instead. */
export type ExpirationState = "active" | "expiring" | "expired" | "never_expires";

/** Closed action vocabulary. Each is a distinct disposition, never an alias. */
export const LIFECYCLE_ACTIONS = ["expire", "archive", "delete", "supersede", "renew"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export interface LifecycleRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly content: string;
  /** Instant of expiry, in UTC milliseconds. Absent means it never expires. */
  readonly expiresAt?: number;
  readonly retention: "pinned" | "persistent" | "ephemeral" | "decaying" | "neverExpire";
  readonly legalHold: boolean;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly supersededBy?: string;
  readonly renewals: number;
  /** Monotonic. Moves only when an action is actually applied. */
  readonly version: number;
}

/**
 * Parse an expiry from untrusted input.
 *
 * An ISO-8601 instant with an explicit offset or `Z` — never a bare local-time string,
 * which resolves to a different instant on different machines and so expires the same
 * data at different times per deployment.
 */
export function parseExpiry(value: string | number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  let ms: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new LifecycleError("INVALID_INPUT", `expiry is not a valid instant: ${value}`);
    }
    return Math.trunc(value);
  }
  const text = value.trim();
  if (text === "") throw new LifecycleError("INVALID_INPUT", "expiry timestamp is empty");
  // Require an explicit zone. A naive local timestamp is the bug this rejects.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    throw new LifecycleError(
      "INVALID_INPUT",
      `expiry "${text}" must carry an explicit UTC offset or Z; a local timestamp expires at different instants per machine`,
    );
  }
  ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new LifecycleError("INVALID_INPUT", `expiry "${text}" is not a valid timestamp`);
  }
  return ms;
}

export interface ExpirationEvaluation {
  readonly state: ExpirationState;
  /** Whether a normal search or context build may return this record. */
  readonly includeInRetrieval: boolean;
  /** What may be done to it right now. */
  readonly disposition: "retrievable" | "expirable" | "blocked_by_hold" | "archived" | "superseded" | "deleted";
  /** Milliseconds until expiry, or undefined when it does not apply. */
  readonly expiresInMs?: number;
}

/**
 * Evaluate expiration against an explicit clock.
 *
 * Expiry is **exclusive**: a record whose `expiresAt` equals `now` is expired. Anything
 * else makes "expires at T" mean "usable until T", which is the more surprising reading.
 *
 * Clock skew widens an *announcement*, never the expiry itself — so a record within the
 * skew window is `expiring` (visible, honest) rather than early-expired.
 */
export function evaluateExpiration(
  record: LifecycleRecord,
  options: { now: number; skewToleranceMs?: number; includeExpired?: boolean },
): ExpirationEvaluation {
  const skew = options.skewToleranceMs ?? 0;

  // Dispositions that are not about the clock are reported as-is, so a caller reading
  // `state` is never told "active" for a record that is on hold or archived.
  if (record.deleted) return { state: "never_expires", includeInRetrieval: false, disposition: "deleted" };
  if (record.supersededBy !== undefined) {
    return { state: "never_expires", includeInRetrieval: false, disposition: "superseded" };
  }
  if (record.archived) return { state: "never_expires", includeInRetrieval: false, disposition: "archived" };

  if (record.expiresAt === undefined) {
    return {
      state: "never_expires",
      includeInRetrieval: true,
      disposition: record.legalHold ? "blocked_by_hold" : "retrievable",
    };
  }

  const expiresInMs = record.expiresAt - options.now;
  // Exclusive at the boundary.
  if (expiresInMs <= 0) {
    return {
      state: "expired",
      includeInRetrieval: options.includeExpired === true,
      disposition: record.legalHold ? "blocked_by_hold" : "expirable",
      expiresInMs,
    };
  }
  if (expiresInMs <= skew) {
    return { state: "expiring", includeInRetrieval: true, disposition: "retrievable", expiresInMs };
  }
  return { state: "active", includeInRetrieval: true, disposition: "retrievable", expiresInMs };
}

export interface LifecycleActionResult {
  readonly applied: boolean;
  readonly record: LifecycleRecord;
  /** Why it did not apply. Absent when it did. */
  readonly blockedBy?: "legal_hold" | "already_deleted" | "already_applied" | "not_expired" | "renewal_limit";
  /** What actually happened, named distinctly per action. */
  readonly disposition?: "expired" | "archived" | "deleted" | "superseded" | "renewed";
}

export interface ActionOptions {
  readonly now: number;
  readonly supersededBy?: string;
  readonly renewForMs?: number;
  readonly maxRenewals?: number;
}

/**
 * Apply one lifecycle action.
 *
 * Returns a *new* record; nothing is mutated in place, so a rejected action leaves the
 * caller's record exactly as it was. Every rejection names its reason, because "nothing
 * happened" and "a hold stopped it" lead to different follow-ups.
 */
export function applyLifecycleAction(
  record: LifecycleRecord,
  action: LifecycleAction,
  options: ActionOptions,
): LifecycleActionResult {
  if (record === undefined || record === null) {
    throw new LifecycleError("NOT_FOUND", "no record to act on");
  }

  // A deleted record is terminal. Resurrection is the failure mode restart tests look
  // for: a crash between the delete and the audit write must not leave it live again.
  if (record.deleted) {
    return { applied: false, record, blockedBy: "already_deleted" };
  }

  // The hold is absolute for every destructive or mutating action. No override
  // parameter exists on this function, by design.
  if (record.legalHold && action !== "supersede") {
    return { applied: false, record, blockedBy: "legal_hold" };
  }

  switch (action) {
    case "delete": {
      const evaluation = evaluateExpiration(record, { now: options.now });
      if (evaluation.state !== "expired") {
        // Retention is not a licence to delete early: deletion requires the record to
        // actually be expired, or the retention window is decorative.
        return { applied: false, record, blockedBy: "not_expired" };
      }
      return { applied: true, disposition: "deleted", record: { ...record, deleted: true, version: record.version + 1 } };
    }
    case "archive": {
      if (record.archived) return { applied: false, record, blockedBy: "already_applied" };
      return { applied: true, disposition: "archived", record: { ...record, archived: true, version: record.version + 1 } };
    }
    case "supersede": {
      if (options.supersededBy === undefined || options.supersededBy === record.id) {
        throw new LifecycleError("INVALID_INPUT", "supersession requires the id of the superseding record");
      }
      return {
        applied: true,
        disposition: "superseded",
        record: { ...record, supersededBy: options.supersededBy, version: record.version + 1 },
      };
    }
    case "renew": {
      const max = options.maxRenewals ?? 3;
      if (record.renewals >= max) return { applied: false, record, blockedBy: "renewal_limit" };
      const duration = options.renewForMs ?? 0;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new LifecycleError("INVALID_INPUT", "renewal requires a positive duration");
      }
      // Renewed from *now*, not from the old expiry. Extending from the old expiry
      // would let a record renewed long after it expired gain a future date without
      // anyone deciding to renew it now.
      return {
        applied: true,
        disposition: "renewed",
        record: { ...record, expiresAt: options.now + duration, renewals: record.renewals + 1, version: record.version + 1 },
      };
    }
    case "expire": {
      const evaluation = evaluateExpiration(record, { now: options.now });
      if (evaluation.state !== "expired") return { applied: false, record, blockedBy: "not_expired" };
      // Expiry marks the record expirable; it is not itself a deletion. Deleting is a
      // separate, separately-audited step.
      return {
        applied: true,
        disposition: "expired",
        record: { ...record, archived: false, version: record.version + 1 },
      };
    }
    default: {
      const exhaustive: never = action;
      throw new LifecycleError("INVALID_INPUT", `unknown lifecycle action ${String(exhaustive)}`);
    }
  }
}

export interface JobAuditEntry {
  readonly memoryId: string;
  readonly organizationId: string;
  readonly action: LifecycleAction;
  readonly outcome: "applied" | "blocked";
  readonly blockedBy?: string;
  readonly at: number;
}

export interface LifecycleJobResult {
  readonly processed: number;
  readonly deleted: number;
  readonly archived: number;
  readonly skippedLegalHold: number;
  readonly skippedForeignTenant: number;
  readonly exceededLimit: boolean;
  readonly audit: readonly JobAuditEntry[];
}

export interface JobOptions {
  readonly now: number;
  readonly batchLimit?: number;
  readonly organizationId?: string;
}

/**
 * Run one bounded, tenant-scoped lifecycle job pass.
 *
 * Bounded: `batchLimit` is a ceiling and the overflow is *reported*, because a job that
 * silently processes only the first N records looks like a job that finished.
 *
 * Tenant-aware: a job scoped to one tenant counts the foreign rows it skipped and
 * leaves them untouched.
 *
 * Rechecks policy: expiration is evaluated here, not read off the record. A record
 * claiming to be expiring is not evidence — a corrupted or forged field must not be
 * able to drive a deletion.
 *
 * Idempotent: a restarted job finds nothing left to do, so no record is deleted twice.
 */
export function runLifecycleJob(
  records: readonly LifecycleRecord[],
  options: JobOptions,
): LifecycleJobResult & { readonly updated: readonly LifecycleRecord[] } {
  const limit = options.batchLimit ?? 100;
  let processed = 0;
  let deleted = 0;
  let archived = 0;
  let skippedLegalHold = 0;
  let skippedForeignTenant = 0;
  let exceededLimit = false;
  const audit: JobAuditEntry[] = [];
  // The job's effects have to be *returned*, not merely counted. An earlier version
  // counted deletions without returning the updated records, so a restarted job found
  // the same expired records again and deleted them twice -- the exact duplication the
  // idempotence criterion forbids.
  const updated: LifecycleRecord[] = [];

  for (const record of records) {
    if (options.organizationId !== undefined && record.organizationId !== options.organizationId) {
      skippedForeignTenant++;
      updated.push(record);
      continue;
    }
    if (processed >= limit) {
      exceededLimit = true;
      // Untouched records are still returned, so a caller persisting `updated` does
      // not accidentally drop the overflow.
      updated.push(record);
      continue;
    }
    processed++;

    if (record.legalHold) {
      // Counted, never silently dropped: a hold that blocked work must be visible in
      // the job's own result.
      skippedLegalHold++;
      audit.push({
        memoryId: record.id,
        organizationId: record.organizationId,
        action: "delete",
        outcome: "blocked",
        blockedBy: "legal_hold",
        at: options.now,
      });
      updated.push(record);
      continue;
    }

    // Re-evaluate rather than trusting `record.expiresAt` blindly.
    const evaluation = evaluateExpiration(record, { now: options.now });
    if (evaluation.state !== "expired") {
      updated.push(record);
      continue;
    }

    const result = applyLifecycleAction(record, "delete", { now: options.now });
    if (result.applied) {
      deleted++;
      updated.push(result.record);
    } else {
      updated.push(record);
    }
    audit.push({
      memoryId: record.id,
      organizationId: record.organizationId,
      action: "delete",
      outcome: result.applied ? "applied" : "blocked",
      ...(result.blockedBy !== undefined ? { blockedBy: result.blockedBy } : {}),
      at: options.now,
    });
  }

  return {
    processed,
    deleted,
    archived,
    skippedLegalHold,
    skippedForeignTenant,
    exceededLimit,
    audit,
    updated,
  };
}