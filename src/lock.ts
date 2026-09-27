/**
 * Distributed-capable locking (V5.6.0, roadmap §29).
 *
 * The file backend already has a cross-process lock, but it is a pid file:
 * correct on one host, meaningless on another, because pid 1234 elsewhere is not
 * this process. The SQLite backend has no cross-process lock at all — only an
 * in-process promise queue. Audit finding S6.
 *
 * This module makes the *shape* explicit so a shared implementation can be
 * added without changing any call site, and so the failure modes are stated
 * rather than discovered.
 *
 * ## Leases, not locks
 *
 * A lock held across a crash is a deadlock, and the only cure is an operator.
 * Every acquisition here is therefore a **lease**: it carries an owner and an
 * absolute expiry, it is renewable, and an aged-out lease is reclaimable by a
 * peer without waiting for the holder to notice it is gone. A holder whose
 * lease was reclaimed learns about it from `renew()` returning `false` — it does
 * not get to keep working on the belief that it still holds the lease.
 *
 * ## Two rules that are easy to get wrong
 *
 * 1. **Release is owner-checked.** Releasing a lease that has been reclaimed and
 *    re-acquired by a peer must not clear the peer's lease. `release()` is a
 *    no-op in that case, and reports `false`.
 * 2. **Renew is not a formality.** Once a lease is lost it stays lost. `renew()`
 *    returning `true` must mean the caller still holds it, or a partitioned
 *    worker resumes writing while a peer has moved on — which is the S1 failure
 *    mode wearing a lock.
 *
 * ## Identity
 *
 * Lease keys are built from opaque digests, never raw tenant or key values, for
 * the same reason rate identities are: a key is written to disk or to a shared
 * store where it would outlive the request.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logEvent } from "./log.js";

/** Work that must not run concurrently across instances (§29). */
export const LOCK_DOMAINS = [
  "snapshot-restore",
  "memory-consolidation",
  "scheduled-jobs",
  "maintenance",
  "migration",
  "tenant-operation",
] as const;

export type LockDomain = (typeof LOCK_DOMAINS)[number] | (string & {});

export interface LockOptions {
  /** How long the lease is valid. Default 30 000ms. */
  leaseMs?: number;
  /** Max time to wait for a contended lease. Default 0 — fail fast. */
  waitMs?: number;
  /** Poll interval while waiting. Default 25ms. */
  pollMs?: number;
  /** Identity of the holder. Default: a per-process random id. */
  owner?: string;
}

export interface LockInfo {
  readonly key: string;
  readonly owner: string;
  readonly expiresAt: number;
}

export interface LockHandle {
  readonly info: LockInfo;
  /** Still held by this owner. False once reclaimed by a peer. */
  isHeld(): boolean;
  /**
   * Extend the lease. Returns `false` if the lease was already lost — in which
   * case the caller must abandon the work rather than continue.
   */
  renew(leaseMs?: number): Promise<boolean>;
  /** Give it up. Returns `false` if it was no longer ours to release. */
  release(): Promise<boolean>;
}

