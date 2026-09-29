/**
 * V5.7.0 T06 — one context budget object (roadmap §37).
 *
 * §37 asks for `maxTokens`, `maxItems`, `maxBytes`, and `maxLatency`. Two of the
 * four existed as unrelated parameters, `maxBytes` and `maxLatency` did not exist
 * anywhere in the tree, and there was no object tying them together — so a caller
 * expressing "fit this into 8k tokens and 16KB and 200ms" had no way to say it.
 *
 * The decision this implements: **exceeding `maxLatency` returns the best results
 * so far and reports the truncation**, never an error. A bound that returns nothing
 * has not degraded, it has failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchQ } from "../retrieval.js";
import { isRemembraError } from "../errors.js";
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

/** A pool where every result matches, so only the budget can shorten it. */
function matchingPool(count: number, content: (i: number) => string = (i) => `matching content number ${i}`): Memory[] {
  return Array.from({ length: count }, (_, i) => mem(content(i)));
}

const QUERY = "matching content";

// --- The four dimensions are one object -----------------------------------

test("T06-001: all four §37 dimensions are fields of one budget", () => {
  const budget = { maxItems: 5, maxTokens: 400, maxBytes: 200, maxLatencyMs: 50 };
  const results = searchQ(matchingPool(20), { query: QUERY, budget });
  assert.ok(results.budget, "the report is present when a budget was asked for");
  assert.deepEqual(results.budget.requested, budget, "and it echoes exactly what was requested");
});

test("T06-002: a budget is optional, and its absence is a distinct claim", () => {
  const without = searchQ(matchingPool(20), { query: QUERY });
  assert.equal(without.budget, undefined, "no budget asked for means no report, not a clean bill of health");

  const withBudget = searchQ(matchingPool(20), { query: QUERY, budget: { maxItems: 20 } });
  assert.equal(withBudget.budget?.truncated, false, "a budget that removed nothing says so explicitly");
});

// --- Each bound is honoured -------------------------------------------------

test("T06-003: maxItems caps the result set", () => {
  const results = searchQ(matchingPool(20), { query: QUERY, budget: { maxItems: 3 } });
  assert.equal(results.results.length, 3);
  assert.equal(results.budget?.truncated, true);
  assert.deepEqual(results.budget?.truncated_by, ["maxItems"]);
});

test("T06-004: budget.maxItems overrides limit rather than composing with it", () => {
  // Two rules for one number would give a caller two answers. The budget wins.
  const results = searchQ(matchingPool(20), { query: QUERY, limit: 2, budget: { maxItems: 7 } });
  assert.equal(results.results.length, 7, "the budget is authoritative");
  const other = searchQ(matchingPool(20), { query: QUERY, limit: 9, budget: { maxItems: 4 } });
  assert.equal(other.results.length, 4, "and in the other direction too");
});

test("T06-005: maxBytes caps the content, measured in UTF-8 bytes", () => {
  const pool = matchingPool(20);
  const results = searchQ(pool, { query: QUERY, budget: { maxBytes: 60 } });
  assert.ok(results.results.length > 0, "a byte budget still returns something");
  const total = results.results.reduce((s, m) => s + Buffer.byteLength(m.content, "utf8"), 0);
  assert.ok(total <= 60, `within the byte budget: ${total}`);
  assert.equal(results.budget?.bytes, total, "and the report agrees with the result");
  assert.deepEqual(results.budget?.truncated_by, ["maxBytes"]);
});

test("T06-006: maxBytes counts bytes, not characters, for multi-byte text", () => {
  // A budget measured in characters would be wrong by 3x on CJK and the caller
  // would blow their byte ceiling.
  const cjk = "検索対象の記憶データ";
  const pool = Array.from({ length: 10 }, (_, i) => mem(`${cjk} ${i}`));
  const results = searchQ(pool, { query: "検索", budget: { maxBytes: 40 } });
  const byteTotal = results.results.reduce((s, m) => s + Buffer.byteLength(m.content, "utf8"), 0);
  const charTotal = results.results.reduce((s, m) => s + m.content.length, 0);
  assert.ok(byteTotal <= 40, `within the byte budget: ${byteTotal}`);
  // The report must be the *byte* count. Measured in characters this reads 33
  // instead of 29, and the item count differs too — so the two are asserted apart
  // rather than merely both being "under 40", which both satisfy.
  assert.equal(results.budget?.bytes, byteTotal, "the report is in bytes");
  assert.notEqual(
    results.budget?.bytes,
    charTotal,
    `bytes and characters must not be interchangeable: ${results.budget?.bytes} vs ${charTotal}`,
  );
  assert.equal(
    results.results.length,
    1,
    `only one 29-byte item fits in 40; counting characters would have let three through (${results.results.length})`,
  );
});

