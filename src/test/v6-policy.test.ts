import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SENSITIVITY_ORDER,
  POLICY_SOURCES,
  PRECEDENCE_ORDER,
  PolicyDecisionSchema,
  PolicyDocumentSchema,
  evaluatePolicy,
  policyDecisionEffect,
  parsePolicyDocument,
  type PolicyInput,
} from "../v6-policy.js";
import { RemembraError } from "../errors.js";

/**
 * V6-T02 decision fixtures.
 *
 * These are the executable form of docs/v6-decisions.md. Each names the case it
 * proves and, where it matters, the decision it must NOT reach — a fail-closed
 * test that only asserts "not allow" passes for the wrong reason just as easily
 * as an allow test passes when the code is broken.
 */

const allowed = (input: Partial<PolicyInput> = {}): PolicyInput => ({
  operation: "read",
  // `clearance: "secret"` is the baseline, not an oversight: an `internal` memory
  // read by a principal holding no declared clearance is *denied*, which is the
  // fail-closed default (an absent clearance covers `public` only). The baseline
  // therefore states a clearance that covers the memory, so each test varies one
  // thing from a known-allowed position.
  principal: {
    organizationId: "org-a",
    projectId: "p1",
    userId: "u1",
    capabilities: ["tenant:read"],
    clearance: "secret",
  },
  memory: { id: "m1", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: false },
  ...input,
});

test("V6-DEC-001: an authorized read of an ordinary memory is allowed", () => {
  const d = evaluatePolicy(allowed());
  assert.equal(d.effect, "allow");
  assert.equal(d.reason, "authorized");
  assert.match(d.policyVersion, /^v6-policy\/\d+\.\d+\.\d+$/);
});

test("V6-DEC-002: deny wins when one layer denies and every other layer allows", () => {
  // The tenant layer denies; nothing else objects. Deny must still win, or a
  // later allow-only layer would paper over it.
  const d = evaluatePolicy(
    allowed({
      layers: [{ source: "system", effect: "allow", reason: "authorized" }, { source: "tenant", effect: "deny", reason: "policy_invalid" }],
    }),
  );
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "policy_invalid");
});

test("V6-DEC-003: precedence is by layer order, not by the order layers are supplied", () => {
  // Two halves, because restriction alone is not enough to observe the ordering.
  //
  // (a) A restrictive low layer beats a permissive high one. This is the coarse
  //     rule, and it is what the first version of this test asserted — which is
  //     why removing the sort entirely left the test green: with only a deny and
  //     an allow, "most restrictive wins" reaches the same answer either way, so
  //     the test never exercised the mechanism it named.
  const restrictive = evaluatePolicy(
    allowed({
      layers: [
        { source: "principal", effect: "allow", reason: "authorized" },
        { source: "system", effect: "deny", reason: "policy_invalid" },
      ],
    }),
  );
  assert.equal(restrictive.effect, "deny");
  assert.equal(restrictive.reason, "policy_invalid");

  // (b) Two layers of *equal* effect but different reasons. Only the precedence
  //     order can decide this, and only if the earlier layer wins on a tie —
  //     which is exactly what deleting the sort breaks. Input order is reversed
  //     between the two calls, so an order-dependent implementation fails one.
  const forward = evaluatePolicy(
    allowed({
      layers: [
        { source: "resource", effect: "allow", reason: "tenant_mismatch" },
        { source: "principal", effect: "allow", reason: "authorized" },
      ],
    }),
  );
  const reversed = evaluatePolicy(
    allowed({
      layers: [
        { source: "principal", effect: "allow", reason: "authorized" },
        { source: "resource", effect: "allow", reason: "tenant_mismatch" },
      ],
    }),
  );
  assert.equal(forward.reason, "tenant_mismatch", "the earlier layer wins the tie");
  assert.deepEqual(forward, reversed, "and the supplied order cannot change it");
});

test("V6-DEC-004: an unknown layer source fails closed rather than being ignored", () => {
  assert.throws(
    () => evaluatePolicy(allowed({ layers: [{ source: "somewhere-else" as never, effect: "allow", reason: "authorized" }] })),
    (error: unknown) =>
      error instanceof RemembraError && /malformed policy layer/i.test((error as Error).message),
    "an unknown layer source is refused, not ignored",
  );
});

