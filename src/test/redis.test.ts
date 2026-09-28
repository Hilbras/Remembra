/**
 * V5.6.0 Redis adapter (roadmap §26, plan T05).
 *
 * Two things are being verified here, and the split matters.
 *
 * **This file verifies the wiring**: which keys are charged, in what order, what
 * goes into the script's arguments, and how the reply maps back to a decision.
 * That is where the defects found while writing this were — dimension order taken
 * from the policies object rather than from `RATE_LIMIT_DIMENSIONS`, an absent
 * dimension charged against a key it should not have touched, and one window
 * shared by every dimension.
 *
 * **The Lua script bodies are verified separately**, by running the text shipped
 * in `src/redis.ts` through a real Lua 5.3 VM with a shim of the Redis commands
 * they use. A fake client cannot check a script's logic, so nothing here pretends
 * to: the reply is canned. What is checked is that the right script is called
 * with the right keys and arguments, and that the reply is read correctly.
 *
 * There is no Redis server in this environment, so **live Redis is untested**.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RedisLockProvider,
  RedisQuotaRateLimiter,
  connectSharedState,
  loadRedis,
  parseRedisUrl,
  REDIS_DISTRIBUTED_URL,
  type RedisLike,
} from "../redis.js";
import { QuotaRateLimiter } from "../quota.js";
import { opaqueRateLimitPart, rateLimitIdentity } from "../rate-limiter.js";
import { isRemembraError } from "../errors.js";

interface ScriptCall {
  script: string;
  keys: string[];
  arguments: string[];
}

const kind = (script: string): string => {
  if (script.includes("Pass two")) return "quota";
  if (script.includes("ZCOUNT")) return "check";
  if (script.includes("PEXPIRE")) return "renew";
  if (script.includes("DEL")) return "release";
  return "unknown";
};

class FakeRedis implements RedisLike {
  readonly calls: ScriptCall[] = [];
  readonly strings = new Map<string, string>();
  private readonly replies = new Map<string, unknown>();
  connectCalls = 0;
  quitCalls = 0;
  failConnect = false;

  reply(name: string, value: unknown): this {
    this.replies.set(name, value);
    return this;
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    this.calls.push({ script, keys: options.keys, arguments: options.arguments });
    const name = kind(script);
    if (!this.replies.has(name)) throw new Error(`fake has no reply canned for "${name}"`);
    return this.replies.get(name);
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<string | null> {
    if (options?.NX && this.strings.has(key)) return null;
    this.strings.set(key, value);
    if (options?.PX !== undefined) this.strings.set(`${key}#ttl`, String(options.PX));
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async quit(): Promise<unknown> {
    this.quitCalls++;
    return "OK";
  }

  /** The keys of the most recent call of one kind. */
  lastKeys(name: string): string[] {
    const call = [...this.calls].reverse().find((entry) => kind(entry.script) === name);
    assert.ok(call, `no ${name} call was made`);
    return call.keys;
  }

  lastArgs(name: string): string[] {
    const call = [...this.calls].reverse().find((entry) => kind(entry.script) === name);
    assert.ok(call, `no ${name} call was made`);
    return call.arguments;
  }

  countOf(name: string): number {
    return this.calls.filter((entry) => kind(entry.script) === name).length;
  }
}

const base = { limit: 100, windowMs: 60_000 };

// --- URL and package loading ---------------------------------------------

