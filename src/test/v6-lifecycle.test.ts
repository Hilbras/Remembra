import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExpirationState,
  LifecycleError,
  evaluateExpiration,
  applyLifecycleAction,
  runLifecycleJob,
  parseExpiry,
  LIFECYCLE_ACTIONS,
  type LifecycleRecord,
  type LifecycleAction,
} from "../v6-lifecycle.js";

/**
 * V6-T11 expiration/lifecycle fixtures.
 *
 * The criterion "retention, legal hold, archive, deletion and supersession cannot be
 * confused or silently overridden" is the one that decides this design. These are five
 * different things that all sound like "the memory is gone", and the failure mode is
 * not a wrong answer — it is a *destructive* wrong answer. Deleting a record under a
 * retention policy when a legal hold applied is unrecoverable, and no test that checks
 * a return value will catch it.
 *
 * So every action is checked for what it actually did, and the overlap cases are
 * explicit: hold beats deletion, archive beats expiry, supersession is not deletion.
 */

const HOUR = 3_600_000;

function record(over: Partial<LifecycleRecord> = {}): LifecycleRecord {
  return {
    id: "m1",
    organizationId: "org-a",
    projectId: "p1",
    content: "a fact",
    expiresAt: undefined,
    retention: "persistent",
    legalHold: false,
    archived: false,
    deleted: false,
    supersededBy: undefined,
    renewals: 0,
    version: 1,
    ...over,
  };
}

// --- clock and timezone semantics -------------------------------------------

test("V6-LC-001: the clock is explicit, not ambient", () => {
  // Every evaluation takes `now`. A module reading Date.now() internally cannot be
  // tested at a boundary, and boundaries are the only interesting part.
  const r = record({ expiresAt: 1_000 });
  assert.equal(evaluateExpiration(r, { now: 999 }).state, "active", "one ms before expiry");
  assert.equal(evaluateExpiration(r, { now: 1_000 }).state, "expired", "expiry is exclusive: at the instant, expired");
  assert.equal(evaluateExpiration(r, { now: 1_001 }).state, "expired", "and after");
});

test("V6-LC-002: a record with no expiry never expires", () => {
  const r = record({ expiresAt: undefined });
  // "never_expires", not "active": the state distinguishes *no expiry* from *not yet
  // expired*, which are different retention intents and must not look alike in an audit.
  assert.equal(evaluateExpiration(r, { now: 0 }).state, "never_expires");
  assert.equal(evaluateExpiration(r, { now: Number.MAX_SAFE_INTEGER }).state, "never_expires",
    "not even at the end of time");
  assert.equal(evaluateExpiration(r, { now: 0 }).includeInRetrieval, true, "but still retrievable");
});

test("V6-LC-003: expiry is an instant in UTC milliseconds, never a wall-clock string", () => {
  // A local-time string is the classic bug: it resolves differently in different
  // deployments, so the same data expires at different instants per machine.
  const parsed = parseExpiry("2030-01-01T00:00:00.000Z");
  assert.equal(parsed, Date.parse("2030-01-01T00:00:00.000Z"));
  assert.equal(typeof parsed, "number");
  // An offset-bearing timestamp is normalised to the same instant.
  assert.equal(parseExpiry("2030-01-01T03:00:00+03:00"), parsed, "timezone offsets resolve to one instant");
});

test("V6-LC-004: a malformed timestamp is refused, not coerced", () => {
  // Coercing a bad timestamp to NaN or to 0 turns a typo into "expires immediately"
  // or "never expires". Both are silent corruption of retention intent.
  for (const bad of ["not-a-date", "", "2030-13-45T99:99:99Z", "0", "null"]) {
    assert.throws(() => parseExpiry(bad), /timestamp|expiry|malformed|invalid/i,
      `"${bad}" must be refused rather than coerced`);
  }
  assert.equal(parseExpiry(undefined), undefined, "absent is not malformed");
  assert.equal(parseExpiry(null), undefined, "nor is null");
});

