import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RequestContextSchema,
  V6_OPERATION_CLASSES,
  V6_AUTH_METHODS,
  V6_MEMBERSHIP_MAX_AGE_MS,
  REPLAY_KEY_MAX_LENGTH,
  createRequestContext,
  parseRequestContext,
  replayScopeOf,
  replayKeyOf,
  assertFreshContext,
  isRequestContext,
  contextPrincipalOf,
  type V6RequestContext,
} from "../v6-request-context.js";
import { RemembraError } from "../errors.js";

/**
 * V6-T04 request-security fixtures.
 *
 * The class of defect this file exists to prevent is a *forged authority*: a
 * caller asserting an identity, tenant, capability, or clearance it does not hold.
 * Every test therefore checks both halves — that the forged input is refused, and
 * that the refusal names the field — because a refusal for an unrelated reason
 * satisfies `assert.throws` just as well as a correct one.
 */

const hostPrincipal = (over: Record<string, unknown> = {}) => ({
  organizationId: "org-a",
  projectId: "p1",
  userId: "u1",
  agentId: "a1",
  membershipVersion: "m-1",
  scopes: ["project/p1"],
  capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  clearance: "secret" as const,
  ...over,
});

const hostContext = (over: Record<string, unknown> = {}) => ({
  principal: hostPrincipal(),
  operation: "read" as const,
  authMethod: "api_key" as const,
  authExpiresAt: 10_000,
  now: 0,
  ...over,
});

test("V6-SEC-001: a context minted by trusted host code is well-formed and branded", () => {
  const ctx = createRequestContext(hostContext());
  assert.equal(isRequestContext(ctx), true);
  // Branded: a plain object with the same fields is not a context, so a caller
  // cannot construct one by spreading fields into a literal.
  assert.equal(isRequestContext({ principal: hostPrincipal(), operation: "read" }), false);
});

test("V6-SEC-002: public fields cannot alter the resolved principal", () => {
  // A request body claiming a different organization, an admin capability, or a
  // higher clearance must not reach the principal. These are refused by name
  // rather than ignored: an adapter that forwards request fields gets a loud
  // failure, not a context that quietly discarded them.
  assert.throws(
    () => createRequestContext(hostContext({ role: "admin", isAdmin: true })),
    (error: unknown) =>
      error instanceof RemembraError && /role|isAdmin/.test(error.message),
    "privilege fields are named in the refusal",
  );

  // And a payload that tries to *replace* the host's principal is refused, rather
  // than the payload's principal winning.
  assert.throws(
    () =>
      createRequestContext({
        ...hostContext(),
        principal: { ...hostPrincipal(), organizationId: "org-evil", capabilities: ["tenant:admin"] },
      }),
    RemembraError,
  );

  // The legitimate case still works, and the host's values are what survive.
  const ctx = createRequestContext(hostContext());
  assert.equal(ctx.principal.organizationId, "org-a");
  assert.equal(ctx.principal.capabilities?.includes("tenant:admin"), false);
  assert.equal(ctx.principal.clearance, "secret", "clearance is host-resolved");
});

test("V6-SEC-003: a forged context — same fields, no brand — is refused", () => {
  const real = createRequestContext(hostContext());

  // Measured, not assumed, because I got this wrong twice. A spread DOES copy
  // symbol keys (the brand survives) but does NOT preserve frozen-ness — so
  // `isRequestContext` rejects the spread on the frozen check alone, and the brand
  // is never what rejects it. That is why the original version of this test passed
  // with the brand check deleted.
  const spread = { ...real };
  assert.equal(Object.isFrozen(spread), false, "precondition: a spread is not frozen");
  assert.deepEqual(
    Object.getOwnPropertySymbols(spread).map(String),
    Object.getOwnPropertySymbols(real).map(String),
    "precondition: a spread does copy the brand symbol",
  );
  assert.equal(isRequestContext(spread), false, "so it is rejected by the frozen check");

  // Re-freeze the copy and the brand is then the only thing that can reject it.
  const refrozen = Object.freeze({ ...real });
  assert.equal(Object.isFrozen(refrozen), true, "precondition: frozen");
  assert.equal(isRequestContext(refrozen), true, "with the brand restored it is valid again");

  // A reconstruction — the shape an attacker would actually build — carries no
  // symbol at all, so it is refused whether frozen or not.
  const rebuilt = Object.freeze({
    principal: real.principal,
    operation: real.operation,
    authMethod: real.authMethod,
    authExpiresAt: real.authExpiresAt,
    resolvedAt: real.resolvedAt,
    now: real.now,
    policyVersion: real.policyVersion,
  });
  assert.equal(isRequestContext(rebuilt), false, "a frozen reconstruction with no brand is refused");
  assert.equal(isRequestContext({ principal: real.principal, operation: real.operation }), false);

  // JSON round-trip is the realistic transport forge: symbols are dropped.
  assert.equal(isRequestContext(JSON.parse(JSON.stringify(real))), false);

  // The real one still passes, so this is about the brand rather than a predicate
  // that rejects everything.
  assert.equal(isRequestContext(real), true);

  assert.throws(
    () => assertFreshContext(rebuilt as never, 0),
    (error: unknown) => error instanceof RemembraError,
  );
});

