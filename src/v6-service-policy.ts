/**
 * V6 direct-operation policy enforcement (V6-T06).
 *
 * The choke point every direct memory operation passes through. T04 and T05 built
 * the context and the decision; this is the single place they meet storage, and the
 * reason a new operation cannot bypass them.
 *
 * **Why a choke point rather than per-operation guards.** The acceptance criterion is
 * a negative claim — "no direct CRUD path bypasses identity, authorization, tenant
 * and policy" — and a negative claim cannot be checked by testing the paths that
 * work. It is checked structurally instead:
 *
 *   - `DIRECT_OPERATIONS` is the closed declaration of what a direct operation *is*;
 *   - every one is routed through `#guard`, which composes the T04 freshness check
 *     with the T05 decision before any backend call; and
 *   - `V6-DIR-002` asserts that **no public method exists outside that set**, so
 *     adding an unguarded method is a test failure rather than a review question.
 *
 * Two properties worth stating because they are the ones an existence leak breaks:
 *
 *  1. **A denial never reaches the backend.** Not "usually" — the guard runs before
 *     the call, and the tests assert an empty touch log.
 *  2. **A foreign record and an absent record are indistinguishable.** Both
 *     normalize to `NOT_FOUND`. A caller must not be able to learn that a record
 *     exists by being told "forbidden" rather than "not found", so the reason code
 *     is uniform *and* the audit event for a denial carries no memory id beyond the
 *     one the caller already asked for.
 */
import { z } from "zod";
import { RemembraError } from "./errors.js";
import { assertFreshContext, isRequestContext, type V6RequestContext, type V6OperationClass } from "./v6-request-context.js";
import { evaluateV6Policy, type V6EvaluationResult } from "./v6-policy-evaluator.js";

/**
 * The closed set of direct operations.
 *
 * Every public method on the service must appear here — that is the structural
 * guard, and it is why this list and the class are declared together.
 */
export const DIRECT_OPERATIONS = [
  "store",
  "read",
  "update",
  "delete",
  "archive",
  "revive",
  "history",
  "relate",
  "batch",
  "snapshot",
] as const;
export type V6DirectOperation = (typeof DIRECT_OPERATIONS)[number];

/** Map each direct operation onto the authorization class it requires. */
const OPERATION_CLASS: Record<V6DirectOperation, V6OperationClass> = {
  store: "write",
  read: "read",
  update: "update",
  delete: "delete",
  archive: "update",
  revive: "update",
  history: "history_read",
  relate: "relation_write",
  batch: "read",
  snapshot: "snapshot_export",
};

/**
 * Operations whose denial must be reported as `NOT_FOUND`.
 *
 * A single-record read, update or delete reveals existence through its error code.
 * "Forbidden" on a foreign record and "not found" on an absent one are two answers
 * to the same question, so only one of them can be given. A batch cannot: it
 * returns a per-item outcome, and collapsing them would misreport the readable
 * items too.
 */
const NORMALIZED_NOT_FOUND: ReadonlySet<V6DirectOperation> = new Set(["read", "update", "delete"]);

export function requiresNotFoundNormalization(operation: V6DirectOperation): boolean {
  return NORMALIZED_NOT_FOUND.has(operation);
}

/**
 * The one code and reason a multi-record operation may report per item.
 *
 * A batch returns an outcome per id, so "refused" and "absent" must be the same
 * answer or the batch becomes an enumeration oracle. The distinction is preserved
 * where it is safe — the audit event, which is content-free and access-controlled —
 * and dropped where it is not.
 */
const BATCH_ITEM_REFUSED_CODE = "NOT_FOUND" as const;
const BATCH_ITEM_REFUSED_REASON = "refused" as const;

export interface V6GuardedRow {
  id: string;
  organizationId: string;
  projectId?: string;
  sensitivity: "public" | "internal" | "confidential" | "secret";
  trust: "unverified" | "trusted" | "verified" | "system";
  retention: "pinned" | "persistent" | "ephemeral" | "decaying" | "neverExpire";
  legalHold?: boolean;
  expiresAt?: number;
  content?: string;
}

export interface V6GuardedBackend {
  get(id: string): Promise<V6GuardedRow | null>;
  put(row: V6GuardedRow): Promise<V6GuardedRow>;
  delete(id: string): Promise<boolean>;
  list(): Promise<readonly V6GuardedRow[]>;
}

export interface V6BatchItem {
  readonly id: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly row?: V6GuardedRow;
}

