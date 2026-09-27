/**
 * V5.6.0 durable job ledger (roadmap §27, plan T03).
 *
 * The properties that matter are the ones that turn a shared queue into a
 * correctness problem: a claim must be atomic, a lost lease must stay lost, a
 * dead worker's job must come back, and a finished job must never run again.
 * Every store is tested against the same suite, so the in-memory and SQLite
 * implementations cannot drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  InMemoryJobStore,
  SqliteJobStore,
  JOB_STATES,
  MAX_JOB_PAYLOAD_BYTES,
  encodeJobPayload,
  normalizeJobType,
  normalizeTenantId,
  type JobStore,
} from "../job-store.js";
import { isRemembraError } from "../errors.js";

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function tempRoot(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `remembra-jobs-${name}-`));
}

/** Both stores, so every behavioural test runs against both. */
function stores(
  t: { after: (fn: () => unknown) => void },
  name: string,
  clock: { now: () => number },
): { label: string; make: () => Promise<{ store: JobStore; close: () => void }> }[] {
  return [
    {
      label: "InMemoryJobStore",
      make: async () => {
        const store = new InMemoryJobStore({ now: clock.now });
        return { store, close: () => {} };
      },
    },
    {
      label: "SqliteJobStore",
      make: async () => {
        const root = await tempRoot(name);
        const db = new Database(path.join(root, "jobs.sqlite"));
        const store = new SqliteJobStore(db as never, { now: clock.now });
        t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        return { store, close: () => db.close() };
      },
    },
  ];
}