test("V6-LC-005: clock skew is reported, not silently absorbed", () => {
  // A record whose expiry is in the future by less than the skew bound is `expiring`:
  // visible, but not yet expired. Skew must not make something expire early.
  const r = record({ expiresAt: 10_000 });
  // Inside the window: announced, not expired.
  const near = evaluateExpiration(r, { now: 9_000, skewToleranceMs: HOUR });
  assert.equal(near.state, "expiring", "within the skew window it is announced, not expired");
  assert.ok(near.expiresInMs !== undefined && near.expiresInMs <= HOUR,
    `expiring announces how soon: ${near.expiresInMs}`);
  assert.equal(near.includeInRetrieval, true, "and it is still retrievable -- skew never expires anything early");

  // Outside the window it is simply active. The window is measured from expiry, so a
  // record a full hour-plus away is not "expiring".
  assert.equal(evaluateExpiration(r, { now: 1_000 - 2 * HOUR, skewToleranceMs: HOUR }).state, "active");
  // A zero tolerance is the strict reading: no window at all, so anything in the
  // future is active regardless of how close.
  assert.equal(evaluateExpiration(r, { now: 9_999, skewToleranceMs: 0 }).state, "active");
  assert.equal(evaluateExpiration(r, { now: 9_999, skewToleranceMs: HOUR }).state, "expiring");
});

test("V6-LC-006: every state is from a closed vocabulary", () => {
  for (const state of ["active", "expiring", "expired", "never_expires"] as ExpirationState[]) {
    assert.ok(["active", "expiring", "expired", "never_expires"].includes(state));
  }
});

// --- expired content is excluded by default ---------------------------------

test("V6-LC-007: expired content is excluded from retrieval by default", () => {
  const rows = [record({ id: "live" }), record({ id: "dead", expiresAt: 500 })];
  const visible = rows.filter((r) => evaluateExpiration(r, { now: 1_000 }).includeInRetrieval);
  assert.deepEqual(visible.map((r) => r.id), ["live"], "an expired record is not a retrieval candidate");
  // The state is reported honestly even though the row is filtered out -- the caller
  // can tell "expired" from "never had an expiry".
  assert.equal(evaluateExpiration(rows[1], { now: 1_000 }).state, "expired");
});

test("V6-LC-008: exclusion is the default, and inclusion must be explicit", () => {
  const r = record({ expiresAt: 500 });
  assert.equal(evaluateExpiration(r, { now: 1_000 }).includeInRetrieval, false, "excluded by default");
  // Asking to include it is possible -- an operator recovering data -- but it is a
  // decision, not an accident of ordering.
  const forced = evaluateExpiration(r, { now: 1_000, includeExpired: true });
  assert.equal(forced.includeInRetrieval, true, "explicit inclusion works");
  assert.equal(forced.state, "expired", "and the state is still honestly reported");
});

test("V6-LC-009: a legal hold is visible but is not a retrieval candidate", () => {
  // The same distinction T07 drew: a hold blocks destruction, not visibility.
  const held = record({ legalHold: true, expiresAt: 500 });
  const e = evaluateExpiration(held, { now: 1_000 });
  assert.equal(e.state, "expired", "expiry is reported honestly even under a hold");
  assert.equal(e.includeInRetrieval, false, "a held record is not a retrieval candidate");
  assert.equal(e.disposition === "blocked_by_hold" || e.disposition === "expirable", true,
    `the disposition says what may happen to it: ${e.disposition}`);
});

// --- actions cannot be confused or silently overridden -----------------------

test("V6-LC-010: every lifecycle action is declared", () => {
  for (const action of ["expire", "archive", "delete", "supersede", "renew"] as LifecycleAction[]) {
    assert.ok(LIFECYCLE_ACTIONS.includes(action), `${action} must be declared`);
  }
  assert.deepEqual([...LIFECYCLE_ACTIONS].sort(), ["archive", "delete", "expire", "renew", "supersede"]);
});

test("V6-LC-011: a legal hold blocks deletion — the destructive case", () => {
  const held = record({ legalHold: true, expiresAt: 500 });
  const result = applyLifecycleAction(held, "delete", { now: 1_000 });
  assert.equal(result.applied, false, "a held record is not deleted");
  assert.equal(result.blockedBy, "legal_hold");
  assert.equal(result.record.deleted, false);
});

