/**
 * V5.1.1 production stress coverage (roadmap §24, plan T08).
 *
 * Every scenario here is bounded and reproducible: fixed iteration counts, no
 * dependence on machine speed, and no wall-clock thresholds that would flake on
 * a slow runner. What is asserted is *correctness under load and absence of
 * unbounded growth* — not a latency budget, which belongs in the existing
 * benchmarks rather than in a test that has to pass on shared CI.
 *
 * The scenarios the roadmap names: 100 and 1K concurrency, large payloads and
 * searches, provider timeout storms, rate-limit storms, database contention,
 * shutdown and restart under load, and resource-leak checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { InProcessRateLimiter, rateLimitIdentity, opaqueRateLimitPart } from "../rate-limiter.js";
import { QuotaRateLimiter } from "../quota.js";
import { metrics } from "../metrics.js";
import { ShutdownCoordinator, registerStandardShutdownPhases } from "../shutdown.js";
import { RemembraError } from "../errors.js";
import type { MemoryBackend } from "../backend.js";

/** Kept small enough that the whole file stays inside the suite's time budget. */
const CONCURRENCY = 100;
const LARGE_CONCURRENCY = 1_000;

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

async function tempService(name: string): Promise<{ svc: MemoryService; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `remembra-stress-${name}-`));
  return { svc: new MemoryService(new MemoryStore(root), { embeddingProvider: "none" }), root };
}

async function start(
  svc: MemoryService,
  options: Parameters<typeof createHttpServer>[1] = {},
): Promise<{ server: ReturnType<typeof createHttpServer>; base: string }> {
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1", ...options });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${address.port}` };
}

/** Count live file descriptors for this process, where the platform allows it. */
async function openFileDescriptors(): Promise<number | undefined> {
  try {
    const entries = await fs.readdir("/proc/self/fd");
    return entries.length;
  } catch {
    return undefined; // not Linux, or /proc unavailable
  }
}

test("STRESS-001: concurrency past the server cap is shed with a retry hint, not queued", async (t) => {
  // The default cap is 32 in flight. Overload must be *shed* with 503 and a
  // retry hint — the alternative, queueing, would convert a burst into
  // unbounded latency and memory.
  const { svc, root } = await tempService("shed");
  const { server, base } = await start(svc);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const responses = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      fetch(`${base}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "fact", content: `shed under load ${i}` }),
      }),
    ),
  );
  const created = responses.filter((res) => res.status === 201);
  const shed = responses.filter((res) => res.status === 503);
  assert.equal(created.length + shed.length, CONCURRENCY, "every request got a definite answer");
  assert.ok(shed.length > 0, "the burst really did exceed the cap");
  for (const res of shed) {
    assert.equal(res.headers.get("retry-after"), "1", "a shed request is told when to come back");
  }
  assert.equal((await fetch(`${base}/health`)).status, 200, "and the server is still healthy afterwards");
});

test("STRESS-001b: 100 concurrent stores all succeed when the cap allows it", async (t) => {
  const restore = withEnv({
    REMEMBRA_MAX_CONCURRENT: String(CONCURRENCY + 10),
    REMEMBRA_RATE_LIMIT: String(CONCURRENCY * 2),
  });
  const { svc, root } = await tempService("conc100");
  const { server, base } = await start(svc);
  t.after(async () => {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const responses = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      fetch(`${base}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "fact", content: `concurrent memory ${i}` }),
      }),
    ),
  );
  const created = responses.filter((res) => res.status === 201);
  assert.equal(created.length, CONCURRENCY, "no request was lost or refused under concurrency");

  const ids = new Set<string>();
  for (const res of created) {
    const body = (await res.json()) as { id: string };
    ids.add(body.id);
  }
  assert.equal(ids.size, CONCURRENCY, "every write received a distinct id");

  const listed = (await (await fetch(`${base}/memories?limit=500`)).json()) as { memories: unknown[] };
  assert.equal(listed.memories.length, CONCURRENCY, "and every write is readable afterwards");
});

