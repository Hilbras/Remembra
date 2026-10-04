import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PolicyAuditLog,
  ResourceClass,
  explainDecision,
  redactForLog,
  buildPolicyAuditEvent,
  V6_POLICY_AUDIT_SCHEMA,
  MAX_CORRELATION_ID,
  MAX_AUDIT_PAGE,
} from "../v6-audit.js";
import { createRequestContext, type V6RequestContext } from "../v6-request-context.js";
import { evaluateV6Policy } from "../v6-policy-evaluator.js";

/**
 * V6-T08 audit fixtures.
 *
 * The class of defect this file exists to prevent is a **disclosure through the audit
 * surface**: an audit log that records what was asked, by whom, and what was refused
 * is exactly the place where a memory id, a content snippet or a credential would end
 * up being written. V5's `memory_audit` table is keyed by memory id, so a decision log
 * built the same way would leak existence — and this log is keyed by decision, with
 * no resource identifier at all.
 *
 * Every test therefore checks the *absence* of a value, not just its presence.
 */

const SECRET_CONTENT = "sk-abc123def456ghi789jkl012mno345pqr";
const CONTENT = "the customer's SSN is 123-45-6789";

function context(over: Record<string, unknown> = {}): V6RequestContext {
  return createRequestContext({
    principal: {
      organizationId: "org-a",
      projectId: "p1",
      userId: "u1",
      membershipVersion: "m-1",
      scopes: ["project/p1"],
      capabilities: ["tenant:read", "tenant:write", "tenant:export"],
      clearance: "secret",
    },
    operation: "read",
    authMethod: "api_key",
    authExpiresAt: 10_000_000,
    resolvedAt: 0,
    now: 0,
    ...over,
  });
}

const decisionFor = (over: Record<string, unknown> = {}) =>
  evaluateV6Policy({
    operation: "read",
    principal: { organizationId: "org-a", projectId: "p1", capabilities: ["tenant:read"], clearance: "public" },
    memory: { id: "m1", organizationId: "org-a", sensitivity: "secret", trust: "trusted", retention: "persistent", legalHold: false },
    now: 1_000,
    ...over,
  });

// --- the event shape ----------------------------------------------------------

test("V6-AUD-001: an event identifies actor, tenant, operation, version, effect and reason", () => {
  const event = buildPolicyAuditEvent({
    decision: decisionFor(),
    operation: "read",
    context: context(),
    resourceClass: "tenant-memory",
    now: 1_000,
  });
  const parsed = V6_POLICY_AUDIT_SCHEMA.parse(event);
  assert.equal(parsed.organizationId, "org-a");
  assert.equal(parsed.userId, "u1");
  assert.equal(parsed.operation, "read");
  assert.equal(parsed.policyVersion, "v6-policy/1.0.0");
  assert.equal(parsed.effect, "deny");
  assert.equal(parsed.reason, "sensitivity_denied");
  assert.equal(parsed.resourceClass, "tenant-memory");
  assert.equal(parsed.authMethod, "api_key");
  assert.equal(parsed.at, 1_000);
});

test("V6-AUD-002: an event never carries memory content, a resource id, or a secret", () => {
  const event = buildPolicyAuditEvent({
    decision: decisionFor(),
    operation: "read",
    context: context(),
    resourceClass: "tenant-memory",
    now: 1_000,
  });
  const json = JSON.stringify(event);
  assert.equal(json.includes("m1"), false, "no resource id: existence itself is a disclosure");
  assert.equal(json.includes(SECRET_CONTENT), false);
  assert.equal(json.includes("123-45-6789"), false);
  // No key at all can smuggle content, whatever its name.
  for (const key of Object.keys(event)) {
    assert.match(key, /^[a-z][A-Za-z]*$/, `${key} is a plain field name`);
    assert.equal(/content|text|body|snippet|payload|secret|credential/i.test(key), false,
      `${key} would be a place content could hide`);
  }
});