test("REDIS-001: an unset or empty URL means single-host, and a bad scheme is rejected", () => {
  assert.equal(parseRedisUrl(undefined), undefined, "absent means no shared state");
  assert.equal(parseRedisUrl(""), undefined);
  assert.equal(parseRedisUrl("   "), undefined);
  assert.equal(parseRedisUrl("redis://cache:6379"), "redis://cache:6379");
  assert.equal(parseRedisUrl(" rediss://cache:6379 "), "rediss://cache:6379", "trims, and TLS is allowed");
  assert.throws(
    () => parseRedisUrl("http://cache:6379"),
    (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
    "a non-Redis scheme is a configuration error, not a silent fallback",
  );
});

test("REDIS-002: with the variable unset, no Redis code is imported and no client is built", async () => {
  let imported = false;
  const connection = await connectSharedState({}, async () => {
    imported = true;
    return {};
  });
  assert.equal(connection, undefined);
  assert.equal(imported, false, "a single-host deployment must not reach the optional package at all");
});

test("REDIS-003: the variable set with the package absent fails startup, naming the remedy", async () => {
  // Real, not simulated: `redis` is not a dependency of this package, so the
  // default importer genuinely cannot resolve it. The specifier goes through a
  // variable so the compiler does not try to resolve it either.
  const specifier = "redis";
  assert.equal(
    await import(/* @vite-ignore */ specifier).then(() => true, () => false),
    false,
    "redis is genuinely not installed here",
  );
  await assert.rejects(
    () => loadRedis("redis://cache:6379"),
    (error: unknown) =>
      isRemembraError(error) &&
      error.code === "SERVICE_UNAVAILABLE" &&
      /npm install redis/.test(error.message) &&
      new RegExp(`unset ${REDIS_DISTRIBUTED_URL}`).test(error.message),
    "the operator is told both how to fix it and how to opt out",
  );
});

test("REDIS-004: a module without createClient fails rather than returning an unusable client", async () => {
  await assert.rejects(
    () => loadRedis("redis://cache:6379", async () => ({ somethingElse: true })),
    (error: unknown) => isRemembraError(error) && /does not expose createClient/.test(error.message),
  );
});

test("REDIS-005: a connection failure is fatal, never a quiet downgrade to local state", async () => {
  // Split-brain that looks healthy is the failure mode this exists to prevent: a
  // deployment that asked for a shared budget and silently got a per-instance one
  // would report a limit it is not enforcing.
  const client = new FakeRedis();
  client.failConnect = true;
  await assert.rejects(
    () =>
      loadRedis("redis://cache:6379", async () => ({
        createClient: () => ({
          ...client,
          connect: async () => {
            throw new Error("ECONNREFUSED 10.0.0.7:6379");
          },
        }),
      })),
    (error: unknown) =>
      isRemembraError(error) &&
      error.code === "SERVICE_UNAVAILABLE" &&
      /refusing to run with per-instance state/.test(error.message),
  );
});

test("REDIS-006: redis is an optional peer and not a runtime dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  assert.equal(manifest.dependencies.redis, undefined, "a fifth runtime dependency is not permitted");
  assert.equal(
    manifest.devDependencies.redis,
    undefined,
    "not even a devDependency: keeping it uninstalled is what makes REDIS-003 a real test",
  );
  assert.equal(manifest.peerDependencies?.redis, ">=4", "declared so a resolver can find it");
  assert.equal(
    manifest.peerDependenciesMeta?.redis?.optional,
    true,
    "optional, so an installation without it is not an error",
  );
});

// --- Locking --------------------------------------------------------------

test("REDIS-007: acquiring a lease is one atomic create-with-expiry", async () => {
  const client = new FakeRedis();
  const provider = new RedisLockProvider(client);
  const handle = await provider.acquire("maintenance", { leaseMs: 5_000, owner: "a" });
  assert.deepEqual(handle.info, { key: "maintenance", owner: "a", expiresAt: handle.info.expiresAt });
  assert.equal(client.strings.get("remembra:lock:maintenance"), "a");
  assert.equal(
    client.strings.get("remembra:lock:maintenance#ttl"),
    "5000",
    "NX and PX together: there is no window where a lock exists without an expiry",
  );
  const live = await provider.inspect("maintenance");
  assert.equal(live?.owner, "a");
  assert.equal(await provider.inspect("absent"), undefined);
});

test("REDIS-008: contention is refused and names the holder", async () => {
  const client = new FakeRedis();
  client.strings.set("remembra:lock:shared", "holder-b");
  const provider = new RedisLockProvider(client);
  await assert.rejects(
    () => provider.acquire("shared", { owner: "a" }),
    (error: unknown) =>
      (error as { code?: string }).code === "LOCK_TIMEOUT" &&
      /held by holder-b/.test((error as Error).message),
  );
});

test("REDIS-009: renew and release are owner-checked by the server, not by the caller", async () => {
  const client = new FakeRedis();
  const provider = new RedisLockProvider(client);
  const handle = await provider.acquire("k", { owner: "a", leaseMs: 1_000 });
  client.reply("renew", 1);
  client.reply("release", 1);
  assert.equal(await handle.renew(), true);
  assert.deepEqual(client.lastArgs("renew"), ["a", "1000"], "the owner is the argument, so the server compares it");
  assert.equal(await handle.release(), true);
  assert.deepEqual(client.lastArgs("release"), ["a"]);
  // A peer that reclaimed and re-took the lease must not be cleared by our
  // release, so the release cannot be a bare DEL.
  client.reply("release", 0);
  assert.equal(await handle.release(), false, "a refused release is reported, not assumed");
});

// --- Quota wiring ---------------------------------------------------------

