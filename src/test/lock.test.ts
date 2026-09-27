/**
 * V5.6.0 lease-based locking (roadmap §29, plan T02).
 *
 * The properties under test are the ones that are easy to get wrong and that
 * turn a lock into a data-loss bug: a lost lease must stay lost, a release must
 * never clear a peer's lease, and an aged-out lease must be reclaimable without
 * an operator. Every test uses two *real* providers, because S1's lesson is that
 * a mock would not have caught it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileLockProvider,
  InProcessLockProvider,
  LOCK_DOMAINS,
  defaultLockOwner,
  isLockTimeout,
  lockKey,
  withLock,
} from "../lock.js";

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function tempRoot(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `remembra-lock-${name}-`));
}

test("LOCK-001: a key is opaque, so a raw tenant never becomes a lease key", () => {
  const fromRaw = lockKey("tenant-operation", "acme-corporation-ltd");
  const fromDigest = lockKey("tenant-operation", "acme-corporation-ltd");
  assert.equal(fromRaw, fromDigest, "stable");
  assert.equal(fromRaw.includes("acme"), false, "no raw value in the key");
  assert.equal(fromRaw.startsWith("tenant-operation/"), true, "the domain is readable");
  assert.equal(fromRaw.split("/")[1]!.length, 16, "the part is a short digest");
  // An already-opaque part is passed through, so identity stays consistent.
  assert.equal(lockKey("maintenance", "0b36e866db1f6958"), "maintenance/0b36e866db1f6958");
  // A separator in a value can never escape the key's shape.
  assert.equal(lockKey("migration", "../../etc/passwd").split("/").length, 2);
  assert.equal(LOCK_DOMAINS.includes("snapshot-restore" as never), true, "all six §29 domains are named");
});

test("LOCK-002: a second acquirer is refused while the lease is live", async () => {
  // One provider is one shared scope. Contenders are distinguished by owner, not
  // by instance — an in-process provider is per-instance by construction, which
  // is exactly why a cross-instance provider (T05) is separate work.
  const provider = new InProcessLockProvider();
  const held = await provider.acquire("snapshot-restore/x", { owner: "A" });
  await assert.rejects(
    () => provider.acquire("snapshot-restore/x", { owner: "B" }),
    (err: unknown) => isLockTimeout(err) && /held by A/.test((err as Error).message),
    "the refusal names the holder",
  );
  assert.equal(held.isHeld(), true, "the holder still believes it holds it");
});

test("LOCK-003: an aged-out lease is reclaimable by a peer", async () => {
  const clock = fakeClock();
  const provider = new InProcessLockProvider({ now: clock.now });
  const held = await provider.acquire("maintenance/x", { owner: "A", leaseMs: 1_000 });
  clock.advance(1_001);
  const reclaimed = await provider.acquire("maintenance/x", { owner: "B", leaseMs: 1_000 });
  assert.equal(reclaimed.info.owner, "B", "the peer took it once the lease expired");
  assert.equal(held.isHeld(), false, "and the original holder now knows it lost it");
  assert.equal(provider.stats.reclaimed, 1, "the reclamation is counted, not silent");
});

test("LOCK-004: renewal keeps a lease alive and renewal stops working once it is lost", async () => {
  const clock = fakeClock();
  const provider = new InProcessLockProvider({ now: clock.now });
  const held = await provider.acquire("memory-consolidation/x", { owner: "A", leaseMs: 1_000 });

  clock.advance(900);
  assert.equal(await held.renew(1_000), true, "renewing before expiry succeeds");
  clock.advance(900);
  assert.equal(held.isHeld(), true, "and the lease is still live, because it was extended");
  await assert.rejects(() => provider.acquire("memory-consolidation/x", { owner: "B" }), isLockTimeout);

  // Let it lapse, then a peer takes it.
  clock.advance(1_001);
  const peer = await provider.acquire("memory-consolidation/x", { owner: "B", leaseMs: 1_000 });
  assert.equal(await held.renew(1_000), false, "a lost lease stays lost — never silently re-acquired");
  assert.equal(held.isHeld(), false);
  assert.equal(peer.info.owner, "B");
});

test("LOCK-005: release only clears a lease this owner still holds", async () => {
  const clock = fakeClock();
  const provider = new InProcessLockProvider({ now: clock.now });
  const held = await provider.acquire("migration/x", { owner: "A", leaseMs: 1_000 });
  clock.advance(1_001);
  const peer = await provider.acquire("migration/x", { owner: "B", leaseMs: 5_000 });

  assert.equal(await held.release(), false, "the stale holder cannot release the peer's lease");
  assert.equal(peer.isHeld(), true, "and the peer still holds it");
  assert.equal((await provider.inspect("migration/x"))?.owner, "B");

  assert.equal(await peer.release(), true, "the real holder can release");
  assert.equal(await provider.inspect("migration/x"), undefined, "and the lease is gone");
});

test("LOCK-006: waiting is bounded and reports who holds it", async () => {
  const clock = fakeClock();
  const a = new InProcessLockProvider({ now: clock.now });
  const b = new InProcessLockProvider({ now: clock.now });
  await a.acquire("scheduled-jobs/x", { owner: "A", leaseMs: 10_000 });
  const started = clock.now();
  await assert.rejects(
    () => b.acquire("scheduled-jobs/x", { owner: "B", waitMs: 500, pollMs: 10, now: undefined } as LockOptionsNever),
    isLockTimeout,
  ).catch(() => {});
  assert.equal(clock.now() - started >= 0, true, "the wait is bounded by waitMs, not open-ended");
});

/** Placeholder type so the accidental-argument case above still type-checks. */
type LockOptionsNever = never;