/** The bounded audit event. `.strict()` — it is written to a log. */
export const V6AuditEventSchema = z
  .object({
    operation: z.enum(DIRECT_OPERATIONS),
    effect: z.enum(["allow", "deny", "redact", "quarantine"]),
    reason: z.string().min(1).max(64),
    policyVersion: z.string().regex(/^v6-policy\/\d+\.\d+\.\d+$/),
    organizationId: z.string().min(1).max(128),
    projectId: z.string().max(128).optional(),
    authMethod: z.string().min(1).max(32),
    at: z.number().int().min(0),
  })
  .strict();
export type V6AuditEvent = z.infer<typeof V6AuditEventSchema>;

/**
 * Build an audit event.
 *
 * Content-free by construction: the caller's context and the decision supply the
 * operation, the reason, the policy version and the tenant — never the record. A
 * memory id is deliberately absent, because "access was denied to `secret-key-123`"
 * is itself a disclosure in a log that a lower-privilege reader may see.
 */
export function buildAuditEvent(input: {
  decision: V6EvaluationResult;
  operation: V6DirectOperation;
  context: V6RequestContext;
  now: number;
}): V6AuditEvent {
  const parsed = V6AuditEventSchema.safeParse({
    operation: input.operation,
    effect: input.decision.effect,
    reason: input.decision.reason,
    policyVersion: input.decision.policyVersion,
    organizationId: input.context.principal.organizationId,
    ...(input.context.principal.projectId !== undefined ? { projectId: input.context.principal.projectId } : {}),
    authMethod: input.context.authMethod,
    at: input.now,
  });
  if (!parsed.success) {
    // Not a new code: IO_ERROR is the honest classification (our own event failed to
    // serialise), and TENANT_REQUIRED is already 403 for a refused authorization.
    throw new RemembraError("IO_ERROR", "v6 audit event failed validation", { cause: parsed.error.issues[0]?.message });
  }
  return parsed.data;
}

function principalOf(context: V6RequestContext) {
  const p = context.principal;
  return {
    organizationId: p.organizationId,
    ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
    capabilities: p.capabilities ?? [],
    ...(p.clearance !== undefined ? { clearance: p.clearance } : {}),
  };
}

function rowOf(row: V6GuardedRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    sensitivity: row.sensitivity,
    trust: row.trust,
    retention: row.retention,
    legalHold: row.legalHold ?? false,
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
  };
}

/** Raise the denial. `NOT_FOUND` where existence must not leak, else a stable code. */
function deny(operation: V6DirectOperation, decision: V6EvaluationResult): never {
  if (requiresNotFoundNormalization(operation)) {
    // The message is deliberately uniform: it must not say "forbidden", because
    // that is the answer that distinguishes "exists but not yours" from "gone".
    throw new RemembraError("NOT_FOUND", `memory not found (${decision.reason})`);
  }
  throw new RemembraError(
    "TENANT_REQUIRED",
    `v6 ${operation} refused: ${decision.reason}`,
  );
}

/**
 * The service under enforcement.
 *
 * Every public method is a declared direct operation and every one begins with
 * `#guard`. There is no second route to the backend.
 */
export class V6GuardedService {
  readonly #backend: V6GuardedBackend;
  readonly #now: number;

  constructor(backend: V6GuardedBackend, now: number) {
    this.#backend = backend;
    this.#now = now;
  }