test("REDIS-010: precedence follows the declared dimension order, not the policies object's order", () => {
  // Switching stores must not change which budget reports a refusal, so the order
  // cannot come from how the operator happened to write the config object.
  // Written apikey-first, which is the reverse of the declared order (user
  // precedes apikey in RATE_LIMIT_DIMENSIONS), so an implementation that trusted
  // the object's key order would produce a different answer here.
  const reversed = { apikey: { limit: 5, windowMs: 1_000 }, user: { limit: 5, windowMs: 1_000 } };
  const redis = new RedisQuotaRateLimiter({ client: new FakeRedis(), base, policies: reversed });
  const inProcess = new QuotaRateLimiter({ base, policies: reversed });
  assert.deepEqual(Object.keys(reversed), ["apikey", "user"], "the config object really is in the other order");
  assert.deepEqual(redis.configured.dimensions, ["user", "apikey"], "precedence is the declared order, base last");
  assert.deepEqual(redis.configured.dimensions, inProcess.configured.dimensions);
  assert.deepEqual(redis.configured.base, inProcess.configured.base);
});

test("REDIS-011: a dimension the request does not carry is not charged a key", async () => {
  const client = new FakeRedis().reply("quota", [1, 0, 4, 0]);
  const limiter = new RedisQuotaRateLimiter({
    client,
    base,
    policies: { organization: { limit: 10, windowMs: 1_000 }, user: { limit: 10, windowMs: 1_000 } },
  });
  const userOnly = rateLimitIdentity({ user: opaqueRateLimitPart("u1") });
  await limiter.consume(userOnly);
  assert.deepEqual(
    client.lastKeys("quota"),
    ["remembra:quota:user=" + userOnly.dimensions.user, "remembra:quota:base=" + userOnly.key],
    "only the dimension the request carries, plus the base budget",
  );
  const both = rateLimitIdentity({ user: opaqueRateLimitPart("u1"), organization: opaqueRateLimitPart("o1") });
  await limiter.consume(both);
  assert.deepEqual(
    client.lastKeys("quota"),
    [
      "remembra:quota:organization=" + both.dimensions.organization,
      "remembra:quota:user=" + both.dimensions.user,
      "remembra:quota:base=" + both.key,
    ],
    "a request carrying both is charged both, plus the base budget",
  );
});

test("REDIS-012: each dimension carries its own window into the script", async () => {
  // The defect this guards: one window shared by every dimension left a 60-per-
  // minute budget enforcing over the hour-long window of a neighbouring dimension,
  // so it read as configured and behaved as 60 per hour.
  const client = new FakeRedis().reply("quota", [1, 0, 4, 0]);
  const limiter = new RedisQuotaRateLimiter({
    client,
    base,
    policies: { user: { limit: 5, windowMs: 60_000 }, organization: { limit: 50, windowMs: 3_600_000 } },
  });
  const identity = rateLimitIdentity({ user: opaqueRateLimitPart("u1"), organization: opaqueRateLimitPart("o1") });
  await limiter.consume(identity);
  const args = client.lastArgs("quota");
  // [now, member, then (limit, window) per key]. The config above is written
  // user-first but the keys come out organization-first, which is the declared
  // precedence order — so this also re-checks REDIS-010.
  assert.deepEqual(
    client.lastKeys("quota").map((key) => key.split(":").pop()),
    ["organization=" + identity.dimensions.organization, "user=" + identity.dimensions.user, `base=${identity.key}`],
  );
  assert.deepEqual(args.slice(2), ["50", "3600000", "5", "60000", "100", "60000"]);
  assert.equal(args.length, 2 + 3 * 2, "now and member, then one (limit, window) pair per charged key");
});

test("REDIS-013: a refusal is attributed to the dimension that refused", async () => {
  const client = new FakeRedis();
  const limiter = new RedisQuotaRateLimiter({
    client,
    base,
    policies: { organization: { limit: 7, windowMs: 3_600_000 }, user: { limit: 9, windowMs: 60_000 } },
  });
  // The keys go out organization-first, so the script's 1-based index 1 is
  // organization: the refusal must be attributed to the dimension that refused,
  // not merely to whichever key happened to be first.
  client.reply("quota", [0, 1, 0, 1_800]);
  const refused = await limiter.consume(rateLimitIdentity({ user: opaqueRateLimitPart("u1"), organization: opaqueRateLimitPart("o1") }));
  assert.equal(refused.allowed, false);
  assert.equal(refused.dimension, "organization", "not merely the first key, but the refusing dimension");
  assert.equal(refused.limit, 7, "and its own limit, not a neighbour's");
  assert.equal(refused.windowMs, 3_600_000);
  assert.equal(refused.remaining, 0);
  assert.equal(refused.retryAfterMs, 1_800);
  // The base budget's own refusal still reports as the base budget, which is the
  // last key.
  client.reply("quota", [0, 3, 0, 42]);
  const byBase = await limiter.consume(rateLimitIdentity({ user: opaqueRateLimitPart("u1"), organization: opaqueRateLimitPart("o1") }));
  assert.equal(byBase.dimension, "global");
  assert.equal(byBase.limit, 100);
  assert.equal(byBase.windowMs, 60_000);
});

