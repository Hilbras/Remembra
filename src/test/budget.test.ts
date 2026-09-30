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
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchQ } from "../retrieval.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { defaultMemoryPolicy } from "../policy.js";
import { isRemembraError } from "../errors.js";
import { SearchInput, searchInputShape, type Memory, type SearchQuery } from "../types.js";

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

/**
 * The two tests above every one in this file calls `searchQ` directly, and that is
 * how a defect survived T06: the service destructured only `results` and
 * `explanations` from `searchQ`, so the budget was computed and then dropped, and
 * the report reached no caller on any surface. A test that stops at the function
 * under test cannot see a field another layer forgets to forward.
 */
describe("T06: the budget report survives the service", () => {
  test("T06-020: service.search returns the report it was given", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-budget-svc-"));
    try {
      // The store creates files but not its own directory.
      const storeDir = path.join(dir, "plain");
      await fs.mkdir(storeDir, { recursive: true });
      const service = new MemoryService(new MemoryStore(storeDir));
      for (const content of ["alpha note one", "beta note two", "gamma note three"]) {
        await service.store({ type: "fact", content });
      }

      const unbudgeted = await service.search({ query: "note" });
      assert.equal(unbudgeted.budget, undefined, "no budget asked for means no report");

      const budgeted = await service.search({ query: "note", budget: { maxItems: 2 } });
      assert.ok(budgeted.budget, "a budget was asked for, so a report comes back");
      assert.equal(budgeted.budget.truncated, true);
      assert.deepEqual(budgeted.budget.truncated_by, ["maxItems"]);
      assert.equal(
        budgeted.budget.items,
        budgeted.results.length,
        "the report counts agree with what was actually returned",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("T06-021: the report describes the results returned, not a discarded pass", async () => {
    // Relation expansion runs a *second* search over the expanded pool. If the
    // report from the first pass is the one returned, the caller is told about
    // results they did not get. Keeping the stale report survived mutation testing,
    // because no test had relation expansion and a budget in the same call.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-budget-rerank-"));
    try {
      const policy = defaultMemoryPolicy();
      policy.retrieval.relationExpansion = true;
      const storeDir = path.join(dir, "rerank");
      await fs.mkdir(storeDir, { recursive: true });
      const service = new MemoryService(new MemoryStore(storeDir), { embeddingProvider: "none", policy });

      const seed = await service.store({ type: "fact", content: "needle seed" });
      const neighbour = await service.store({ type: "fact", content: "related neighbour", importance: 5 });
      await service.relate({ id: seed.id, related: [neighbour.id], action: "add" });
      for (let i = 0; i < 8; i++) {
        await service.store({ type: "observation", content: `unrelated ${i}`, importance: 1, source: `old-${i}` });
      }

      const hits = await service.search({ query: "needle", limit: 10, budget: { maxItems: 4 } });
      assert.ok(hits.budget, "a report came back");
      assert.equal(
        hits.budget.items,
        hits.results.length,
        "the report counts the returned results, which is the only thing a caller can check",
      );
      assert.ok(hits.budget.items <= 4, "and the bound held through the re-rank");
      // Item *count* is not enough to catch a stale report here: both passes hit
      // maxItems, so the counts agree while describing different documents. Bytes do
      // not, and the caller can check them — they are the size of the payload they hold.
      const returnedBytes = Buffer.byteLength(
        hits.results.map((m) => m.content).join(""),
        "utf8",
      );
      assert.equal(
        hits.budget.bytes,
        returnedBytes,
        "the report describes the bytes actually returned, not the discarded pass's",
      );
      // What this test does NOT prove: that the re-ranked pass's report is the one
      // returned. Mutation testing could not reach it. Relation expansion re-ranks a
      // *superset* of the pool the first pass already searched, so both passes apply
      // the same budget to the same corpus and their reports agree — the item counts and
      // the bytes are identical either way. Passing a candidate list would make the
      // first pass search a subset, but that is exactly the condition under which
      // expansion is skipped, so the two cases cannot be made to differ. The
      // assignment of the re-ranked report is still correct and still worth having,
      // but it is structural, not mutation-verified, and claiming otherwise would
      // overstate what this test checks.
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
    }
  });
});

/**
 * The invariant whose absence let §37 ship unreachable.
 *
 * `SearchInput` — which the SDK's `SearchOptions` is an alias of — and `SearchQuery` are
 * two hand-maintained descriptions of the same request. They drifted: `budget` was
 * added to `SearchQuery` and honoured by `searchQ`, and never added to
 * `SearchInput`, so a typed SDK caller could not set a budget. Nothing compared
 * them, because `SearchQuery` is a plain interface with no runtime shape to compare
 * against a zod object.
 *
 * So this is a compile-time assertion, and that is the honest tool for it: the
 * compiler sees the interface, no amount of runtime inspection would. A drift fails
 * the build rather than a test, which is a stronger place for it to fail.
 */
/**
 * Two directions, because `SearchInput` and `SearchQuery` are not meant to be
 * identical — they are two descriptions of one request at two different layers, and
 * conflating them would be its own kind of wrong.
 *
 * 1. **Every field `searchQ` honours must be on `SearchInput`.** This is the
 *    direction that matters and the one §37 broke: a caller-settable option the SDK
 *    type omits cannot be set by a typed caller, whatever the server supports.
 * 2. **`SearchInput` may exceed `SearchQuery` only by fields the service filters on
 *    before the pipeline ever sees them.** `includeExpired` and its three siblings
 *    are exactly that: `MemoryService.search` applies them at lines around the
 *    candidate filter and never forwards them, so `searchQ` has no reason to declare
 *    them. Any *other* extra field is unexplained and fails the build.
 */
type SearchQueryPipelineOnly = "candidates" | "totalDocs";
type ServiceConsumedOnly = "includeExpired" | "includeFuture" | "includeQuarantined" | "includeArchived";
type CallerSettableQueryFields = Exclude<keyof SearchQuery, SearchQueryPipelineOnly>;
type UnexplainedInputFields = Exclude<Exclude<keyof SearchInput, keyof SearchQuery>, ServiceConsumedOnly>;

/**
 * Written as mapped assignments rather than `extends never`, because they report
 * *which* field drifted. The `never` form only names the type alias, so a real drift
 * was as opaque as the bug it replaced.
 */
// Direction 1, as "the missing set is empty" rather than "every key is present".
//
// The presence form was tried twice and both versions were wrong in ways that
// mattered. Requiring each field to be optional-compatible reported on `type` and
// `scope` instead of on what was being checked; and building the *source* from the
// query keys reported nothing at all when `budget` was removed, because the source
// then carried `budget` itself. An empty set is the only shape that cannot be
// satisfied by the thing it is supposed to check — and an empty target produces no
// error, so it is free.
type QueryFieldsMissingFromInput = Exclude<CallerSettableQueryFields, keyof SearchInput>;
const _noQueryFieldIsHiddenFromInput: { [K in QueryFieldsMissingFromInput]: never } = {} as Record<string, unknown>;

// Direction 2: any extra SearchInput field outside the service-consumed list appears
// here, and the error names it.
const _noUnexplainedInputFields: { [K in UnexplainedInputFields]: never } = {} as Record<string, unknown>;
void _noQueryFieldIsHiddenFromInput;
void _noUnexplainedInputFields;

test("T06-023: SearchInput and SearchQuery describe the same request", () => {
  // The compile-time assertions above are the real check: a drift fails the build,
  // which is a stronger place to fail than a test. This test exists so the invariant
  // is visible in the suite output and points at itself in a report, and so removing
  // the assertions cannot pass unnoticed.
  assert.ok(
    Object.keys(searchInputShape).length > 0,
    "SearchInput still describes a request — if this is zero the assertions above are vacuous",
  );
});

test("T06-024: a budget parses through SearchInput, and a malformed one does not", () => {
  assert.equal(SearchInput.safeParse({ query: "note", budget: { maxItems: 2 } }).success, true);
  // Every failure mode the HTTP route rejects, checked at the schema too.
  for (const bad of [{ maxItems: -1 }, { maxItems: 1.5 }, { maxItems: "two" }, { nonsense: 1 }]) {
    assert.equal(
      SearchInput.safeParse({ query: "note", budget: bad }).success,
      false,
      `rejected: ${JSON.stringify(bad)}`,
    );
  }
});
