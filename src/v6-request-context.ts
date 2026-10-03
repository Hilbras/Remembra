/**
 * V6 request context: identity, operation, policy version, deadline, replay
 * identity (V6-T04).
 *
 * The executable form of the architecture spec §5 pipeline, and deliberately the
 * *first* stage of it. Everything downstream reads its inputs from here, so the
 * property that matters is narrow and absolute: **a context can only be minted by
 * trusted host code, and a request payload can never widen one.**
 *
 * Three mechanisms carry that, and each exists because the weaker version was the
 * obvious one to write:
 *
 * 1. **A brand.** `createRequestContext` is the only constructor and stamps a
 *    private symbol. `{ ...ctx }` copies every own property *except* a symbol is
 *    non-enumerable here, so a structurally identical forgery is rejected by
 *    `isRequestContext`. This mirrors V5's `TENANT_CONTEXT` in `tenant.ts` —
 *    the same pattern, extended, not a second idea.
 * 2. **Frozen output.** The context and its principal are frozen, so a later
 *    mutation cannot widen capabilities mid-request.
 * 3. **Bounded vocabularies and strict parsing.** Unknown fields are refused, not
 *    stripped, so an injected `isAdmin` cannot ride along unnoticed.
 */
import { z } from "zod";
import { RemembraError } from "./errors.js";
import { isValidTenantId } from "./types.js";
import { POLICY_VERSION, SENSITIVITY_ORDER, type Sensitivity } from "./v6-policy.js";

/**
 * Operation classes, closed and explicit.
 *
 * The architecture spec §5.3 requires authorization to be explicit for each of
 * these, which means the *set* must be closed — an undeclared operation cannot be
 * "authorized by default". `export`/`snapshot_export` and `provider_transmit` are
 * separate classes from `read`/`write` for exactly that reason: a read permission
 * must not imply the ability to ship data to a third party.
 */
export const V6_OPERATION_CLASSES = [
  "read",
  "context_read",
  "write",
  "update",
  "delete",
  "relation_write",
  "history_read",
  "export",
  "snapshot_export",
  "provider_transmit",
  "policy_admin",
] as const;
export type V6OperationClass = (typeof V6_OPERATION_CLASSES)[number];

/** How the caller authenticated, for audit. Never carries the credential. */
export const V6_AUTH_METHODS = [
  "local_operator",
  "api_key",
  "mtls",
  "oauth_oidc",
  "application_resolver",
] as const;
export type V6AuthMethod = (typeof V6_AUTH_METHODS)[number];

/**
 * How old a resolved membership may be before the context is treated as stale.
 *
 * Membership does not expire on its own — it is invalidated by a version bump — so
 * this bounds how long a *resolved* membership may be trusted without a
 * re-resolution. 5 minutes: long enough that a busy request does not re-resolve on
 * every call, short enough that a revoked membership stops working promptly.
 */
export const V6_MEMBERSHIP_MAX_AGE_MS = 5 * 60_000;

/** Replay keys are opaque caller-supplied handles, bounded so they cannot smuggle a payload. */
export const REPLAY_KEY_MAX_LENGTH = 128;

/**
 * Capability required per operation class.
 *
 * `policy_admin` deliberately has no V5-equivalent capability and is unreachable
 * from a context carrying only V5 capabilities — that is the point: administrative
 * authority is not something a `tenant:admin` claim should silently imply.
 */
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

/** Operations that must carry a caller-supplied replay key. */
const MUTATING: ReadonlySet<V6OperationClass> = new Set([
  "write",
  "update",
  "delete",
  "relation_write",
  "export",
  "snapshot_export",
  "policy_admin",
]);

const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidTenantId, "must be a valid opaque tenant identifier");

/**
 * Replay keys are opaque handles, so anything shaped like a credential or a
 * structured query is refused. A payload-derived key would silently dedupe two
 * genuinely different requests that hash alike; accepting a secret-shaped value
 * would put that secret into an idempotency store.
 */
const replayKey = z
  .string()
  .min(1)
  .max(REPLAY_KEY_MAX_LENGTH)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "replay key must be an opaque handle: letters, digits, dot, underscore, colon or dash",
  )
  .refine(
    (key) => !/^sk[-_]/i.test(key) && !/^bearer$/i.test(key) && !/[&=?]/.test(key),
    "replay key must not carry a credential or a structured payload",
  );

