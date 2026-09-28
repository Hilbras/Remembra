# Distributed Locking and the Job Ledger

V5.6.0 adds lease-based locking for the work that must not run concurrently
across instances: snapshot restore, memory consolidation, scheduled jobs,
maintenance, migration, and tenant operations.

## Leases, not locks

A lock held across a crash is a deadlock, and the only cure is an operator. Every
acquisition here is therefore a **lease**: an owner plus an absolute expiry, a
`renew` that extends it, and reclamation by a peer once it ages out. Nothing
blocks forever waiting for a holder that will never return.

```ts
import { InProcessLockProvider, lockKey, withLock } from "@hilbras/remembra/lock";

const locks = new InProcessLockProvider();
const key = lockKey("snapshot-restore", snapshotId);   // opaque, see below

await withLock(locks, key, async (lease) => {
  // ... the critical section ...
  // lease.renew(ms) returns false the moment the lease is lost
});
```

Two rules exist because getting them wrong turns a lock into a data-loss bug:

1. **`release()` is owner-checked.** If your lease was reclaimed and re-acquired
   by a peer, your `release()` returns `false` and does nothing. It can never
   clear someone else's lease.
2. **A lost lease stays lost.** `renew()` returns `false` once the lease is gone.
   If it returned `true` after a partition, a worker would resume writing while a
   peer had already moved on — the same failure as a lost update, wearing a lock.
   Check it, and abandon the work when it fails.

## Implementations

| Provider | Scope | Use |
|---|---|---|
| `InProcessLockProvider` | one process | the default, and what a single process has always had |
| `FileLockProvider` | one host, many processes | replaces the pid-liveness check with an absolute expiry, which is portable |
| Redis | many hosts | planned in T05, over the same interface |

`FileLockProvider` reclaims a lease when its `expiresAt` has passed, not when a
pid stops responding. Pid liveness is a same-host signal — pid 1234 on another
machine is not this process — so the expiry is what makes the file provider
portable. The pid is retained only as a fast path for a same-host crash.

**A corrupt lease file is reclaimable, not a deadlock.** A file that exists but
cannot be parsed is treated as expired and removed; `acquire` also bounds its
reclaim-and-retry spins, so any future filesystem livelock becomes a refusal
rather than a hang.

## Identity

`lockKey(domain, ...parts)` hashes any part that is not already a hex digest, so
a raw tenant, user, agent, or key value cannot reach a lease key. Lease files
live on disk or in a shared store and outlive the request that created them; the
provider also hashes the whole key again before using it as a filename, so a key
can never contain a separator that escapes the lease directory.

The owner id defaults to `<pid>-<random>`, so a holder is recognisable in a log
and in a diagnostic without carrying anything sensitive.

## Refusal

A contended acquisition throws with `code === "LOCK_TIMEOUT"` and a message
naming the current holder. `waitMs` bounds any waiting — it defaults to `0`, so
the default is fail-fast rather than queueing. `isLockTimeout(error)` recognises
it.

```ts
try {
  await locks.acquire(key, { leaseMs: 30_000 });
} catch (error) {
  if (isLockTimeout(error)) return;   // another instance is doing this work
  throw error;
}
```

`inspect(key)` returns the holder and expiry for diagnostics, and `sweep()`
reclaims expired leases deterministically rather than on a timer.

---

# The durable job ledger

Roadmap §27. `src/job-store.ts`, published as `@hilbras/remembra/job-store`.

The in-memory `JobQueue` hands back a promise that resolves when the job
settles. That shape cannot cross a process boundary — nothing in this process can
resolve a promise created in another — so a ledger that N workers share has to be
*polled* rather than awaited. `JobQueue` is unchanged and remains what a single
process uses.