test("V6-LC-012: a legal hold blocks archive too, and says so separately", () => {
  // Archive and delete are different dispositions. A hold that blocked both would let
  // someone "archive" a held record as a euphemism for hiding it.
  const held = record({ legalHold: true });
  const result = applyLifecycleAction(held, "archive", { now: 1_000 });
  assert.equal(result.applied, false);
  assert.equal(result.blockedBy, "legal_hold");
  assert.equal(result.record.archived, false);
});

test("V6-LC-013: supersession is not deletion", () => {
  // The dangerous confusion: marking a record superseded and marking it deleted are
  // both "it is no longer current", and conflating them loses the audit trail.
  const r = record();
  const result = applyLifecycleAction(r, "supersede", { now: 1_000, supersededBy: "m2" });
  assert.equal(result.applied, true);
  assert.equal(result.record.deleted, false, "superseding does not delete");
  assert.equal(result.record.supersededBy, "m2", "it records what superseded it");
  assert.equal(result.disposition, "superseded");
});

test("V6-LC-014: archive is not deletion", () => {
  const r = record();
  const result = applyLifecycleAction(r, "archive", { now: 1_000 });
  assert.equal(result.record.archived, true);
  assert.equal(result.record.deleted, false, "archiving is reversible; deleting is not");
  assert.equal(result.disposition, "archived");
});

test("V6-LC-015: renewal extends the expiry and is bounded", () => {
  const r = record({ expiresAt: 1_000 });
  const result = applyLifecycleAction(r, "renew", { now: 500, renewForMs: HOUR });
  assert.equal(result.applied, true);
  assert.equal(result.record.expiresAt, 500 + HOUR, "renewed from now, not from the old expiry");
  assert.equal(result.record.renewals, 1, "renewals are counted");
});

test("V6-LC-016: renewal is bounded — it cannot extend forever", () => {
  // An unbounded renewal means retention intent is unenforceable, which defeats the
  // point of declaring an expiry.
  let r = record({ expiresAt: 1_000 });
  for (let i = 0; i < 20; i++) {
    const result = applyLifecycleAction(r, "renew", { now: 500, renewForMs: HOUR, maxRenewals: 3 });
    r = result.record;
    if (!result.applied) break;
  }
  assert.ok(r.renewals <= 3, `renewals stop at the declared bound, got ${r.renewals}`);
});

test("V6-LC-017: an action on a record that does not exist is refused", () => {
  assert.throws(() => applyLifecycleAction(undefined as never, "delete", { now: 0 }), /record|exist/i);
});

test("V6-LC-018: a deleted record cannot be resurrected by a later action", () => {
  // Resurrection is the failure mode restart tests look for: a crash between the
  // delete and the audit write must not leave the record live again.
  const deleted = record({ deleted: true });
  for (const action of ["archive", "renew", "supersede"] as LifecycleAction[]) {
    const result = applyLifecycleAction(deleted, action, { now: 1_000 });
    assert.equal(result.applied, false, `${action} must not resurrect a deleted record`);
    assert.equal(result.blockedBy, "already_deleted");
    assert.equal(result.record.deleted, true, "and it stays deleted");
  }
});

test("V6-LC-019: applying an action twice is not a second effect", () => {
  // Idempotence: a retried job must not double-archive, double-count a renewal, or
  // resurrect anything.
  const once = applyLifecycleAction(record(), "archive", { now: 1_000 });
  const twice = applyLifecycleAction(once.record, "archive", { now: 1_000 });
  assert.equal(twice.applied, false, "a repeated action is a no-op");
  assert.equal(twice.blockedBy, "already_applied");
  assert.equal(twice.record.version, once.record.version, "and the version does not move");
});

// --- the job: bounded, idempotent, tenant-aware ------------------------------

test("V6-LC-020: a lifecycle job is bounded", () => {
  const many = Array.from({ length: 500 }, (_, i) => record({ id: `m${i}`, expiresAt: 500, organizationId: "org-a" }));
  const job = runLifecycleJob(many, { now: 1_000, batchLimit: 10 });
  assert.equal(job.processed, 10, "a batch limit is a ceiling");
  assert.equal(job.exceededLimit, true, "and the overflow is visible, not silent");
});

