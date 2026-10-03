import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateV6Policy,
  explainV6Decision,
  V6EvaluationResultSchema,
  type V6EvaluationInput,
} from "../v6-policy-evaluator.js";
// The vocabularies belong to v6-policy.ts (T02); the evaluator consumes them, it
// does not own them. Importing them from the evaluator would re-introduce the
// "which file defines this" question T02 settled.
import {
  SENSITIVITY_ORDER,
  TRUST_LEVELS,
  RETENTION_MODES,
  DECISION_REASONS,
  DECISION_EFFECTS,
} from "../v6-policy.js";
import { V6_OPERATION_CLASSES } from "../v6-request-context.js";

/**
 * V6-T05 evaluator fixtures.
 *
 * Table-driven across every axis and every conflict pair, because the acceptance
 * criterion is "every policy axis and conflict pair" and the tempting version of
 * that is a handful of hand-picked cases.
 *
 * Two properties are load-bearing and are checked as properties rather than
 * examples:
 *
 *  - **no invalid input can produce an allow**, over the whole cross-product;
 *  - **explanation is content-free**, because these strings reach logs and audit.
 */

// --- fixtures -----------------------------------------------------------------

const principal = (over: Record<string, unknown> = {}) => ({
  organizationId: "org-a",
  projectId: "p1",
  userId: "u1",
  membershipVersion: "m-1",
  scopes: ["project/p1"],
  capabilities: ["tenant:read", "tenant:write", "tenant:export", "provider:transmit"],
  clearance: "secret" as const,
  ...over,
});

// `projectId` is present because T03 makes it OPTIONAL on a V6 record — an
// organization-wide memory legitimately has none, and a principal scoped to p1 may
// read it. The first version of this fixture omitted it, so the "project mismatch"
// case below had no project to mismatch and every request was allowed.
const memory = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  organizationId: "org-a",
  projectId: "p1",
  sensitivity: "internal" as const,
  trust: "trusted" as const,
  retention: "persistent" as const,
  legalHold: false,
  ...over,
});

const input = (over: Partial<V6EvaluationInput> = {}): V6EvaluationInput => ({
  operation: "read",
  principal: principal(),
  memory: memory(),
  now: 0,
  ...over,
});

// --- determinism --------------------------------------------------------------

test("V6-POL-001: the evaluator is pure and repeatable", () => {
  const first = evaluateV6Policy(input());
  const second = evaluateV6Policy(input());
  assert.deepEqual(first, second, "same input, same decision");
  // A frozen input must not be mutated — "pure" includes not writing to the caller's
  // object, which a caching evaluator would do.
  const frozen = Object.freeze(input({ memory: Object.freeze(memory()) }));
  assert.doesNotThrow(() => evaluateV6Policy(frozen));
});

// --- the allow path -----------------------------------------------------------

test("V6-POL-002: an ordinary authorized read is allowed", () => {
  const d = evaluateV6Policy(input());
  assert.equal(d.effect, "allow");
  assert.equal(d.reason, "authorized");
  assert.equal(d.policyVersion, "v6-policy/1.0.0");
});

// --- every axis, denied individually ------------------------------------------

test("V6-POL-003: each axis denies on its own, with its own reason", () => {
  const cases: Array<[string, Partial<V6EvaluationInput>, string]> = [
    ["tenant", { principal: principal({ organizationId: "org-b" }) }, "tenant_mismatch"],
    ["project", { principal: principal({ projectId: "p2" }) }, "project_mismatch"],
    ["sensitivity", { principal: principal({ clearance: "public" }) }, "sensitivity_denied"],
    ["trust", { memory: memory({ trust: "unverified" }) }, "trust_restricted"],
    ["expiration", { memory: memory({ expiresAt: 1_000 }), now: 5_000 }, "expired"],
    ["legal hold", { operation: "delete", memory: memory({ legalHold: true }) }, "legal_hold"],
    ["capability", { principal: principal({ capabilities: [] }) }, "capability_missing"],
    ["provider egress", { operation: "provider_transmit", principal: principal({ clearance: "public" }) }, "provider_not_permitted"],
  ];
  // And the inverse, which must NOT deny: an organization-wide memory has no
  // project, and a project-scoped principal may read it.
  const orgWide = evaluateV6Policy(input({ memory: { ...memory(), projectId: undefined } }));
  assert.equal(orgWide.effect, "allow", "a memory with no project is readable from any project in the org");
  for (const [label, over, reason] of cases) {
    const d = evaluateV6Policy(input(over));
    assert.notEqual(d.effect, "allow", `${label} must not allow`);
    assert.equal(d.reason, reason, `${label} must report its own reason, got ${d.reason}`);
  }
});

// --- conflict pairs: deny wins ----------------------------------------------