test("V6-DEC-005: a caller cannot clear a sensitivity denial by claiming a lower clearance", () => {
  // The memory is `secret` and the principal claims only `internal` clearance.
  // This is the request-field attack the ADR forbids: a public field asserting
  // authority it does not have.
  const d = evaluatePolicy(
    allowed({
      principal: { organizationId: "org-a", projectId: "p1", userId: "u1", capabilities: ["tenant:read"], clearance: "internal" },
      memory: { id: "m1", sensitivity: "secret", trust: "trusted", retention: "persistent", legalHold: false },
    }),
  );
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "sensitivity_denied");
});

test("V6-DEC-006: an expired memory is denied for use, whatever its retention mode", () => {
  const d = evaluatePolicy(
    allowed({ now: 5_000, memory: { id: "m1", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: false, expiresAt: 1_000 } }),
  );
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "expired");
});

test("V6-DEC-007: retention and expiration are independent axes", () => {
  // neverExpire must not make an expired memory usable, and expiry must not be
  // inferred from a retention mode. Conflating them is the mistake this pins.
  const never = evaluatePolicy(
    allowed({ now: 5_000, memory: { id: "m1", sensitivity: "internal", trust: "trusted", retention: "neverExpire", legalHold: false, expiresAt: 1_000 } }),
  );
  assert.equal(never.reason, "expired");
});

test("V6-DEC-008: an untrusted memory is denied for a principal with no trust requirement waiver", () => {
  const d = evaluatePolicy(
    allowed({ memory: { id: "m1", sensitivity: "internal", trust: "unverified", retention: "persistent", legalHold: false } }),
  );
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "trust_restricted");
});

test("V6-DEC-009: a tenant mismatch denies without revealing that the record exists", () => {
  const d = evaluatePolicy(
    allowed({
      principal: { organizationId: "org-b", projectId: "p1", userId: "u1", capabilities: ["tenant:read"] },
      memory: { id: "m1", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: false, organizationId: "org-a" },
    }),
  );
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "tenant_mismatch");
  // The decision carries no memory content and no existence signal beyond the
  // reason code itself — an audit-safe denial.
  assert.equal(JSON.stringify(d).includes("content"), false);
});

test("V6-DEC-010: a provider transmission is refused when the provider is not permitted", () => {
  const d = evaluatePolicy(allowed({ operation: "provider_transmit", principal: { organizationId: "org-a", projectId: "p1", userId: "u1", capabilities: ["provider:transmit"], clearance: "public" } }));
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "provider_not_permitted");
});

test("V6-DEC-011: legal hold blocks destruction but never grants access", () => {
  const held = allowed({ operation: "delete", principal: { organizationId: "org-a", projectId: "p1", userId: "u1", capabilities: ["tenant:write"], clearance: "secret" }, memory: { id: "m1", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: true } });
  const d = evaluatePolicy(held);
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "legal_hold");
  // And it must not turn a read into an allow it would otherwise not have had.
  const stillDenied = evaluatePolicy({
    operation: "read",
    principal: { organizationId: "org-a", projectId: "p1", userId: "u1", capabilities: ["tenant:read"], clearance: "public" },
    memory: { id: "m1", sensitivity: "confidential", trust: "trusted", retention: "persistent", legalHold: true },
  });
  assert.equal(stillDenied.effect, "deny");
  assert.equal(stillDenied.reason, "sensitivity_denied", "the hold must not have granted access");
});

test("V6-DEC-012: quarantine is reachable and distinct from deny", () => {
  const d = evaluatePolicy(allowed({ layers: [{ source: "memory", effect: "quarantine", reason: "injection_detected" }] }));
  assert.equal(d.effect, "quarantine");
  assert.equal(d.reason, "injection_detected");
  assert.notEqual(d.effect, "deny");
});

test("V6-DEC-013: the effect and reason vocabularies are closed", () => {
  const effects = ["allow", "deny", "redact", "quarantine"] as const;
  for (const e of effects) {
    assert.ok(PolicyDecisionSchema.safeParse({ effect: e, reason: "authorized", policyVersion: "v6-policy/1.0.0" }).success);
  }
  for (const bad of ["permit", "ALLOW", "block", ""]) {
    assert.equal(PolicyDecisionSchema.safeParse({ effect: bad, reason: "authorized", policyVersion: "v6-policy/1.0.0" }).success, false, `effect ${JSON.stringify(bad)} must be rejected`);
  }
});