test("V6-AUD-003: the schema is strict, so an added content field fails validation", () => {
  const event = buildPolicyAuditEvent({
    decision: decisionFor(),
    operation: "read",
    context: context(),
    resourceClass: "tenant-memory",
    now: 1_000,
  });
  assert.equal(V6_POLICY_AUDIT_SCHEMA.safeParse({ ...event, content: CONTENT }).success, false);
  assert.equal(V6_POLICY_AUDIT_SCHEMA.safeParse({ ...event, memoryId: "m1" }).success, false,
    "a resource id must not be attachable either");
});

test("V6-AUD-004: the reason is low-cardinality and from the declared vocabulary", () => {
  // Every reason the evaluator can emit must survive the audit schema, or an audit
  // consumer has an undeclared value and a log writer has a shape it cannot verify.
  const seen = new Set<string>();
  for (const clearance of ["public", "internal", "confidential", "secret"] as const) {
    for (const op of ["read", "write", "delete", "export", "provider_transmit"] as const) {
      const d = evaluateV6Policy({
        operation: op,
        principal: { organizationId: "org-a", projectId: "p1", capabilities: ["tenant:read", "tenant:write", "tenant:export", "provider:transmit"], clearance },
        memory: { id: "m1", organizationId: "org-a", sensitivity: clearance, trust: "trusted", retention: "persistent", legalHold: false },
        now: 1_000,
      });
      seen.add(d.reason);
    }
  }
  for (const reason of seen) {
    const event = buildPolicyAuditEvent({ decision: { effect: "deny", reason: reason as never, policyVersion: "v6-policy/1.0.0" }, operation: "read", context: context(), resourceClass: "tenant-memory", now: 1 });
    assert.equal(event.reason, reason);
  }
  assert.ok(seen.size <= 12, `reason cardinality stayed bounded: ${seen.size}`);
});

// --- bounded identifiers ------------------------------------------------------

test("V6-AUD-005: a correlation id is bounded and rejected when longer", () => {
  const ok = "req-abc123";
  assert.equal(MAX_CORRELATION_ID > 8, true);
  const event = buildPolicyAuditEvent({ decision: decisionFor(), operation: "read", context: context(), resourceClass: "tenant-memory", now: 1, correlationId: ok });
  assert.equal(event.correlationId, ok);
  assert.throws(
    () => buildPolicyAuditEvent({ decision: decisionFor(), operation: "read", context: context(), resourceClass: "tenant-memory", now: 1, correlationId: "x".repeat(MAX_CORRELATION_ID + 1) }),
    /correlation|bound|length/i,
  );
});

test("V6-AUD-006: a correlation id cannot smuggle content through a short field", () => {
  // Bounded length is not the same as bounded content: 40 characters of a credential
  // still fits. The value must be an opaque handle.
  assert.throws(
    () => buildPolicyAuditEvent({ decision: decisionFor(), operation: "read", context: context(), resourceClass: "tenant-memory", now: 1, correlationId: "sk-abc123def456ghi789jkl" }),
    /correlation|opaque/i,
  );
});

// --- explanations -------------------------------------------------------------

test("V6-AUD-007: an operator can explain a decision without reading content", () => {
  const text = explainDecision(decisionFor(), { resourceClass: "tenant-memory" });
  assert.match(text, /deny/);
  assert.match(text, /sensitivity_denied/);
  assert.equal(text.includes(SECRET_CONTENT), false);
  assert.ok(text.length < 300, `bounded explanation, got ${text.length} chars`);
});

test("V6-AUD-008: an explanation never includes a resource id", () => {
  const text = explainDecision(decisionFor({ memory: { id: "topsecret-key-42", organizationId: "org-a", sensitivity: "secret", trust: "trusted", retention: "persistent", legalHold: false } }), {});
  assert.equal(text.includes("topsecret-key-42"), false, "naming the resource would confirm it exists");
});

