import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteBackend } from "../sqlite-backend.js";
import { StoreInput } from "../types.js";

/**
 * A malformed `valid_until` must not read as "never expires".
 *
 * `sqlite-backend.ts` filtered expiry with
 *
 *   OR julianday(m.valid_until) IS NULL
 *   OR julianday(m.valid_until) >= julianday(?)
 *
 * `julianday()` returns NULL for a string it cannot parse, so that second clause
 * matched **every malformed timestamp** and a memory with `validUntil: "not-a-date"`
 * was returned by every search forever. That is the exact failure V6-T11's
 * `parseExpiry` refuses to allow — there, a bad timestamp throws; here it silently
 * became permanent retention.
 *
 * The two halves of the fix are separate and both are tested:
 *
 *  1. **Query**: a malformed value must not satisfy the expiry predicate.
 *  2. **Write**: `store()` and `update()` must refuse a malformed value up front, so
 *     the row cannot be created in the first place. Refusing at write also means an
 *     existing malformed row (imported, migrated, or written by an older version) is
 *     a visible condition rather than permanent silent retention.
 */

async function tempSqlite(): Promise<{ store: SqliteBackend; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-expiry-"));
  const store = new SqliteBackend({ root: dir });
  return { store, dir };
}

const cleanup = async (dir: string): Promise<void> => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
};

/**
 * The keyword path matches on TAGS (json_each), not on content -- see the existing
 * `sqlite: FTS5 search returns IDs` fixture, which searches for a tag and not for a
 * word in the content. My first version searched for a content word and silently
 * matched nothing, so three "the fix excludes too much" failures turned out to be a
 * broken fixture rather than a broken query.
 */
async function countReturned(store: SqliteBackend, id: string, includeExpired = false): Promise<boolean> {
  const page = await store.searchCandidates({
    terms: ["expiry-probe"],
    vector: null,
    now: Date.now(),
    // resultLimit 100 makes the backend report `coverage: partial` (its own budget
    // guard), which is indistinguishable from "excluded". 10 finds the row reliably.
    resultLimit: 10,
    maxCandidates: 100,
    eligible: () => true,
    scope: "",
    ...(includeExpired ? { includeExpired: true } : {}),
  });
  return page.memories.some((m: { id: string }) => m.id === id);
}