test("V6-SEC-004: operation classes are an explicit closed set", () => {
  assert.ok(V6_OPERATION_CLASSES.length >= 8, "read/write/update/delete/export/egress plus admin variants");
  assert.deepEqual([...V6_OPERATION_CLASSES].sort(), [
    "context_read", "delete", "export", "history_read", "policy_admin",
    "provider_transmit", "read", "relation_write", "snapshot_export", "update", "write",
  ].sort());
  const bad = RequestContextSchema.safeParse(hostContext({ operation: "escalate" }));
  assert.equal(bad.success, false, "an undeclared operation class is refused");
});

test("V6-SEC-005: authentication strength and method are recorded and bounded", () => {
  for (const method of V6_AUTH_METHODS) {
    const parsed = RequestContextSchema.safeParse(hostContext({ authMethod: method }));
    assert.equal(parsed.success, true, `${method} must be a valid method`);
  }
  assert.equal(RequestContextSchema.safeParse(hostContext({ authMethod: "vibes" })).success, false);
});

test("V6-SEC-006: an expired authentication fails closed", () => {
  const ctx = createRequestContext(hostContext({ authExpiresAt: 1_000 }));
  assert.equal(assertFreshContext(ctx, 999), ctx, "before expiry");
  assert.throws(
    () => assertFreshContext(ctx, 1_000),
    (error: unknown) => error instanceof RemembraError && /expir/i.test(error.message),
    "at the expiry instant the context is no longer fresh",
  );
  assert.throws(() => assertFreshContext(ctx, 5_000), RemembraError);
});

test("V6-SEC-007: stale membership fails closed", () => {
  // A principal whose membershipVersion no longer matches the directory's is no
  // longer authorized, even with valid credentials.
  const ctx = createRequestContext(hostContext());
  assert.equal(assertFreshContext(ctx, 0), ctx);
  assert.throws(
    () => assertFreshContext(ctx, 0, { currentMembershipVersion: "m-2" }),
    (error: unknown) => error instanceof RemembraError && /membership/i.test(error.message),
  );
});

test("V6-SEC-008: a membership older than the ceiling fails closed", () => {
  // Membership versions do not expire on their own; the bound is on how old a
  // resolved membership may be.
  // authExpiresAt must outlive the membership ceiling, or the expiry check fires
  // first and the test proves nothing about staleness.
  const ctx = createRequestContext(
    hostContext({ resolvedAt: 0, authExpiresAt: V6_MEMBERSHIP_MAX_AGE_MS * 10 }),
  );
  // Boundary is inclusive: a membership exactly at the ceiling is still fresh, and
  // one millisecond past it is not. `>` in the implementation is correct and this
  // line pins which side of the boundary is allowed.
  assert.equal(assertFreshContext(ctx, V6_MEMBERSHIP_MAX_AGE_MS - 1), ctx, "just inside the ceiling");
  assert.equal(assertFreshContext(ctx, V6_MEMBERSHIP_MAX_AGE_MS), ctx, "exactly at the ceiling is still fresh");
  assert.throws(
    () => assertFreshContext(ctx, V6_MEMBERSHIP_MAX_AGE_MS + 1),
    (error: unknown) => error instanceof RemembraError && /membership|stale/i.test(error.message),
  );
});

test("V6-SEC-009: an operation the principal lacks is refused, naming the operation", () => {
  // The context is valid; the mismatch is between principal capabilities and the
  // requested operation class. It must fail closed rather than default.
  const ctx = createRequestContext(
    hostContext({
      operation: "export",
      replayKey: "export-1",
      // Deliberately no `tenant:export` capability.
      principal: { ...hostPrincipal(), capabilities: ["tenant:read", "tenant:write"] },
    }),
  );
  assert.throws(
    () => assertFreshContext(ctx, 0),
    (error: unknown) => error instanceof RemembraError && /export/i.test(error.message),
  );
});

