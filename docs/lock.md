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