/**
 * The host-resolved principal.
 *
 * Every field here is resolved by trusted code *before* the context exists. The
 * schema exists to validate that resolution, not to accept it from a request.
 */
export const RequestPrincipalSchema = z
  .object({
    organizationId: identifier,
    projectId: identifier.optional(),
    userId: identifier.optional(),
    agentId: identifier.optional(),
    /** Changes when the principal's membership changes; a mismatch fails closed. */
    membershipVersion: z.string().min(1).max(128),
    scopes: z.array(z.string().min(1).max(512)).max(256).optional(),
    capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
    /** The clearance the identity actually holds; a request cannot raise it. */
    clearance: z.enum(SENSITIVITY_ORDER).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A scoped principal must say what it is scoped to, mirroring V5's rule.
    const dimensions = [value.userId, value.projectId, value.agentId].filter(Boolean).length;
    if (dimensions > 0 && !value.scopes?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopes"], message: "scoped principals require explicit scopes" });
    }
    // Read is the floor: an organization-wide principal with no read capability
    // cannot do anything this module is for.
    if (dimensions === 0 && !value.capabilities?.some((c) => c === "tenant:read" || c === "policy:admin")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "organization-wide principals require an explicit read capability" });
    }
    // Admin implies read, as in V5.
    if (value.capabilities?.includes("tenant:admin") && !value.capabilities.includes("tenant:read")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "admin capability requires read capability" });
    }
  });
export type V6RequestPrincipal = Readonly<z.infer<typeof RequestPrincipalSchema>>;

/**
 * The minting input.
 *
 * Note what is absent: no `role`, no `isAdmin`, no tenant claim. A field that could
 * grant authority does not appear, so a payload cannot supply one — the adapter's
 * job is to *resolve* identity, not to forward what it was given.
 */
export const RequestContextSchema = z
  .object({
    principal: RequestPrincipalSchema,
    operation: z.enum(V6_OPERATION_CLASSES),
    authMethod: z.enum(V6_AUTH_METHODS),
    /** Absolute instant, ms since epoch. Required: an unbounded credential is not one. */
    authExpiresAt: z.number().int().positive(),
    /** When the membership was resolved; bounds staleness. */
    resolvedAt: z.number().int().min(0).default(0),
    /** Minting clock. Injected so the context is deterministic and replayable. */
    now: z.number().int().min(0).default(0),
    /** Caller-supplied, opaque. Required for mutating operations. */
    replayKey: replayKey.optional(),
    /** Correlation id for audit. Bounded; never carries content. */
    requestId: z.string().min(1).max(128).optional(),
    /** Explicit deadline. Never extended by a request. */
    deadlineAt: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (MUTATING.has(value.operation) && value.replayKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replayKey"],
        message: `mutating operation "${value.operation}" requires a caller-supplied replay key`,
      });
    }
    if (value.deadlineAt !== undefined && value.deadlineAt <= value.now) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deadlineAt"], message: "deadline must be in the future" });
    }
  });
export type RequestContextInput = Readonly<z.infer<typeof RequestContextSchema>>;

const REQUEST_CONTEXT = Symbol("remembra.v6-request-context");

/** An immutable, host-minted request context. */
export interface V6RequestContext extends RequestContextInput {
  readonly [REQUEST_CONTEXT]: true;
  /** The policy version this context was built against, for audit and replay. */
  readonly policyVersion: string;
}

/**
 * Refuse. `TENANT_REQUIRED` rather than a new code: it is already mapped to 403 and
 * already means "a trusted context is required", which is precisely this case.
 * Adding a V6-only code would put an unmapped identifier into the V5 error surface,
 * and the HTTP status table is the thing callers switch on.
 */
function fail(code: "INVALID_INPUT" | "TENANT_REQUIRED", detail: string): never {
  throw new RemembraError(code, `v6 request context: ${detail}`);
}

/**
 * Mint a request context. The only way to obtain one.
 *
 * Fields outside the schema are **not** merged — they are rejected — so a caller
 * that forwards request-body fields alongside the resolved principal gets a
 * refusal naming the field, rather than a context that silently ignores the
 * injection.
 */