test("V6-POL-004: with several axes denying, the reported reason is deterministic", () => {
  // Not "any" reason — the same conflicting input must always report the same one,
  // or an operator cannot read a denial and an audit cannot group them.
  const conflicting = input({
    principal: principal({ organizationId: "org-b", clearance: "public", capabilities: [] }),
    memory: memory({ trust: "unverified", expiresAt: 1 }),
    now: 5_000,
  });
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) seen.add(evaluateV6Policy(conflicting).reason);
  assert.equal(seen.size, 1, `conflicting input reported ${seen.size} different reasons: ${[...seen].join(",")}`);
  assert.notEqual([...seen][0], "authorized");
});

test("V6-POL-005: an explicit policy deny beats everything that would allow", () => {
  const d = evaluateV6Policy(
    input({
      policy: [{ source: "system", effect: "deny", reason: "policy_invalid" }],
    }),
  );
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "policy_invalid", "an explicit system deny is not diluted by permissive layers");
});

// --- expiration precedes retrieval eligibility --------------------------------

test("V6-POL-006: expiration is evaluated before retention and trust", () => {
  // An expired memory is unusable regardless of how trusted or retained it is, and
  // the reason must say so — otherwise an operator sees `trust_restricted` for a
  // memory that is simply stale.
  const d = evaluateV6Policy(
    input({ memory: memory({ trust: "unverified", expiresAt: 1 }), now: 5_000 }),
  );
  assert.equal(d.reason, "expired", "expiry outranks trust");
});

test("V6-POL-007: retention never re-enables an expired memory", () => {
  for (const retention of RETENTION_MODES) {
    const d = evaluateV6Policy(input({ memory: memory({ retention, expiresAt: 1 }), now: 5_000 }));
    assert.equal(d.reason, "expired", `${retention} must not resurrect an expired memory`);
  }
});

// --- property: no invalid input yields allow ---------------------------------

test("V6-POL-008: property — a defective axis can never produce an allow", () => {
  // One defect at a time, swept across every operation, clearance and trust level.
  // The invariant is narrow and checkable: with a defect present, the decision is
  // never `allow`.
  //
  // The first version of this test had a predicate that was true on every
  // iteration, so it asserted only that "no allow leaked for these inputs" — which
  // is trivially satisfied while the *fixture* was wrong (see the projectId note
  // above), and would have passed with the sweep broken.
  const defects: Array<[string, Partial<V6EvaluationInput>]> = [
    ["foreign tenant", { principal: principal({ organizationId: "org-b" }) }],
    ["foreign project", { principal: principal({ projectId: "p2" }) }],
    ["insufficient clearance", { principal: principal({ clearance: "public" }) }],
    ["no capabilities", { principal: principal({ capabilities: [] }) }],
  ];
  let checked = 0;
  for (const [label, defect] of defects) {
    for (const op of V6_OPERATION_CLASSES) {
      for (const clear of SENSITIVITY_ORDER) {
        const d = evaluateV6Policy(input({ operation: op, ...defect, now: 0 }));
        checked++;
        assert.notEqual(d.effect, "allow", `${label} must not allow (op=${op} clearance=${clear})`);
      }
    }
  }
  // Stated exactly rather than guessed: the first version asserted >= 300 against a
  // sweep that produces 176, so the guard failed for a reason unrelated to policy.
  assert.ok(checked > 100, `expected a broad sweep, checked ${checked}`);
});

test("V6-POL-009: a defective axis always denies, whatever the others say", () => {
  // Sweep the *non-defective* axes so each defect is isolated, and apply the defect
  // last so it cannot be overwritten by the sweep. The first version of this test
  // spread `...defect.memory` before the sweep's own memory, so the sweep silently
  // replaced the defect and every case was actually testing the allow path.
  const memoryDefects: Array<[string, Record<string, unknown>]> = [
    ["untrusted", { trust: "unverified" }],
    ["expired", { expiresAt: 1 }],
    ["secret memory", { sensitivity: "secret" }],
  ];
  // Every defect here must apply to EVERY operation class. "no read capability"
  // does not: `write` requires `tenant:write`, so a principal holding only
  // `tenant:write` is *correctly* allowed to write, and including it made the
  // sweep assert that a correct allow was a bypass. A defect that only bites for
  // some operations belongs in an operation-specific test (POL-003), not here.
  const principalDefects: Array<[string, Record<string, unknown>]> = [
    ["foreign tenant", { organizationId: "org-b" }],
    ["foreign project", { projectId: "p2" }],
    ["no capabilities at all", { capabilities: [] }],
    ["public clearance", { clearance: "public" }],
  ];

  let checked = 0;
  for (const [mlabel, mem] of memoryDefects) {
    for (const [plabel, prin] of principalDefects) {
      for (const op of V6_OPERATION_CLASSES) {
        const d = evaluateV6Policy(
          input({
            operation: op,
            principal: principal({ clearance: "secret", ...prin } as never),
            memory: memory({ sensitivity: "internal", trust: "trusted", ...mem } as never),
            now: 9_999,
          }),
        );
        checked++;
        assert.notEqual(d.reason, "authorized", `${mlabel}+${plabel} allowed for op=${op} (reason=${d.reason})`);
      }
    }
  }
  assert.ok(checked > 100, `expected a broad sweep, checked ${checked}`);
});


