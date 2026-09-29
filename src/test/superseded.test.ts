/**
 * V5.7.0 T05 — superseded-memory suppression.
 *
 * The decision this implements, recorded in the plan: **suppress by default, with
 * an explicit `includeSuperseded` escape hatch.** §36 forbids *destroying*
 * historical records, which is a statement about storage and not retrieval, so it
 * does not answer this. A query for "the support policy" should get the current
 * version; a query for "what did the policy say in January" is a real question too
 * and gets v1 on request.
 *
 * The part that took the most care is the boundary: suppression only happens when
 * the superseding memory is actually available. Suppressing a copy whose superseder
 * is missing or filtered out would replace a stale answer with **no** answer, which
 * is the wrong direction to fail in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchQ } from "../retrieval.js";
import type { Memory } from "../types.js";

let seq = 0;
function mem(content: string, over: Partial<Memory> = {}): Memory {
  seq++;
  return {
    id: over.id ?? `m${String(seq).padStart(3, "0")}`,
    type: "fact",
    content,
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** v1 and v2 of the same policy, where v1 points at v2. */
function versionedPolicy() {
  const v1 = mem("refunds are 30 days", { id: "v1", supersededBy: "v2" });
  const v2 = mem("refunds are 45 days", { id: "v2" });
  return { v1, v2 };
}

const ids = (results: Memory[]): string[] => results.map((m) => m.id);

// --- The default ----------------------------------------------------------

test("T05-001: a superseded copy is suppressed by default and the current one answers", () => {
  const { v1, v2 } = versionedPolicy();
  const results = searchQ([v1, v2], { query: "refunds" });
  assert.deepEqual(ids(results.results), ["v2"], "only the current version is returned");
  assert.equal(results.results[0]!.content, "refunds are 45 days");
});

test("T05-002: includeSuperseded brings the old version back", () => {
  const { v1, v2 } = versionedPolicy();
  const results = searchQ([v1, v2], { query: "refunds", includeSuperseded: true });
  assert.deepEqual(ids(results.results).sort(), ["v1", "v2"], "both versions on request");
});

test("T05-003: a memory with no superseder is never affected", () => {
  const solo = mem("the API rate limit is 60 per minute", { id: "solo" });
  const results = searchQ([solo], { query: "rate limit" });
  assert.deepEqual(ids(results.results), ["solo"], "an ordinary memory comes back unchanged");
});

test("T05-004: several superseded copies all yield to one current version", () => {
  const v1 = mem("deploys are manual on fridays", { id: "v1", supersededBy: "v3" });
  const v2 = mem("deploys are manual on fridays except fridays", { id: "v2", supersededBy: "v3" });
  const v3 = mem("deploys are fully automated", { id: "v3" });
  const results = searchQ([v1, v2, v3], { query: "deploys manual" });
  assert.deepEqual(ids(results.results), ["v3"], "one answer, not three versions of it");
});

test("T05-005: a chain ends at the newest link, not an intermediate one", () => {
  // v1 → v2 → v3. Suppressing only on a direct "the superseder is not itself
  // superseded" rule would leave v2 in the results, so a three-deep chain would
  // return two answers instead of one.
  const v1 = mem("limit 10", { id: "v1", supersededBy: "v2" });
  const v2 = mem("limit 20", { id: "v2", supersededBy: "v3" });
  const v3 = mem("limit 30", { id: "v3" });
  const results = searchQ([v1, v2, v3], { query: "limit" });
  assert.deepEqual(ids(results.results), ["v3"], "the chain collapses to the newest link");
  assert.equal(searchQ([v1, v2, v3], { query: "limit", includeSuperseded: true }).results.length, 3);
});

// --- The boundary that matters most ---------------------------------------

test("T05-006: a dangling supersededBy keeps the old copy visible", () => {
  // The reference points at a memory that is not in the pool — deleted, archived,
  // or filtered out by scope. Suppressing here would leave the caller with nothing
  // at all, which is strictly worse than a stale answer.
  const orphan = mem("refunds are 30 days", { id: "v1", supersededBy: "deleted-long-ago" });
  const results = searchQ([orphan], { query: "refunds" });
  assert.deepEqual(ids(results.results), ["v1"], "kept, because the replacement is unavailable");
});

test("T05-007: suppression respects the pool, so a scoped-out superseder keeps the old copy", () => {
  const v1 = mem("policy for global scope", { id: "v1", scope: "global", supersededBy: "v2" });
  const v2 = mem("policy for project scope only", { id: "v2", scope: "project/other" });
  // Querying without a scope: both are candidates, so v1 is suppressed.
  assert.deepEqual(ids(searchQ([v1, v2], { query: "policy" }).results), ["v2"]);
  // With v2 filtered out of the pool entirely, v1 has no replacement available.
  assert.deepEqual(ids(searchQ([v1], { query: "policy" }).results), ["v1"]);
});

test("T05-008: an includeSuperseded request is not itself suppressed", () => {
  const { v1, v2 } = versionedPolicy();
  const results = searchQ([v1, v2], { query: "refunds", includeSuperseded: true });
  assert.equal(results.results.some((m) => m.id === "v2"), true, "the current version is still there");
  assert.equal(results.results.some((m) => m.id === "v1"), true, "alongside the old one");
});

// --- Composition with T04 -------------------------------------------------

test("T05-009: suppression and deduplication compose in the right order", () => {
  // Different mechanisms: one removes a *version*, the other removes a *repeat*.
  // A superseded copy that is also an exact duplicate should not be counted twice
  // as a reason for suppression, and the survivor should still be the current one.
  const v1 = mem("refunds are 45 days", { id: "v1", supersededBy: "v2" });
  const v2 = mem("refunds are 45 days", { id: "v2" });
  const results = searchQ([v1, v2], { query: "refunds" });
  assert.deepEqual(ids(results.results), ["v2"], "one answer: the current, non-duplicate copy");
});

test("T05-010: a superseded copy and a distinct memory both behave correctly", () => {
  const v1 = mem("refunds are 30 days", { id: "v1", supersededBy: "v2" });
  const v2 = mem("refunds are 45 days", { id: "v2" });
  const unrelated = mem("escalation goes to the on-call engineer", { id: "unrelated" });
  const results = searchQ([v1, v2, unrelated], { query: "refunds escalation" });
  assert.equal(results.results.some((m) => m.id === "v1"), false, "the old version is gone");
  assert.equal(results.results.some((m) => m.id === "unrelated"), true, "and the unrelated memory is untouched");
});

test("T05-011: suppression never removes every result", () => {
  // The invariant that distinguishes this from a filter that can starve a query.
  for (const pool of [
    [mem("a", { id: "a", supersededBy: "gone" })],
    [mem("a", { id: "a", supersededBy: "b" }), mem("b", { id: "b" })],
    [mem("a", { id: "a", supersededBy: "b" }), mem("b", { id: "b", supersededBy: "c" }), mem("c", { id: "c" })],
  ]) {
    const results = searchQ(pool, { query: "a b c" });
    assert.ok(results.results.length > 0, `a query must never come back empty: ${JSON.stringify(ids(results.results))}`);
  }
});

test("T05-012: nothing is deleted — both versions remain readable", () => {
  const { v1, v2 } = versionedPolicy();
  const before = { v1: { ...v1 }, v2: { ...v2 } };
  searchQ([v1, v2], { query: "refunds" });
  assert.deepEqual(v1, before.v1, "the suppressed copy is untouched, not cleared or rewritten");
  assert.deepEqual(v2, before.v2);
  assert.equal(v1.supersededBy, "v2", "and still knows what superseded it");
});