test("V6-SEC-010: replay scope is tenant plus operation class, never the principal", () => {
  // Two principals in one tenant requesting the same operation share a scope —
  // that is deliberate: the scope partitions *records*, not callers.
  // `read` is non-mutating and legitimately needs no key, so these contexts
  // declare one explicitly: the property under test is the *scope's* shape, not
  // whether a key is required.
  const a = createRequestContext(hostContext({ operation: "context_read", replayKey: "k1" }));
  const b = createRequestContext(
    hostContext({ operation: "context_read", replayKey: "k1", principal: { ...hostPrincipal(), userId: "u2" } }),
  );
  assert.equal(replayScopeOf(a), replayScopeOf(b), "scope is tenant+operation, not principal");
  const write = createRequestContext(hostContext({ operation: "write", replayKey: "k1" }));

  // A different operation class must not share an idempotency record.
  assert.notEqual(replayScopeOf(a), replayScopeOf(write), "operation class partitions the scope");

  // And a different tenant never shares one.
  const other = createRequestContext(
    hostContext({
      operation: "context_read",
      replayKey: "k1",
      principal: { ...hostPrincipal(), organizationId: "org-b" },
    }),
  );
  assert.notEqual(replayScopeOf(a), replayScopeOf(other), "tenant partitions the scope");
});

test("V6-SEC-011: the replay key is caller-supplied, bounded, and never a secret", () => {
  const ctx = createRequestContext(hostContext({ replayKey: "client-key-1" }));
  assert.equal(replayKeyOf(ctx), "client-key-1");

  assert.equal(
    RequestContextSchema.safeParse(hostContext({ replayKey: "x".repeat(REPLAY_KEY_MAX_LENGTH + 1) })).success,
    false,
    "an over-long key is refused",
  );
  // A payload-derived key would silently dedupe two different requests that hash
  // alike, so a key that looks like content is refused.
  for (const bad of ["sk-abc123def456ghi789", "Bearer abc", "a=b&c=d"]) {
    assert.equal(
      RequestContextSchema.safeParse(hostContext({ replayKey: bad })).success,
      false,
      `a secret-bearing or structured key must be refused: ${bad}`,
    );
  }
});

test("V6-SEC-012: an absent replay key is allowed but produces no dedupe scope", () => {
  // Reads are idempotent and need no key; writes should carry one. A context with
  // none must not fabricate a scope, or every unkeyed request would collide.
  const ctx = createRequestContext(hostContext({ operation: "read" }));
  assert.equal(ctx.replayKey, undefined);
  assert.throws(
    () => replayScopeOf(ctx),
    (error: unknown) => error instanceof RemembraError && /replay|idempot/i.test(error.message),
  );
});

test("V6-SEC-013: the schema refuses unknown fields rather than stripping them", () => {
  const bad = RequestContextSchema.safeParse(hostContext({ isAdmin: true }));
  assert.equal(bad.success, false, "an injected privilege field must not be silently dropped");
});

test("V6-SEC-014: parsing an untrusted payload fails closed and names the field", () => {
  const parsed = parseRequestContext({ principal: hostPrincipal(), operation: "read", injected: true });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /injected/, "the refusal names the offending field");
});

test("V6-SEC-015: contextPrincipalOf returns a frozen principal", () => {
  const ctx = createRequestContext(hostContext());
  const p = contextPrincipalOf(ctx);
  assert.equal(Object.isFrozen(p), true, "a caller must not be able to widen its own capabilities");
});

test("V6-SEC-016: an unauthenticated context cannot be minted", () => {
  // authExpiresAt in the past at minting time is refused outright rather than
  // producing a context that is immediately stale.
  assert.throws(
    () => createRequestContext(hostContext({ authExpiresAt: -1 })),
    (error: unknown) => error instanceof RemembraError && /expir/i.test(error.message),
  );
});

