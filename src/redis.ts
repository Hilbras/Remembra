/**
 * Redis adapters (V5.6.0, roadmap §26).
 *
 * **Redis is optional and stays optional.** Nothing in this module is imported
 * unless `REMEMBRA_REDIS_URL` is set, and the package that provides the client
 * is an optional peer — never a `dependencies` entry. A Remembra installation
 * that works today keeps working with this file present, because the only
 * reference to the client is a dynamic `import()` inside `loadRedis`.
 *
 * ## What is atomic, and why this is not N limiters
 *
 * The obvious composition — a Redis limiter per quota dimension, wired into the
 * existing `QuotaRateLimiter` — is wrong. `QuotaRateLimiter` serializes its
 * dimensions with an in-process mutex, so N instances would interleave their
 * dimension checks and a shared organization budget could be exceeded by
 * concurrent requests. That is check-then-act, the shape that produced audit
 * finding S1, one level up. So `RedisQuotaRateLimiter` evaluates **every**
 * dimension inside one Lua script and charges only if all of them allow, which is
 * the same guarantee the in-process limiter makes, held by the store.
 *
 * ## Scope of verification
 *
 * There is no Redis server in this repository's test environment, so the scripts
 * are verified against a fake client that models the commands used, and the
 * package-loading paths are verified for real. **Live Redis is not exercised
 * here.** Treat the script bodies as reviewed-but-unrun against a real server.
 */
import { RemembraError } from "./errors.js";
import { defaultLockOwner } from "./lock.js";
import { logEvent } from "./log.js";
import { RATE_LIMIT_DIMENSIONS } from "./rate-limiter.js";
import { assertPolicy, type QuotaPolicies, type QuotaPolicy } from "./quota.js";
import type { LockHandle, LockInfo, LockOptions, LockProvider } from "./lock.js";
import type { RateLimitDimension, RateLimitIdentity, RateLimitResult, RateLimiter } from "./rate-limiter.js";

export const REDIS_DISTRIBUTED_URL = "REMEMBRA_REDIS_URL";

/**
 * The narrow slice of a Redis client this module uses.
 *
 * Depending on an interface rather than on a client package is what makes the
 * dependency optional *and* testable: the package is named in exactly one place
 * (`loadRedis`), and everything above it can be exercised without it.
 */
export interface RedisLike {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
  quit?(): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface RedisConnection {
  client: RedisLike;
  /** True when the connection was established and is usable. */
  connected: boolean;
  close(): Promise<void>;
}

/** Validate `REMEMBRA_REDIS_URL`. Absent means "no shared state configured". */
export function parseRedisUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!/^rediss?:\/\//i.test(trimmed)) {
    throw new RemembraError(
      "INVALID_INPUT",
      `${REDIS_DISTRIBUTED_URL} must start with redis:// or rediss://`,
    );
  }
  return trimmed;
}

/**
 * Load the optional client. This is the only place the package is named.
 *
 * A missing package is a startup failure with a named remedy, never a silent
 * fallback to per-instance state: a deployment that asked for shared state and
 * quietly got local state would be running split-brain while looking healthy.
 */