export interface LockProvider {
  /**
   * Acquire a lease, or refuse. Never blocks indefinitely: `waitMs` bounds it
   * and a refusal throws `LOCK_TIMEOUT` naming the current holder.
   */
  acquire(key: string, options?: LockOptions): Promise<LockHandle>;
  /** Who holds it, if anyone. Bounded diagnostic state, never a secret. */
  inspect(key: string): Promise<LockInfo | undefined>;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WAIT_MS = 0;
const DEFAULT_POLL_MS = 25;
/** Reclaim-and-retry attempts before `acquire` refuses instead of spinning. */
const MAX_ACQUIRE_SPINS = 64;

/** A stable, opaque lease key. Never a raw tenant, user, agent, or key value. */
export function lockKey(domain: LockDomain, ...opaqueParts: string[]): string {
  const parts = opaqueParts.map((part) =>
    /^[0-9a-f]{8,128}$/.test(part) ? part : createHash("sha256").update(part).digest("hex").slice(0, 16),
  );
  return [domain, ...parts].join("/");
}

/** A process-stable owner id, so a crashed holder is recognisable in a log. */
let processOwnerId: string | undefined;
export function defaultLockOwner(): string {
  if (!processOwnerId) processOwnerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  return processOwnerId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// In-process provider — the default, and what a single process has always had.
// ---------------------------------------------------------------------------

interface Entry {
  owner: string;
  expiresAt: number;
}

export class InProcessLockProvider implements LockProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  /** Leases this process currently believes it holds. */
  private readonly held = new Set<string>();
  private timers = new Map<string, unknown>();
  /** Reclaimed because they aged out — surfaced in health and tests. */
  private reclaimed = 0;

  constructor(
    options: {
      now?: () => number;
      setTimeoutFn?: (fn: () => void, ms: number) => unknown;
      clearTimeoutFn?: (handle: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get stats(): { tracked: number; held: number; reclaimed: number } {
    return { tracked: this.entries.size, held: this.held.size, reclaimed: this.reclaimed };
  }

  async acquire(key: string, options: LockOptions = {}): Promise<LockHandle> {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const owner = options.owner ?? defaultLockOwner();
    const deadline = this.now() + waitMs;

    for (;;) {
      const existing = this.entries.get(key);
      if (!existing || existing.expiresAt <= this.now()) {
        if (existing) this.reclaimed++;
        this.entries.set(key, { owner, expiresAt: this.now() + leaseMs });
        return this.handle(key, owner);
      }
      if (this.now() >= deadline) {
        throw Object.assign(new Error(`lock "${key}" is held by ${existing.owner}`), {
          name: "LockTimeout",
          code: "LOCK_TIMEOUT",
          holder: existing.owner,
        });
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - this.now())));
    }
  }

  async inspect(key: string): Promise<LockInfo | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.reclaimed++;
      return undefined;
    }
    return { key, owner: entry.owner, expiresAt: entry.expiresAt };
  }

  /** Drop every expired lease. Deterministic, so tests do not depend on timers. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.held.delete(key);
        this.reclaimed++;
        removed++;
      }
    }
    return removed;
  }

  private handle(key: string, owner: string): LockHandle {
    this.held.add(key);
    const provider = this;
    return {
      info: { key, owner, expiresAt: this.entries.get(key)?.expiresAt ?? this.now() },
      isHeld(): boolean {
        const entry = provider.entries.get(key);
        return entry !== undefined && entry.owner === owner && entry.expiresAt > provider.now();
      },
      async renew(leaseMs?: number): Promise<boolean> {
        const entry = provider.entries.get(key);
        if (!entry || entry.owner !== owner || entry.expiresAt <= provider.now()) return false;
        entry.expiresAt = provider.now() + (leaseMs ?? DEFAULT_LEASE_MS);
        return true;
      },
      async release(): Promise<boolean> {
        const entry = provider.entries.get(key);
        // Owner-checked: never clear a lease a peer has since taken.
        if (!entry || entry.owner !== owner) return false;
        provider.entries.delete(key);
        provider.held.delete(key);
        return true;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// File-backed provider — a real cross-process lease on one host.
// ---------------------------------------------------------------------------

interface LeasePayload {
  owner: string;
  expiresAt: number;
  pid: number;
}

export class FileLockProvider implements LockProvider {
  private readonly root: string;
  private readonly now: () => number;
  /** Files this provider instance believes it holds. */
  readonly heldFiles = new Set<string>();

  constructor(root: string, options: { now?: () => number } = {}) {
    this.root = root;
    this.now = options.now ?? Date.now;
  }

  private file(key: string): string {
    // The key is already opaque; hash again so a key can never contain a
    // separator that escapes the directory.
    const name = createHash("sha256").update(key).digest("hex");
    return path.join(this.root, `${name}.lease`);
  }

  async inspect(key: string): Promise<LockInfo | undefined> {
    const payload = await this.read(this.file(key));
    if (!payload) return undefined;
    if (payload.expiresAt <= this.now()) return undefined;
    return { key, owner: payload.owner, expiresAt: payload.expiresAt };
  }

