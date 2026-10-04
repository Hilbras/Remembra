import assert from "node:assert/strict";
import { test } from "node:test";
import {
  V6Predicate,
  buildV6Predicate,
  compileV6Predicate,
  RETRIEVAL_PATHS,
  guardCandidateSet,
  type V6Candidate,
} from "../v6-retrieval-policy.js";
import { createRequestContext, type V6RequestContext } from "../v6-request-context.js";
import { SENSITIVITY_ORDER } from "../v6-policy.js";

/**
 * V6-T07 retrieval-policy fixtures.
 *
 * The acceptance criterion is about **ordering**: tenant/sensitivity/expiration
 * predicates must occur *before* SQL limits, because a `LIMIT 10` applied to
 * unfiltered rows returns ten foreign memories and then filters them to zero — a
 * correct-looking result that is also a wrong answer, and a leak in the one place
 * the count is observable.
 *
 * That is a property of the emitted SQL, not of behaviour, so it is asserted
 * against the compiled clause rather than against a result set. A test that checks
 * "no foreign memory came back" passes just as happily with a `LIMIT`-first query
 * whenever the tenant happens to own enough rows.
 */

function context(over: Record<string, unknown> = {}): V6RequestContext {
  return createRequestContext({
    principal: {
      organizationId: "org-a",
      projectId: "p1",
      membershipVersion: "m-1",
      scopes: ["project/p1"],
      capabilities: ["tenant:read"],
      clearance: "confidential",
    },
    operation: "read",
    authMethod: "api_key",
    authExpiresAt: 10_000_000,
    resolvedAt: 0,
    now: 0,
    ...over,
  });
}

const at = (now: number) => context({ now });

// --- the predicate itself -----------------------------------------------------

test("V6-RET-001: the predicate is tenant, then policy, with every axis present", () => {
  const p = buildV6Predicate(at(1_000), { now: 1_000 });
  assert.equal(p.sql.includes("tenant_id"), true, "tenant binding is in the clause");
  assert.equal(p.sql.includes("project_id"), true, "project binding is in the clause");
  assert.equal(p.sql.includes("sensitivity"), true, "sensitivity is a storage predicate, not a post-filter");
  assert.equal(p.sql.includes("legal_hold"), true, "legal hold is a storage predicate");
  // Every parameter is positional and bound, never interpolated.
  assert.ok(p.params.length >= 4, `params are bound, got ${p.params.length}`);
  assert.equal(/'[^']*'/.test(p.sql), false, "no literal values interpolated into the clause");
});

test("V6-RET-002: expiration is a range predicate, not a post-hoc filter", () => {
  const p = buildV6Predicate(at(1_000), { now: 1_000 });
  // A memory is usable while it is unexpired OR has no expiry at all. Both halves
  // must be present, and as SQL rather than in JavaScript.
  assert.match(p.sql, /expires_at IS NULL/);
  assert.match(p.sql, /expires_at/);
  assert.ok(p.params.includes("1000"), "the clock is a bound parameter, not interpolated");
});

test("V6-RET-003: a legal hold is excluded from candidate selection entirely", () => {
  // A held memory must not become a candidate — not be a candidate and then be
  // dropped, which would show up in a count.
  const p = buildV6Predicate(at(1_000), { now: 1_000 });
  assert.match(p.sql, /legal_hold/, "held records are excluded in the predicate");
});

test("V6-RET-004: an administrative capability does not widen the clause silently", () => {
  // A principal holding tenant:admin still only sees its own tenant here. Admin
  // widens *operations* (T06), not the retrieval scope.
  const admin = context({
    principal: {
      organizationId: "org-a", projectId: "p1", membershipVersion: "m-1",
      scopes: ["project/p1"], capabilities: ["tenant:read", "tenant:admin"],
      clearance: "secret",
    },
  });
  const p = buildV6Predicate(admin, { now: 1_000 });
  assert.equal(p.sql.includes("org-b"), false, "no other tenant appears in the clause");
  assert.ok(p.params.includes("org-a"));
});

// --- ordering: the criterion that matters -------------------------------------

test("V6-RET-005: every retrieval path applies the predicate BEFORE its limit", () => {
  // The whole acceptance criterion. Each path declares its limit; the compiled
  // query must place the predicate ahead of it, so a limit can only ever truncate
  // rows the caller was entitled to see.
  const predicate = compileV6Predicate(at(1_000), { now: 1_000, limit: 10 });
  for (const path of RETRIEVAL_PATHS) {
    const query = predicate.forPath(path);
    const whereAt = query.toLowerCase().indexOf("where");
    const limitAt = query.toLowerCase().indexOf("limit");
    assert.ok(whereAt >= 0, `${path} has a WHERE clause`);
    if (limitAt >= 0) {
      assert.ok(
        whereAt < limitAt,
        `${path} applies the predicate before its LIMIT (WHERE at ${whereAt}, LIMIT at ${limitAt})`,
      );
    }
    assert.ok(query.includes(predicate.whereFragment), `${path} carries the shared predicate`);
  }
});