export async function loadRedis(
  url: string,
  importer: (specifier: string) => Promise<Record<string, unknown>> = (specifier) =>
    import(/* @vite-ignore */ specifier) as unknown as Promise<Record<string, unknown>>,
): Promise<RedisConnection> {
  const resolved = parseRedisUrl(url);
  if (!resolved) {
    throw new RemembraError("SERVICE_UNAVAILABLE", `${REDIS_DISTRIBUTED_URL} is required for shared state`);
  }
  let module: Record<string, unknown>;
  try {
    module = await importer("redis");
  } catch (error) {
    throw new RemembraError(
      "SERVICE_UNAVAILABLE",
      `${REDIS_DISTRIBUTED_URL} is set but the optional "redis" package is not installed. ` +
        `Install it with \`npm install redis\`, or unset ${REDIS_DISTRIBUTED_URL} to run single-host.`,
      { cause: error },
    );
  }
  const createClient = (module.createClient ?? module.default) as
    | ((options: { url: string }) => RedisLike)
    | undefined;
  if (typeof createClient !== "function") {
    throw new RemembraError("SERVICE_UNAVAILABLE", "the installed redis package does not expose createClient");
  }
  const client = createClient({ url: resolved });
  client.on?.("error", (error: unknown) => {
    // Logged as a classified label only: a Redis URL and its error text can both
    // carry credentials.
    logEvent("warn", "redis.error", { error: error instanceof Error ? error.name : "unknown" });
  });
  const connect = (client as unknown as { connect?: () => Promise<unknown> }).connect;
  if (typeof connect === "function") {
    try {
      await connect.call(client);
    } catch (error) {
      throw new RemembraError(
        "SERVICE_UNAVAILABLE",
        "could not connect to the configured Redis; refusing to run with per-instance state",
        { cause: error },
      );
    }
  }
  return {
    client,
    connected: true,
    async close() {
      await client.quit?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/** Release only when we still own it, and report whether we did. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Extend only when we still own it. */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export class RedisLockProvider implements LockProvider {
  private readonly client: RedisLike;
  private readonly prefix: string;

  constructor(client: RedisLike, options: { prefix?: string } = {}) {
    this.client = client;
    this.prefix = options.prefix ?? "remembra:lock:";
  }

  private redisKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async inspect(key: string): Promise<LockInfo | undefined> {
    const owner = await this.client.get(this.redisKey(key));
    // Redis expires the key itself, so a present value is always a live lease.
    return owner === null ? undefined : { key, owner, expiresAt: Date.now() };
  }

  async acquire(key: string, options: LockOptions = {}): Promise<LockHandle> {
    const leaseMs = options.leaseMs ?? 30_000;
    const owner = options.owner ?? defaultLockOwner();
    const redisKey = this.redisKey(key);
    // NX + PX is the whole point of using Redis for a lease: the create and its
    // expiry are one atomic server-side operation, so there is no window in
    // which a lock exists without an expiry.
    const taken = await this.client.set(redisKey, owner, { NX: true, PX: leaseMs });
    if (taken === null) {
      const holder = await this.client.get(redisKey);
      throw Object.assign(new Error(`lock "${key}" is held by ${holder ?? "another owner"}`), {
        name: "LockTimeout",
        code: "LOCK_TIMEOUT",
        holder: holder ?? undefined,
      });
    }
    const provider = this;
    return {
      info: { key, owner, expiresAt: Date.now() + leaseMs },
      isHeld(): boolean {
        return true;
      },
      async renew(nextLeaseMs?: number): Promise<boolean> {
        const result = await provider.client.eval(RENEW_SCRIPT, {
          keys: [redisKey],
          arguments: [owner, String(nextLeaseMs ?? leaseMs)],
        });
        return Number(result) === 1;
      },
      async release(): Promise<boolean> {
        // Owner-checked by the server, so a lease reclaimed and re-taken by a
        // peer between our expiry and this call is never cleared.
        const result = await provider.client.eval(RELEASE_SCRIPT, { keys: [redisKey], arguments: [owner] });
        return Number(result) === 1;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/*
 * One script for every dimension, so a denied request charges nothing anywhere
 * and two instances cannot interleave their dimension checks.
 *
 * KEYS: one sliding-window key per *charged* dimension, in precedence order, the
 * base budget last.
 * ARGV: now, member, then (limit, window) per key.
 * Returns { allowed, index, remaining, retryAfterMs }.
 *
 * Each dimension keeps its own window. Pruning every key against one shared
 * `max(windowMs)` would leave stale entries in a short window, so ZCARD would
 * count requests from hours ago and silently enforce that budget over hours —
 * a limit that reads as 60/min and behaves as 60/hour is worse than no limit,
 * because it looks configured.
 */
const QUOTA_SCRIPT = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local count = #KEYS
-- Pass one: prune and decide. Nothing is charged unless every dimension allows.
for i = 1, count do
  local limit = tonumber(ARGV[3 + (i - 1) * 2])
  local window = tonumber(ARGV[4 + (i - 1) * 2])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], 0, now - window)
  local used = redis.call('ZCARD', KEYS[i])
  if used >= limit then
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local retry = 0
    if oldest[2] then retry = math.max(0, tonumber(oldest[2]) + window - now) end
    return {0, i, 0, retry}
  end
end
-- Pass two: charge, then report the tightest budget, ties broken by precedence.
local tightest = 1
local tightestRemaining = -1
for i = 1, count do
  local limit = tonumber(ARGV[3 + (i - 1) * 2])
  local window = tonumber(ARGV[4 + (i - 1) * 2])
  redis.call('ZADD', KEYS[i], now, member .. ':' .. i)
  redis.call('PEXPIRE', KEYS[i], window)
  local remaining = limit - redis.call('ZCARD', KEYS[i])
  if i == 1 or remaining < tightestRemaining then
    tightestRemaining = remaining
    tightest = i
  end
end
return {1, 0, tightestRemaining, 0}
`;

/** Non-consuming read of the same decision, for a speculative check. */
const QUOTA_CHECK_SCRIPT = `
local now = tonumber(ARGV[1])
local tightestRemaining = -1
for i = 1, #KEYS do
  local limit = tonumber(ARGV[3 + (i - 1) * 2])
  local window = tonumber(ARGV[4 + (i - 1) * 2])
  local used = redis.call('ZCOUNT', KEYS[i], now - window, '+inf')
  if used >= limit then
    return {0, i, 0, 0}
  end
  local remaining = limit - used
  if i == 1 or remaining < tightestRemaining then
    tightestRemaining = remaining
  end
end
return {1, 0, tightestRemaining, 0}
`;

export interface RedisQuotaOptions {
  client: RedisLike;
  /** The base per-identity budget, always charged. */
  base: QuotaPolicy;
  /** Per-dimension constraints. Only dimensions the request carries are charged. */
  policies?: QuotaPolicies;
  /** Key prefix, so several deployments can share one Redis. */
  prefix?: string;
  now?: () => number;
}

export class RedisQuotaRateLimiter implements RateLimiter {
  private readonly client: RedisLike;
  private readonly base: QuotaPolicy;
  private readonly policies: QuotaPolicies;
  private readonly order: RateLimitDimension[];
  private readonly prefix: string;
  private readonly now: () => number;
  /** Distinguishes members across processes; see `member()`. */
  private readonly instanceTag = Math.random().toString(36).slice(2, 10);
  private sequence = 0;

  constructor(options: RedisQuotaOptions) {
    this.client = options.client;
    this.base = assertPolicy("base", options.base, "quota");
    this.policies = {};
    for (const dimension of RATE_LIMIT_DIMENSIONS) {
      const policy = options.policies?.[dimension];
      if (policy === undefined) continue;
      // The same validator the in-process limiter uses, so a policy that is
      // rejected one way is rejected the other way too.
      this.policies[dimension] = assertPolicy(dimension, policy, "quota");
    }
    // Deterministic precedence: the declared order, base last — identical to
    // QuotaRateLimiter, so switching stores cannot change which budget reports a
    // refusal.
    this.order = RATE_LIMIT_DIMENSIONS.filter((dimension) => this.policies[dimension] !== undefined);
    this.prefix = options.prefix ?? "remembra:quota:";
    this.now = options.now ?? Date.now;
  }

  /** The effective policy set, for reporting and tests. */
  get configured(): { base: QuotaPolicy; dimensions: RateLimitDimension[] } {
    return { base: this.base, dimensions: [...this.order] };
  }

  /**
   * The keys charged for one request, in precedence order, base last.
   *
   * Only dimensions the request actually carries are charged, matching
   * `QuotaRateLimiter.charged`. A dimension the host did not resolve cannot be
   * charged, and the base budget already covers that request — evaluating it per
   * absent dimension would multiply a single request's charge by the number of
   * configured dimensions it happens to be missing.
   */
  private plan(identity: RateLimitIdentity): { dimension: RateLimitDimension; policy: QuotaPolicy; key: string }[] {
    const plan: { dimension: RateLimitDimension; policy: QuotaPolicy; key: string }[] = [];
    for (const dimension of this.order) {
      const value = identity.dimensions[dimension];
      if (value === undefined) continue;
      plan.push({ dimension, policy: this.policies[dimension]!, key: `${this.prefix}${dimension}=${value}` });
    }
    plan.push({ dimension: "global", policy: this.base, key: `${this.prefix}base=${identity.key}` });
    return plan;
  }

  /**
   * A sorted-set member unique per charge.
   *
   * Uniqueness matters: `ZADD` on a duplicate score/member *overwrites*, so two
   * requests in the same millisecond sharing a member would collapse into one
   * and the second would be invisible to the limit. The per-instance tag makes
   * cross-process collisions impossible, and the counter makes them impossible
   * within a process.
   */
  private member(now: number): string {
    return `${this.instanceTag}:${++this.sequence}:${now}`;
  }

  async check(identity: RateLimitIdentity): Promise<RateLimitResult> {
    return this.evaluate(identity, QUOTA_CHECK_SCRIPT, false);
  }

  async consume(identity: RateLimitIdentity): Promise<RateLimitResult> {
    return this.evaluate(identity, QUOTA_SCRIPT, true);
  }

  async reset(identity: RateLimitIdentity): Promise<void> {
    for (const entry of this.plan(identity)) await this.client.del(entry.key);
  }

  private async evaluate(
    identity: RateLimitIdentity,
    script: string,
    charge: boolean,
  ): Promise<RateLimitResult> {
    const now = this.now();
    const plan = this.plan(identity);
    const raw = (await this.client.eval(script, {
      keys: plan.map((entry) => entry.key),
      arguments: [
        String(now),
        this.member(now),
        ...plan.flatMap((entry) => [String(entry.policy.limit), String(entry.policy.windowMs)]),
      ],
    })) as number[];
    const allowed = Number(raw?.[0]) === 1;
    // Index 0 is unused on the allowed path; on a denial the script returns the
    // 1-based position of the first dimension that refused, which is the one that
    // decides the answer.
    const entry = plan[Math.max(0, Number(raw?.[1] ?? 1) - 1)] ?? plan[plan.length - 1]!;
    return {
      allowed,
      remaining: allowed ? Math.max(0, Number(raw?.[2] ?? 0)) : 0,
      retryAfterMs: allowed ? 0 : Number(raw?.[3] ?? 0),
      limit: entry.policy.limit,
      windowMs: entry.policy.windowMs,
      dimension: entry.dimension,
    };
  }
}

/**
 * Connect only if shared state is configured. Returns `undefined` when
 * `REMEMBRA_REDIS_URL` is unset, so a single-host deployment performs no Redis
 * work and imports no Redis code at all.
 */
export async function connectSharedState(
  env: NodeJS.ProcessEnv = process.env,
  importer?: (specifier: string) => Promise<Record<string, unknown>>,
): Promise<RedisConnection | undefined> {
  const url = parseRedisUrl(env[REDIS_DISTRIBUTED_URL]);
  if (!url) return undefined;
  const connection = await loadRedis(url, importer);
  logEvent("info", "redis.connected", { rediss: url.startsWith("rediss://") });
  return connection;
}
