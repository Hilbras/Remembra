/**
 * V5.6.0 §30 failure matrix (plan T08).
 *
 * Every row states the invariant it asserts, because "did not crash" is not a
 * result. The rows split by what they can honestly claim:
 *
 *   • **Two real processes** (`src/test/matrix-peer.ts`): concurrent writes,
 *     concurrent restore, concurrent migration, tenant isolation. These need
 *     genuine OS-level concurrency, because JavaScript's single thread removes the
 *     interleaving that produced audit S1 — two objects in one event loop cannot
 *     reproduce a lost update.
 *   • **Two real workers over one SQLite ledger**: duplicate job execution, expired
 *     leases, worker crash, stale claims.
 *   • **Our response to an outage**: Redis restart and network partition. These use
 *     a client that fails and recovers. They verify *our* behaviour under a store
 *     outage — fail closed, then recover — and they do **not** verify Redis. See
 *     the note at the end of this file, which is the most important line in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { DurableWorker, type DurableJobContext } from "../durable-worker.js";
import { InMemoryJobStore, SqliteJobStore, type JobStore } from "../job-store.js";
import { MemoryService } from "../service.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { RedisQuotaRateLimiter } from "../redis.js";
import { SharedState } from "../shared-state.js";
import { opaqueRateLimitPart, rateLimitIdentity } from "../rate-limiter.js";
import type { RedisLike } from "../redis.js";

const run = promisify(execFile);
const PEER = fileURLToPath(new URL("./matrix-peer.js", import.meta.url));

type PeerResult = Record<string, string | number | boolean | undefined>;

async function peer(args: string[]): Promise<PeerResult> {
  const { stdout } = await run(process.execPath, [PEER, ...args], {
    env: { ...process.env },
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as PeerResult;
}

async function tempRoot(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `remembra-matrix-${name}-`));
}

async function seeded(root: string): Promise<{ id: string; service: MemoryService; close: () => void }> {
  const backend = new SqliteBackend({ dbPath: path.join(root, "memories.sqlite") });
  const service = new MemoryService(backend, { embeddingProvider: "none" });
  const memory = await service.store({ type: "fact", content: "original" });
  return { id: memory.id, service, close: () => backend.close?.() };
}

function clockAt(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function ledgerAt(t: { after: (fn: () => unknown) => void }, name: string, clock: { now: () => number }) {
  const root = await tempRoot(name);
  const db = new Database(path.join(root, "jobs.sqlite"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  t.after(() => db.close());
  return new SqliteJobStore(db as never, { now: clock.now });
}

// --- Row: concurrent writes (two real processes) ---------------------------

test("MATRIX-01 concurrent writes: two processes CAS the same version, exactly one wins", async (t) => {
  // The invariant is audit S1's fix under real concurrency. Before the CAS, both
  // processes were told they had written version 2 and one change vanished — the
  // reproduction was 5/5. The version is forced rather than left to interleaving,
  // so this tests the CAS and not the scheduler.
  const root = await tempRoot("writes");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const { id, close } = await seeded(root);
  close();

  const [a, b] = await Promise.all([
    peer(["cas-race", root, "peer-a", id, "1"]),
    peer(["cas-race", root, "peer-b", id, "1"]),
  ]);

  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["conflict", "won"], `exactly one writer may win: ${JSON.stringify([a, b])}`);
  const winner = a.outcome === "won" ? a : b;
  const loser = a.outcome === "won" ? b : a;
  assert.equal(winner.versionAfter, 2, "the stored version advanced exactly once");
  assert.equal(loser.versionAfter, 2, "the loser did not advance it");
  assert.equal(
    winner.content,
    loser.content,
    "and both processes agree on what is stored — the loser's write did not land",
  );
});

// --- Row: concurrent restore (two real processes) --------------------------

test("MATRIX-02 concurrent restore: a durable gate has exactly one owner", async (t) => {
  const root = await tempRoot("restore");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const [a, b] = await Promise.all([peer(["restore-gate", root, "gate-a"]), peer(["restore-gate", root, "gate-b"])]);
  const outcomes = [a.outcome, b.outcome].sort();
  // `detail` is the classified code from the losing process, so a failure here
  // says what actually happened rather than just "other".
  assert.deepEqual(
    outcomes,
    ["acquired", "refused"],
    `a gate with two owners is a gate nobody can close: ${JSON.stringify([a, b])}`,
  );
  assert.equal(a.pending, true);
  assert.equal(b.pending, true, "and the loser sees it pending rather than clearing it");
});

// --- Row: concurrent migration (two real processes) ------------------------

test("MATRIX-03 concurrent migration: a migration gate is not a restore gate, and holds once", async (t) => {
  // The distinction matters: http.ts treats a migration gate as a reason *not* to
  // let recovery verification publish, because verifying storage must not roll
  // back a half-applied tenant migration.
  const root = await tempRoot("migration");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const [a, b] = await Promise.all([peer(["migration-gate", root, "mig-a"]), peer(["migration-gate", root, "mig-b"])]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["acquired", "refused"], `one migration owner only: ${JSON.stringify([a, b])}`);
  const owner = a.outcome === "acquired" ? a : b;
  assert.equal(owner.reason, "migration", "and the reason is recorded, so recovery can refuse to publish over it");
});

// --- Row: tenant isolation across processes and shared keys ---------------

test("MATRIX-04 tenant isolation: a shared store never widens a tenant's visibility", async (t) => {
  const root = await tempRoot("isolation");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const result = await peer(["tenant-read", root, "peer-a", "org-one", "org-two"]);
  assert.equal(result.readOwn, "visible", "a tenant sees its own memory");
  assert.notEqual(result.readForeign, "VISIBLE-LEAK", "and never another's");
  assert.equal(result.leakedInList, false, "including in a listing");
});

test("MATRIX-05 shared-state keys are built from digests, never a raw principal", () => {
  // The risk table's Critical row. If a raw organization id reached a shared key,
  // it would be enumerable by anyone with access to the store — and a shared
  // store is by definition reachable by more people than a local one.
  const seen: string[] = [];
  const client: RedisLike = {
    eval: async (_script, options) => {
      seen.push(...options.keys);
      return [1, 0, 4, 0];
    },
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
  };
  const limiter = new RedisQuotaRateLimiter({
    client,
    base: { limit: 10, windowMs: 1_000 },
    policies: { organization: { limit: 5, windowMs: 1_000 } },
  });
  const raw = "acme-corporation";
  void limiter.check(rateLimitIdentity({ organization: opaqueRateLimitPart(raw), user: opaqueRateLimitPart("u") }));
  assert.ok(seen.length > 0, "keys were produced");
  const dimensions = new Set(["global", "organization", "project", "user", "agent", "apikey", "ip", "endpoint", "provider", "base"]);
  for (const key of seen) {
    assert.equal(key.includes(raw), false, `a raw principal reached a shared key: ${key}`);
    assert.equal(/@|:\/\//.test(key), false, `a URL or credential reached a shared key: ${key}`);
    // Every token after the dimension is either a dimension name (the base key
    // embeds a composite identity key) or a lowercase hex digest. Nothing else.
    for (const token of key.split(/[=&]/).slice(1)) {
      assert.ok(
        dimensions.has(token) || /^[0-9a-f]{8,}$/.test(token),
        `a shared key carried something that is not a digest or a dimension: ${key}`,
      );
    }
  }
});

// --- Rows: duplicate execution, expired leases, worker crash --------------

test("MATRIX-06 duplicate job execution: a job is never run by two workers at once", async (t) => {
  // The invariant is not "it completed" but "no two workers were inside the
  // handler at the same time, and it completed exactly once". A worker that ran a
  // duplicate concurrently would not be visible in the final state at all.
  const store = new InMemoryJobStore();
  const inside = new Map<string, number>();
  const runs: string[] = [];
  const handler = async (_p: unknown, ctx: DurableJobContext) => {
    // Per *job*, not global. Six workers inside six different jobs at once is the
    // system working as intended; two inside the same job is the defect, and only
    // a per-job count can tell the two apart.
    const current = (inside.get(ctx.jobId) ?? 0) + 1;
    inside.set(ctx.jobId, current);
    runs.push(`${ctx.jobId}#${ctx.attempt}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inside.set(ctx.jobId, (inside.get(ctx.jobId) ?? 1) - 1);
  };
  const workers = Array.from({ length: 6 }, (_, i) =>
    new DurableWorker({ store, handlers: { maintenance: handler }, owner: `w${i}`, concurrency: 1 }),
  );
  t.after(() => workers.forEach((w) => void w.stop(0)));

  for (let i = 0; i < 25; i++) await store.enqueue({ type: "maintenance", payload: { i } });
  for (let round = 0; round < 60; round++) {
    await Promise.all(workers.map((w) => w.drain(1)));
  }
  assert.equal(
    Math.max(0, ...inside.values()),
    0,
    "no job was left with a worker still inside it",
  );
  assert.equal(runs.length, 25, `every job ran exactly once, ran ${runs.length}`);
  assert.equal(new Set(runs.map((r) => r.split("#")[0])).size, 25, "and no job was run twice");
  const stats = await store.stats();
  assert.equal(stats.completed, 25);
  assert.equal(stats.failed, 0);
});

test("MATRIX-07 expired leases: a lapsed lease is reclaimed and re-run, never silently dropped", async (t) => {
  const clock = clockAt();
  const store = await ledgerAt(t, "leases", clock);
  const attempts: number[] = [];

  // A process that claimed a job and then died: a claim with an owner that will
  // never renew it, which is exactly what a killed process leaves behind.
  const jobId = await store.enqueue({ type: "maintenance", payload: {} });
  const abandoned = await store.claim({ owner: "dead", leaseMs: 5_000 });
  assert.equal(abandoned?.jobId, jobId);
  assert.equal(abandoned?.leaseOwner, "dead");
  assert.equal(await store.reclaimExpired(), 0, "a live lease is not reclaimed");

  const worker = new DurableWorker({
    store,
    handlers: { maintenance: async (_p, ctx) => { attempts.push(ctx.attempt); } },
    owner: "healthy",
    leaseMs: 5_000,
  });
  t.after(() => void worker.stop(0));

  clock.advance(5_001);
  assert.equal(await store.reclaimExpired(), 1, "once it lapses, exactly one job is reclaimed");
  assert.equal(await worker.drain(), 1, "and a healthy worker picks it up");
  assert.deepEqual(attempts, [2], "as attempt 2, so the handler can tell it is a re-run");
  const stats = await store.stats();
  assert.equal(stats.completed, 1, "and it completes exactly once");
});

test("MATRIX-08 worker crash: a mid-job crash costs a retry, not the work", async (t) => {
  const clock = clockAt();
  const store = await ledgerAt(t, "crash", clock);
  const ran: string[] = [];
  const TOTAL = 3;

  for (let i = 0; i < TOTAL; i++) await store.enqueue({ type: "maintenance", payload: { i }, maxAttempts: 3 });

  // A worker claims one job and then vanishes, leaving a lease nobody will renew.
  const crashed = await store.claim({ owner: "crashed", leaseMs: 1_000 });
  assert.ok(crashed, "the crashed worker held a job");

  const survivor = new DurableWorker({
    store,
    handlers: { maintenance: async (_p, ctx) => { ran.push(`${ctx.jobId}#${ctx.attempt}`); } },
    owner: "survivor",
    leaseMs: 60_000,
  });
  t.after(() => void survivor.stop(0));

  // While the crashed worker's lease is live, the survivor must leave it alone:
  // taking it would mean two processes running one job.
  assert.equal(await survivor.drain(1), 1, "it takes one of the untouched jobs");
  assert.equal((await store.get(crashed.jobId))!.leaseOwner, "crashed", "and does not touch the crashed one");

  // Once the lease truly lapses the job returns to the ledger.
  clock.advance(1_001);
  assert.equal(await store.reclaimExpired(), 1);
  await survivor.drain();

  assert.equal(ran.length, TOTAL, `no work is lost: ${TOTAL} jobs, ran ${ran.length}`);
  assert.equal(new Set(ran.map((r) => r.split("#")[0])).size, TOTAL, "and no job ran twice");
  assert.equal(
    ran.filter((r) => r.startsWith(`${crashed.jobId}#`)).length,
    1,
    "the crashed job ran once, as a retry rather than being dropped",
  );
  const stats = await store.stats();
  assert.equal(stats.completed, TOTAL);
  assert.equal(stats.failed, 0, "and nothing was recorded as failed");
});

test("MATRIX-09 stale claims: a worker that lost its lease cannot report success", async (t) => {
  // The stale-cache row, in the form that matters. A worker whose lease was
  // reclaimed must not be able to mark the job complete, or the ledger would
  // record a success that a peer is about to duplicate.
  const store = new InMemoryJobStore();
  const jobId = await store.enqueue({ type: "maintenance", payload: {} });
  const first = await store.claim({ owner: "a", leaseMs: 60_000 });
  assert.equal(first?.jobId, jobId);

  // A peer reclaims it out from under the first worker.
  (store as unknown as { jobs: Map<string, { leaseOwner?: string; leaseExpiresAt: number }> }).jobs.get(jobId)!.leaseOwner =
    "thief";

  assert.equal(await store.complete(jobId, "a"), false, "the stale owner's completion is refused");
  assert.equal((await store.get(jobId))!.state, "running", "and the job is not marked complete");
  assert.equal(await store.complete(jobId, "thief"), true, "the current owner still can");
});

// --- Rows: store outage (Redis restart, network partition) -----------------

/**
 * These two rows verify **our** response to a store outage, not Redis itself.
 *
 * The client is a fake, so nothing here can catch a Redis protocol change, a
 * script that a real server rejects, or a connection behaviour that only shows
 * up under load. What it does establish is the property that matters operationally
 * and that is entirely ours: while the store is unreachable the limiter refuses
 * rather than falling back to per-instance limits, and it recovers by itself.
 */