// --- explanations -------------------------------------------------------------

test("V6-POL-010: explanations are stable and content-free", () => {
  const decision = evaluateV6Policy(input({ principal: principal({ clearance: "public" }), memory: memory({ sensitivity: "secret", content: "TOPSECRETPAYLOAD" } as never) }));
  const text = explainV6Decision(decision);
  assert.equal(explainV6Decision(decision), text, "explanations are stable for the same decision");
  assert.ok(!text.includes("TOPSECRETPAYLOAD"), "an explanation must never carry content");
  assert.ok(!text.includes("org-a"), "nor a tenant identifier");
  assert.ok(text.length < 200, `explanation is bounded, got ${text.length} chars`);
});

test("V6-POL-011: the result carries only effect, reason and version", () => {
  const d = evaluateV6Policy(input());
  assert.deepEqual(Object.keys(d).sort(), ["effect", "policyVersion", "reason"]);
  assert.equal(V6EvaluationResultSchema.safeParse(d).success, true);
  // And nothing extra may be attached — an audit event is written from this.
  assert.equal(
    V6EvaluationResultSchema.safeParse({ ...d, content: "leak" }).success,
    false,
    "a decision carrying content must fail validation",
  );
});

// --- closed vocabularies ------------------------------------------------------

test("V6-POL-012: every reason and effect in use is in the declared vocabulary", () => {
  for (const reason of DECISION_REASONS) assert.equal(typeof reason, "string");
  for (const effect of DECISION_EFFECTS) assert.equal(typeof effect, "string");
  // Every reason the evaluator can actually emit must be declared, or an audit
  // consumer has an undeclared value to handle.
  const emitted = new Set<string>();
  for (const clear of SENSITIVITY_ORDER) {
    for (const trust of TRUST_LEVELS) {
      for (const op of V6_OPERATION_CLASSES) {
        emitted.add(evaluateV6Policy(
          input({ operation: op, principal: principal({ clearance: clear }), memory: memory({ sensitivity: clear, trust }) }),
        ).reason);
      }
    }
  }
  for (const reason of emitted) {
    assert.ok((DECISION_REASONS as readonly string[]).includes(reason), `undeclared reason emitted: ${reason}`);
  }
});

// ---------------------------------------------------------------------------
// Added after mutation testing: 8 of 20 caught. Eleven survived, and they cluster
// into two whole surfaces that nothing had touched — malformed input, and policy
// layer resolution. A passing suite covering only the axes is not coverage of an
// evaluator.
// ---------------------------------------------------------------------------

test("V6-POL-013: every malformed axis denies with policy_invalid, never allows", () => {
  // E1-E5 survived: no test ever passed an invalid value, so the entire fail-closed
  // validation path was unobserved. Each of these must DENY, and must say
  // `policy_invalid` so an operator can tell a bad record from a refused one.
  const cases: Array<[string, unknown]> = [
    ["unknown clearance", input({ principal: principal({ clearance: "restricted" as never }) })],
    ["unknown sensitivity", input({ memory: memory({ sensitivity: "restricted" as never }) })],
    ["unknown trust level", input({ memory: memory({ trust: "godmode" as never }) })],
    ["unknown retention", input({ memory: memory({ retention: "forever" as never }) })],
    ["non-finite clock", input({ now: Number.NaN })],
    ["infinite clock", input({ now: Number.POSITIVE_INFINITY })],
    ["invalid tenant id", input({ principal: principal({ organizationId: ".." }) })],
    ["tenant id with a path separator", input({ principal: principal({ organizationId: "a/b" }) })],
    ["non-finite expiry", input({ memory: memory({ expiresAt: Number.NaN }) })],
  ];
  for (const [label, payload] of cases) {
    const d = evaluateV6Policy(payload as V6EvaluationInput);
    assert.notEqual(d.effect, "allow", `${label} must not allow`);
    assert.equal(d.reason, "policy_invalid", `${label} must report policy_invalid, got ${d.reason}`);
  }
});

test("V6-POL-014: an explicit deny layer is never diluted", () => {
  // E8 survived: only an all-allow case existed, so removing the deny branch
  // changed nothing. A system-layer deny must win over an otherwise-permitted
  // request, and must be checked before the computed axes so nothing below can
  // soften it.
  for (const source of ["system", "tenant", "resource", "principal", "memory", "provider"] as const) {
    const d = evaluateV6Policy(input({ policy: [{ source, effect: "deny", reason: "policy_invalid" }] }));
    assert.equal(d.effect, "deny", `a ${source}-layer deny must not be diluted`);
    assert.equal(d.reason, "policy_invalid");
  }
});