```ts
import { InMemoryJobStore, SqliteJobStore } from "@hilbras/remembra/job-store";

const store = new SqliteJobStore(db);              // or InMemoryJobStore
const jobId = await store.enqueue({ type: "maintenance", payload: {}, maxAttempts: 3 });

const job = await store.claim({ owner: "worker-1", leaseMs: 60_000 });
if (job) {
  try {
    await doWork(JSON.parse(job.payload));
    await store.complete(job.jobId, "worker-1");
  } catch (err) {
    await store.fail(job.jobId, "worker-1", classify(err));
  }
}
```

## A claim is one statement, not a read then a write

Two workers polling the same ledger must not both believe they own a job. The
claim is a single `UPDATE ... RETURNING`, so the database decides the winner and
returns the row it actually claimed. This is the same check-then-act shape that
produced audit finding S1, where two writers were each told they had succeeded.

Jobs are ordered oldest-first, ties broken by id. The id is random, so order
*within* a millisecond is arbitrary — but it is the same arbitrary order for every
claimer, which is what stops two workers racing for the same job.

## A dead worker's job comes back

A claimed job carries a lease. `reclaimExpired()` returns jobs whose lease lapsed
to `retrying` (or `failed` once attempts run out), so a worker that dies mid-job
does not strand it and nothing waits for a holder that will never return.

`renew()` returns `false` once a lease is lost, and `complete()`/`fail()` return
`false` for a lease that is no longer yours. A worker that lost its lease cannot
commit anything, and a partitioned one cannot resume on a belief it still holds
it.

## Bounds

| Input | Limit |
|---|---|
| `payload` | 64 KiB, JSON-encoded; a non-serializable payload is refused |
| `type` | 1–64 chars, `[A-Za-z0-9._:-]` — it becomes a metric label |
| `tenantId` | hashed to a 12-byte digest unless already opaque |
| `lastError` | a classified code, never a message: an unsafe value is stored as `unknown` |

`prune(olderThanMs)` removes settled jobs and never touches an outstanding one, so
the ledger stays bounded.

---

# The durable worker

Roadmap §28. `src/durable-worker.ts`, published as `@hilbras/remembra/worker`.

Polls a `JobStore`, claims jobs, runs them, and reports the outcome. This is
the shared-execution counterpart to the in-memory `JobQueue`, which is unchanged
and remains what a single process uses.

```ts
import { DurableWorker } from "@hilbras/remembra/worker";

const worker = new DurableWorker({
  store,                                    // SqliteJobStore or InMemoryJobStore
  handlers: { "maintenance": runMaintenance },
  concurrency: 4,
  leaseMs: 60_000,
});
worker.start();
// ... later, and required, so the process can exit:
await worker.stop();
```

## Handlers are declared, not discovered

A worker declares the types it can run, and claims are restricted to those. It
therefore never claims a job it has no handler for — which is what makes a
heterogeneous fleet safe, and how §28's server/worker/scheduler split falls out
without a separate mechanism. `worker.types` is what a peer should route to this
process. Starting a worker with no handlers is refused, because it would poll
forever claiming nothing and look like a healthy idle worker.

## The partition guard

A claimed job's lease is renewed while the job runs. **If a renewal ever fails,
the job's `AbortSignal` fires.** Continuing would be the S1 lost-update failure
wearing a lease: two workers each believing they own one job. So the worker stops
and reports `lease_lost` rather than claiming a success it cannot vouch for, and
`complete()` returning `false` is treated the same way.

## Handlers must be idempotent

A worker that dies mid-job has its lease reclaimed and the job re-run, as
attempt 2. Nothing can make an arbitrary handler safe to run twice — that is a
stated requirement on the handler. `context.attempt` is passed so it can tell
which run it is, and `context.signal` so a long job can stop early.

## stop() is required

The poll timer is deliberately **not** `unref`'d: §28 allows a worker-only
process, and a worker-only process has nothing else holding its event loop open,
so an unref'd timer would let it exit before claiming a single job. `stop()` is
what releases the handle, and the process owner is responsible for calling it.

`stop(timeoutMs)` also **releases** each in-flight lease rather than abandoning
it, so a peer can take the work immediately instead of waiting out the lease. A
job that does not finish within the timeout keeps its lease and is reclaimed on
expiry, which is the right outcome for work that is genuinely still running.

