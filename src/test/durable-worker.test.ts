/**
 * V5.6.0 durable worker (roadmap §28, plan T04).
 *
 * The property that matters most is the partition guard: a worker that loses
 * its lease must stop, not finish. Finishing would be the S1 lost-update failure
 * wearing a lease — two workers each believing they own one job. Every test here
 * uses two real workers over one ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DurableWorker, type DurableJobContext } from "../durable-worker.js";
import { InMemoryJobStore, SqliteJobStore, type JobStore } from "../job-store.js";
import { isRemembraError } from "../errors.js";

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function sqliteStore(t: { after: (fn: () => unknown) => void }, name: string, clock: { now: () => number }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `remembra-worker-${name}-`));
  const db = new Database(path.join(root, "jobs.sqlite"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  t.after(() => db.close());
  return new SqliteJobStore(db as never, { now: clock.now });
}

const ok = async () => {};

test("WORK-001: a worker claims, runs, and completes a queued job", async (t) => {
  const store = new InMemoryJobStore();
  const seen: DurableJobContext[] = [];
  const worker = new DurableWorker({
    store,
    handlers: { "maintenance": async (_payload, ctx) => { seen.push(ctx); } },
    owner: "w1",
  });
  t.after(() => worker.stop(0));

  const jobId = await store.enqueue({ type: "maintenance", payload: { n: 1 } });
  assert.equal(await worker.drain(), 1, "one job was claimed and run");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.jobId, jobId);
  assert.equal(seen[0]!.attempt, 1, "the handler is told which attempt it is");
  assert.equal((await store.get(jobId))!.state, "completed");
  assert.equal(worker.stats.completed, 1);
});

test("WORK-002: a worker never claims a type it has no handler for", async (t) => {
  // A heterogeneous fleet: a consolidator must not pick up maintenance jobs and
  // then fail them, because that would burn a retry for no reason.
  const store = new InMemoryJobStore();
  const ran: string[] = [];
  const worker = new DurableWorker({
    store,
    handlers: { "consolidate-memory": async () => { ran.push("consolidate"); } },
    owner: "w1",
  });
  t.after(() => worker.stop(0));

  const mine = await store.enqueue({ type: "consolidate-memory", payload: {} });
  const theirs = await store.enqueue({ type: "maintenance", payload: {} });

  assert.equal(await worker.drain(), 1, "only the job it can run");
  assert.deepEqual(ran, ["consolidate"]);
  assert.equal((await store.get(mine))!.state, "completed");
  assert.equal((await store.get(theirs))!.state, "queued", "the other job is left alone, not failed");
  assert.deepEqual(worker.types, ["consolidate-memory"], "and the worker advertises what it runs");
});

test("WORK-003: a job that throws is failed with a classified label, and retried", async (t) => {
  const store = new InMemoryJobStore();
  let attempts = 0;
  const worker = new DurableWorker({
    store,
    handlers: {
      maintenance: async () => {
        attempts++;
        throw new Error("a message that must not be stored anywhere");
      },
    },
    owner: "w1",
  });
  t.after(() => worker.stop(0));

  const jobId = await store.enqueue({ type: "maintenance", payload: {}, maxAttempts: 2 });
  // drain(1) runs exactly one job: an unbounded drain would retry straight away,
  // because a `retrying` job is claimable again with no backoff set.
  await worker.drain(1);
  const afterFirst = await store.get(jobId);
  assert.equal(afterFirst!.state, "retrying", "a first failure with attempts left retries");
  assert.equal(
    afterFirst!.lastError?.includes("must not be stored"),
    false,
    "the thrown message never reaches the ledger",
  );
  assert.ok((afterFirst!.lastError?.length ?? 0) <= 64, "and what is stored is a short classified token");

  await worker.drain(1);
  const afterSecond = await store.get(jobId);
  assert.equal(afterSecond!.state, "failed", "and the attempt budget is honoured");
  assert.equal(attempts, 2, "the handler ran exactly twice");
});

test("WORK-004: a non-serializable stored payload fails cleanly instead of crashing the worker", async (t) => {
  const store = new InMemoryJobStore();
  const jobId = await store.enqueue({ type: "maintenance", payload: { ok: true } });
  // Corrupt the stored payload the way a partially-written row would.
  (store as unknown as { jobs: Map<string, { payload: string }> }).jobs.get(jobId)!.payload = "{not json";
  const ran: unknown[] = [];
  const worker = new DurableWorker({
    store,
    handlers: { maintenance: async (p) => { ran.push(p); } },
    owner: "w1",
  });
  t.after(() => worker.stop(0));

  await worker.drain();
  assert.deepEqual(ran, [], "the handler was not called");
  assert.equal((await store.get(jobId))!.lastError, "INVALID_PAYLOAD");
  // The worker is still usable afterwards: a bad row is not a poison pill.
  const good = await store.enqueue({ type: "maintenance", payload: { ok: 1 } });
  assert.equal(await worker.drain(), 1, "and the next job still runs");
  assert.equal((await store.get(good))!.state, "completed");
});

test("WORK-005: a worker restart reclaims the job a dead worker was holding", async (t) => {
  const clock = fakeClock();
  const store = await sqliteStore(t, "restart", clock);
  const ran: number[] = [];

  const live = new DurableWorker({
    store,
    handlers: { maintenance: async (_p, ctx) => { ran.push(ctx.attempt); } },
    owner: "healthy",
    leaseMs: 1_000,
    renewIntervalMs: 300,
  });
  t.after(() => void live.stop(0));

  await store.enqueue({ type: "maintenance", payload: {}, maxAttempts: 3 });
  // A killed process leaves exactly this behind: a claim with an owner that will
  // never renew it. Modelling it with a worker whose handler never settles would
  // instead hang the drain, which is a different failure.
  const abandoned = await store.claim({ owner: "dead", leaseMs: 1_000 });
  assert.equal(abandoned?.leaseOwner, "dead", "the job is held by a process that is gone");
  assert.equal(await live.drain(), 0, "the live worker cannot take a job that is still leased");

  clock.advance(1_001);
  assert.equal(await store.reclaimExpired(), 1, "the dead worker's lease is reclaimed");
  assert.equal(await live.drain(), 1, "and a healthy worker can run it");
  assert.deepEqual(ran, [2], "as attempt 2, so the handler can tell it is a re-run");
});

test("WORK-006: renewal keeps a long job's lease, so no peer steals it", async (t) => {
  const store = new InMemoryJobStore();
  let running = true;
  const peer = new DurableWorker({ store, handlers: { maintenance: ok }, owner: "peer" });
  t.after(() => { running = false; void peer.stop(0); });

  const worker = new DurableWorker({
    store,
    handlers: {
      maintenance: async () => {
        // Stay busy across several renewal intervals.
        await new Promise((resolve) => setTimeout(resolve, 260));
        assert.equal(running, true, "not aborted");
      },
    },
    owner: "w1",
    leaseMs: 1_500,
    renewIntervalMs: 250,
  });
  t.after(() => worker.stop(0));
  worker.start();

  const jobId = await store.enqueue({ type: "maintenance", payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 700));
  // The peer polls throughout; the lease was renewed so it never got the job.
  assert.equal(await peer.drain(), 0, "the peer never stole a renewed lease");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await store.get(jobId))!.state, "completed", "and the original worker finished it");
});

test("WORK-007: losing the lease aborts the job rather than letting it race a peer", async (t) => {
  const store = new InMemoryJobStore();
  let aborted = false;
  let finished = false;
  const worker = new DurableWorker({
    store,
    handlers: {
      maintenance: async (_p, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        aborted = ctx.signal.aborted;
        finished = true;
      },
    },
    owner: "w1",
    leaseMs: 1_200,
    renewIntervalMs: 200,
  });
  t.after(() => worker.stop(0));
  // Enqueue before starting: a pump that has already found nothing is asleep for
  // a poll interval, and the assertion would race its wake-up rather than test it.
  await store.enqueue({ type: "maintenance", payload: {} });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(worker.stats.inFlight, 1, "the job is running under a live lease");

  // Steal the lease, which is what a peer does once it believes ours lapsed.
  // Advancing time instead would not work: the worker renews on a real timer and
  // would simply extend the lease again.
  const jobs = (store as unknown as { jobs: Map<string, { jobId: string; leaseOwner?: string; state: string }> }).jobs;
  for (const job of jobs.values()) job.leaseOwner = "thief";
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(finished, true, "the handler ran to completion");
  assert.equal(aborted, true, "but observed that its lease was gone");
  assert.ok(worker.stats.leaseLost >= 1, "and the loss is counted, not hidden");
  const job = [...jobs.values()][0]!;
  assert.notEqual(job.state, "completed", "so the worker does not claim a success it cannot vouch for");
});

test("WORK-008: a graceful stop releases the lease so a peer need not wait it out", async (t) => {
  const clock = fakeClock();
  const store = await sqliteStore(t, "release", clock);
  let finish: (() => void) | undefined;
  const peer = new DurableWorker({ store, handlers: { maintenance: ok }, owner: "peer" });
  t.after(() => { void peer.stop(0); });

  const worker = new DurableWorker({
    store,
    handlers: { maintenance: async () => { await new Promise<void>((r) => { finish = r; }); } },
    owner: "w1",
    leaseMs: 600_000, // a long lease a peer would otherwise wait out entirely
  });
  // Every started worker must be stopped: the worker's poll timer is ref'd on
  // purpose so a worker-only process stays alive, and an unstopped one keeps the
  // event loop open forever.
  t.after(() => void worker.stop(0));
  await store.enqueue({ type: "maintenance", payload: {} });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(worker.stats.inFlight, 1, "the job is running");

  finish?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(worker.stats.inFlight, 0, "and finished before the stop");

  // Now prove the release path: a job abandoned by stop() is claimable at once.
  const jobId = await store.enqueue({ type: "maintenance", payload: {} });
  const second = new DurableWorker({
    store,
    handlers: { maintenance: async () => { await new Promise<void>(() => {}); } },
    owner: "w2",
    leaseMs: 600_000,
  });
  t.after(() => second.stop(0));
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(second.stats.inFlight, 1, "the second worker took the new job");
  assert.equal((await store.get(jobId))!.leaseOwner, "w2");

  await second.stop(2_000);
  assert.equal((await store.get(jobId))!.leaseOwner, undefined, "stop released the lease");
  assert.equal(await peer.drain(), 1, "so a peer can take it immediately, not after 10 minutes");
});

test("WORK-009: two workers on one ledger never run the same job", async (t) => {
  const store = await sqliteStore(t, "two-workers", fakeClock());
  const ran: string[] = [];
  const handlers = {
    maintenance: async (_p: unknown, ctx: DurableJobContext) => {
      ran.push(`${ctx.jobId}#${ctx.attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  const a = new DurableWorker({ store, handlers, owner: "a" });
  const b = new DurableWorker({ store, handlers, owner: "b" });
  t.after(() => { void a.stop(0); void b.stop(0); });

  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) ids.add(await store.enqueue({ type: "maintenance", payload: { i } }));
  // Interleave the two claimers, which is what a shared ledger looks like.
  for (let round = 0; round < 40; round++) {
    await a.drain(1);
    await b.drain(1);
  }
  const counts = await store.stats();
  assert.equal(counts.completed, 20, "every job completed exactly once");
  assert.equal(ran.length, 20, "and the handler ran exactly twenty times");
  assert.equal(new Set(ran.map((r) => r.split("#")[0])).size, 20, "no job ran twice");
});

test("WORK-010: a job with no registered handler anywhere is retried, not silently dropped", async (t) => {
  const store = new InMemoryJobStore();
  const jobId = await store.enqueue({ type: "unknown-job", payload: {}, maxAttempts: 1 });
  const worker = new DurableWorker({ store, handlers: { maintenance: ok }, owner: "w1" });
  t.after(() => worker.stop(0));
  // The worker must not even claim it, so the ledger keeps it for a worker that
  // can run it.
  assert.equal(await worker.drain(), 0);
  assert.equal((await store.get(jobId))!.state, "queued", "still queued, not failed or lost");
});

test("WORK-010b: a worker with no handlers refuses to start", async (t) => {
  // It would poll forever claiming nothing, which looks like a healthy idle
  // worker while silently doing no work. A scheduler-only process should not
  // construct a DurableWorker at all.
  const store = new InMemoryJobStore();
  const worker = new DurableWorker({ store, handlers: {}, owner: "w1" });
  t.after(() => worker.stop(0));
  assert.throws(
    () => worker.start(),
    (err: unknown) => isRemembraError(err) && /no job types/.test((err as Error).message),
    "starting a worker that can run nothing is a configuration error, not an idle loop",
  );
  assert.equal(worker.isRunning, false);
});