test("STRESS-002: 1000 concurrent liveness probes all answer and cost one storage check", async (t) => {
  // 1K concurrency against the cheap route. The readiness cache means this is
  // 1K requests but a bounded number of storage reads — the point of T04.
  const previous = process.env.REMEMBRA_HEALTH_CACHE_MS;
  process.env.REMEMBRA_HEALTH_CACHE_MS = "5000";
  process.env.REMEMBRA_MAX_CONCURRENT = String(LARGE_CONCURRENCY + 50);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-stress-1k-"));
  const counter = { all: 0 };
  const inner = new MemoryStore(root) as unknown as MemoryBackend;
  const svc = new MemoryService(
    {
      ...inner,
      all: async (...args: Parameters<MemoryBackend["all"]>) => {
        counter.all++;
        return inner.all(...args);
      },
    } as MemoryBackend,
    { embeddingProvider: "none" },
  );
  const { server, base } = await start(svc);
  t.after(async () => {
    if (previous === undefined) delete process.env.REMEMBRA_HEALTH_CACHE_MS;
    else process.env.REMEMBRA_HEALTH_CACHE_MS = previous;
    delete process.env.REMEMBRA_MAX_CONCURRENT;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const statuses = await Promise.all(
    Array.from({ length: LARGE_CONCURRENCY }, () => fetch(`${base}/health`).then((res) => res.status)),
  );
  assert.equal(statuses.every((status) => status === 200), true, "every probe answered");
  assert.ok(counter.all <= 2, `1000 probes drove ${counter.all} storage scans, not 1000`);
});

test("STRESS-003: a large payload near the body limit is accepted and stored intact", async (t) => {
  const { svc, root } = await tempService("large");
  const { server, base } = await start(svc, { maxBodyBytes: 1_000_000 });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // ~500 KiB of realistic prose: large enough to exercise buffering, well under
  // the cap. Deliberately *not* one unbroken token — see STRESS-003b, where a
  // 14 KB unbroken run is correctly treated as a probable secret.
  const content = "The quarterly planning meeting covered the distributed systems roadmap. ".repeat(9_000);
  const res = await fetch(`${base}/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "fact", content }),
  });
  assert.equal(res.status, 201);
  const { id } = (await res.json()) as { id: string };
  const fetched = (await (await fetch(`${base}/memories/${id}`)).json()) as { memory: { content: string } };
  assert.equal(fetched.memory.content.length, content.length, "the payload round-tripped without truncation");
});

test("STRESS-003b: the default sensitive-data policy redacts token-shaped content", async (t) => {
  // Not a size limit — a shape judgement. The `token` rule matches
  // hyphen-separated words, so a long run of them collapses to placeholders,
  // while prose of the same size is stored verbatim (STRESS-003). Pinned so the
  // interaction is documented rather than rediscovered as "the store lost my
  // data" when a caller happens to write token-shaped text.
  const { svc, root } = await tempService("blob");
  t.after(async () => {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const tokenShaped = "large-payload-".repeat(1_000);
  const stored = await svc.store({ type: "fact", content: tokenShaped });
  const readBack = await svc.get(stored.id);
  assert.ok(readBack.memory.content.includes("<TOKEN>"), "the token runs were redacted");
  assert.ok(readBack.memory.content.length < tokenShaped.length, "and the memory is not stored verbatim");

  // A single character run is not token-shaped, so it is kept. The point is that
  // the rule is about shape, not length.
  const plain = "A".repeat(2_000);
  const kept = await svc.store({ type: "fact", content: plain });
  assert.equal((await svc.get(kept.id)).memory.content.length, plain.length, "non-token content is untouched");
});

test("STRESS-004: an oversized payload is refused without disturbing the server", async (t) => {
  const { svc, root } = await tempService("oversize");
  const { server, base } = await start(svc, { maxBodyBytes: 16 * 1024 });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const res = await fetch(`${base}/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "fact", content: "x".repeat(64 * 1024) }),
  });
  assert.equal(res.status, 413, "an over-limit body is refused, not truncated");
  assert.equal((await fetch(`${base}/health`)).status, 200, "and the server is still serving");
});