test("V6-DEC-014: the decision schema rejects an unknown reason code", () => {
  assert.equal(
    PolicyDecisionSchema.safeParse({ effect: "deny", reason: "because_i_said_so", policyVersion: "v6-policy/1.0.0" }).success,
    false,
  );
});

test("V6-DEC-015: a decision is bounded — it cannot carry content or extra fields", () => {
  const parsed = PolicyDecisionSchema.safeParse({
    effect: "deny",
    reason: "tenant_mismatch",
    policyVersion: "v6-policy/1.0.0",
    content: "the secret text",
  });
  assert.equal(parsed.success, false, "an unknown field must fail closed, not be stripped silently");
});

test("V6-DEC-016: the sensitivity order is exactly the four approved bands", () => {
  // The architecture spec §4.2 lists public/internal/confidential/restricted;
  // docs/v6-decisions.md §1 approved secret/confidential/internal/public. The ADR
  // is the approved record, and `restricted` is retired in favour of `secret`.
  assert.deepEqual(SENSITIVITY_ORDER, ["public", "internal", "confidential", "secret"]);
});

test("V6-DEC-017: a policy document rejects an unknown field and an unknown source", () => {
  const base = { version: "v6-policy/1.0.0", source: "builtin", layers: [] };
  assert.equal(PolicyDocumentSchema.safeParse({ ...base, surprise: 1 }).success, false, "unknown field");
  assert.equal(PolicyDocumentSchema.safeParse({ ...base, source: "somebody-elses-file" }).success, false, "unknown source");
  assert.equal(PolicyDocumentSchema.safeParse(base).success, true);
});