test("REDIS-014: an allowed reply reports the tightest remaining budget", async () => {
  const client = new FakeRedis().reply("quota", [1, 0, 2, 0]);
  const limiter = new RedisQuotaRateLimiter({
    client,
    base,
    policies: { organization: { limit: 7, windowMs: 60_000 } },
  });
  const allowed = await limiter.consume(rateLimitIdentity({ organization: opaqueRateLimitPart("o1") }));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.remaining, 2);
  assert.equal(allowed.retryAfterMs, 0, "an allowed request never carries a retry hint");
});

test("REDIS-015: policies are validated by the same function the in-process limiter uses", () => {
  const client = new FakeRedis();
  for (const policies of [
    { user: { limit: 0, windowMs: 1_000 } },
    { user: { limit: 5, windowMs: 0 } },
    { user: { limit: 1.5, windowMs: 1_000 } },
  ]) {
    assert.throws(
      () => new RedisQuotaRateLimiter({ client, base, policies }),
      (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
      `rejected: ${JSON.stringify(policies)}`,
    );
  }
  // And the base policy itself.
  assert.throws(
    () => new RedisQuotaRateLimiter({ client, base: { limit: 0, windowMs: 1_000 } }),
    (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
  );
  // The same input is rejected the same way by the in-process limiter, so
  // switching stores cannot change which configuration is accepted.
  for (const policies of [{ user: { limit: 0, windowMs: 1_000 } }, { user: { limit: 1.5, windowMs: 1_000 } }]) {
    assert.throws(() => new QuotaRateLimiter({ base, policies }), (error: unknown) => isRemembraError(error));
  }
});

test("REDIS-016: two limiters over one client charge the same budget", async () => {
  // The whole point of a shared store: two instances, one budget. Distinct
  // instances must produce the same keys or each would get its own budget.
  const client = new FakeRedis().reply("quota", [1, 0, 4, 0]);
  const a = new RedisQuotaRateLimiter({ client, base });
  const b = new RedisQuotaRateLimiter({ client, base });
  const identity = rateLimitIdentity({ user: opaqueRateLimitPart("u1") });
  await a.consume(identity);
  await b.consume(identity);
  assert.deepEqual(
    client.calls.map((call) => call.keys.join("|")),
    [client.calls[0]!.keys.join("|"), client.calls[0]!.keys.join("|")],
    "identical keys, so the second instance sees the first instance's charges",
  );
});

test("REDIS-017: sorted-set members never repeat, so no charge is silently overwritten", async () => {
  // ZADD on an existing member overwrites it, so two requests sharing a member
  // collapse into one and the second is invisible to the limit. Members must
  // therefore differ within an instance and across instances.
  const client = new FakeRedis().reply("quota", [1, 0, 4, 0]);
  const a = new RedisQuotaRateLimiter({ client, base, now: () => 1_000 });
  const b = new RedisQuotaRateLimiter({ client, base, now: () => 1_000 });
  const identity = rateLimitIdentity({ user: opaqueRateLimitPart("u1") });
  await a.consume(identity);
  await a.consume(identity);
  await b.consume(identity);
  const members = client.calls.map((call) => call.arguments[1]);
  assert.equal(new Set(members).size, 3, "three distinct members for three charges in the same millisecond");
});

test("REDIS-018: a check reads the same decision without spending it, and reset clears every key", async () => {
  const client = new FakeRedis().reply("check", [1, 0, 9, 0]).reply("quota", [1, 0, 4, 0]);
  const limiter = new RedisQuotaRateLimiter({
    client,
    base,
    policies: { user: { limit: 10, windowMs: 1_000 } },
  });
  const identity = rateLimitIdentity({ user: opaqueRateLimitPart("u1") });
  const checked = await limiter.check(identity);
  assert.equal(checked.allowed, true);
  assert.equal(checked.remaining, 9);
  assert.equal(client.countOf("quota"), 0, "a check must not call the charging script");
  await limiter.consume(identity);
  assert.equal(client.countOf("quota"), 1);

  const deleted: string[] = [];
  const realDel = client.del.bind(client);
  client.del = async (key: string) => {
    deleted.push(key);
    return realDel(key);
  };
  await limiter.reset(identity);
  assert.deepEqual(deleted, client.lastKeys("quota"), "reset clears exactly the keys that were charged");
});
