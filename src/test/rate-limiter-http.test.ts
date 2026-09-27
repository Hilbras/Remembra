/**
 * HTTP parity for the V5.1.0 rate limiter.
 *
 * The limiter was replaced behind an interface, so these tests pin the two
 * things that must not move: authentication still precedes any charge, and the
 * server still answers 429 with a retry hint when a budget is exhausted. The
 * injected-limiter tests additionally pin that the request path depends on the
 * interface and not on a concrete implementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createTenantContext } from "../tenant.js";
import {
  InProcessRateLimiter,
  type RateLimitIdentity,
  type RateLimitResult,
  type RateLimiter,
} from "../rate-limiter.js";
import type { TenantContext } from "../tenant.js";

async function makeService(): Promise<{ service: MemoryService; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-rl-http-"));
  return { service: new MemoryService(new MemoryStore(root), { embeddingProvider: "none" }), root };
}

function withEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A limiter that records what it was asked and answers from a script. */
class RecordingRateLimiter implements RateLimiter {
  readonly seen: RateLimitIdentity[] = [];
  constructor(
    private readonly answer: (identity: RateLimitIdentity) => RateLimitResult,
    private readonly name: string,
  ) {}
  async check(identity: RateLimitIdentity): Promise<RateLimitResult> {
    return { ...this.answer(identity), limit: 0, windowMs: 0 };
  }
  async consume(identity: RateLimitIdentity): Promise<RateLimitResult> {
    this.seen.push(identity);
    return this.answer(identity);
  }
  async reset(identity: RateLimitIdentity): Promise<void> {
    this.seen.length = 0;
  }
  get called(): boolean {
    return this.seen.length > 0;
  }
  get label(): string {
    return this.name;
  }
}

async function start(
  service: MemoryService,
  options: Parameters<typeof createHttpServer>[1] = {},
): Promise<{ server: ReturnType<typeof createHttpServer>; base: string }> {
  const server = createHttpServer(service, { port: 0, host: "127.0.0.1", ...options });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${address.port}` };
}

const allow: RateLimitResult = { allowed: true, remaining: 59, retryAfterMs: 0, limit: 60, windowMs: 60_000 };
const deny: RateLimitResult = { allowed: false, remaining: 0, retryAfterMs: 1_500, limit: 60, windowMs: 60_000 };

test("RL-HTTP-001: the request path uses the injected limiter", async (t) => {
  const { service, root } = await makeService();
  const limiter = new RecordingRateLimiter(() => allow, "recording");
  const { server, base } = await start(service, { rateLimiter: limiter });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const res = await fetch(`${base}/memories`);
  assert.equal(res.status, 200);
  assert.equal(limiter.called, true, "the injected implementation, not a default one, made the decision");
});

test("RL-HTTP-002: a denied identity yields 429 with a retry hint", async (t) => {
  const { service, root } = await makeService();
  const limiter = new RecordingRateLimiter(() => deny, "denying");
  const { server, base } = await start(service, { rateLimiter: limiter });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const res = await fetch(`${base}/memories`);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "2", "retry hint survives the interface change");
  const body = (await res.json()) as { error: string; retryAfterMs: number };
  assert.match(body.error, /Rate limit/);
  assert.ok(body.retryAfterMs > 0);
});

test("RL-HTTP-003: authentication still precedes the protected charge", async (t) => {
  const { service, root } = await makeService();
  const limiter = new RecordingRateLimiter(() => allow, "recording");
  const { server, base } = await start(service, { apiKey: "parity-secret", rateLimiter: limiter });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const unauthorized = await fetch(`${base}/memories`);
  assert.equal(unauthorized.status, 401);
  const anonymousIdentity = limiter.seen.at(-1);
  assert.ok(anonymousIdentity, "the unauthenticated attempt is still charged somewhere");
  assert.equal(
    anonymousIdentity.key.includes("apikey"),
    false,
    "and it is charged to an address-only identity, never the protected key's",
  );

  const authorized = await fetch(`${base}/memories`, { headers: { "x-api-key": "parity-secret" } });
  assert.equal(authorized.status, 200);
  const protectedIdentity = limiter.seen.at(-1);
  assert.notEqual(protectedIdentity?.key, anonymousIdentity?.key, "the two identities are distinct buckets");
  assert.equal(protectedIdentity?.dimensions.apikey !== undefined, true, "the protected bucket is key-scoped");
});

test("RL-HTTP-004: the protected identity follows the resolved tenant, not a public header", async (t) => {
  const { service, root } = await makeService();
  const limiter = new RecordingRateLimiter(() => allow, "recording");
  const seen: string[] = [];
  const { server, base } = await start(service, {
    apiKey: "parity-secret",
    rateLimiter: limiter,
    resolveTenantContext: (req): TenantContext | undefined => {
      const tenant = req.headers["x-test-tenant"];
      return typeof tenant === "string" && tenant.length > 0
        ? createTenantContext({
            organizationId: tenant,
            membershipVersion: "membership-1",
            scopes: ["global"],
            capabilities: ["tenant:read"],
          })
        : undefined;
    },
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  for (const org of ["org-a", "org-b", "org-a"]) {
    await fetch(`${base}/memories`, { headers: { "x-api-key": "parity-secret", "x-test-tenant": org } });
    seen.push(limiter.seen.at(-1)!.key);
  }
  assert.notEqual(seen[0], seen[1], "different tenants get different budgets");
  assert.equal(seen[0], seen[2], "the same tenant is charged to the same budget");
  assert.equal(seen[0]!.startsWith("organization="), true, "the identity names the resolved dimension");
  assert.equal(seen[0]!.includes("org-a"), false, "and it is hashed, not the raw organization id");
});

test("RL-HTTP-005: the default limiter still reads its configuration from the environment", async (t) => {
  const restore = withEnv({ REMEMBRA_RATE_LIMIT: "2", REMEMBRA_RATE_WINDOW_MS: "60000" });
  const { service, root } = await makeService();
  const { server, base } = await start(service, { apiKey: "env-secret" });
  t.after(async () => {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    statuses.push((await fetch(`${base}/memories`, { headers: { "x-api-key": "env-secret" } })).status);
  }
  assert.deepEqual(statuses, [200, 200, 429], "REMEMBRA_RATE_LIMIT=2 still means two requests per window");
});

test("RL-HTTP-006: an in-process limiter survives being shared across servers", async (t) => {
  // A shared limiter instance is the seam a later shared-store implementation
  // will plug into; two servers on one limiter must charge one budget.
  const { service, root } = await makeService();
  const limiter = new InProcessRateLimiter({ limit: 1, windowMs: 60_000 });
  const first = await start(service, { rateLimiter: limiter });
  const second = await start(service, { rateLimiter: limiter });
  t.after(async () => {
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    await new Promise<void>((resolve) => second.server.close(() => resolve()));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  assert.equal((await fetch(`${first.base}/memories`)).status, 200);
  assert.equal((await fetch(`${second.base}/memories`)).status, 429, "one budget, two servers");
});