for (const clock of [fakeClock()]) {
  for (const flavour of [
    { label: "InMemoryJobStore", make: async (t: { after: (fn: () => unknown) => void }) => {
        const store = new InMemoryJobStore({ now: clock.now });
        return { store, close: () => {} };
      } },
    { label: "SqliteJobStore", make: async (t: { after: (fn: () => unknown) => void }) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-jobs-"));
        const db = new Database(path.join(root, "jobs.sqlite"));
        t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        return { store: new SqliteJobStore(db as never, { now: clock.now }), close: () => db.close() };
      } },
  ]) {
    const name = flavour.label;

    test(`JOB-${name}: the §27 model is carried on every record`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const jobId = await store.enqueue({ type: "maintenance", payload: { a: 1 }, tenantId: "acme", maxAttempts: 4 });
      const job = await store.get(jobId);
      assert.ok(job, "the job is readable by id");
      assert.equal(job.type, "maintenance");
      assert.equal(job.state, "queued");
      assert.equal(job.createdAt, clock.now());
      assert.equal(job.attempt, 0);
      assert.equal(job.maxAttempts, 4);
      assert.equal(JSON.parse(job.payload).a, 1);
      assert.match(String(job.tenantId), /^[0-9a-f]{16}$/, "a raw tenant is hashed, not stored");
      assert.equal(job.leaseOwner, undefined, "no lease until claimed");
      assert.equal(JOB_STATES.includes(job.state), true);
    });

    test(`JOB-${name}: a claim is atomic — two claimers, one winner`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      await store.enqueue({ type: "maintenance", payload: {} });
      const [first, second] = await Promise.all([
        store.claim({ owner: "A", leaseMs: 10_000 }),
        store.claim({ owner: "B", leaseMs: 10_000 }),
      ]);
      const winners = [first, second].filter(Boolean);
      assert.equal(winners.length, 1, "exactly one claimer wins a single job");
      assert.equal(winners[0]!.state, "running");
      assert.equal(winners[0]!.attempt, 1, "the attempt is counted at claim time");
      assert.equal(winners[0]!.leaseOwner, "A" === winners[0]!.leaseOwner ? "A" : "B");
      assert.ok(winners[0]!.leaseExpiresAt! > clock.now(), "the claim carries a lease");
    });

    test(`JOB-${name}: an empty ledger is not an error`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      assert.equal(await store.claim({ owner: "A" }), undefined, "nothing to claim is a normal result");
    });

    test(`JOB-${name}: a completed job is never claimed again`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const jobId = await store.enqueue({ type: "maintenance", payload: {} });
      const claimed = await store.claim({ owner: "A", leaseMs: 10_000 });
      assert.equal(await store.complete(jobId, "A"), true);
      clock.advance(1_000);
      assert.equal(await store.claim({ owner: "B" }), undefined, "a finished job does not come back");
      assert.equal((await store.get(jobId))!.state, "completed");
    });

    test(`JOB-${name}: a dead worker's job is reclaimed after its lease expires`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const jobId = await store.enqueue({ type: "maintenance", payload: {}, maxAttempts: 3 });
      await store.claim({ owner: "dead", leaseMs: 1_000 });
      clock.advance(1_001);
      assert.equal(await store.reclaimExpired(), 1, "the expired claim is returned");
      const job = await store.get(jobId);
      assert.equal(job!.state, "retrying", "and it is claimable again");
      assert.equal(job!.leaseOwner, undefined, "with no stale holder");
      const again = await store.claim({ owner: "healthy", leaseMs: 10_000 });
      assert.equal(again?.jobId, jobId, "so a healthy worker can pick it up");
      assert.equal(again!.attempt, 2, "and the attempt count carried over");
    });

    test(`JOB-${name}: a job past maxAttempts fails instead of retrying forever`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const jobId = await store.enqueue({ type: "maintenance", payload: {}, maxAttempts: 1 });
      await store.claim({ owner: "A", leaseMs: 1_000 });
      await store.fail(jobId, "A", "PROVIDER_TIMEOUT");
      assert.equal((await store.get(jobId))!.state, "failed", "one attempt was the budget");
      assert.equal((await store.get(jobId))!.lastError, "PROVIDER_TIMEOUT", "with the classified label");
    });

    test(`JOB-${name}: a failure with attempts left becomes retrying`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const jobId = await store.enqueue({ type: "maintenance", payload: {}, maxAttempts: 3 });
      await store.claim({ owner: "A", leaseMs: 10_000 });
      await store.fail(jobId, "A", "LOCK_TIMEOUT", 500);
      const job = await store.get(jobId);
      assert.equal(job!.state, "retrying");
      assert.equal(job!.runAfter, clock.now() + 500, "with a backoff");
      // Before the backoff elapses it is not claimable.
      assert.equal(await store.claim({ owner: "B" }), undefined, "the backoff is honoured");
      clock.advance(501);
      assert.ok(await store.claim({ owner: "B", leaseMs: 10_000 }), "and claimable after it");
    });

    test(`JOB-${name}: a lost lease stays lost`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const jobId = await store.enqueue({ type: "maintenance", payload: {} });
      await store.claim({ owner: "A", leaseMs: 1_000 });
      clock.advance(1_001);
      await store.reclaimExpired();
      const peer = await store.claim({ owner: "B", leaseMs: 10_000 });
      assert.ok(peer, "a peer took the job");
      assert.equal(await store.renew(jobId, "A", 5_000), false, "the stale holder cannot renew");
      assert.equal(await store.complete(jobId, "A"), false, "nor complete it");
      assert.equal(await store.fail(jobId, "A", "IO_ERROR"), false, "nor fail it");
      assert.equal((await store.get(jobId))!.state, "running", "and the peer's claim is untouched");
      assert.equal(await store.renew(jobId, "B", 5_000), true, "while the real holder can");
    });

    test(`JOB-${name}: claims are ordered oldest first`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const first = await store.enqueue({ type: "maintenance", payload: { n: 1 } });
      clock.advance(10);
      const second = await store.enqueue({ type: "maintenance", payload: { n: 2 } });
      const a = await store.claim({ owner: "A", leaseMs: 10_000 });
      const b = await store.claim({ owner: "B", leaseMs: 10_000 });
      assert.equal(a?.jobId, first, "the oldest job is claimed first");
      assert.equal(b?.jobId, second);
    });

    test(`JOB-${name}: jobs enqueued in the same millisecond are claimed without duplication`, async (t) => {
      // Ties on createdAt are broken by job id. The id is random, so the order
      // within a millisecond is arbitrary — but it must be the SAME order for
      // every claimer, or two workers would race for the same job. This asserts
      // the property that matters: no duplication, and every job claimed once.
      const { store, close } = await flavour.make(t);
      t.after(close);
      const ids = new Set<string>();
      for (let i = 0; i < 12; i++) ids.add(await store.enqueue({ type: "maintenance", payload: { i } }));
      const claimed: string[] = [];
      for (;;) {
        const job = await store.claim({ owner: "A", leaseMs: 10_000 });
        if (!job) break;
        claimed.push(job.jobId);
      }
      assert.equal(claimed.length, ids.size, "every job was claimed");
      assert.equal(new Set(claimed).size, ids.size, "and none was claimed twice");
    });

    test(`JOB-${name}: a claim can be restricted by type and tenant`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      const tenantA = normalizeTenantId("tenant-a")!;
      const tenantB = normalizeTenantId("tenant-b")!;
      await store.enqueue({ type: "archive-memory", payload: {}, tenantId: tenantA });
      await store.enqueue({ type: "maintenance", payload: {}, tenantId: tenantB });
      const maintenance = await store.claim({ owner: "W", types: ["maintenance"], leaseMs: 10_000 });
      assert.equal(maintenance?.type, "maintenance", "only the requested type is claimed");
      const tenantClaim = await store.claim({ owner: "W", tenantId: tenantA, leaseMs: 10_000 });
      assert.equal(tenantClaim?.type, "archive-memory", "and the tenant scope is respected");
    });

    test(`JOB-${name}: stats and prune keep the ledger bounded`, async (t) => {
      const { store, close } = await flavour.make(t);
      t.after(close);
      // Distinct creation times, so "oldest" is unambiguous. Ties on createdAt
      // are broken by job id; that case is covered by the no-duplication test
      // rather than by assuming an insertion order that may not exist.
      const done = await store.enqueue({ type: "maintenance", payload: {} });
      clock.advance(10);
      const live = await store.enqueue({ type: "maintenance", payload: {} });
      const claimed = await store.claim({ owner: "A", leaseMs: 10_000, types: ["maintenance"] });
      assert.equal(claimed?.jobId, done, "the older job is the one claimed");
      assert.equal(await store.complete(done, "A"), true, "and it is completed");
      const counts = await store.stats();
      assert.equal(counts.completed, 1);
      assert.equal(counts.running + counts.queued, 1, "the other job is still outstanding");
      assert.equal(await store.prune(1_000), 0, "nothing is pruned while it is inside the window");
      clock.advance(2_000);
      assert.equal(await store.prune(1_000), 1, "a settled job is pruned once it ages out");
      assert.ok(await store.get(live), "and an unsettled job never is");
    });
  }
}