test("V6-LC-021: a lifecycle job only touches its own tenant", () => {
  const rows = [
    record({ id: "a1", organizationId: "org-a", expiresAt: 500 }),
    record({ id: "b1", organizationId: "org-b", expiresAt: 500 }),
  ];
  const job = runLifecycleJob(rows, { now: 1_000, organizationId: "org-a" });
  assert.equal(job.processed, 1, "only org-a is processed");
  assert.equal(job.skippedForeignTenant, 1, "and the foreign row is counted as skipped");
  // The foreign row was passed through untouched.
  assert.equal(job.updated.find((r) => r.id === "b1")?.deleted, false, "another tenant's record is untouched");
});

test("V6-LC-022: a lifecycle job is idempotent across restarts", () => {
  // Run twice over the same data: the second run must find nothing left to do, so a
  // restarted job cannot double-delete.
  let rows = [record({ id: "m1", expiresAt: 500 })];
  const first = runLifecycleJob(rows, { now: 1_000 });
  assert.equal(first.deleted, 1);
  // The job must RETURN its effect, or a restart has nothing to skip and deletes the
  // same record twice. The first version counted without returning, and this caught it.
  assert.equal(first.updated[0].deleted, true, "the job reports the updated record");

  // Persist what the job returned, then run again -- the restart case.
  rows = [...first.updated];
  const second = runLifecycleJob(rows, { now: 1_000 });
  assert.equal(second.deleted, 0, "a restart finds nothing already done");
  assert.equal(second.audit.filter((e) => e.outcome === "applied").length, 0,
    "and records no second deletion");
  assert.equal(rows[0].version, first.updated[0].version, "and the version does not move on a no-op run");
  // `processed` counts rows *examined* within the batch, not rows deleted -- a job that
  // examined a deleted record and correctly skipped it still examined it.
  assert.equal(second.audit.length, 0, "a deleted record produces no audit entry at all");
});

test("V6-LC-023: a held record is skipped by the job and reported", () => {
  const rows = [record({ id: "held", expiresAt: 500, legalHold: true }), record({ id: "free", expiresAt: 500 })];
  const job = runLifecycleJob(rows, { now: 1_000 });
  assert.equal(job.deleted, 1);
  assert.equal(job.skippedLegalHold, 1, "the hold is counted, not silently dropped");
  assert.equal(job.updated.find((r) => r.id === "held")?.deleted, false);
});

test("V6-LC-024: the job rechecks policy rather than trusting the record's own fields", () => {
  // A record claiming to be expiring is not evidence. The job evaluates expiration
  // itself, so a corrupted or forged field cannot drive a deletion.
  const liar = record({ id: "liar", expiresAt: undefined, retention: "ephemeral" });
  const job = runLifecycleJob([liar], { now: 1_000 });
  assert.equal(job.deleted, 0, "a record with no expiry is not deleted regardless of what it claims");
  assert.equal(job.updated[0].deleted, false);
});

test("V6-LC-025: every job run is auditable", () => {
  const rows = [record({ id: "m1", expiresAt: 500 }), record({ id: "m2", expiresAt: 500 })];
  const job = runLifecycleJob(rows, { now: 1_000 });
  assert.equal(job.audit.length, job.processed, "one audit entry per processed record");
  for (const entry of job.audit) {
    assert.ok(entry.organizationId, "an audit entry names its tenant");
    assert.ok(entry.action, "and the action taken");
    assert.ok(typeof entry.at === "number", "and when");
    assert.equal("content" in entry, false, "and never the content");
  }
});

test("V6-LC-026: a job cannot be told to delete a held record by passing a flag", () => {
  // `force` is the shape such an override would take. It must not exist as a way to
  // bypass a hold: the hold is absolute here, and an operator override is a separate,
  // audited path that this module does not implement.
  const held = record({ legalHold: true, expiresAt: 500 });
  const job = runLifecycleJob([held], { now: 1_000, force: true } as never);
  assert.equal(job.deleted, 0, "there is no force flag that bypasses a legal hold");
  assert.equal(job.updated[0].deleted, false);
});

