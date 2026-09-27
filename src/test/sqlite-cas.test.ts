/**
 * Cross-instance write safety on the SQLite backend.
 *
 * `SqliteBackend.withLock` is an in-process promise queue: it serializes writers
 * inside one instance and does nothing across two. The `MemoryBackend`
 * contract nevertheless requires "safe under ... cross-process concurrency
 * (advisory lock)", so every read-modify-write has to be safe on its own.
 *
 * These tests use two backend instances over the SAME `data.sqlite`, which is
 * precisely the shape of two Remembra processes behind a load balancer. They
 * caught a silent lost update: `update` checked `expectedVersion` in application
 * code and then wrote `WHERE id = ?`, so two instances that read the same
 * version both wrote, both were told they succeeded, and one write vanished.
 * The write is now a real compare-and-swap on the version it read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteBackend } from "../sqlite-backend.js";
import { isRemembraError } from "../errors.js";
import type { Memory } from "../types.js";

/** Two independent instances over one database file, as two processes would be. */
async function pair(name: string): Promise<{ a: SqliteBackend; b: SqliteBackend; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `remembra-cas-${name}-`));
  const a = new SqliteBackend({ root });
  const b = new SqliteBackend({ root });
  await a.ready();
  await b.ready();
  return { a, b, root };
}

async function teardown(a: SqliteBackend, b: SqliteBackend, root: string) {
  a.close();
  b.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test("CAS-001: two instances racing the same memory cannot both succeed", async (t) => {
  const { a, b, root } = await pair("race");
  t.after(() => teardown(a, b, root));

  const created = await a.store({ type: "fact", content: "original", scope: "global", importance: 3, tags: [] });
  const id = created.id;

  // Both read before either writes — the interleaving that loses an update.
  const seenByA = await a.get(id);
  const seenByB = await b.get(id);
  assert.ok(seenByA && seenByB, "both instances can read the row");
  assert.equal(seenByA!.version, seenByB!.version, "and they see the same version");

  const results = await Promise.allSettled([
    a.update({ ...seenByA!, content: "written by A" } as Memory, { expectedVersion: seenByA!.version }),
    b.update({ ...seenByB!, content: "written by B" } as Memory, { expectedVersion: seenByB!.version }),
  ]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected");
  assert.equal(succeeded.length, 1, "exactly one writer may succeed");
  assert.equal(refused.length, 1, "and the other must be told, not silently dropped");
  const failure = refused[0] as PromiseRejectedResult;
  assert.equal(isRemembraError(failure.reason), true);
  assert.equal((failure.reason as { code: string }).code, "CONFLICT");

  // The two writers must not both have been told they wrote the same version.
  const versions = succeeded.map((r) => (r as PromiseFulfilledResult<Memory>).value.version);
  assert.equal(new Set(versions).size, versions.length, "no two writers share a version number");

  const final = await a.get(id);
  assert.ok(final);
  assert.equal(final!.version, 2, "exactly one increment happened");
});

test("CAS-002: the refusal names the version that actually won", async (t) => {
  const { a, b, root } = await pair("message");
  t.after(() => teardown(a, b, root));

  const created = await a.store({ type: "fact", content: "original", scope: "global", importance: 3, tags: [] });
  const id = created.id;
  const seenByA = (await a.get(id))!;
  const seenByB = (await b.get(id))!;

  await a.update({ ...seenByA, content: "A wins" } as Memory, { expectedVersion: seenByA.version });
  // B still holds the stale version it read before A's write.
  await assert.rejects(
    () => b.update({ ...seenByB, content: "B loses" } as Memory, { expectedVersion: seenByB.version }),
    (err: unknown) =>
      isRemembraError(err) &&
      err.code === "CONFLICT" &&
      new RegExp(`expected ${seenByB.version}, stored 2`).test(err.message),
    "the caller is told what it expected and what is actually stored",
  );
});

test("CAS-003: a stale expectedVersion is still refused before any write", async (t) => {
  const { a, root } = await pair("stale");
  t.after(() => teardown(a, a, root));

  const created = await a.store({ type: "fact", content: "original", scope: "global", importance: 3, tags: [] });
  const seen = (await a.get(created.id))!;
  await a.update({ ...seen, content: "first" } as Memory, { expectedVersion: seen.version });

  await assert.rejects(
    () => a.update({ ...seen, content: "second" } as Memory, { expectedVersion: seen.version }),
    (err: unknown) => isRemembraError(err) && err.code === "CONFLICT",
  );
  assert.equal((await a.get(created.id))!.content, "first", "the refused write changed nothing");
});

test("CAS-004: a delete between read and write reports NOT_FOUND, not CONFLICT", async (t) => {
  // The CAS predicate can no longer match a row that was deleted, so the two
  // outcomes must be told apart or a caller retries a write that can never land.
  const { a, b, root } = await pair("deleted");
  t.after(() => teardown(a, b, root));

  const created = await a.store({ type: "fact", content: "original", scope: "global", importance: 3, tags: [] });
  const id = created.id;
  const seenByB = (await b.get(id))!;
  await a.forget(id);

  await assert.rejects(
    () => b.update({ ...seenByB, content: "too late" } as Memory, { expectedVersion: seenByB.version }),
    (err: unknown) => isRemembraError(err) && err.code === "NOT_FOUND",
    "a row that no longer exists is not a version conflict",
  );
});

test("CAS-005: the fix does not change single-instance behaviour", async (t) => {
  // Optimistic concurrency with the correct version must still succeed; the CAS
  // predicate must not turn ordinary sequential writes into false conflicts.
  const { a, b, root } = await pair("sequential");
  t.after(() => teardown(a, b, root));

  const created = await a.store({ type: "fact", content: "v1", scope: "global", importance: 3, tags: [] });
  const id = created.id;
  for (let version = 1; version <= 4; version++) {
    const current = (await b.get(id))!;
    const written = await a.update(
      { ...current, content: `v${version + 1}` } as Memory,
      { expectedVersion: version },
    );
    assert.equal(written.version, version + 1, `write ${version + 1} succeeded as expected`);
  }
  assert.equal((await a.get(id))!.content, "v5");
});

test("CAS-006: an update without an explicit expectedVersion still succeeds", async (t) => {
  const { a, b, root } = await pair("no-version");
  t.after(() => teardown(a, b, root));

  const created = await a.store({ type: "fact", content: "original", scope: "global", importance: 3, tags: [] });
  const current = (await b.get(created.id))!;
  const written = await a.update({ ...current, content: "no expectation given" } as Memory);
  assert.equal(written.content, "no expectation given", "omitting expectedVersion must not be an error");
  assert.equal(written.version, current.version + 1);
});