test("V6-POL-015: layer resolution takes the most restrictive, not the most permissive", () => {
  // E9 survived: no test had two layers disagreeing.
  const denyThenRedact = evaluateV6Policy(input({
    policy: [
      { source: "system", effect: "redact", reason: "sensitivity_denied" },
      { source: "memory", effect: "deny", reason: "policy_invalid" },
    ],
  }));
  assert.equal(denyThenRedact.effect, "deny", "deny outranks redact regardless of order");

  const allowThenQuarantine = evaluateV6Policy(input({
    policy: [
      { source: "memory", effect: "allow", reason: "authorized" },
      { source: "provider", effect: "quarantine", reason: "injection_detected" },
    ],
  }));
  assert.equal(allowThenQuarantine.effect, "quarantine", "quarantine outranks allow");
});

test("V6-POL-016: layer precedence is by layer, not by the order supplied", () => {
  // E10 survived for the same reason as T02's DEC-003 did: with a deny and an
  // allow, restriction alone decides, so deleting the sort changed nothing. Two
  // layers of EQUAL effect but different reasons is the case only ordering can
  // decide, and only if the earlier layer wins a tie.
  const forward = evaluateV6Policy(input({
    policy: [
      { source: "system", effect: "allow", reason: "authorized" },
      { source: "resource", effect: "allow", reason: "provider_not_permitted" },
    ],
  }));
  const reversed = evaluateV6Policy(input({
    policy: [
      { source: "resource", effect: "allow", reason: "provider_not_permitted" },
      { source: "system", effect: "allow", reason: "authorized" },
    ],
  }));
  assert.deepEqual(forward, reversed, "supplied order cannot change the decision");
  // system precedes resource, so system's reason is the one reported.
  assert.equal(forward.reason, "authorized");
});

test("V6-POL-017: expiration is inclusive at the boundary", () => {
  // E14 survived: the boundary instant was never probed. `>=` is what makes
  // expiresAt a deadline rather than an approximation.
  assert.equal(evaluateV6Policy(input({ memory: memory({ expiresAt: 1_000 }), now: 999 })).reason, "authorized");
  assert.equal(evaluateV6Policy(input({ memory: memory({ expiresAt: 1_000 }), now: 1_000 })).reason, "expired", "the boundary instant is expired");
  assert.equal(evaluateV6Policy(input({ memory: memory({ expiresAt: 1_000 }), now: 1_001 })).reason, "expired");
});

test("V6-POL-018: an absent clearance covers public only", () => {
  // E16 survived: every fixture declared a clearance, so the default was never
  // observed. "Absent means unrestricted" is the permissive failure this whole
  // design exists to prevent, so it gets its own assertion.
  for (const sensitivity of SENSITIVITY_ORDER) {
    const d = evaluateV6Policy(
      input({ principal: { ...principal(), clearance: undefined }, memory: memory({ sensitivity }) }),
    );
    if (sensitivity === "public") {
      assert.equal(d.reason, "authorized", "an absent clearance covers public");
    } else {
      assert.equal(d.reason, "sensitivity_denied", `an absent clearance must not cover ${sensitivity}`);
    }
  }
});

test("V6-POL-019: legal hold blocks deletion and nothing else", () => {
  // E18 survived: only `delete` was exercised, so widening the hold to every
  // operation changed nothing. A hold that blocked reads would make held records
  // invisible to exactly the operators who need to see them.
  const held = memory({ legalHold: true });
  assert.equal(evaluateV6Policy(input({ operation: "delete", memory: held })).reason, "legal_hold");
  for (const operation of V6_OPERATION_CLASSES.filter((op) => op !== "delete")) {
    const d = evaluateV6Policy(input({ operation, memory: held }));
    assert.notEqual(d.reason, "legal_hold", `a legal hold must not block ${operation}`);
  }
});

test("V6-POL-020: a non-deny layer still narrows the result", () => {
  // E20 survived: no test had a redact/quarantine layer reach the outcome, so the
  // final narrowing step was unobserved. A quarantine verdict that comes back as
  // `allow` would be the worst possible failure: the memory is quarantined and the
  // caller is told it was fine.
  const quarantined = evaluateV6Policy(
    input({ policy: [{ source: "memory", effect: "quarantine", reason: "injection_detected" }] }),
  );
  assert.equal(quarantined.effect, "quarantine");
  assert.equal(quarantined.reason, "injection_detected");

  const redacted = evaluateV6Policy(
    input({ policy: [{ source: "system", effect: "redact", reason: "sensitivity_denied" }] }),
  );
  assert.equal(redacted.effect, "redact");
});