  async acquire(key: string, options: LockOptions = {}): Promise<LockHandle> {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const owner = options.owner ?? defaultLockOwner();
    const file = this.file(key);
    const deadline = this.now() + waitMs;

    await fs.mkdir(this.root, { recursive: true });
    // A bounded spin, so any future livelock on the filesystem becomes a refusal
    // rather than a hang. Reaching it means real contention, not a bug.
    let spins = 0;
    for (;;) {
      const payload: LeasePayload = { owner, expiresAt: this.now() + leaseMs, pid: process.pid };
      // `wx` fails if the file exists, so the create is the atomic step: two
      // processes cannot both believe they created it.
      try {
        await fs.writeFile(file, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
        this.heldFiles.add(file);
        return this.handle(key, file, owner, leaseMs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw Object.assign(new Error(`lock "${key}" could not be created`), { code: "LOCK_TIMEOUT", cause: error });
        }
      }

      const existing = await this.read(file);
      const expired = !existing || existing.corrupt === true || existing.expiresAt <= this.now();
      if (expired) {
        if (existing) {
          // Reclaim: drop the stale or unreadable lease, then race for it again.
          // The next `wx` is the arbiter, so a peer that reclaimed first simply
          // wins the retry and this caller sees EEXIST and moves on.
          await fs.unlink(file).catch(() => {});
        }
        // It vanished between EEXIST and read, or we just removed it: retry.
        if (++spins > MAX_ACQUIRE_SPINS) {
          throw Object.assign(new Error(`lock "${key}" could not be acquired: too much contention`), {
            name: "LockTimeout",
            code: "LOCK_TIMEOUT",
          });
        }
        continue;
      }
      if (this.now() >= deadline) {
        throw Object.assign(new Error(`lock "${key}" is held by ${existing!.owner}`), {
          name: "LockTimeout",
          code: "LOCK_TIMEOUT",
          holder: existing!.owner,
        });
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - this.now())));
    }
  }

  /**
   * Read a lease.
   *
   * `undefined` means the file is gone. A lease that exists but cannot be
   * understood is returned as `corrupt` rather than as `undefined`, because the
   * two need opposite handling: a vanished file just needs another create
   * attempt, while a corrupt one has to be removed or it blocks the key
   * forever. Conflating them is what made an unparseable file livelock.
   */
  private async read(file: string): Promise<(LeasePayload & { corrupt?: true }) | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return undefined; // gone, or unreadable for another reason
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LeasePayload>;
      if (typeof parsed.owner !== "string" || typeof parsed.expiresAt !== "number") {
        throw new Error("shape");
      }
      return { owner: parsed.owner, expiresAt: parsed.expiresAt, pid: parsed.pid ?? 0 };
    } catch {
      // A lease we cannot understand is not a lease we may honour.
      logEvent("warn", "lock.unreadable", { file: path.basename(file) });
      return { owner: "unknown", expiresAt: 0, pid: 0, corrupt: true };
    }
  }

  private handle(key: string, file: string, owner: string, leaseMs: number): LockHandle {
    const provider = this;
    return {
      info: { key, owner, expiresAt: this.now() + leaseMs },
      isHeld(): boolean {
        return provider.heldFiles.has(file);
      },
      async renew(nextLeaseMs?: number): Promise<boolean> {
        if (!provider.heldFiles.has(file)) return false;
        const payload: LeasePayload = {
          owner,
          expiresAt: provider.now() + (nextLeaseMs ?? leaseMs),
          pid: process.pid,
        };
        try {
          // Only rewrite while it is still ours.
          const current = await provider.read(file);
          if (!current || current.owner !== owner) {
            provider.heldFiles.delete(file);
            return false;
          }
          await fs.writeFile(file, JSON.stringify(payload), { mode: 0o600 });
          return true;
        } catch {
          provider.heldFiles.delete(file);
          return false;
        }
      },
      async release(): Promise<boolean> {
        provider.heldFiles.delete(file);
        try {
          const current = await provider.read(file);
          if (!current || current.owner !== owner) return false;
          await fs.unlink(file);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

}

/**
 * Run `fn` under a lease, releasing it however `fn` ends. A failure inside the
 * body is the caller's error, not a lock error; the lease is released either
 * way so a failed critical section does not need an operator.
 */
export async function withLock<T>(
  provider: LockProvider,
  key: string,
  fn: (handle: LockHandle) => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const handle = await provider.acquire(key, options);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

/** True when a thrown value is a lease-timeout refusal. */
export function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "LOCK_TIMEOUT"
  );
}
