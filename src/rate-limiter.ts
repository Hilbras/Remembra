/**
 * Rate limiting (V5.1.0, roadmap §18) — a stable interface plus an in-process
 * implementation.
 *
 * The application depends on the `RateLimiter` interface, never on a concrete
 * limiter, so a shared-store implementation can be supplied later without
 * touching the request path. V5.1 ships only the in-process one; Redis arrives
 * with the distributed runtime and must not leak in here.
 *
 * Two invariants this module exists to hold:
 *
 * 1. **Authentication still precedes any charge.** The HTTP layer authenticates
 *    first and only then consumes a protected bucket; an unauthenticated caller
 *    is charged to a separate anonymous bucket so it cannot exhaust the
 *    configured client's quota. That ordering is pinned by SEC-RL-001.
 *
 * 2. **Identity is opaque.** Every dimension value must already be a truncated
 *    digest. `rateLimitIdentity` refuses anything else, so a raw tenant, user,
 *    agent, or key string cannot become a quota identity by accident (SEC-RL-002).
 *
 * State is bounded: tracked identities are capped and evicted in a
 * deterministic order, because the limiter is reachable before authentication
 * and an unbounded map is a memory-exhaustion vector.
 */
import { createHash } from "node:crypto";
import { RemembraError } from "./errors.js";

/** Quota dimensions from roadmap §19. Order is the default precedence order. */
export const RATE_LIMIT_DIMENSIONS = [
  "global",
  "organization",
  "project",
  "user",
  "agent",
  "apikey",
  "ip",
  "endpoint",
  "provider",
] as const;

export type RateLimitDimension = (typeof RATE_LIMIT_DIMENSIONS)[number];

/** Opaque, already-hashed dimension values. See `rateLimitIdentity`. */
export type RateLimitDimensions = Partial<Record<RateLimitDimension, string>>;

/**
 * The identity a decision is made about. Dimensions are optional so an
 * unresolved dimension is visibly absent rather than defaulted to something
 * wider — a missing dimension can never grant more access than a present one.
 */
export interface RateLimitIdentity {
  readonly dimensions: RateLimitDimensions;
  /** Stable, opaque composite key. Derived, never caller-supplied. */
  readonly key: string;
}

export interface RateLimitResult {
  /** True when the request may proceed. `consume` charges only when true. */
  readonly allowed: boolean;
  /** Requests still available in the current window after this decision. */
  readonly remaining: number;
  /** Milliseconds until the window frees a slot. 0 when `allowed`. */
  readonly retryAfterMs: number;
  /** The configured ceiling, so a caller can report it without config access. */
  readonly limit: number;
  readonly windowMs: number;
  /** Which dimension decided, when the decision came from a named dimension. */
  readonly dimension?: RateLimitDimension;
}

export interface RateLimiter {
  /** Decide without charging. Safe to call speculatively. */
  check(identity: RateLimitIdentity): Promise<RateLimitResult>;
  /** Decide and charge one request when allowed. */
  consume(identity: RateLimitIdentity): Promise<RateLimitResult>;
  /** Forget one identity's window. */
  reset(identity: RateLimitIdentity): Promise<void>;
}

export interface RateLimiterOptions {
  /** Max requests per window per identity. Default: 60. */
  limit?: number;
  /** Window size in ms. Default: 60_000. */
  windowMs?: number;
  /**
   * Hard ceiling on tracked identities. Default: 10_000. Reached under
   * identity rotation, the least recently used window is evicted.
   */
  maxIdentities?: number;
  /**
   * Operations between deterministic sweeps of fully expired windows.
   * Default: 256. Never randomized: a security-relevant path must be testable.
   */
  sweepEvery?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_IDENTITIES = 10_000;
const DEFAULT_SWEEP_EVERY = 256;

/** Dimension values must be lowercase hex digests of at least 8 characters. */
const OPAQUE_VALUE = /^[0-9a-f]{8,128}$/;

interface Window {
  timestamps: number[];
  /** Monotonic counter used for deterministic least-recently-used eviction. */
  lastAccess: number;
}

/**
 * Build an identity from already-opaque dimension values.
 *
 * Values that are not hex digests are rejected rather than hashed here: a
 * caller that reaches for this with a raw principal has a bug, and hashing it
 * silently would hide the bug while still making a raw secret the input to a
 * rate-limit key.
 */
export function rateLimitIdentity(dimensions: RateLimitDimensions): RateLimitIdentity {
  const entries = RATE_LIMIT_DIMENSIONS.filter((name) => {
    const value = dimensions[name];
    return typeof value === "string" && value.length > 0;
  }).map((name) => {
    const value = dimensions[name] as string;
    if (!OPAQUE_VALUE.test(value)) {
      throw new RemembraError(
        "INVALID_INPUT",
        `rate limit dimension "${name}" must be an opaque digest, not a raw value`,
      );
    }
    return `${name}=${value}` as const;
  });
  return { dimensions, key: entries.length > 0 ? entries.join("&") : "global" };
}

/** Hash a value into an opaque dimension component. */
export function opaqueRateLimitPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Sliding-window limiter over a bounded identity map.
 *
 * `check` and `consume` are deliberately distinct: charging on a speculative
 * check would let a caller burn its own quota by asking whether it has any.
 */
export class InProcessRateLimiter implements RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxIdentities: number;
  private readonly sweepEvery: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();
  private accessCounter = 0;
  private operations = 0;
  /** Identities evicted by the ceiling, for the metrics and tests. */
  private evicted = 0;