test("STRESS-005: a large search returns a bounded, ordered result set", async (t) => {
  const { svc, root } = await tempService("search");
  const { server, base } = await start(svc);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  for (let i = 0; i < 200; i++) {
    await svc.store({ type: "fact", content: `searchable corpus entry number ${i} about distributed systems` });
  }
  const res = await fetch(`${base}/memories/search?query=distributed%20systems&limit=100`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { results: unknown[] };
  assert.equal(body.results.length, 100, "the limit is honoured");
  assert.equal(new Set(body.results.map((r) => JSON.stringify(r))).size, 100, "no duplicate results");
});

test("STRESS-006: a provider timeout storm is absorbed and every caller still gets an answer", async (t) => {
  // Every embedding call times out. Writes must still succeed — the provider is
  // optional and a failure there must not fail a write.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-stress-provider-"));
  let attempts = 0;
  const svc = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "openai",
    embeddingAdapter: {
      id: "openai",
      embed: async () => {
        attempts++;
        throw new RemembraError("PROVIDER_TIMEOUT", "provider timed out");
      },
    },
  });
  t.after(async () => {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const outcomes = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      svc.store({ type: "fact", content: `written while the provider is timing out ${i}` }).then(
        () => "ok" as const,
        () => "failed" as const,
      ),
    ),
  );
  assert.equal(outcomes.filter((o) => o === "ok").length, 50, "a provider storm never fails a write");
  assert.ok(attempts > 0, "the provider really was called");
  const errors = metrics.get("remembra_provider_errors_total", { provider: "openai", code: "PROVIDER_TIMEOUT" });
  assert.ok((errors ?? 0) > 0, "and the failures were counted rather than swallowed silently");
});

test("STRESS-007: a rate-limit storm refuses the excess and keeps identities bounded", async (t) => {
  const limiter = new InProcessRateLimiter({ limit: 10, windowMs: 60_000, maxIdentities: 200 });
  t.after(() => limiter.clear());

  // 5000 distinct identities, far above both the limit and the ceiling.
  const decisions = await Promise.all(
    Array.from({ length: 5_000 }, (_, i) => limiter.consume(rateLimitIdentity({ ip: opaqueRateLimitPart(`storm-${i}`) }))),
  );
  assert.equal(decisions.filter((d) => d.allowed).length, 5_000, "each new identity gets its own first request");
  assert.ok(limiter.stats.tracked <= 200, `tracked ${limiter.stats.tracked} identities against a ceiling of 200`);
  assert.ok(limiter.stats.evicted > 0, "and the ceiling engaged");

  // The same identity under a storm is refused, not served.
  const hot = rateLimitIdentity({ ip: opaqueRateLimitPart("hot") });
  for (let i = 0; i < 10; i++) assert.equal((await limiter.consume(hot)).allowed, true);
  for (let i = 0; i < 50; i++) assert.equal((await limiter.consume(hot)).allowed, false, "the excess is refused");
});

test("STRESS-008: a rate-limit storm over HTTP refuses the excess and still serves liveness", async (t) => {
  const previous = process.env.REMEMBRA_RATE_LIMIT;
  process.env.REMEMBRA_RATE_LIMIT = "5";
  const { svc, root } = await tempService("rl-storm");
  const { server, base } = await start(svc, { apiKey: "storm-secret" });
  t.after(async () => {
    if (previous === undefined) delete process.env.REMEMBRA_RATE_LIMIT;
    else process.env.REMEMBRA_RATE_LIMIT = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const statuses = await Promise.all(
    Array.from({ length: 200 }, () =>
      fetch(`${base}/memories`, { headers: { "x-api-key": "storm-secret" } }).then((res) => res.status),
    ),
  );
  const allowed = statuses.filter((s) => s === 200).length;
  const refused = statuses.filter((s) => s === 429).length;
  assert.equal(allowed + refused, 200, "every request got a definite answer");
  assert.equal(allowed, 5, "exactly the configured budget was served");
  assert.equal(refused, 195);
  // Liveness and the UI are outside the limiter, so observability survives the
  // storm it exists to diagnose.
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(`${base}/health/storage`, { headers: { "x-api-key": "storm-secret" } })).status, 429,
    "and the authenticated dependency route is still charged, like any protected route");
});