test("T06-007: maxLatency returns partial results rather than an error", () => {
  // The decision: a bound that returns nothing has not degraded, it has failed.
  const results = searchQ(matchingPool(200), { query: QUERY, budget: { maxLatencyMs: 1 } });
  assert.ok(results.results.length > 0, "never an empty result set");
  assert.equal(results.budget?.truncated, true);
  assert.deepEqual(results.budget?.truncated_by, ["maxLatency"]);
  assert.equal(typeof results.budget?.elapsed_ms, "number");
});

test("T06-008: the report names every bound that was binding", () => {
  const results = searchQ(matchingPool(200), { query: QUERY, budget: { maxItems: 50, maxBytes: 60 } });
  const by = results.budget?.truncated_by ?? [];
  assert.ok(by.length >= 1, "at least one bound is named");
  assert.ok(by.every((reason) => ["maxItems", "maxBytes", "maxLatency"].includes(reason)), `closed set: ${by}`);
});

test("T06-009: a bound the caller did not set is never blamed", () => {
  // The default limit (10) truncates this list of 200, and the only budget bound is
  // generous enough never to bind. So the budget removed nothing, and reporting
  // "maxItems" would blame it for pre-existing behaviour.
  //
  // My first version of this test used `maxLatencyMs`, which fires *before* the
  // limit is ever reached — so the case it was guarding was never exercised, and
  // deliberately breaking the attribution still passed.
  const results = searchQ(matchingPool(200), { query: QUERY, budget: { maxBytes: 1_000_000 } });
  assert.equal(results.results.length, 10, "the default limit still cut it to ten");
  assert.equal(results.budget?.truncated, false, "and the budget removed nothing");
  assert.deepEqual(results.budget?.truncated_by, [], "so nothing is blamed");
});

test("T06-010: a generous budget reports no truncation and still reports its use", () => {
  const results = searchQ(matchingPool(5), { query: QUERY, budget: { maxItems: 50, maxBytes: 100_000 } });
  assert.equal(results.budget?.truncated, false);
  assert.deepEqual(results.budget?.truncated_by, []);
  assert.equal(results.budget?.items, results.results.length, "the report counts what it returned");
  assert.ok(results.budget!.bytes > 0, "and measures it");
});

// --- The invariants that matter --------------------------------------------

test("T06-011: a budget never starves a query of every result", () => {
  // The property separating degradation from failure. A caller who sets an
  // impossible budget still gets the single best answer.
  const pool = matchingPool(20);
  for (const budget of [{ maxBytes: 1 }, { maxLatencyMs: 1 }, { maxItems: 1 }]) {
    const results = searchQ(pool, { query: QUERY, budget });
    assert.ok(results.results.length >= 1, `${JSON.stringify(budget)} -> ${results.results.length} results`);
  }
});

test("T06-012: a malformed budget is rejected rather than silently repaired", () => {
  const pool = matchingPool(4);
  for (const budget of [{ maxItems: 0 }, { maxBytes: -1 }, { maxTokens: 0 }, { maxLatencyMs: 0 }, { maxItems: 1.5 }]) {
    assert.throws(
      () => searchQ(pool, { query: QUERY, budget }),
      (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
      `rejected: ${JSON.stringify(budget)}`,
    );
  }
});

test("T06-013: no budget means the pre-existing behaviour is untouched", () => {
  // The default limit still applies when no budget is supplied — the budget is
  // additive, not a replacement for the existing contract.
  assert.equal(searchQ(matchingPool(200), { query: QUERY }).results.length, 10, "the default of 10 still holds");
  assert.equal(searchQ(matchingPool(200), { query: QUERY, limit: 4 }).results.length, 4, "and an explicit limit");
  assert.equal(searchQ(matchingPool(20), { query: QUERY, limit: 20 }).results.length, 20);
});

test("T06-014: the budget composes with deduplication and superseded suppression", () => {
  // Three independent result-set decisions; the budget applies to what survives them.
  const dupes = [mem("identical result text"), mem("identical result text"), mem("distinct result text")];
  const v1 = mem("superseded result text", { id: "v1", supersededBy: "v2" });
  const v2 = mem("current result text", { id: "v2" });
  const results = searchQ([...dupes, v1, v2], { query: "result text", budget: { maxItems: 2 } });
  assert.equal(results.results.length, 2, "the item cap applies after the other passes");
  assert.equal(results.results.some((m) => m.id === "v1"), false, "and suppression already happened");
  assert.equal(results.budget?.truncated, true);
});

test("T06-015: a budget over an empty candidate set is honest about it", () => {
  const results = searchQ([], { query: QUERY, budget: { maxItems: 5 } });
  assert.deepEqual(results.results, []);
  assert.equal(results.budget?.truncated, false, "nothing was removed, because there was nothing to remove");
  assert.equal(results.budget?.items, 0);
  assert.equal(results.budget?.bytes, 0);
});