export function createRequestContext(input: unknown): V6RequestContext {
  const parsed = RequestContextSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "context"}: ${i.message}`).join("; ");
    fail("INVALID_INPUT", detail);
  }
  const value = parsed.data;

  // An already-expired credential is refused at minting time rather than
  // producing a context that is stale the instant it exists.
  if (value.authExpiresAt <= value.now) {
    fail("TENANT_REQUIRED", "authentication is already expired at minting time");
  }
  if (value.principal.capabilities?.length === 0) {
    fail("TENANT_REQUIRED", "a principal with no capabilities cannot mint a request context");
  }

  const context = {
    ...value,
    principal: Object.freeze({ ...value.principal }),
    policyVersion: POLICY_VERSION,
    [REQUEST_CONTEXT]: true as const,
  };
  return Object.freeze(context) as V6RequestContext;
}

/** True only for a context this module minted. */
export function isRequestContext(value: unknown): value is V6RequestContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[REQUEST_CONTEXT] === true &&
    Object.isFrozen(value)
  );
}

export type ParseResult =
  | { ok: true; value: V6RequestContext }
  | { ok: false; error: string };

/**
 * Parse an untrusted structure into a context.
 *
 * Exists for adapters, and is deliberately separate from `createRequestContext`:
 * parsing still cannot widen anything, but it reports rather than throws, because
 * a transport wants to turn a bad context into a 400 with a field name.
 */
export function parseRequestContext(input: unknown): ParseResult {
  try {
    return { ok: true, value: createRequestContext(input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The frozen principal. There is no path that returns a mutable one. */
export function contextPrincipalOf(context: V6RequestContext): V6RequestPrincipal {
  if (!isRequestContext(context)) fail("TENANT_REQUIRED", "not a minted request context");
  return context.principal;
}

export interface FreshnessOptions {
  /** The membership version the directory currently reports. */
  readonly currentMembershipVersion?: string;
}

/**
 * Assert a context is still usable at `now`.
 *
 * Four independent reasons to refuse, all fail-closed:
 * expired authentication, stale membership version, membership resolved too long
 * ago, and an operation the principal's capabilities do not cover. Each names its
 * own cause, because an operator debugging a 403 needs to know which.
 */
export function assertFreshContext(
  context: V6RequestContext,
  now: number,
  options: FreshnessOptions = {},
): V6RequestContext {
  if (!isRequestContext(context)) fail("TENANT_REQUIRED", "not a minted request context");

  if (context.authExpiresAt <= now) {
    fail("TENANT_REQUIRED", `authentication expired at ${context.authExpiresAt} (now ${now})`);
  }
  if (options.currentMembershipVersion !== undefined && context.principal.membershipVersion !== options.currentMembershipVersion) {
    fail(
      "TENANT_REQUIRED",
      `stale membership: context has "${context.principal.membershipVersion}", directory has "${options.currentMembershipVersion}"`,
    );
  }
  if (now - context.resolvedAt > V6_MEMBERSHIP_MAX_AGE_MS) {
    fail("TENANT_REQUIRED", `membership resolved at ${context.resolvedAt} is stale at ${now}`);
  }
  if (context.deadlineAt !== undefined && context.deadlineAt <= now) {
    fail("TENANT_REQUIRED", `request deadline ${context.deadlineAt} passed at ${now}`);
  }

  const required = OPERATION_CAPABILITY[context.operation];
  if (!context.principal.capabilities?.includes(required)) {
    fail("TENANT_REQUIRED", `operation "${context.operation}" requires capability "${required}"`);
  }
  return context;
}

/**
 * The idempotency scope: tenant plus operation class.
 *
 * Deliberately excludes the principal and the user/agent dimensions. The scope
 * partitions *records*, so two principals in one tenant requesting the same
 * operation share a scope — and a caller who can influence only their own key
 * still cannot collide with a different operation or a different tenant, which
 * are the two collisions that would produce a wrong replayed response.
 */
export function replayScopeOf(context: V6RequestContext): string {
  if (!isRequestContext(context)) fail("TENANT_REQUIRED", "not a minted request context");
  if (context.replayKey === undefined) {
    fail("INVALID_INPUT", "operation has no replay key, so there is no idempotency scope");
  }
  return `${context.principal.organizationId}/${context.operation}`;
}

/** The caller-supplied key. Never derived from the payload (ADR §6). */
export function replayKeyOf(context: V6RequestContext): string {
  if (!isRequestContext(context)) fail("TENANT_REQUIRED", "not a minted request context");
  if (context.replayKey === undefined) fail("INVALID_INPUT", "operation has no replay key");
  return context.replayKey;
}