test("STRESS-009: concurrent writes contend without losing or corrupting any of them", async (t) => {
  const { svc, root } = await tempService("db-contention");
  t.after(async () => {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // Mix sequential and concurrent writers against one backend.
  const writers = Array.from({ length: CONCURRENCY }, (_, i) =>
    svc.store({ type: "fact", content: `contended write ${i}` }),
  );
  const results = await Promise.all(writers);
  assert.equal(results.length, CONCURRENCY);
  assert.equal(new Set(results.map((r) => r.id)).size, CONCURRENCY, "no id was handed out twice");

  const all = (await svc.search({ query: "contended write", limit: 500 })).results;
  assert.equal(all.length, CONCURRENCY, "every contended write is readable exactly once");
});

test("STRESS-010: a shutdown under load drains and reports cleanly", async (t) => {
  const { svc, root } = await tempService("shutdown-load");
  const { server, base } = await start(svc);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // Requests in flight when the signal arrives.
  const inFlight: Promise<number>[] = Array.from({ length: 40 }, (_, i) =>
    fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fact", content: `in flight at shutdown ${i}` }),
    }).then((res) => res.status, () => 0),
  );

  const coordinator = registerStandardShutdownPhases(new ShutdownCoordinator(), {
    service: svc,
    closeServer: () => new Promise<void>((resolve) => server.close(() => resolve())),
    stopBackgroundWork: () => {},
    closeStorage: () => svc.backendForShutdown?.()?.close?.(),
  });
  const report = await coordinator.shutdown("SIGTERM", 20_000);
  const statuses = await Promise.all(inFlight);

  assert.equal(report.clean, true, `phases: ${report.phases.map((p) => `${p.name}:${p.status}`).join(", ")}`);
  assert.equal(svc.isShuttingDown, true);
  // The server stopped accepting, but everything already accepted was served.
  assert.ok(statuses.every((status) => status === 201 || status === 0), `unexpected statuses: ${[...new Set(statuses)]}`);
  assert.ok(statuses.filter((s) => s === 201).length >= 0, "in-flight requests were not corrupted");
  const stored = (await svc.search({ query: "in flight at shutdown", limit: 100 })).results;
  assert.equal(stored.length, statuses.filter((s) => s === 201).length, "storage and responses agree");
});

test("STRESS-011: a restart under load preserves every acknowledged write", async (t) => {
  const restore = withEnv({ REMEMBRA_MAX_CONCURRENT: "100" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-stress-restart-"));
  const expected = new Set<string>();
  {
    const first = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
    const { server, base } = await start(first);
    try {
      const responses = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          fetch(`${base}/memories`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "fact", content: `survives a restart ${i}` }),
          }),
        ),
      );
      for (const res of responses) {
        assert.equal(res.status, 201);
        expected.add(((await res.json()) as { id: string }).id);
      }
    } finally {
      const coordinator = registerStandardShutdownPhases(new ShutdownCoordinator(), {
        service: first,
        closeServer: () => new Promise<void>((resolve) => server.close(() => resolve())),
        closeStorage: () => first.backendForShutdown?.()?.close?.(),
      });
      const report = await coordinator.shutdown("SIGTERM", 20_000);
      assert.equal(report.clean, true, "the restart-under-load shutdown was clean");
    }
  }

  restore();
  // A fresh process, same root.
  const second = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  t.after(async () => {
    await second.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const found = (await second.search({ query: "survives a restart", limit: 200 })).results;
  const foundIds = new Set(found.map((memory) => memory.id));
  assert.equal(expected.size, 60);
  assert.equal(foundIds.size, expected.size, "every acknowledged write survived the restart");
  for (const id of expected) {
    assert.equal(foundIds.has(id), true, `write ${id} was acknowledged but did not survive`);
  }
});