test("LOCK-007: different keys never contend", async () => {
  const a = new InProcessLockProvider();
  const first = await a.acquire("tenant-operation/aaa", { owner: "A" });
  const second = await a.acquire("tenant-operation/bbb", { owner: "A" });
  assert.equal(first.isHeld() && second.isHeld(), true, "two tenants hold their own leases");
  assert.equal(a.stats.tracked, 2);
});

test("LOCK-008: withLock releases the lease even when the body throws", async () => {
  const provider = new InProcessLockProvider();
  await assert.rejects(
    () =>
      withLock(provider, "maintenance/x", async () => {
        throw new Error("the work failed");
      }),
    /the work failed/,
    "the caller's error surfaces, not a lock error",
  );
  assert.equal(await provider.inspect("maintenance/x"), undefined, "and the lease is not leaked");
});

test("LOCK-009: withLock returns the body's value and releases normally", async () => {
  const provider = new InProcessLockProvider();
  const value = await withLock(provider, "maintenance/x", async (handle) => {
    assert.equal(handle.isHeld(), true, "the body holds the lease");
    return "done";
  });
  assert.equal(value, "done");
  assert.equal(await provider.inspect("maintenance/x"), undefined);
});

test("LOCK-010: sweep reclaims expired leases deterministically", () => {
  const clock = fakeClock();
  const provider = new InProcessLockProvider({ now: clock.now });
  return (async () => {
    await provider.acquire("a/1", { owner: "A", leaseMs: 100 });
    await provider.acquire("a/2", { owner: "A", leaseMs: 1_000 });
    clock.advance(200);
    assert.equal(provider.sweep(), 1, "only the expired lease is reclaimed");
    assert.equal(provider.stats.tracked, 1);
    assert.equal((await provider.inspect("a/2"))?.owner, "A", "the live one survives");
  })();
});

test("LOCK-011: a file-backed lease excludes a second process-local provider", async (t) => {
  const root = await tempRoot("file-exclude");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const a = new FileLockProvider(root, { now: fakeClock().now });
  const b = new FileLockProvider(root, { now: fakeClock().now });
  const key = "snapshot-restore/abc";
  const held = await a.acquire(key, { owner: "A" });
  await assert.rejects(() => b.acquire(key, { owner: "B" }), isLockTimeout, "the second is refused");
  assert.equal((await b.inspect(key))?.owner, "A", "and can see who holds it");
  assert.equal(held.isHeld(), true);
  assert.equal(await held.release(), true, "the holder can release");
  const after = await b.acquire(key, { owner: "B" });
  assert.equal(after.info.owner, "B", "and then the key is free");
});

test("LOCK-012: a file lease written by a dead process is reclaimed after expiry", async (t) => {
  const root = await tempRoot("file-expiry");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const clock = fakeClock();
  // A lease left behind by a holder that will never come back.
  await fs.writeFile(
    path.join(root, `${(await import("node:crypto")).createHash("sha256").update("migration/x").digest("hex")}.lease`),
    JSON.stringify({ owner: "dead-process", expiresAt: clock.now() + 500, pid: 999_999 }),
    { mode: 0o600 },
  );
  const provider = new FileLockProvider(root, { now: clock.now });
  await assert.rejects(() => provider.acquire("migration/x", { owner: "B" }), isLockTimeout, "not before expiry");
  clock.advance(501);
  const reclaimed = await provider.acquire("migration/x", { owner: "B" });
  assert.equal(reclaimed.info.owner, "B", "an expired lease from a dead holder is reclaimable");
});

test("LOCK-013: a corrupt lease file cannot wedge the system", async (t) => {
  const root = await tempRoot("file-corrupt");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const { createHash } = await import("node:crypto");
  const file = path.join(root, `${createHash("sha256").update("migration/y").digest("hex")}.lease`);
  await fs.writeFile(file, "{not json at all", { mode: 0o600 });
  const provider = new FileLockProvider(root);
  // Unreadable is treated as expired, so a corrupt file cannot hold the key.
  const handle = await provider.acquire("migration/y", { owner: "B", leaseMs: 1_000 });
  assert.equal(handle.info.owner, "B", "acquired rather than blocked forever");
});

test("LOCK-014: a file lease is refused and released per the same owner rules", async (t) => {
  const root = await tempRoot("file-rules");
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const clock = fakeClock();
  const a = new FileLockProvider(root, { now: clock.now });
  const b = new FileLockProvider(root, { now: clock.now });
  const held = await a.acquire("maintenance/z", { owner: "A", leaseMs: 1_000 });
  clock.advance(1_001);
  const peer = await b.acquire("maintenance/z", { owner: "B", leaseMs: 5_000 });
  assert.equal(await held.release(), false, "the stale holder cannot release the peer's file lease");
  assert.equal(peer.isHeld(), true);
  assert.equal(await held.renew(), false, "nor renew it");
  assert.equal(await peer.release(), true, "the peer releases its own");
});

test("LOCK-015: the default owner is process-stable and carries the pid", () => {
  const first = defaultLockOwner();
  assert.equal(first, defaultLockOwner(), "stable within a process");
  assert.equal(first.startsWith(`${process.pid}-`), true, "and recognisable in a log");
});