test("V6-SEC-017: the full happy path produces a frozen, self-consistent context", () => {
  const ctx: V6RequestContext = createRequestContext(hostContext());
  assert.equal(Object.isFrozen(ctx), true);
  assert.equal(Object.isFrozen(ctx.principal), true);
  assert.equal(ctx.operation, "read");
  assert.equal(ctx.policyVersion, "v6-policy/1.0.0", "a context carries the policy version it was built against");
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Six of nineteen mutations were not caught by the
// first pass; five were missing rules and one did not compile. Each addition pins
// a rule that the implementation had and nothing observed.
// ---------------------------------------------------------------------------

test("V6-SEC-018: a credential already expired at minting time is refused", () => {
  // R5 survived: every existing context was minted with a future expiry, so the
  // mint-time check was never the thing under test. A context minted from an
  // expired credential is stale the instant it exists, and minting it anyway would
  // hand the caller an object that only fails later, at whatever call site happens
  // to check.
  for (const authExpiresAt of [-1, 0, 5]) {
    assert.throws(
      () => createRequestContext(hostContext({ authExpiresAt, now: 10 })),
      (error: unknown) => error instanceof RemembraError && /expir/i.test(error.message),
      `authExpiresAt ${authExpiresAt} against now=10 must be refused`,
    );
  }
  // The boundary: expiring exactly now is expired.
  assert.throws(() => createRequestContext(hostContext({ authExpiresAt: 10, now: 10 })), RemembraError);
  // One millisecond of life is enough to mint, and the context is then fresh.
  const barely = createRequestContext(hostContext({ authExpiresAt: 11, now: 10 }));
  assert.equal(assertFreshContext(barely, 10), barely);
});

test("V6-SEC-019: a passed deadline fails closed", () => {
  // R8 survived: no context in the first pass carried a deadline, so the check was
  // unobserved. A deadline that is silently ignored turns a bounded request into an
  // unbounded one, which is the whole reason the field exists.
  const ctx = createRequestContext(hostContext({ deadlineAt: 5_000, authExpiresAt: 50_000 }));
  assert.equal(assertFreshContext(ctx, 4_999), ctx, "before the deadline");
  assert.throws(
    () => assertFreshContext(ctx, 5_000),
    (error: unknown) => error instanceof RemembraError && /deadline/i.test(error.message),
    "at the deadline it is spent",
  );
  assert.throws(() => assertFreshContext(ctx, 9_999), RemembraError);
  // A deadline already in the past cannot even be minted.
  assert.throws(() => createRequestContext(hostContext({ deadlineAt: 5, now: 10 })), RemembraError);
});

test("V6-SEC-020: every mutating operation class requires a replay key", () => {
  // R14 survived: only `export` was checked, so removing the requirement for the
  // other five changed nothing. These are the operations whose replay would return
  // a *different* response if skipped, which is the whole point of the rule.
  const mutating = ["write", "update", "delete", "relation_write", "export", "snapshot_export", "policy_admin"] as const;
  for (const operation of mutating) {
    const withoutKey = RequestContextSchema.safeParse(hostContext({ operation }));
    assert.equal(withoutKey.success, false, `${operation} must require a replay key`);
    // And with one, it mints.
    const withKey = RequestContextSchema.safeParse(
      hostContext({ operation, replayKey: `k-${operation}`, principal: { ...hostPrincipal(), capabilities: ["policy:admin", "tenant:read", "tenant:write", "tenant:export", "provider:transmit"] } }),
    );
    assert.equal(withKey.success, true, `${operation} must be mintable with a key`);
  }
  // And a non-mutating read legitimately needs none.
  assert.equal(RequestContextSchema.safeParse(hostContext({ operation: "read" })).success, true);
});

test("V6-SEC-021: a scoped principal must declare its scopes", () => {
  // R17 survived: every principal in the first pass carried `scopes`, so the
  // requirement was unobserved. A scoped principal with no scope list has no way to
  // be checked against a scope filter, which is a widening by omission.
  const scoped = { ...hostPrincipal() };
  delete (scoped as Record<string, unknown>).scopes;
  assert.equal(RequestContextSchema.safeParse(hostContext({ principal: scoped })).success, false);

  // With scopes, it mints.
  assert.equal(
    RequestContextSchema.safeParse(hostContext({ principal: { ...scoped, scopes: ["project/p1"] } })).success,
    true,
  );
});

test("V6-SEC-022: an organization-wide principal must hold a read capability", () => {
  // R18 survived: every principal in the first pass was scoped *and* held
  // tenant:read, so neither half of the rule was isolated.
  const orgWide = { organizationId: "org-a", membershipVersion: "m-1", capabilities: ["tenant:write"] };
  assert.equal(
    RequestContextSchema.safeParse(hostContext({ principal: orgWide })).success,
    false,
    "an org-wide principal with only write cannot read, and must be refused rather than silently narrowed",
  );
  assert.equal(
    RequestContextSchema.safeParse(hostContext({ principal: { ...orgWide, capabilities: ["tenant:read"] } })).success,
    true,
  );
});