function flakyClient(down: () => boolean): { client: RedisLike; calls: () => number } {
  let calls = 0;
  return {
    client: {
      eval: async () => {
        calls++;
        if (down()) throw new Error("ECONNREFUSED 10.0.0.7:6379");
        return [1, 0, 4, 0];
      },
      get: async () => null,
      set: async () => "OK",
      del: async () => 1,
    },
    calls: () => calls,
  };
}

test("MATRIX-10 Redis restart: the limiter fails closed, then recovers unaided", async (t) => {
  const state = { down: true };
  const { client, calls } = flakyClient(() => state.down);
  const shared = SharedState.absent();
  Object.assign(shared, { configured: true, connection: { client, connected: true, close: async () => {} } });
  shared.markConnected();
  t.after(() => shared.close());

  const limiter = shared.rateLimiter({ base: { limit: 5, windowMs: 1_000 } });
  assert.ok(limiter);
  const identity = rateLimitIdentity({ user: opaqueRateLimitPart("u") });

  // While down, every request is refused and nothing is granted. A silent
  // fallback to a per-instance budget would be the failure this whole design
  // exists to prevent: two instances would each allow 5, so the fleet allows 10
  // while each reports 5.
  const during = await Promise.all(
    Array.from({ length: 10 }, () => limiter.consume(identity).then((r) => r.allowed, () => "refused")),
  );
  assert.equal(during.filter((r) => r === true).length, 0, "no request is granted while the store is down");
  assert.equal(during.filter((r) => r === "refused").length, 10, "all ten are refused");
  assert.equal(shared.report?.mode, "unreachable", "and readiness says so");

  // The store comes back. No restart, no operator action.
  state.down = false;
  const before = calls();
  const after = await limiter.consume(identity);
  assert.equal(after.allowed, true, "the next successful operation is admitted");
  assert.ok(calls() > before, "and it really did reach the store");
  assert.deepEqual(shared.report, { mode: "connected" }, "readiness recovers on its own");
});