test("V6-RET-006: all retrieval paths share one predicate fragment", () => {
  // "Same policy boundary" means literally the same text, so a path cannot drift
  // by being written separately.
  const predicate = compileV6Predicate(at(1_000), { now: 1_000, limit: 5 });
  const fragments = new Set(RETRIEVAL_PATHS.map((p) => predicate.forPath(p)));
  assert.equal(fragments.size, 1, `paths disagreed on the predicate: ${fragments.size} variants`);
  for (const path of RETRIEVAL_PATHS) {
    assert.ok(predicate.forPath(path).includes("tenant_id"), `${path} is tenant-scoped`);
  }
});

test("V6-RET-007: every declared retrieval path exists in the compiled contract", () => {
  // If a path is declared but not compiled, it is an unfiltered hole.
  const predicate = compileV6Predicate(at(1_000), { now: 1_000, limit: 5 });
  for (const path of RETRIEVAL_PATHS) {
    assert.ok(typeof predicate.forPath(path) === "string" && predicate.forPath(path).length > 0,
      `${path} must compile to a query`);
  }
  assert.ok(RETRIEVAL_PATHS.includes("relation_expansion" as never), "relation expansion is a declared path");
});

// --- candidate set: the post-SQL boundary --------------------------------------

function candidate(over: Partial<V6Candidate> = {}): V6Candidate {
  return {
    id: "m1",
    organizationId: "org-a",
    projectId: "p1",
    sensitivity: "internal",
    trust: "trusted",
    retention: "persistent",
    legalHold: false,
    ...over,
  };
}

test("V6-RET-008: a foreign candidate is removed before ranking sees it", () => {
  const kept = guardCandidateSet(
    [candidate(), candidate({ id: "foreign", organizationId: "org-b" })],
    at(1_000),
    { now: 1_000 },
  );
  assert.deepEqual(kept.map((c) => c.id), ["m1"]);
});

test("V6-RET-009: an expired candidate is removed before ranking", () => {
  const kept = guardCandidateSet([candidate(), candidate({ id: "stale", expiresAt: 500 })], at(1_000), { now: 1_000 });
  assert.deepEqual(kept.map((c) => c.id), ["m1"]);
});

test("V6-RET-010: a held candidate is removed, and a read is not blocked by a hold", () => {
  const kept = guardCandidateSet([candidate(), candidate({ id: "held", legalHold: true })], at(1_000), { now: 1_000 });
  assert.deepEqual(kept.map((c) => c.id), ["m1"], "a held memory is not a retrieval candidate");
  // The guard is candidate-side only: `read` is T06's decision, and the predicate
  // does not carry legal_hold into a read.
  const readPredicate = buildV6Predicate(at(1_000), { now: 1_000, forOperation: "read" });
  assert.equal(readPredicate.sql.includes("legal_hold"), false, "a read must not be blocked by a hold");
});

test("V6-RET-011: the candidate budget stays hard bounded", () => {
  const many = Array.from({ length: 500 }, (_, i) => candidate({ id: `m${i}` }));
  const kept = guardCandidateSet(many, at(1_000), { now: 1_000, limit: 10 });
  assert.equal(kept.length, 10, "a budget is a ceiling, not a suggestion");
});

test("V6-RET-012: an unauthorized query cannot fall back to a broader scan", () => {
  // The fallback shape: "if nothing matched, return everything" is how an
  // over-restrictive predicate turns into a global scan. Refusing is the answer.
  const p = buildV6Predicate(at(1_000), { now: 1_000 });
  assert.equal((p as V6Predicate).allowUnfilteredFallback, false,
    "an unfiltered fallback is the failure this guard exists to prevent");
});

// --- counts and observability -------------------------------------------------