test("V6-EX-001: a malformed valid_until is refused at write time", async () => {
  const { store, dir } = await tempSqlite();
  try {
    // Two entry points, both of which must refuse. The schema is what `MemoryService`
    // parses with; the backend guard catches a caller that passes a pre-built object
    // and so never went through the schema. Asserting only one leaves the other open.
    assert.throws(
      () => StoreInput.parse({ type: "fact", content: "a", validUntil: "not-a-date" }),
      /validUntil|ISO-8601|offset|timestamp/i,
      "the schema refuses a malformed expiry",
    );
    await assert.rejects(
      () => store.store({ type: "fact", content: "a", tags: ["expiry-probe"], validUntil: "not-a-date" } as never),
      /validUntil|ISO-8601|offset|timestamp/i,
      "and so does the backend when the schema is bypassed",
    );
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-002: a valid_until with an explicit offset or Z is accepted", async () => {
  const { store, dir } = await tempSqlite();
  try {
    const ok = await store.store(StoreInput.parse({
      type: "fact",
      content: "a",
      tags: ["expiry-probe"],
      validUntil: "2030-01-01T00:00:00.000Z",
    }) as never);
    assert.ok(ok.id);
    const alsoOk = await store.store(StoreInput.parse({
      type: "fact",
      content: "a",
      tags: ["expiry-probe"],
      validUntil: "2030-01-01T03:00:00+03:00",
    }) as never);
    assert.ok(alsoOk.id, "an offset-bearing timestamp resolves to one instant and is valid");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-003: a naive local timestamp is refused", async () => {
  // A timestamp with no offset resolves differently per machine, so the same data
  // expires at different instants per deployment. T11 refuses these; the write path
  // must agree rather than storing a value the query then treats unpredictably.
  const { store, dir } = await tempSqlite();
  try {
    await assert.rejects(
      () => store.store({ type: "fact", content: "a", tags: ["expiry-probe"], validUntil: "2030-01-01T00:00:00" } as never),
      /validUntil|offset|ISO-8601|timestamp/i,
      "a naive local timestamp is refused: it resolves differently per machine",
    );
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-004: a malformed row written directly is excluded from search", async () => {
  // The query-side half. The row is inserted past `store()` to simulate data
  // imported, migrated, or written by an older version — the case a write-time guard
  // alone cannot cover.
  const { store, dir } = await tempSqlite();
  try {
    const good = await store.store(StoreInput.parse({ type: "fact", content: "a", tags: ["expiry-probe"] }) as never);
    const bad = await store.store(StoreInput.parse({ type: "fact", content: "b", tags: ["expiry-probe"] }) as never);

    // Reach past the public API, the way an import or migration would.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare("UPDATE memories SET valid_until = ? WHERE id = ?").run("not-a-date", bad.id);

    assert.equal(await countReturned(store, good.id), true, "a memory with no expiry is still returned");
    assert.equal(
      await countReturned(store, bad.id),
      false,
      "a malformed valid_until must NOT read as never-expires",
    );
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-005: an actually-expired row is still excluded", async () => {
  // The contrast. Without it, the fix above would also pass against a query that
  // excluded everything.
  const { store, dir } = await tempSqlite();
  try {
    const expired = await store.store(StoreInput.parse({
      type: "fact",
      content: "a",
      tags: ["expiry-probe"],
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    }) as never);
    assert.equal(await countReturned(store, expired.id), false, "an expired memory is not a candidate");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-006: a future expiry is still returned", async () => {
  // The other half of the contrast: the fix must not exclude live memories.
  const { store, dir } = await tempSqlite();
  try {
    const live = await store.store(StoreInput.parse({
      type: "fact",
      content: "a",
      tags: ["expiry-probe"],
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }) as never);
    assert.equal(await countReturned(store, live.id), true, "a memory expiring in an hour is a candidate");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-007: includeExpired is still an explicit escape hatch", async () => {
  // The existing V5 flag must keep working, and it must remain the *only* way to see
  // an expired row — which is what makes the malformed case a bug rather than a
  // deliberate policy.
  const { store, dir } = await tempSqlite();
  try {
    const expired = await store.store(StoreInput.parse({
      type: "fact",
      content: "a",
      tags: ["expiry-probe"],
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    }) as never);
    assert.equal(await countReturned(store, expired.id), false, "not returned by default");
    assert.equal(await countReturned(store, expired.id, true),
      true, "includeExpired still returns an expired memory, as V5 did");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Four of ten SURVIVED, and all four are one gap:
// `validFrom` was never tested, and the zone requirement was only ever asserted
// through the backend, never through the schema that also enforces it.
// ---------------------------------------------------------------------------

test("V6-EX-008: validFrom gets the same treatment as validUntil", () => {
  // Q9/Q4 survived: every fixture set validUntil and left validFrom undefined, so the
  // second temporal bound was completely unobserved -- in the schema AND in the query.
  assert.throws(
    () => StoreInput.parse({ type: "fact", content: "a", validFrom: "not-a-date" }),
    /validFrom|ISO-8601|offset|timestamp/i,
    "the schema refuses a malformed validFrom",
  );
  assert.throws(
    () => StoreInput.parse({ type: "fact", content: "a", validFrom: "2030-01-01T00:00:00" }),
    /validFrom|ISO-8601|offset|timestamp/i,
    "and a naive local one",
  );
  assert.ok(
    StoreInput.safeParse({ type: "fact", content: "a", validFrom: "2030-01-01T00:00:00.000Z" }).success,
    "while an explicit-zone instant is accepted",
  );
});

test("V6-EX-009: the backend guard covers validFrom and observedAt too", async () => {
  // Q6 survived: the guard's loop was only ever exercised with validUntil set, so
  // narrowing it to that one field was invisible.
  const { store, dir } = await tempSqlite();
  try {
    for (const [field, value] of [
      ["validFrom", "not-a-date"],
      ["observedAt", "not-a-date"],
    ] as const) {
      await assert.rejects(
        () => store.store({ type: "fact", content: "a", [field]: value } as never),
        new RegExp(`${field}|ISO-8601|offset|timestamp`),
        `the backend guard must cover ${field}`,
      );
    }
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-010: a malformed validFrom does not become always-visible", async () => {
  // The query half for validFrom, mirroring V6-EX-004. A not-yet-valid memory is
  // excluded; the same row with a malformed bound must not slip through the
  // `julianday() IS NULL` branch the way its valid_until twin used to.
  const { store, dir } = await tempSqlite();
  try {
    const good = await store.store(StoreInput.parse({
      type: "fact", content: "a", tags: ["expiry-probe"],
      validFrom: new Date(Date.now() - 60_000).toISOString(),
    }));
    const bad = await store.store(StoreInput.parse({ type: "fact", content: "b", tags: ["expiry-probe"] }));
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare("UPDATE memories SET valid_from = ? WHERE id = ?").run("not-a-date", bad.id);

    assert.equal(await countReturned(store, good.id), true, "a memory valid since an hour ago is returned");
    assert.equal(await countReturned(store, bad.id), false,
      "a malformed validFrom must not read as 'no lower bound'");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-011: a future validFrom is excluded, as it should be", async () => {
  // The contrast for the above, so the fix cannot pass by excluding everything.
  const { store, dir } = await tempSqlite();
  try {
    const future = await store.store(StoreInput.parse({
      type: "fact", content: "a", tags: ["expiry-probe"],
      validFrom: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    assert.equal(await countReturned(store, future.id), false,
      "a memory that is not yet valid is not a candidate");
  } finally {
    store.close();
    await cleanup(dir);
  }
});

test("V6-EX-012: the zone requirement is asserted on the schema itself", async () => {
  // Q10 survived: the refine was only exercised through the backend guard, which has
  // its own copy of the rule. Removing it from the schema left every test passing --
  // two copies of one rule, only one of them tested.
  for (const field of ["validFrom", "validUntil", "observedAt"] as const) {
    for (const naive of ["2030-01-01T00:00:00", "2030-01-01 00:00:00", "2030-01-01"]) {
      assert.equal(
        StoreInput.safeParse({ type: "fact", content: "a", [field]: naive }).success,
        false,
        `${field} must refuse the naive local timestamp ${naive}`,
      );
    }
    // And the offset-bearing form is accepted, so it is the zone that is required and
    // not the format in general.
    for (const zoned of ["2030-01-01T00:00:00.000Z", "2030-01-01T03:00:00+03:00", "2030-01-01T00:00:00+00:00"]) {
      assert.equal(
        StoreInput.safeParse({ type: "fact", content: "a", [field]: zoned }).success,
        true,
        `${field} must accept ${zoned}`,
      );
    }
  }
});