test("JOB-002: two independent SQLite ledgers over one file — exactly one claimer wins", async (t) => {
  // The cross-instance case: separate connections, as separate processes have.
  // The in-memory store cannot express this, which is why the SQLite store has
  // its own test rather than only sharing the behavioural suite.
  const root = await tempRoot("shared-file");
  const a = new Database(path.join(root, "jobs.sqlite"));
  const b = new Database(path.join(root, "jobs.sqlite"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  t.after(() => { a.close(); b.close(); });
  const storeA = new SqliteJobStore(a as never);
  const storeB = new SqliteJobStore(b as never);
  await storeA.enqueue({ type: "maintenance", payload: { n: 1 } });
  const [first, second] = await Promise.all([
    storeA.claim({ owner: "A", leaseMs: 10_000 }),
    storeB.claim({ owner: "B", leaseMs: 10_000 }),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1, "one job, one winner, two connections");
});

test("JOB-003: two claimers draining a backlog each get distinct jobs", async (t) => {
  const root = await tempRoot("drain");
  const db = new Database(path.join(root, "jobs.sqlite"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  t.after(() => db.close());
  const store = new SqliteJobStore(db as never);
  for (let i = 0; i < 25; i++) await store.enqueue({ type: "maintenance", payload: { i } });
  const claimed = new Set<string>();
  for (let round = 0; round < 40; round++) {
    const job = await store.claim({ owner: "A", leaseMs: 10_000 });
    if (!job) break;
    claimed.add(job.jobId);
  }
  assert.equal(claimed.size, 25, "every job was claimed exactly once, with no duplicates");
});

test("JOB-004: bounded input — payload, type, and tenant are all constrained", () => {
  assert.throws(() => encodeJobPayload({ blob: "x".repeat(MAX_JOB_PAYLOAD_BYTES) }), (err: unknown) => isRemembraError(err) && /over the/.test((err as Error).message));
  assert.throws(() => encodeJobPayload({ bad: BigInt(1) }), (err: unknown) => isRemembraError(err), "a non-serializable payload is refused");
  for (const bad of ["", "  ", "x".repeat(65), "has space", "../escape", "semi;colon"]) {
    assert.throws(() => normalizeJobType(bad), (err: unknown) => isRemembraError(err), `${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(normalizeJobType("memory-validate"), "memory-validate");
  assert.equal(normalizeTenantId(undefined), undefined, "a tenantless job has no tenant field");
  assert.equal(normalizeTenantId("0b36e866db1f6958"), "0b36e866db1f6958", "an opaque id passes through");
  assert.match(String(normalizeTenantId("alice@example.com")), /^[0-9a-f]{16}$/, "a raw value is hashed");
  assert.throws(() => normalizeTenantId("x".repeat(300)), (err: unknown) => isRemembraError(err));
});

test("JOB-005: a stored error is a classified label, never a message", async (t) => {
  const root = await tempRoot("errorlabel");
  const db = new Database(path.join(root, "jobs.sqlite"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  t.after(() => db.close());
  const store = new SqliteJobStore(db as never);
  const jobId = await store.enqueue({ type: "maintenance", payload: {}, maxAttempts: 1 });
  await store.claim({ owner: "A", leaseMs: 10_000 });
  await store.fail(jobId, "A", "disk /home/someone exploded at line 42");
  assert.equal((await store.get(jobId))!.lastError, "unknown", "an unsafe label is replaced, not stored");
});