test("MATRIX-11 network partition: a partitioned worker cannot report success", async (t) => {
  // The dangerous case is a worker that is *partitioned from the store* while
  // still believing it holds the job. It must not mark the job complete: doing so
  // records a success a peer is about to duplicate.
  const store = new InMemoryJobStore();
  const started: string[] = [];
  let released: (() => void) | undefined;

  // The handler holds the job open. A handler that returned immediately would let
  // the worker finish before the partition happened, and the row would pass
  // without ever testing anything.
  const worker = new DurableWorker({
    store,
    handlers: {
      maintenance: async (_p, ctx) => {
        started.push(ctx.jobId);
        await new Promise<void>((resolve) => { released = resolve; });
      },
    },
    owner: "w1",
    leaseMs: 1_200,
    renewIntervalMs: 200,
  });
  t.after(() => { released?.(); void worker.stop(0); });

  const jobId = await store.enqueue({ type: "maintenance", payload: {} });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(worker.stats.inFlight, 1, "the job is running under a live lease");

  // The partition: the store stops answering this worker's renewals, exactly as a
  // store on the other side of a network cut would.
  const jobs = (store as unknown as { jobs: Map<string, { leaseOwner?: string; state: string }> }).jobs;
  jobs.get(jobId)!.leaseOwner = "gone";
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(jobs.get(jobId)!.state !== "completed", true, "a partitioned worker must not record a completion it could not verify");
  assert.equal(worker.stats.leaseLost >= 1, true, `the lost lease is counted, saw ${worker.stats.leaseLost}`);
  assert.equal(worker.stats.completed, 0, "and it is not reported as a success");
  assert.deepEqual(started, [jobId], "the work did start; the row is about the completion, not the attempt");
});

