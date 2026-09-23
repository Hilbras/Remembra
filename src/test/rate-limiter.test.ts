import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../rate-limiter.js";

test("rate-limiter: allows requests within the limit", () => {
  const rl = new RateLimiter({ limit: 5, windowMs: 1000 });
  for (let i = 0; i < 5; i++) {
    const r = rl.check("key-1");
    assert.ok(r.allowed, `request ${i + 1} should be allowed`);
  }
});

test("rate-limiter: rejects requests over the limit", () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
  rl.check("key-a");
  rl.check("key-a");
  rl.check("key-a");
  const r = rl.check("key-a");
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterMs > 0, true);
});

test("rate-limiter: separate keys are independent", () => {
  const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
  rl.check("x");
  rl.check("x");
  assert.equal(rl.check("x").allowed, false);
  assert.equal(rl.check("y").allowed, true);
});

test("rate-limiter: window expires after windowMs", async () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 50 });
  rl.check("k");
  assert.equal(rl.check("k").allowed, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rl.check("k").allowed, true);
});

test("rate-limiter: remaining count is accurate", () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
  assert.equal(rl.check("k").remaining, 2);
  assert.equal(rl.check("k").remaining, 1);
  assert.equal(rl.check("k").remaining, 0);
});

test("rate-limiter: clear resets state", () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  rl.check("k");
  assert.equal(rl.check("k").allowed, false);
  rl.clear();
  assert.equal(rl.check("k").allowed, true);
});
