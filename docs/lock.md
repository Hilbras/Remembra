# Distributed Locking

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