// --- Row: stale cache ------------------------------------------------------

test("MATRIX-12 stale cache: a cached readiness answer is one consistent snapshot", async (t) => {
  const root = await tempRoot("stale");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const backend = new SqliteBackend({ dbPath: path.join(root, "memories.sqlite") });
  t.after(() => backend.close?.());
  const service = new MemoryService(backend, { embeddingProvider: "none" });

  const previous = process.env.REMEMBRA_HEALTH_CACHE_MS;
  process.env.REMEMBRA_HEALTH_CACHE_MS = "2000";
  t.after(() => {
    if (previous === undefined) delete process.env.REMEMBRA_HEALTH_CACHE_MS;
    else process.env.REMEMBRA_HEALTH_CACHE_MS = previous;
  });

  // A fake client that answers, so the shared view starts connected.
  let down = false;
  const shared = SharedState.absent();
  Object.assign(shared, {
    configured: true,
    connection: {
      client: {
        eval: async () => { if (down) throw new Error("ECONNRESET"); return [1, 0, 4, 0]; },
        get: async () => null,
        set: async () => "OK",
        del: async () => 1,
      },
      connected: true,
      close: async () => {},
    },
  });
  shared.markConnected();
  t.after(() => shared.close());

  const { createHttpServer } = await import("../http.js");
  const server = createHttpServer(service, { port: 0, host: "127.0.0.1", sharedState: shared, rateLimiter: {
    check: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0, limit: 10, windowMs: 1_000 }),
    consume: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0, limit: 10, windowMs: 1_000 }),
    reset: async () => {},
  } });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const probe = async () => (await (await fetch(`${base}/health/ready`)).json()) as { status: string; shared?: { mode: string } };

  assert.equal((await probe()).shared?.mode, "connected");
  // The store goes away mid-cache-window.
  down = true;
  shared.markUnreachable("SERVICE_UNAVAILABLE");
  const withinTtl = await probe();
  assert.equal(withinTtl.shared?.mode, "connected", "inside the TTL the cached snapshot is reused");
  assert.equal(withinTtl.status, "ok", "and its status matches its own shared view — one consistent snapshot, not two samples of different ages");

  // Once the TTL passes, the answer is refreshed and the truth shows.
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  const afterTtl = await probe();
  assert.equal(afterTtl.shared?.mode, "unreachable");
  assert.equal(afterTtl.status, "unready", "a cached answer bounds staleness; it never outlives the outage");
});

/*
 * ---------------------------------------------------------------------------
 * What this matrix does NOT establish
 *
 * There is no Redis server in this project's test environment. MATRIX-10 and
 * MATRIX-11 therefore verify our *response* to a store outage — fail closed,
 * report, recover — and nothing about Redis itself. Specifically unverified:
 *
 *   • that the Lua scripts load and run under a real server's Lua sandbox;
 *   • behaviour across a real network partition, as opposed to a client that
 *     throws;
 *   • Redis restart with in-flight commands, replication, and failover;
 *   • EVALSHA / script-cache behaviour with the real client.
 *
 * The scripts are separately executed through a Lua 5.3 VM with a shim of the
 * commands they use (scripts/verify-redis-lua.mjs, 28 checks), which covers their
 * logic but not a real server. `redis` is also deliberately not installed, which
 * keeps the missing-package startup failure a real test.
 *
 * Closing this gap needs a Redis instance in CI. Until then, treat shared-state
 * operation as reviewed-and-unit-tested, not integration-tested.
 * ---------------------------------------------------------------------------
 */