test("V6-DEC-018: a policy document with a version mismatch is refused", () => {
  const parsed = parsePolicyDocument({
    version: "v6-policy/9.9.9",
    source: "builtin",
    layers: [],
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /version/i);
});

test("V6-DEC-019: the precedence order has no duplicates and matches the spec's sequence", () => {
  // PRECEDENCE_ORDER (which layer speaks) and POLICY_SOURCES (where a *document*
  // came from) are deliberately different sets and must not be conflated — a
  // document origin is not a precedence position. This test pins the sequence the
  // architecture spec §4.6 specifies, so a reordering that weakened system-first
  // would fail here rather than pass quietly.
  assert.equal(new Set(PRECEDENCE_ORDER).size, PRECEDENCE_ORDER.length);
  assert.deepEqual(PRECEDENCE_ORDER, ["system", "tenant", "resource", "principal", "memory", "provider"]);
  // The origin vocabulary is closed and distinct from the layer vocabulary.
  assert.deepEqual([...POLICY_SOURCES].sort(), ["builtin", "host", "policy_file"]);
  for (const origin of POLICY_SOURCES) {
    assert.equal((PRECEDENCE_ORDER as readonly string[]).includes(origin), false, `${origin} is an origin, not a layer`);
  }
});

test("V6-DEC-022: an absent clearance is fail-closed, never unrestricted", () => {
  // Found by mutation: treating an absent clearance as `secret` changed no
  // outcome, because every other test either supplies a clearance or compares
  // two labels. The default itself was untested — and it is the single most
  // consequential default in this module, since "absent means unrestricted" is
  // the permissive failure mode the whole design exists to prevent.
  for (const sensitivity of ["public", "internal", "confidential", "secret"] as const) {
    const d = evaluatePolicy({
      operation: "read",
      principal: { organizationId: "org-a", projectId: "p1", userId: "u1", capabilities: ["tenant:read"] },
      memory: { id: "m1", sensitivity, trust: "trusted", retention: "persistent", legalHold: false },
    });
    if (sensitivity === "public") {
      assert.equal(d.effect, "allow", "an absent clearance covers public, and nothing more");
    } else {
      assert.equal(d.effect, "deny", `an absent clearance must not cover ${sensitivity}`);
      assert.equal(d.reason, "sensitivity_denied");
    }
  }
});

test("V6-DEC-023: a missing operation capability denies", () => {
  // Found by mutation: dropping the capability check changed no outcome, because
  // every test granted the capability its operation needed. So nothing pinned
  // that absence denies rather than permits.
  const operations = ["read", "write", "update", "delete", "export", "provider_transmit"] as const;
  for (const operation of operations) {
    const d = evaluatePolicy({
      operation,
      principal: { organizationId: "org-a", projectId: "p1", userId: "u1", capabilities: [], clearance: "secret" },
      memory: { id: "m1", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: false },
    });
    assert.equal(d.effect, "deny", `${operation} without its capability must deny`);
    assert.equal(d.reason, "capability_missing", `${operation} names the missing capability, not a downstream cause`);
  }
});

test("V6-DEC-024: capabilities are per-operation, not a single read/write pair", () => {
  // `tenant:read` must not imply `tenant:export`, and `tenant:write` must not
  // imply `provider:transmit`. A single "can write" capability that covered
  // egress would be the classic privilege-escalation shape.
  const base = { organizationId: "org-a", projectId: "p1", userId: "u1", clearance: "secret" } as const;
  const memory = { id: "m1", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: false } as const;

  const readOnly = evaluatePolicy({ operation: "read", principal: { ...base, capabilities: ["tenant:read"] }, memory });
  assert.equal(readOnly.effect, "allow");

  const exportAttempt = evaluatePolicy({ operation: "export", principal: { ...base, capabilities: ["tenant:read"] }, memory });
  assert.equal(exportAttempt.effect, "deny", "read does not imply export");
  assert.equal(exportAttempt.reason, "capability_missing");

  const writeOnly = evaluatePolicy({ operation: "write", principal: { ...base, capabilities: ["tenant:write"] }, memory });
  assert.equal(writeOnly.effect, "allow");

  const egressAttempt = evaluatePolicy({ operation: "provider_transmit", principal: { ...base, capabilities: ["tenant:write"] }, memory });
  assert.equal(egressAttempt.effect, "deny", "write does not imply provider egress");
  assert.equal(egressAttempt.reason, "capability_missing");
});

test("V6-DEC-025: the evaluator's clock is the injected one, and absent a clock it is not the wall clock", () => {
  // Found by mutation, twice. The first version asserted that two evaluations of
  // the same input agree — which `Date.now()` also satisfies, because two calls a
  // few microseconds apart return the same millisecond. The test passed against a
  // clock-dependent evaluator and proved nothing.
  //
  // The property that actually distinguishes them is the bound: with no injected
  // clock the evaluator must behave as if `now` were 0, so a memory expiring in
  // 1970+1 is still usable. `Date.now()` is ~1.7e12, which puts the same memory
  // long expired. The assertion is therefore about the decision, not about two
  // calls agreeing.
  const memory = { id: "m1", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: false, expiresAt: 1_000 } as const;
  const principal = { organizationId: "org-a", projectId: "p1", userId: "u1", capabilities: ["tenant:read"], clearance: "secret" } as const;

  // No `now` supplied. A wall clock would report this memory as long expired.
  const noClock = evaluatePolicy({ operation: "read", principal, memory });
  assert.equal(noClock.effect, "allow", "an absent clock must not be the wall clock");
  assert.equal(noClock.reason, "authorized");

  // An explicit clock at and after the boundary is what actually decides it.
  assert.equal(evaluatePolicy({ operation: "read", now: 500, principal, memory }).effect, "allow", "before expiry");
  assert.equal(evaluatePolicy({ operation: "read", now: 1_000, principal, memory }).reason, "expired", "at the boundary, expired");
  assert.equal(evaluatePolicy({ operation: "read", now: 1_001, principal, memory }).reason, "expired", "after expiry");

  // And a far-future injected clock must expire it even though the absent-clock
  // case did not — the two cannot be conflated.
  assert.equal(evaluatePolicy({ operation: "read", now: 2_000_000_000_000, principal, memory }).reason, "expired");
});

test("V6-DEC-020: the evaluator is pure and repeatable", () => {
  const input = allowed();
  const a = evaluatePolicy(input);
  const b = evaluatePolicy(input);
  assert.deepEqual(a, b, "same input must produce the same decision, with no clock or randomness");
});

test("V6-DEC-021: policyDecisionEffect exposes only the effect, for enforcement call sites", () => {
  assert.equal(policyDecisionEffect(evaluatePolicy(allowed())), "allow");
  assert.equal(policyDecisionEffect(evaluatePolicy(allowed({ layers: [{ source: "system", effect: "redact", reason: "sensitivity_denied" }] }))), "redact");
});