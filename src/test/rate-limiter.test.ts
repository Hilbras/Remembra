import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InProcessRateLimiter,
  opaqueRateLimitPart,
  rateLimitIdentity,
  type RateLimitIdentity,
} from "../rate-limiter.js";
import { isRemembraError } from "../errors.js";

/** A deterministic clock, so window and sweep behaviour is reproducible. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function id(parts: Record<string, string>): RateLimitIdentity {
  return rateLimitIdentity(parts as Parameters<typeof rateLimitIdentity>[0]);
}

test("rate-limiter: allows requests within the limit", async () => {
  const rl = new InProcessRateLimiter({ limit: 5, windowMs: 1000 });
  const identity = id({ user: opaqueRateLimitPart("key-1") });
  for (let i = 0; i < 5; i++) {
    const r = await rl.consume(identity);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
});

test("rate-limiter: rejects requests over the limit", async () => {
  const rl = new InProcessRateLimiter({ limit: 3, windowMs: 1000 });
  const identity = id({ user: opaqueRateLimitPart("key-a") });
  await rl.consume(identity);
  await rl.consume(identity);
  await rl.consume(identity);
  const r = await rl.consume(identity);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterMs > 0);
});

test("rate-limiter: separate identities are independent", async () => {
  const rl = new InProcessRateLimiter({ limit: 2, windowMs: 1000 });
  const x = id({ user: opaqueRateLimitPart("x") });
  const y = id({ user: opaqueRateLimitPart("y") });
  await rl.consume(x);
  await rl.consume(x);
  assert.equal((await rl.consume(x)).allowed, false);
  assert.equal((await rl.consume(y)).allowed, true);
});

test("rate-limiter: window expires after windowMs", async () => {
  const clock = fakeClock();
  const rl = new InProcessRateLimiter({ limit: 1, windowMs: 50, now: clock.now });
  const identity = id({ user: opaqueRateLimitPart("k") });
  await rl.consume(identity);
  assert.equal((await rl.consume(identity)).allowed, false);
  clock.advance(60);
  assert.equal((await rl.consume(identity)).allowed, true);
});

test("rate-limiter: remaining count is accurate", async () => {
  const rl = new InProcessRateLimiter({ limit: 3, windowMs: 1000 });
  const identity = id({ user: opaqueRateLimitPart("k") });
  assert.equal((await rl.consume(identity)).remaining, 2);
  assert.equal((await rl.consume(identity)).remaining, 1);
  assert.equal((await rl.consume(identity)).remaining, 0);
});

test("rate-limiter: reset clears one identity and leaves others alone", async () => {
  const rl = new InProcessRateLimiter({ limit: 1, windowMs: 1000 });
  const a = id({ user: opaqueRateLimitPart("a") });
  const b = id({ user: opaqueRateLimitPart("b") });
  await rl.consume(a);
  await rl.consume(b);
  assert.equal((await rl.consume(a)).allowed, false);
  await rl.reset(a);
  assert.equal((await rl.consume(a)).allowed, true, "reset identity is fresh");
  assert.equal((await rl.consume(b)).allowed, false, "other identity is untouched");
});

test("rate-limiter: clear resets all state", async () => {
  const rl = new InProcessRateLimiter({ limit: 1, windowMs: 1000 });
  const identity = id({ user: opaqueRateLimitPart("k") });
  await rl.consume(identity);
  assert.equal((await rl.consume(identity)).allowed, false);
  rl.clear();
  assert.equal((await rl.consume(identity)).allowed, true);
});

test("RL-001: check decides without charging", async () => {
  const rl = new InProcessRateLimiter({ limit: 2, windowMs: 1000 });
  const identity = id({ user: opaqueRateLimitPart("k") });
  // Asking repeatedly must not spend quota, or a caller could exhaust its own
  // limit just by asking whether it has any left.
  for (let i = 0; i < 10; i++) {
    const r = await rl.check(identity);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 2);
  }
  await rl.consume(identity);
  assert.equal((await rl.check(identity)).remaining, 1);
  await rl.consume(identity);
  assert.equal((await rl.check(identity)).allowed, false);
  // A rejected consume must not charge either.
  assert.equal((await rl.consume(identity)).allowed, false);
  assert.equal((await rl.check(identity)).allowed, false);
});

test("RL-002: tracked identities stay bounded under rotation", async () => {
  // The anonymous bucket is charged before authentication, so an unauthenticated
  // caller rotating source addresses reaches this path with no credential. The
  // pre-V5.1 limiter retained every such key forever.
  const rl = new InProcessRateLimiter({ limit: 5, windowMs: 60_000, maxIdentities: 100 });
  for (let i = 0; i < 5_000; i++) {
    await rl.consume(id({ ip: opaqueRateLimitPart(`rotating-${i}`) }));
  }
  const stats = rl.stats;
  assert.ok(stats.tracked <= 100, `tracked ${stats.tracked} identities, ceiling is 100`);
  assert.ok(stats.evicted > 0, "the ceiling actually engaged");
});

test("RL-003: an untouched expired identity is reclaimed", async () => {
  const clock = fakeClock();
  const rl = new InProcessRateLimiter({
    limit: 5,
    windowMs: 1_000,
    maxIdentities: 1_000,
    sweepEvery: 1,
    now: clock.now,
  });
  for (let i = 0; i < 50; i++) await rl.consume(id({ ip: opaqueRateLimitPart(`k-${i}`) }));
  assert.equal(rl.stats.tracked, 50);
  // Nothing revisits those identities; expiry alone has to reclaim them.
  clock.advance(5_000);
  await rl.consume(id({ ip: opaqueRateLimitPart("fresh") }));
  assert.equal(rl.stats.tracked, 1, "expired windows are swept, not accumulated");
});

test("RL-004: eviction is deterministic and least-recently-used", async () => {
  // limit 1 makes "was this identity's window preserved?" observable: a
  // surviving charged window reports remaining 0, a reclaimed one reports 1.
  // The ceiling is left with slack so that probing cannot itself cause an
  // eviction, and survivors are probed before the reclaimed identity.
  const runOnce = async () => {
    const rl = new InProcessRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxIdentities: 3,
      sweepEvery: 1_000_000,
    });
    const one = (name: string) => id({ user: opaqueRateLimitPart(name) });
    for (const name of ["a", "b", "c"]) assert.equal((await rl.consume(one(name))).allowed, true);
    // Overflowing the ceiling evicts the least recently used, which is a.
    assert.equal((await rl.consume(one("d"))).allowed, true);
    const evictedAfterOverflow = rl.stats.evicted;
    const survivors = {
      b: (await rl.check(one("b"))).remaining,
      c: (await rl.check(one("c"))).remaining,
      d: (await rl.check(one("d"))).remaining,
    };
    return { evictedAfterOverflow, survivors, a: (await rl.check(one("a"))).remaining };
  };
  const first = await runOnce();
  assert.equal(first.evictedAfterOverflow, 1, "exactly one window was reclaimed at the ceiling");
  assert.deepEqual(first.survivors, { b: 0, c: 0, d: 0 }, "every surviving window kept its charge");
  assert.equal(first.a, 1, "a was the least recently used and its window was reclaimed");
  assert.deepEqual(await runOnce(), first, "the same inputs evict the same identity");
});

test("RL-005: an identity must be opaque, never a raw principal", () => {
  assert.throws(
    () => rateLimitIdentity({ user: "alice@example.com" } as never),
    (err: unknown) => isRemembraError(err) && /opaque digest/.test((err as Error).message),
    "a raw value must fail loudly rather than be hashed quietly",
  );
  assert.throws(
    () => rateLimitIdentity({ apikey: "sk-live-abcdefghijklmnop" } as never),
    (err: unknown) => isRemembraError(err),
    "an API key must never become a quota identity value",
  );
  // An opaque digest of the same value is accepted.
  assert.doesNotThrow(() => rateLimitIdentity({ apikey: opaqueRateLimitPart("sk-live-abcdefghijklmnop") }));
});

test("RL-006: an absent dimension is visibly absent, and identities differ", () => {
  const withUser = rateLimitIdentity({ organization: opaqueRateLimitPart("org"), user: opaqueRateLimitPart("u") });
  const withoutUser = rateLimitIdentity({ organization: opaqueRateLimitPart("org") });
  assert.equal(withUser.key.includes("user="), true);
  assert.equal(withoutUser.key.includes("user="), false);
  assert.notEqual(withUser.key, withoutUser.key);
  // An identity with no dimensions at all still has a stable key.
  assert.equal(rateLimitIdentity({}).key, "global");
});

test("RL-007: dimensions compose, so a narrower identity is a distinct bucket", async () => {
  const rl = new InProcessRateLimiter({ limit: 1, windowMs: 1000 });
  const org = opaqueRateLimitPart("org-1");
  const alice = rateLimitIdentity({ organization: org, user: opaqueRateLimitPart("alice") });
  const bob = rateLimitIdentity({ organization: org, user: opaqueRateLimitPart("bob") });
  assert.equal((await rl.consume(alice)).allowed, true);
  assert.equal((await rl.consume(alice)).allowed, false);
  assert.equal((await rl.consume(bob)).allowed, true, "a different user has its own budget");
});

test("RL-008: an invalid configuration fails at construction, not at request time", () => {
  for (const bad of [{ limit: 0 }, { limit: 1.5 }, { windowMs: 0 }, { maxIdentities: 0 }, { sweepEvery: 0 }]) {
    assert.throws(
      () => new InProcessRateLimiter(bad as never),
      (err: unknown) => isRemembraError(err),
      `${JSON.stringify(bad)} should be refused`,
    );
  }
});

test("RL-009: the limiter exposes its own policy for reporting", async () => {
  const rl = new InProcessRateLimiter({ limit: 7, windowMs: 1234 });
  const r = await rl.consume(id({ user: opaqueRateLimitPart("k") }));
  assert.equal(r.limit, 7);
  assert.equal(r.windowMs, 1234);
});