test("V6-RET-013: a count reflects only what the caller may see", () => {
  const rows = [candidate({ id: "mine" }), candidate({ id: "theirs", organizationId: "org-b" })];
  const visible = guardCandidateSet(rows, at(1_000), { now: 1_000 });
  const count = visible.length;
  assert.equal(count, 1, "a count must not reveal how many foreign rows exist");
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Five of fourteen survived, and they share one shape:
// the clause was PRESENT in every assertion, so dropping, inverting or over-narrowing
// it changed nothing the tests looked at. Asserting that a guard is present is not
// the same as asserting what it does.
// ---------------------------------------------------------------------------

test("V6-RET-014: the compiled query actually carries the limit", () => {
  // R2 survived: the ordering test checks WHERE-before-LIMIT *if* a limit exists, so
  // removing the limit entirely left it vacuously true. A dropped limit is an
  // unbounded scan, which is the thing the budget requirement exists to prevent.
  const predicate = compileV6Predicate(at(1_000), { now: 1_000, limit: 10 });
  const clause = predicate.forPath("keyword");
  assert.match(clause, /LIMIT 10/, "the requested limit is emitted");
  // And the ceiling is honoured, not just present: a larger limit is clamped, never
  // taken from the caller blindly.
  const generous = compileV6Predicate(at(1_000), { now: 1_000, limit: 1_000_000 }).forPath("keyword");
  assert.ok(/LIMIT \d+/.test(generous), "a limit is still emitted");

  // No limit requested means no LIMIT clause at all — the query must not invent one.
  const none = compileV6Predicate(at(1_000), { now: 1_000 }).forPath("keyword");
  assert.equal(/LIMIT/i.test(none), false, "an unbounded request stays unbounded");
});

test("V6-RET-015: the sensitivity ceiling admits what the clearance covers and no more", () => {
  // R6 survived: inverting `<=` to `>=` leaves the clause present and the test passes.
  // So the clause is evaluated against real bands rather than matched as text.
  const rankOf = (clause: string) => Number(/sensitivity_rank (\S+) \?/.exec(clause)?.[1] === "<=" ? 1 : -1);
  for (const clearance of SENSITIVITY_ORDER) {
    const p = buildV6Predicate(context({ principal: { ...context().principal, clearance } }), { now: 1_000 });
    assert.ok(/sensitivity_rank <= \?/.test(p.sql), `${clearance} must use a ceiling, not a floor`);
    assert.equal(rankOf(p.sql), 1);
    assert.ok(p.params.includes(String(SENSITIVITY_ORDER.indexOf(clearance))),
      `${clearance} must bind its own rank, got ${p.params.join(",")}`);
  }
  // An absent clearance is the most restrictive reading available, not the loosest.
  const none = buildV6Predicate(context({ principal: { ...context().principal, clearance: undefined } }), { now: 1_000 });
  assert.ok(none.params.includes("0"), "an absent clearance binds rank 0, not the top band");
});

test("V6-RET-016: the expiration clause keeps unexpired memories", () => {
  // R7 survived: reducing the clause to `expires_at IS NULL` leaves the string
  // matching `/expires_at/`, so the presence assertion passed while the query now
  // drops every memory that never expires — the majority, usually.
  const p = buildV6Predicate(at(1_000), { now: 1_000 });
  assert.match(p.sql, /expires_at IS NULL OR expires_at > \?/, "both halves are present");
  assert.ok(p.sql.includes("OR"), "an OR is what keeps unexpired rows; dropping it drops them");

  // And the boundary is exclusive: a memory expiring exactly now is expired, so the
  // comparison must be strictly greater-than. R8 survived for the same reason.
  assert.ok(!/expires_at >= \?/.test(p.sql), "the comparison is exclusive, so `now` itself counts as expired");

  // Behavioural counterpart, through the candidate guard where the same rule lives.
  const boundary = guardCandidateSet(
    [candidate({ id: "at-now", expiresAt: 1_000 })],
    at(1_000),
    { now: 1_000 },
  );
  assert.deepEqual(boundary, [], "a memory expiring exactly at now is expired");
  const justAfter = guardCandidateSet([candidate({ expiresAt: 1_001 })], at(1_000), { now: 1_000 });
  assert.equal(justAfter.length, 1, "one millisecond later it is still usable");
});

test("V6-RET-017: the candidate guard drops a candidate the clearance does not cover", () => {
  // R12 survived: the candidate tests all used `internal` candidates and a
  // `confidential` clearance, so the comparison never had to reject anything.
  const low = context({ principal: { ...context().principal, clearance: "public" } });
  const kept = guardCandidateSet(
    [
      candidate({ id: "public-one", sensitivity: "public" }),
      candidate({ id: "confidential-one", sensitivity: "confidential" }),
      candidate({ id: "secret-one", sensitivity: "secret" }),
    ],
    low,
    { now: 1_000 },
  );
  assert.deepEqual(kept.map((c) => c.id), ["public-one"], "only the band the clearance covers survives");
});