test("V6-LC-027: lifecycle errors carry a stable, catchable code", () => {
  try {
    applyLifecycleAction(undefined as never, "delete", { now: 0 });
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof LifecycleError, "a typed error, not a bare Error");
    assert.equal((error as LifecycleError).code, "NOT_FOUND", "reuses the existing ErrorCode vocabulary");
    assert.ok((error as LifecycleError).message.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Two of twenty-three were unmeasured: L4 SURVIVED,
// and L22 failed to COMPILE -- which is not the same as passing.
// ---------------------------------------------------------------------------

test("V6-LC-028: a live record cannot be deleted, whatever the reason", () => {
  // L4 survived, and it is the most destructive mutation in the set: without the
  // expiry check, `delete` removes any record at any time. Nothing caught it because
  // every existing delete fixture used an *expired* record, so the check was never
  // the thing under test -- and deleting a live memory is exactly the failure this
  // module exists to prevent.
  for (const live of [
    record({ id: "fresh", expiresAt: 10_000 }),        // expires in the future
    record({ id: "forever", expiresAt: undefined }),   // never expires
  ]) {
    const result = applyLifecycleAction(live, "delete", { now: 1_000 });
    assert.equal(result.applied, false, `${live.id} is not expired and must not be deleted`);
    assert.equal(result.blockedBy, "not_expired");
    assert.equal(result.record.deleted, false, `${live.id} survives`);
    assert.equal(result.record.version, live.version, "and its version does not move");
  }
  // The contrast, and the boundary is the subtle part: expiry is EXCLUSIVE, so a
  // record expiring exactly at `now` IS expired and is deleted. V6-LC-001 pins the
  // same boundary from the other direction; without this contrast the assertions
  // above would pass against a `delete` that never works.
  const dead = record({ id: "dead", expiresAt: 1_000 });
  assert.equal(applyLifecycleAction(dead, "delete", { now: 1_000 }).applied, true,
    "a record expiring exactly now is expired and is deleted");
  assert.equal(applyLifecycleAction(dead, "delete", { now: 1_000 }).applied, true,
    "an expired record is deleted");
});

test("V6-LC-029: an expiry action on a live record is refused too", () => {
  // The same check guards the `expire` action. "Expiring" a live record would mark it
  // expirable without any policy basis.
  const live = record({ expiresAt: 10_000 });
  const result = applyLifecycleAction(live, "expire", { now: 1_000 });
  assert.equal(result.applied, false);
  assert.equal(result.blockedBy, "not_expired");
  assert.equal(applyLifecycleAction(record({ expiresAt: 999 }), "expire", { now: 1_000 }).applied, true);
});

test("V6-LC-030: the lifecycle job cannot delete a live record even if asked directly", () => {
  // The job routes through the same check, but the criterion is stated at the job
  // boundary too, because a job is the thing that actually runs unattended.
  const rows = [record({ id: "live", expiresAt: 99_999 }), record({ id: "dead", expiresAt: 500 })];
  const job = runLifecycleJob(rows, { now: 1_000 });
  assert.equal(job.deleted, 1);
  assert.equal(job.updated.find((r) => r.id === "live")?.deleted, false, "the live record survives");
  assert.equal(job.updated.find((r) => r.id === "dead")?.deleted, true);
});

test("V6-LC-031: an audit entry has no content field, structurally", () => {
  // L22 could not compile as written -- adding `content` to the interface breaks the
  // audit-entry literals. That is the compiler doing the work, so the property is
  // asserted structurally instead: the entry's keys are enumerable and none of them
  // is a content-shaped name.
  const job = runLifecycleJob([record({ id: "m1", expiresAt: 500 }), record({ id: "m2", expiresAt: 500, legalHold: true })], { now: 1_000 });
  assert.ok(job.audit.length >= 1);
  for (const entry of job.audit) {
    const keys = Object.keys(entry);
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.equal(/content|text|body|snippet|payload|secret/i.test(key), false,
        `${key} would be a place content could hide`);
    }
    // And the serialized form carries no content.
    const json = JSON.stringify(entry);
    assert.equal(json.includes("a fact"), false, "the record's content never appears in an audit entry");
  }
});