`drain(maxRounds)` claims and runs to completion, awaiting the work it claims —
useful for a one-shot drain and for tests.

---

# The Redis adapter

Roadmap §26. `src/redis.ts`, published as `@hilbras/remembra/redis`.

## Redis is optional, and it stays optional

`redis` is an **optional peer dependency**. It is not in `dependencies`, and not
even in `devDependencies` — keeping it uninstalled is what makes the
missing-package startup failure a real test rather than a mocked one. The only
reference to the package is a dynamic `import()` inside `loadRedis`.

| `REMEMBRA_REDIS_URL` | Result |
| --- | --- |
| unset, empty, or whitespace | single-host. No Redis code is imported and no client is built. |
| `redis://…` / `rediss://…`, package present | shared state, connected at startup. |
| `redis://…`, package absent | **startup fails**, naming `npm install redis`. |
| `redis://…`, connection refused | **startup fails.** |
| any other scheme | rejected as `INVALID_INPUT`. |

There is no fallback. A deployment that asked for a shared budget and quietly got
a per-instance one would report a limit it is not enforcing, while looking
healthy in `/health` — so an unreachable Redis is a failure to start, not a
degraded mode.

## Why this is one script and not N limiters

The obvious composition — a Redis limiter per quota dimension, wired into the
existing `QuotaRateLimiter` — is wrong. `QuotaRateLimiter` serializes its
dimensions with an **in-process** mutex, so N instances would interleave their
dimension checks and a shared organization budget could be exceeded by concurrent
requests. That is check-then-act, the shape that produced the lost-update defect
in the V5.6.0 audit, one level up.

So `RedisQuotaRateLimiter` evaluates **every** dimension in one Lua script and
charges only if all of them allow. A refused request charges nothing anywhere.
Precedence is `RATE_LIMIT_DIMENSIONS` with the base budget last — identical to
`QuotaRateLimiter`, so switching stores cannot change which budget reports a
refusal. Policies are validated by the *same exported* `assertPolicy`, so a
configuration accepted in one mode is accepted in the other.

Two details that are easy to get wrong, and were:

- **Each dimension keeps its own window.** Pruning every key against the largest
  window present would leave a short window's stale entries in place, so `ZCARD`
  would count hours-old requests and a 60-per-minute budget would behave as
  60-per-hour. A limit that reads as configured and enforces over the wrong
  period is worse than no limit.
- **Members must be unique.** `ZADD` on an existing member *overwrites*, so two
  requests sharing a member collapse into one and the second is invisible to the
  limit. Members carry a per-instance tag and a counter.

Only dimensions the request actually carries are charged, matching
`QuotaRateLimiter.charged`: a dimension the host did not resolve cannot be
charged, and the base budget already covers that request.

## Locking

`RedisLockProvider` uses `SET … NX PX`, so the lease and its expiry are one atomic
server-side operation — there is no window in which a lock exists without an
expiry. `renew` and `release` are owner-checked **by the server** through Lua, so
a lease that a peer reclaimed and re-took between our expiry and our release is
never cleared. Both return a boolean rather than throwing, because "someone else
holds it now" is an answer, not an error.

## What is and is not verified here

Verified: the script bodies, executed as the text shipped in `src/redis.ts`
through a real Lua 5.3 VM with a shim of the Redis commands they use —
per-dimension windows, precedence, tightest-budget reporting, the same-millisecond
member hazard, non-consuming `check`, window boundaries matched against
`InProcessRateLimiter`, and owner-checked renew/release. Plus the TypeScript
wiring under test: which keys are charged, what reaches the script, and how a
reply maps back to a decision.

**Not verified: a live Redis server.** Every test against the adapter uses a fake
client whose replies are canned, and there is no Redis in this project's test
environment. Before relying on this in production, run it against a real server —
in particular confirm the script loads under your Redis version and that
`EVALSHA`/script caching behaves as the client expects.