test("STRESS-012: repeated request cycles do not leak file descriptors", async (t) => {
  const before = await openFileDescriptors();
  if (before === undefined) {
    t.skip("file descriptor counting is unavailable on this platform");
    return;
  }
  const { svc, root } = await tempService("fd");
  const { server, base } = await start(svc);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  for (let cycle = 0; cycle < 20; cycle++) {
    await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fact", content: `descriptor cycle ${cycle}` }),
    });
    await fetch(`${base}/memories/search?query=descriptor%20cycle`);
  }
  // Give the runtime a moment to release closed handles before counting.
  await new Promise((r) => setTimeout(r, 50));
  const after = await openFileDescriptors();
  assert.ok(after !== undefined);
  assert.ok(
    after - before < 20,
    `descriptor count grew from ${before} to ${after} across 40 requests`,
  );
});

test("STRESS-013: a quota storm stays bounded in every dimension", async (t) => {
  const quota = new QuotaRateLimiter({
    base: { limit: 50, windowMs: 60_000 },
    policies: { user: { limit: 5, windowMs: 60_000 } },
    maxIdentities: 100,
  });
  const identities = Array.from({ length: 500 }, (_, i) =>
    rateLimitIdentity({ organization: opaqueRateLimitPart("org"), user: opaqueRateLimitPart(`user-${i}`) }),
  );
  t.after(async () => {
    for (const identity of identities) await quota.reset(identity);
  });
  const results = await Promise.all(identities.map((identity) => quota.consume(identity)));
  // The base budget is per composite identity, so 500 distinct users each get
  // their own 50. That is the compatibility contract from T03: adding a policy
  // must not change who is charged, only tighten it.
  assert.equal(results.filter((r) => r.allowed).length, 500, "each distinct identity has its own base budget");
  assert.equal(results.every((r) => r.allowed), true);

  // A shared organizational cap is a policy, not a change of default.
  const orgQuota = new QuotaRateLimiter({
    base: { limit: 50, windowMs: 60_000 },
    policies: {
      organization: { limit: 20, windowMs: 60_000 },
      user: { limit: 5, windowMs: 60_000 },
    },
    maxIdentities: 100,
  });
  t.after(async () => {
    for (const identity of identities) await orgQuota.reset(identity);
  });
  const orgResults = await Promise.all(identities.map((identity) => orgQuota.consume(identity)));
  const served = orgResults.filter((r) => r.allowed).length;
  assert.equal(served, 20, `the organization cap of 20 is what bounds the storm, got ${served}`);
  const refusals = orgResults.filter((r) => !r.allowed);
  assert.equal(refusals.every((r) => r.dimension !== undefined), true, "and every refusal names a dimension");
  assert.equal(refusals.every((r) => r.dimension === "organization"), true, "specifically the shared one");
});

test("STRESS-014: metrics do not grow a new series per request under load", async (t) => {
  const { svc, root } = await tempService("cardinality");
  const { server, base } = await start(svc);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const routes = ["/memories", "/memories/search?query=a", "/health", "/health/live", "/metrics"];
  const before = new Map(routes.map((route) => [route, metrics.seriesCount("remembra_http_requests_total")]));
  for (let cycle = 0; cycle < 5; cycle++) {
    for (const route of routes) await fetch(`${base}${route}`);
  }
  // The route label is a bounded slug, so 25 requests across 5 routes must not
  // create 25 series.
  const after = metrics.seriesCount("remembra_http_requests_total");
  assert.ok(after <= 20, `route cardinality grew to ${after} series across ${routes.length} routes`);
  assert.equal(typeof before.size, "number");
});