  constructor(opts: RateLimiterOptions = {}) {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const maxIdentities = opts.maxIdentities ?? DEFAULT_MAX_IDENTITIES;
    const sweepEvery = opts.sweepEvery ?? DEFAULT_SWEEP_EVERY;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RemembraError("INVALID_INPUT", "rate limit must be a positive integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RemembraError("INVALID_INPUT", "rate limit window must be a positive integer");
    }
    if (!Number.isSafeInteger(maxIdentities) || maxIdentities < 1) {
      throw new RemembraError("INVALID_INPUT", "max tracked rate limit identities must be a positive integer");
    }
    if (!Number.isSafeInteger(sweepEvery) || sweepEvery < 1) {
      throw new RemembraError("INVALID_INPUT", "rate limit sweep interval must be a positive integer");
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxIdentities = maxIdentities;
    this.sweepEvery = sweepEvery;
    this.now = opts.now ?? Date.now;
  }

  async check(identity: RateLimitIdentity): Promise<RateLimitResult> {
    return this.evaluate(identity, false);
  }

  async consume(identity: RateLimitIdentity): Promise<RateLimitResult> {
    return this.evaluate(identity, true);
  }

  async reset(identity: RateLimitIdentity): Promise<void> {
    this.windows.delete(identity.key);
  }

  /** Forget every window. */
  clear(): void {
    this.windows.clear();
  }

  /** Tracked identity count, and how many the ceiling has evicted. */
  get stats(): { tracked: number; evicted: number; limit: number; windowMs: number } {
    return {
      tracked: this.windows.size,
      evicted: this.evicted,
      limit: this.limit,
      windowMs: this.windowMs,
    };
  }

  private evaluate(identity: RateLimitIdentity, charge: boolean): RateLimitResult {
    const now = this.now();
    let window = this.windows.get(identity.key);
    if (!window) {
      // Bound the map before admitting a new identity.
      if (this.windows.size >= this.maxIdentities) this.evict(now);
      window = { timestamps: [], lastAccess: this.accessCounter++ };
      this.windows.set(identity.key, window);
    }
    window.lastAccess = this.accessCounter++;

    // Drop timestamps that have aged out; what remains is the live window.
    let drop = 0;
    while (drop < window.timestamps.length && now - window.timestamps[drop]! >= this.windowMs) drop++;
    if (drop > 0) window.timestamps.splice(0, drop);

    const used = window.timestamps.length;
    const allowed = used < this.limit;
    if (charge && allowed) window.timestamps.push(now);

    if (++this.operations % this.sweepEvery === 0) this.sweep(now);

    let retryAfterMs = 0;
    if (!allowed) {
      const oldest = window.timestamps[0]!;
      retryAfterMs = Math.max(0, oldest + this.windowMs - now);
    }
    const remaining = Math.max(0, this.limit - used - (charge && allowed ? 1 : 0));
    return {
      allowed,
      remaining,
      retryAfterMs,
      limit: this.limit,
      windowMs: this.windowMs,
    };
  }

  /**
   * Remove windows whose newest timestamp has aged out. A window that is never
   * touched again is exactly the one a rotating-identity caller leaves behind,
   * so expiry — not re-use — is what has to reclaim it.
   */
  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      const newest = window.timestamps[window.timestamps.length - 1];
      if (newest === undefined || now - newest >= this.windowMs) this.windows.delete(key);
    }
  }

  /**
   * Enforce the ceiling. Fully expired windows go first; if the map is still
   * full, the least recently used window is dropped. Deterministic order, so
   * this is reproducible in a test.
   */
  private evict(now: number): void {
    this.sweep(now);
    if (this.windows.size < this.maxIdentities) return;
    let oldestKey: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, window] of this.windows) {
      if (window.lastAccess < oldestAccess) {
        oldestAccess = window.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.windows.delete(oldestKey);
      this.evicted++;
    }
  }
}