// --- redaction ----------------------------------------------------------------

test("V6-AUD-009: redactForLog strips known secret and content shapes", () => {
  const out = redactForLog(`key ${SECRET_CONTENT} ssn 123-45-6789 email a@b.example`);
  assert.equal(out.includes(SECRET_CONTENT), false);
  assert.equal(out.includes("123-45-6789"), false);
  assert.equal(out.includes("a@b.example"), false);
  assert.match(out, /\[REDACTED/);
});

test("V6-AUD-010: redaction is idempotent and bounded", () => {
  const once = redactForLog(`key ${SECRET_CONTENT}`);
  assert.equal(redactForLog(once), once, "redacting twice changes nothing");
  assert.ok(once.length < 200);
});

// --- pagination and tenant filtering ------------------------------------------

function seededLog(): PolicyAuditLog {
  const log = new PolicyAuditLog();
  for (let i = 0; i < 25; i++) {
    log.append(buildPolicyAuditEvent({
      decision: { effect: "deny", reason: "sensitivity_denied", policyVersion: "v6-policy/1.0.0" },
      operation: "read",
      context: context({ principal: { ...context().principal, organizationId: i % 2 === 0 ? "org-a" : "org-b" } }),
      resourceClass: "tenant-memory",
      now: i,
    }));
  }
  return log;
}

test("V6-AUD-011: queries are tenant-filtered — a tenant never sees another's decisions", () => {
  const log = seededLog();
  const forA = log.query({ organizationId: "org-a", limit: 100 });
  assert.ok(forA.events.length > 0);
  assert.ok(forA.events.every((e) => e.organizationId === "org-a"), "cross-tenant leak in the audit query");
});

test("V6-AUD-012: queries are paginated and bounded", () => {
  const log = seededLog();
  const first = log.query({ organizationId: "org-a", limit: 5 });
  assert.equal(first.events.length, 5, "the page size is honoured");
  assert.ok(MAX_AUDIT_PAGE <= 500, "the page ceiling is itself bounded");
  assert.throws(() => log.query({ organizationId: "org-a", limit: MAX_AUDIT_PAGE + 1 }), /limit|page|bound/i);

  // Cursors do not overlap and do not skip.
  const second = log.query({ organizationId: "org-a", limit: 5, cursor: first.nextCursor });
  const firstIds = new Set(first.events.map((e) => `${e.organizationId}@${e.at}`));
  assert.ok(second.events.every((e) => !firstIds.has(`${e.organizationId}@${e.at}`)), "pages overlap");
});

test("V6-AUD-013: the retained event count is bounded, so a log cannot grow without limit", () => {
  const log = new PolicyAuditLog({ maxEvents: 20 });
  for (let i = 0; i < 100; i++) {
    log.append(buildPolicyAuditEvent({ decision: decisionFor(), operation: "read", context: context(), resourceClass: "tenant-memory", now: i }));
  }
  const result = log.query({ organizationId: "org-a", limit: 100 });
  assert.equal(result.events.length, 20, "retention is a ceiling");
  assert.equal(result.totalRetained, 20);
  assert.equal(result.dropped, 80, "and the drop is visible rather than silent");
});

// --- resource class -----------------------------------------------------------

test("V6-AUD-014: the resource class is a closed vocabulary", () => {
  assert.ok(ResourceClass.length >= 4, "memory, export, provider and snapshot classes");
  for (const rc of ResourceClass) {
    const event = buildPolicyAuditEvent({ decision: decisionFor(), operation: "read", context: context(), resourceClass: rc, now: 1 });
    assert.equal(event.resourceClass, rc);
  }
  assert.throws(
    () => buildPolicyAuditEvent({ decision: decisionFor(), operation: "read", context: context(), resourceClass: "everything" as never, now: 1 }),
    /resource ?class/i,
    "an undeclared resource class is refused",
  );
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Four of fourteen survived, and one of them was a
// genuine cross-tenant hole: the mandatory organization filter could be removed
// without any test failing.
// ---------------------------------------------------------------------------

test("V6-AUD-015: an audit query without an organization is refused", () => {
  // A7 survived: every existing query passed an organizationId, so the mandatory
  // check was unobserved. Without it, an unqualified query returns every tenant's
  // decisions — the audit surface leaking more than the data plane does.
  const log = seededLog();
  for (const bad of [{}, { organizationId: "" }]) {
    assert.throws(
      () => log.query(bad as never),
      /organization/i,
      "an audit query must name a tenant",
    );
  }
  // And the filter is applied, not merely required.
  const a = log.query({ organizationId: "org-a", limit: 100 });
  assert.ok(a.events.every((e) => e.organizationId === "org-a"));
  assert.ok(a.events.some((e) => e.organizationId !== "org-a") === false);
});

test("V6-AUD-016: an event that does not satisfy the schema is never appended", () => {
  // A5 survived: append was only ever called with a built event, so the validation
  // was unobserved. A log that accepts a hand-built or mutated event can hold a row
  // no query or schema would otherwise permit.
  const log = new PolicyAuditLog();
  const good = buildPolicyAuditEvent({ decision: decisionFor(), operation: "read", context: context(), resourceClass: "tenant-memory", now: 1 });
  log.append(good);
  assert.throws(
    () => log.append({ ...good, content: CONTENT } as never),
    /schema|audit|refus/i,
    "an event carrying content must be refused at the boundary",
  );
  assert.throws(() => log.append({ ...good, effect: "maybe" } as never));
  assert.equal(log.query({ organizationId: "org-a", limit: 10 }).events.length, 1, "only the valid event is stored");
});

test("V6-AUD-017: the correlation-id ceiling is enforced against the exported constant", () => {
  // A3 survived: the test built a string from MAX_CORRELATION_ID, so raising the
  // constant raised the fixture with it. Pin an absolute bound as well, so the
  // ceiling cannot be relaxed by editing one number.
  assert.ok(MAX_CORRELATION_ID <= 128, `the ceiling is a real ceiling, got ${MAX_CORRELATION_ID}`);
  // A handle longer than the ceiling is refused, and the refusal is not dependent on
  // the fixture having been built from the same constant.
  assert.throws(
    () => buildPolicyAuditEvent({
      decision: decisionFor(), operation: "read", context: context(),
      resourceClass: "tenant-memory", now: 1,
      correlationId: "c".repeat(MAX_CORRELATION_ID + 1),
    }),
    /correlation|bound|length/i,
  );
  // A handle at the ceiling is accepted, so the boundary is pinned from both sides.
  const atLimit = buildPolicyAuditEvent({
    decision: decisionFor(), operation: "read", context: context(),
    resourceClass: "tenant-memory", now: 1,
    correlationId: "c".repeat(MAX_CORRELATION_ID),
  });
  assert.equal(atLimit.correlationId?.length, MAX_CORRELATION_ID);
});

test("V6-AUD-018: an explanation never renders a resource identifier", () => {
  // A14 survived: the mutation reached for a `resourceId` the options type does not
  // have, so the explanation was never exercised with anything but a resourceClass.
  // Assert the property against arbitrary extra options, which is what an adapter
  // would hand it.
  for (const options of [
    { resourceClass: "tenant-memory" as const },
    { resourceClass: "tenant-memory" as const, resourceId: "m-secret-1" } as never,
    { resourceId: "m-secret-1" } as never,
    {} as never,
  ]) {
    const text = explainDecision(decisionFor(), options);
    assert.equal(text.includes("m-secret-1"), false, "a resource id must never be rendered");
    assert.ok(!/\bm-\w+/.test(text), `no id-shaped token in: ${text.slice(0, 80)}`);
  }
});
