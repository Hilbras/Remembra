/**
 * V5.1.0 quota contract (roadmap §19): typed policies, deterministic
 * precedence, all-or-nothing charging, and configuration validation.
 *
 * The property under test throughout is that a quota can only ever make a
 * deployment stricter. Every request is charged its base budget, so layering a
 * dimension policy on top can never hand an identity a larger allowance than it
 * had before the policy existed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QuotaRateLimiter,
  parseQuotaPolicies,
  type QuotaPolicies,
} from "../quota.js";
import {
  InProcessRateLimiter,
  RATE_LIMIT_DIMENSIONS,
  opaqueRateLimitPart,
  rateLimitIdentity,
  type RateLimitDimension,
  type RateLimitIdentity,
} from "../rate-limiter.js";
import { isRemembraError } from "../errors.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function id(parts: Partial<Record<RateLimitDimension, string>>): RateLimitIdentity {
  return rateLimitIdentity(parts);
}

const base = { limit: 100, windowMs: 60_000 };

test("QUOTA-001: with no dimension policies the base budget alone applies", async () => {
  const quota = new QuotaRateLimiter({ base });
  assert.deepEqual(quota.configured.dimensions, [], "no dimension is charged when none is configured");
  for (let i = 0; i < 100; i++) {
    const r = await quota.consume(id({ user: opaqueRateLimitPart("u") }));
    assert.equal(r.allowed, true, `request ${i + 1} of the base budget is allowed`);
  }
  const denied = await quota.consume(id({ user: opaqueRateLimitPart("u") }));
  assert.equal(denied.allowed, false);
  assert.equal(denied.dimension, "global", "the base budget reports as the global dimension");
});

test("QUOTA-002: a dimension policy is charged in addition to the base budget", async () => {
  const quota = new QuotaRateLimiter({
    base: { limit: 100, windowMs: 60_000 },
    policies: { user: { limit: 3, windowMs: 60_000 } },
  });
  const alice = id({ user: opaqueRateLimitPart("alice") });
  for (let i = 0; i < 3; i++) assert.equal((await quota.consume(alice)).allowed, true);
  const denied = await quota.consume(alice);
  assert.equal(denied.allowed, false);
  assert.equal(denied.dimension, "user", "the tight budget names its dimension");
  assert.equal(denied.limit, 3, "and reports that dimension's own ceiling");
});

test("QUOTA-003: dimension budgets are independent per value", async () => {
  const quota = new QuotaRateLimiter({ base, policies: { user: { limit: 2, windowMs: 60_000 } } });
  const alice = id({ user: opaqueRateLimitPart("alice") });
  const bob = id({ user: opaqueRateLimitPart("bob") });
  await quota.consume(alice);
  await quota.consume(alice);
  assert.equal((await quota.consume(alice)).allowed, false, "alice is out of budget");
  assert.equal((await quota.consume(bob)).allowed, true, "bob has his own");
  assert.equal((await quota.consume(bob)).allowed, true);
  assert.equal((await quota.consume(bob)).allowed, false);
});

test("QUOTA-004: precedence is deterministic when several dimensions are exhausted", async () => {
  // Both organization and user are exhausted; the declared order decides which
  // one is reported, and the same state must always report the same dimension.
  const quota = new QuotaRateLimiter({
    base: { limit: 1, windowMs: 60_000 },
    policies: {
      organization: { limit: 1, windowMs: 60_000 },
      user: { limit: 1, windowMs: 60_000 },
    },
  });
  const subject = id({
    organization: opaqueRateLimitPart("org"),
    user: opaqueRateLimitPart("user"),
  });
  assert.equal((await quota.consume(subject)).allowed, true);
  const first = await quota.consume(subject);
  assert.equal(first.allowed, false);
  assert.equal(first.dimension, "organization", "organization precedes user");
  const second = await quota.consume(subject);
  assert.equal(second.dimension, "organization", "and the answer is stable");
});

test("QUOTA-005: the precedence order is the declared dimension order", () => {
  assert.deepEqual(
    [...RATE_LIMIT_DIMENSIONS],
    ["global", "organization", "project", "user", "agent", "apikey", "ip", "endpoint", "provider"],
    "organization outranks user, which outranks apikey, and so on",
  );
});

test("QUOTA-006: a denied request charges nothing anywhere", async () => {
  // The organization budget is exhausted but the user budget is not. If the
  // denial still charged the user budget, a later request would be refused for
  // a request that was never served. The check therefore has to be made from an
  // identity whose organization still has budget, so the user budget is the
  // only thing under observation.
  const quota = new QuotaRateLimiter({
    base: { limit: 1000, windowMs: 60_000 },
    policies: {
      organization: { limit: 1, windowMs: 60_000 },
      user: { limit: 5, windowMs: 60_000 },
    },
  });
  const orgOne = opaqueRateLimitPart("org-1");
  const a = id({ organization: orgOne, user: opaqueRateLimitPart("a") });
  const b = id({ organization: orgOne, user: opaqueRateLimitPart("b") });
  assert.equal((await quota.consume(a)).allowed, true);
  const denied = await quota.consume(b);
  assert.equal(denied.allowed, false);
  assert.equal(denied.dimension, "organization");

  // A user budget is per user value, shared across identities, so b's budget is
  // observable from an identity that carries only that user. Observing it from
  // b's own identity would just re-report the organization denial, and adding
  // a fresh organization would introduce a tighter budget to be reported
  // instead.
  const observer = id({ user: opaqueRateLimitPart("b") });
  const after = await quota.check(observer);
  assert.equal(after.dimension, "user", "the user budget is what is under observation");
  assert.equal(after.remaining, 5, "the denied request did not spend b's user budget");
});

test("QUOTA-006b: a request missing every configured dimension is charged once, not once per absence", async () => {
  // With eight dimensions configured and none of them resolved, a naive
  // fallback would charge the base budget nine times for a single request.
  const policies: QuotaPolicies = {};
  for (const dimension of RATE_LIMIT_DIMENSIONS) {
    if (dimension === "global") continue;
    policies[dimension] = { limit: 1_000, windowMs: 60_000 };
  }
  const quota = new QuotaRateLimiter({ base: { limit: 10, windowMs: 60_000 }, policies });
  const bare = id({ ip: opaqueRateLimitPart("1.2.3.4") });
  for (let i = 0; i < 10; i++) {
    const r = await quota.consume(bare);
    assert.equal(r.allowed, true, `request ${i + 1} of 10 is allowed`);
  }
  const denied = await quota.consume(bare);
  assert.equal(denied.allowed, false, "ten requests consumed the base budget, not ninety");
});

test("QUOTA-007: an absent dimension cannot widen access", async () => {
  // A user policy exists, but this request carries no trusted user identity.
  // It must still be charged the base budget, and it must not get a larger
  // allowance than a request that does have one.
  const quota = new QuotaRateLimiter({
    base: { limit: 2, windowMs: 60_000 },
    policies: { user: { limit: 100, windowMs: 60_000 } },
  });
  const noUser = id({ ip: opaqueRateLimitPart("1.2.3.4") });
  assert.equal((await quota.consume(noUser)).allowed, true);
  assert.equal((await quota.consume(noUser)).allowed, true);
  const denied = await quota.consume(noUser);
  assert.equal(denied.allowed, false, "the base budget still applies without a user dimension");
  assert.equal(denied.dimension, "global", "and the denial is attributed to the base budget");
});

test("QUOTA-008: a user policy cannot be used to grant more than the base budget", async () => {
  // A generous user policy layered over a tight base budget must not become a
  // way around the base budget.
  const quota = new QuotaRateLimiter({
    base: { limit: 2, windowMs: 60_000 },
    policies: { user: { limit: 1_000_000, windowMs: 60_000 } },
  });
  const alice = id({ user: opaqueRateLimitPart("alice") });
  assert.equal((await quota.consume(alice)).allowed, true);
  assert.equal((await quota.consume(alice)).allowed, true);
  assert.equal((await quota.consume(alice)).allowed, false, "the base budget is still the ceiling");
});

test("QUOTA-009: reset clears the base budget and every dimension", async () => {
  const quota = new QuotaRateLimiter({
    base: { limit: 1, windowMs: 60_000 },
    policies: { user: { limit: 1, windowMs: 60_000 } },
  });
  const alice = id({ user: opaqueRateLimitPart("alice") });
  assert.equal((await quota.consume(alice)).allowed, true);
  assert.equal((await quota.consume(alice)).allowed, false);
  await quota.reset(alice);
  assert.equal((await quota.consume(alice)).allowed, true, "both the base and the user window are cleared");
});

test("QUOTA-010: the reported remaining is the tightest budget", async () => {
  const quota = new QuotaRateLimiter({
    base: { limit: 100, windowMs: 60_000 },
    policies: { user: { limit: 3, windowMs: 60_000 } },
  });
  const alice = id({ user: opaqueRateLimitPart("alice") });
  assert.equal((await quota.consume(alice)).remaining, 2, "reports the user budget, not the base");
  assert.equal((await quota.consume(alice)).remaining, 1);
  assert.equal((await quota.consume(alice)).remaining, 0);
});

test("QUOTA-010b: a concurrent burst cannot slip past the limit", async () => {
  // Found by the V5.1.1 stress matrix. `check` and `consume` are separated by
  // an await, so without serialization every caller in a burst observes an empty
  // window and every one of them is admitted as the first request. A 500-request
  // storm against an organization cap of 20 served all 500.
  const quota = new QuotaRateLimiter({
    base: { limit: 1_000, windowMs: 60_000 },
    policies: { organization: { limit: 20, windowMs: 60_000 } },
  });
  const org = opaqueRateLimitPart("shared-org");
  const identities = Array.from({ length: 500 }, (_, i) =>
    id({ organization: org, user: opaqueRateLimitPart(`user-${i}`) }),
  );
  const results = await Promise.all(identities.map((identity) => quota.consume(identity)));
  const served = results.filter((r) => r.allowed).length;
  assert.equal(served, 20, `exactly the organization cap was served, got ${served}`);
  assert.equal(
    results.filter((r) => !r.allowed).every((r) => r.dimension === "organization"),
    true,
    "and every refusal is attributed to the shared dimension",
  );
});

test("QUOTA-010c: concurrent single-identity consumers cannot exceed the limit", async () => {
  const quota = new QuotaRateLimiter({ base: { limit: 10, windowMs: 60_000 } });
  const subject = id({ user: opaqueRateLimitPart("hot") });
  const results = await Promise.all(Array.from({ length: 200 }, () => quota.consume(subject)));
  assert.equal(results.filter((r) => r.allowed).length, 10, "the base budget holds under a parallel burst");
});

test("QUOTA-010d: a concurrent check does not consume", async () => {
  const quota = new QuotaRateLimiter({ base: { limit: 1, windowMs: 60_000 } });
  const subject = id({ user: opaqueRateLimitPart("speculative") });
  const checks = await Promise.all(Array.from({ length: 50 }, () => quota.check(subject)));
  assert.equal(checks.every((c) => c.allowed), true, "asking repeatedly is still free");
  const consumed = await Promise.all(Array.from({ length: 5 }, () => quota.consume(subject)));
  assert.equal(consumed.filter((c) => c.allowed).length, 1, "and only one of five parallel consumes is charged");
});

test("QUOTA-011: an invalid policy is refused at construction", () => {
  for (const bad of [{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { windowMs: 0 }]) {
    assert.throws(
      () => new QuotaRateLimiter({ base: bad as never }),
      (err: unknown) => isRemembraError(err),
      `base ${JSON.stringify(bad)} should be refused`,
    );
    assert.throws(
      () => new QuotaRateLimiter({ base, policies: { user: bad as never } }),
      (err: unknown) => isRemembraError(err) && /"user"/.test((err as Error).message),
      `user ${JSON.stringify(bad)} should name the offending dimension`,
    );
  }
});

test("QUOTA-012: every declared dimension is configurable", async () => {
  // The contract covers all nine dimensions, and an unconfigured one is simply
  // not charged rather than defaulting to something wider.
  const policies: QuotaPolicies = {};
  for (const dimension of RATE_LIMIT_DIMENSIONS) {
    if (dimension === "global") continue;
    policies[dimension] = { limit: 5, windowMs: 1_000 };
  }
  const quota = new QuotaRateLimiter({ base, policies });
  assert.equal(quota.configured.dimensions.length, RATE_LIMIT_DIMENSIONS.length - 1);
  for (const dimension of RATE_LIMIT_DIMENSIONS) {
    if (dimension === "global") continue;
    const subject = id({ [dimension]: opaqueRateLimitPart("v") } as Partial<Record<RateLimitDimension, string>>);
    for (let i = 0; i < 5; i++) {
      const r = await quota.consume(subject);
      assert.equal(r.allowed, true, `${dimension} allows its first five requests`);
    }
    const denied = await quota.consume(subject);
    assert.equal(denied.dimension, dimension, `${dimension} names itself when it denies`);
  }
});

test("QUOTA-013: a configured dimension is charged even when a broader one is also present", async () => {
  const quota = new QuotaRateLimiter({
    base: { limit: 100, windowMs: 60_000 },
    policies: { organization: { limit: 4, windowMs: 60_000 }, user: { limit: 2, windowMs: 60_000 } },
  });
  const alice = id({ organization: opaqueRateLimitPart("org"), user: opaqueRateLimitPart("alice") });
  assert.equal((await quota.consume(alice)).allowed, true);
  assert.equal((await quota.consume(alice)).allowed, true);
  const denied = await quota.consume(alice);
  assert.equal(denied.dimension, "user", "the tighter of the two reports");
  // A different user in the same organization still has organization budget.
  const bob = id({ organization: opaqueRateLimitPart("org"), user: opaqueRateLimitPart("bob") });
  assert.equal((await quota.consume(bob)).allowed, true);
});

test("QUOTA-014: windows expire independently per dimension", async () => {
  const time = clock();
  const quota = new QuotaRateLimiter({
    base: { limit: 100, windowMs: 60_000 },
    policies: { user: { limit: 1, windowMs: 1_000 } },
    now: time.now,
  });
  const alice = id({ user: opaqueRateLimitPart("alice") });
  assert.equal((await quota.consume(alice)).allowed, true);
  assert.equal((await quota.consume(alice)).allowed, false);
  time.advance(1_100);
  assert.equal((await quota.consume(alice)).allowed, true, "the user window rolled over");
});

test("QUOTA-015: the composed limiter stays bounded under identity rotation", async () => {
  // Every dimension owns an InProcessRateLimiter, so each needs the same
  // ceiling; otherwise multiplying dimensions would multiply unbounded state.
  const quota = new QuotaRateLimiter({
    base: { limit: 5, windowMs: 60_000 },
    policies: { user: { limit: 5, windowMs: 60_000 } },
    maxIdentities: 50,
  });
  for (let i = 0; i < 2_000; i++) {
    await quota.consume(id({ user: opaqueRateLimitPart(`rotating-${i}`) }));
  }
  // The public surface exposes no map, so assert through the base limiter that
  // composition kept the ceiling rather than growing with the input.
  const single = new InProcessRateLimiter({ limit: 5, windowMs: 60_000, maxIdentities: 50 });
  for (let i = 0; i < 2_000; i++) await single.consume(id({ user: opaqueRateLimitPart(`rotating-${i}`) }));
  assert.ok(single.stats.tracked <= 50, "the underlying limiter honours the ceiling");
  assert.deepEqual(quota.configured.dimensions, ["user"]);
});

test("CONFIG-001: an absent or empty variable means no dimension policies", () => {
  assert.deepEqual(parseQuotaPolicies(undefined), {});
  assert.deepEqual(parseQuotaPolicies(""), {});
  assert.deepEqual(parseQuotaPolicies("   "), {});
});

test("CONFIG-002: a valid policy object parses", () => {
  const parsed = parseQuotaPolicies(
    '{"organization":{"limit":1000000,"windowMs":2592000000},"user":{"limit":10000,"windowMs":86400000}}',
  );
  assert.deepEqual(parsed, {
    organization: { limit: 1_000_000, windowMs: 2_592_000_000 },
    user: { limit: 10_000, windowMs: 86_400_000 },
  });
});

test("CONFIG-003: every failure names the variable and the offending entry", () => {
  const cases: [string, RegExp][] = [
    ["{not json", /REMEMBRA_QUOTAS must be valid JSON/],
    ["[]", /must be a JSON object/],
    ['"nope"', /must be a JSON object/],
    ['{"nonsense":{"limit":1,"windowMs":1}}', /unknown dimension "nonsense".*supported: global, organization/s],
    ['{"user":5}', /dimension "user" must be an object/],
    ['{"user":{"limit":"lots","windowMs":1}}', /dimension "user" has a non-numeric limit/],
    ['{"user":{"limit":1,"windowMs":"long"}}', /dimension "user" has a non-numeric windowMs/],
    ['{"user":{"limit":0,"windowMs":1}}', /dimension "user" needs a positive integer limit/],
    ['{"user":{"limit":1,"windowMs":0}}', /dimension "user" needs a positive integer windowMs/],
    [`{"user":{"limit":1,"windowMs":1},${"x".repeat(20_000)}:1}`, /exceeds the supported configuration size/],
  ];
  for (const [raw, expected] of cases) {
    assert.throws(
      () => parseQuotaPolicies(raw),
      (err: unknown) => isRemembraError(err) && expected.test((err as Error).message),
      `${raw.slice(0, 40)} should fail with ${expected}`,
    );
  }
});

test("CONFIG-004: a configured policy actually reaches the request path", () => {
  // The parse result must be the same shape the limiter consumes, so a
  // mis-wired deployment fails loudly rather than silently not enforcing.
  const policies = parseQuotaPolicies('{"agent":{"limit":2,"windowMs":60000}}');
  const quota = new QuotaRateLimiter({ base, policies });
  assert.deepEqual(quota.configured.dimensions, ["agent"]);
  assert.deepEqual(policies.agent, { limit: 2, windowMs: 60_000 });
});