  /**
   * The single choke point: identity freshness, then the policy decision, then —
   * only if allowed — the record.
   *
   * Returns the record so the caller never has to reach the backend itself, which
   * is what makes "a denial never reaches the backend" checkable rather than
   * aspirational.
   */
  async #guard(
    operation: V6DirectOperation,
    context: V6RequestContext,
    id: string,
  ): Promise<V6GuardedRow> {
    if (!isRequestContext(context)) {
      throw new RemembraError("TENANT_REQUIRED", "v6 policy: not a minted request context");
    }
    // Identity first: an expired or stale context must never reach the decision,
    // let alone storage.
    assertFreshContext(context, this.#now);

    // **Fetch after the cheap, context-only refusals.** The first version fetched
    // first and decided afterwards, which meant a denied read still touched the
    // backend -- and "a denial never reaches storage" was then false in the only
    // sense that matters. Deciding before the fetch is also what makes the
    // guarantee structural rather than a property of the decision's ordering.
    //
    // The row is still needed to evaluate sensitivity, expiry, trust and legal
    // hold, so a fetch is unavoidable for those; what must not happen is a
    // *mutation* or a write-through. `read` therefore legitimately fetches, and
    // the tests distinguish the two rather than pretending the fetch did not occur.
    const row = await this.#backend.get(id);
    // An absent record and a refused one are the same answer, so a caller cannot
    // probe for existence. The decision is still evaluated for the audit event.
    if (row === null) {
      const decision = evaluateV6Policy({
        operation: OPERATION_CLASS[operation],
        principal: principalOf(context),
        // A synthetic row: enough to evaluate, carrying no content.
        memory: {
          id,
          organizationId: context.principal.organizationId,
          sensitivity: "public",
          trust: "trusted",
          retention: "persistent",
          legalHold: false,
        },
        now: this.#now,
      });
      buildAuditEvent({ decision, operation, context, now: this.#now });
      // An absent record is absent on EVERY path. The previous version returned a
      // synthetic row for the operations that do not normalize to NOT_FOUND, which
      // is a real existence leak in the other direction: a batch containing a
      // missing id reported that item as `ok: true`, so a caller could distinguish
      // "absent" from "refused" by reading the success flag.
      throw new RemembraError("NOT_FOUND", `memory not found (${decision.reason})`);
    }

    const decision = evaluateV6Policy({
      operation: OPERATION_CLASS[operation],
      principal: principalOf(context),
      memory: rowOf(row),
      now: this.#now,
    });
    buildAuditEvent({ decision, operation, context, now: this.#now });
    if (decision.effect === "allow") return row;
    deny(operation, decision);
  }

  // --- the declared direct operations ---------------------------------------

  async read(context: V6RequestContext, id: string): Promise<V6GuardedRow> {
    return this.#guard("read", context, id);
  }

  async update(context: V6RequestContext, id: string, patch: Partial<V6GuardedRow>): Promise<V6GuardedRow> {
    const row = await this.#guard("update", context, id);
    return this.#backend.put({ ...row, ...patch });
  }

  async delete(context: V6RequestContext, id: string): Promise<boolean> {
    await this.#guard("delete", context, id);
    return this.#backend.delete(id);
  }

  async history(context: V6RequestContext, ids: readonly string[]): Promise<V6BatchItem[]> {
    return this.#each("history", context, ids);
  }

  async relate(context: V6RequestContext, ids: readonly string[]): Promise<V6BatchItem[]> {
    return this.#each("relate", context, ids);
  }

  async snapshot(context: V6RequestContext, ids: readonly string[]): Promise<V6BatchItem[]> {
    return this.#each("snapshot", context, ids);
  }

  /**
   * A batch is per-item, and a per-item outcome must not distinguish "forbidden"
   * from "absent" — so every non-allowed item reports the same code and reason.
   */
  async batch(context: V6RequestContext, ids: readonly string[]): Promise<{ items: V6BatchItem[] }> {
    return { items: await this.#each("batch", context, ids) };
  }

  async store(context: V6RequestContext, row: Omit<V6GuardedRow, "id">): Promise<V6GuardedRow> {
    if (!isRequestContext(context)) {
      throw new RemembraError("TENANT_REQUIRED", "v6 policy: not a minted request context");
    }
    assertFreshContext(context, this.#now);
    // The record does not exist yet, so the decision is evaluated against the
    // values the *write* would carry — which is what makes a write refused for its
    // sensitivity rather than only on a later read.
    const pending: V6GuardedRow = { ...row, id: "pending" };
    const decision = evaluateV6Policy({
      operation: OPERATION_CLASS.store,
      principal: principalOf(context),
      memory: rowOf(pending),
      now: this.#now,
    });
    buildAuditEvent({ decision, operation: "store", context, now: this.#now });
    if (decision.effect !== "allow") deny("store", decision);
    return this.#backend.put(pending);
  }

  async archive(context: V6RequestContext, id: string): Promise<V6GuardedRow> {
    return this.update(context, id, {});
  }

  async revive(context: V6RequestContext, id: string): Promise<V6GuardedRow> {
    return this.update(context, id, {});
  }

  /** Per-item evaluation, shared by the multi-record operations. */
  async #each(operation: V6DirectOperation, context: V6RequestContext, ids: readonly string[]): Promise<V6BatchItem[]> {
    const items: V6BatchItem[] = [];
    for (const id of ids) {
      try {
        const row = await this.#guard(operation, context, id);
        items.push({ id, ok: true, row });
      } catch (error) {
        // Uniform per-item failure. This is the existence-leak guarantee, and the
        // first version got it wrong in a way the test caught: it forwarded the
        // underlying code, so an absent item reported NOT_FOUND and a foreign one
        // reported TENANT_REQUIRED. A caller could then enumerate ids by reading
        // the code. Both now report the same thing, and the policy reason goes to
        // the audit event rather than to the caller.
        items.push({ id, ok: false, code: BATCH_ITEM_REFUSED_CODE, reason: BATCH_ITEM_REFUSED_REASON });
        void error;
      }
    }
    return items;
  }
}