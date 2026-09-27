/**
 * V5.1.0 metrics: quantiles over recorded histograms, the series roadmap §21
 * names, and a hard bound on label cardinality.
 *
 * The cardinality tests are the important ones. Every label value in this
 * codebase is either a literal or drawn from a closed set, and these tests are
 * what stop that from quietly ceasing to be true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MetricsRegistry, metrics } from "../metrics.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createHttpServer } from "../http.js";
import { JobQueue } from "../job-queue.js";
import { RemembraError } from "../errors.js";

test("METRIC-001: a quantile interpolates inside the bucket it falls in", () => {
  const m = new MetricsRegistry();
  m.histogram("lat", "latency", [0.1, 0.5, 1, 5]);
  for (let i = 0; i < 100; i++) m.observe("lat", 0.05);
  // All observations are in the first bucket (le=0.1).
  const s = m.summary("lat");
  assert.equal(s.count, 100);
  assert.ok(s.p50 > 0 && s.p50 <= 0.1, `p50 ${s.p50} lands in the first bucket`);
  assert.ok(s.p99 >= s.p50, "quantiles are monotonic");
});

test("METRIC-002: quantiles order correctly and reflect the distribution", () => {
  const m = new MetricsRegistry();
  m.histogram("lat", "latency", [0.01, 0.1, 1, 10]);
  // 90 fast, 10 slow.
  for (let i = 0; i < 90; i++) m.observe("lat", 0.005);
  for (let i = 0; i < 10; i++) m.observe("lat", 5);
  const s = m.summary("lat");
  assert.equal(s.count, 100);
  assert.ok(s.p50 <= 0.1, `p50 ${s.p50} reflects the fast majority`);
  assert.ok(s.p99 > s.p50, "a slow tail pushes p99 above p50");
  assert.ok(s.sum > 50, "the sum is exact even though the quantiles are estimated");
});

test("METRIC-003: an empty or unquantifiable series reports zero, never a guess", () => {
  const m = new MetricsRegistry();
  m.histogram("lat", "latency", [1, 2]);
  assert.equal(m.quantile("lat", 0.99), 0, "no observations means no fabricated latency");
  assert.deepEqual(m.summary("lat"), { p50: 0, p95: 0, p99: 0, count: 0, sum: 0 });
  assert.equal(m.quantile("never-registered", 0.5), 0);
  for (const bad of [-0.1, 1.5, Number.NaN]) {
    assert.equal(m.quantile("lat", bad), 0, `q=${bad} is not a quantile`);
  }
});

test("METRIC-004: observations above the last bucket clamp to its edge", () => {
  const m = new MetricsRegistry();
  m.histogram("lat", "latency", [1, 2]);
  for (let i = 0; i < 10; i++) m.observe("lat", 1_000);
  const s = m.summary("lat");
  assert.equal(s.count, 10);
  assert.ok(s.p99 <= 2, `p99 ${s.p99} does not exceed the top finite bucket`);
  assert.equal(s.sum, 10_000, "the sum stays exact");
});

test("METRIC-005: quantile series are isolated by label", () => {
  const m = new MetricsRegistry();
  m.histogram("lat", "latency", [0.1, 1, 10]);
  for (let i = 0; i < 10; i++) m.observe("lat", 0.05, { route: "/fast" });
  for (let i = 0; i < 10; i++) m.observe("lat", 5, { route: "/slow" });
  assert.ok(m.quantile("lat", 0.99, { route: "/fast" }) <= 0.1);
  assert.ok(m.quantile("lat", 0.99, { route: "/slow" }) > 0.1);
  assert.equal(m.quantile("lat", 0.99, { route: "/never" }), 0, "an unobserved series reports nothing");
  assert.equal(m.seriesCount("lat"), 2);
});

test("METRIC-006: reset clears observations but keeps the schema", () => {
  const m = new MetricsRegistry();
  m.counter("c", "counter");
  m.histogram("h", "hist", [1, 2]);
  m.inc("c", { a: "1" });
  m.observe("h", 0.5, { a: "1" });
  m.gauge("g", "gauge", () => [{ value: 7 }]);
  m.reset();
  assert.equal(m.get("c", { a: "1" }), undefined, "counters are cleared");
  assert.equal(m.quantile("h", 0.5, { a: "1" }), 0, "histograms are cleared");
  assert.equal(m.names().includes("c"), true, "the series name is still registered");
  assert.equal(m.names().includes("g"), true, "gauges are structural and stay");
  assert.match(m.render(), /g 7/, "and a gauge still reports");
  assert.doesNotThrow(() => m.inc("c"), "so the name can be incremented again");
});

test("METRIC-007: every series roadmap §21 names is declared", () => {
  // The audit found five of these missing entirely and seven more declared but
  // never recorded. The names below are the ones a §21 reader would expect.
  for (const name of [
    "remembra_http_requests_total",
    "remembra_http_request_duration_seconds",
    "remembra_errors_total",
    "remembra_rate_limit_hits_total",
    "remembra_memory_reads_total",
    "remembra_stores_total",
    "remembra_searches_total",
    "remembra_provider_requests_total",
    "remembra_provider_errors_total",
    "remembra_embedding_latency_seconds",
    "remembra_llm_latency_seconds",
    "remembra_storage_latency_seconds",
    "remembra_snapshot_operations_total",
    "remembra_recovery_operations_total",
  ]) {
    assert.equal(metrics.names().includes(name), true, `${name} must be declared`);
  }
});

test("METRIC-008: no declared series is left permanently empty", async () => {
  // A declared series that nothing records is worse than an absent one, because
  // a dashboard on it renders empty and looks like data loss. The gauges and
  // counters declared with an empty collector were removed for this reason.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-metrics-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    await fetch(`http://127.0.0.1:${address.port}/health`);
    await fetch(`http://127.0.0.1:${address.port}/health/live`);
    const text = await (await fetch(`http://127.0.0.1:${address.port}/metrics`)).text();

    // The gauges that used to be declared with `collect: () => []` must be gone.
    for (const gone of [
      "remembra_estimated_cost_usd",
      "remembra_memory_count_active",
      "remembra_memory_count_archived",
      "remembra_memory_count_deleted",
      "remembra_duplicate_rate",
      "remembra_conflict_rate",
      "remembra_stale_memory_rate",
      "remembra_token_usage_total",
    ]) {
      assert.equal(text.includes(gone), false, `${gone} cannot be populated and must not be advertised`);
    }
    // And the build-info gauge, which is real, must still be there.
    assert.match(text, /remembra_info\{version=/, "a populated gauge is still exposed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("METRIC-009: the exposition is well-formed and keeps p50/p95/p99 readable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-metrics-fmt-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "fact", content: `request ${i}` }),
      });
    }
    await fetch(`${base}/memories/search?query=request`);
    const text = await (await fetch(`${base}/metrics`)).text();

    assert.match(text, /# TYPE remembra_http_requests_total counter/);
    assert.match(text, /remembra_http_requests_total\{method="POST",route="memories"/);
    assert.match(text, /remembra_stores_total \d+/);
    assert.match(text, /remembra_memory_reads_total\{operation="search"\} \d+/);
    assert.match(text, /remembra_searches_total \d+/);
    assert.match(text, /remembra_http_request_duration_seconds_bucket\{le="\+Inf",route="[a-z_]+"\}/);
    assert.match(text, /remembra_http_request_duration_seconds_count\{/);
    // Every exposition line is either a comment or `name{labels} value`.
    for (const line of text.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.eE+]+$/, `malformed line: ${line}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("METRIC-010: request latency percentiles are computable from the live registry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-metrics-pct-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    for (let i = 0; i < 10; i++) await fetch(`${base}/health`);
    const s = metrics.summary("remembra_http_request_duration_seconds", { route: "health" });
    assert.ok(s.count >= 10, `recorded ${s.count} observations`);
    assert.ok(s.p50 >= 0 && s.p50 <= 1, `p50 ${s.p50}s is a plausible liveness latency`);
    assert.ok(s.p99 >= s.p95 && s.p95 >= s.p50, "percentiles are ordered");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("METRIC-011: rate-limit hits are attributed to a bounded dimension", async () => {
  const previous = process.env.REMEMBRA_RATE_LIMIT;
  process.env.REMEMBRA_RATE_LIMIT = "1";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-metrics-rl-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1", apiKey: "metric-secret" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/memories`, { headers: { "x-api-key": "metric-secret" } });
    }
    const hits = metrics.get("remembra_rate_limit_hits_total", { dimension: "global", transport: "http" });
    assert.ok((hits ?? 0) >= 1, "a rejected request is counted against the base budget");
    assert.equal(
      metrics.seriesCount("remembra_rate_limit_hits_total") <= 4,
      true,
      "the dimension label stays inside the closed quota enum",
    );
  } finally {
    if (previous === undefined) delete process.env.REMEMBRA_RATE_LIMIT;
    else process.env.REMEMBRA_RATE_LIMIT = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("METRIC-012: a host-registered job type cannot create unbounded series", async () => {
  // `JobType` is an open union, so a host may register anything. The metric
  // label is closed, which is the only thing standing between an embedder and
  // one series per tenant.
  const queue = new JobQueue({ concurrency: 4, maxQueue: 500 });
  await queue.register("maintenance", async () => "ok");
  try {
    // A host that keys its job type by tenant, which is exactly the shape that
    // would have produced one series per tenant before the label was closed.
    for (let i = 0; i < 200; i++) {
      const type = `tenant-${i}-job`;
      await queue.register(type, async () => "ok");
      await queue.enqueue(type, {});
    }
    await queue.drain();
    const rendered = metrics.render();
    assert.match(rendered, /remembra_jobs_total\{outcome="completed",type="other"\}/, "an unknown type is counted as other");
    assert.equal(rendered.includes("tenant-0-job"), false, "no caller-chosen value reaches a label, queued or completed");
    assert.equal(
      rendered.includes('remembra_jobs_total{outcome="queued",type="tenant'),
      false,
      "the enqueue-time increment is bounded too, which is where the growth actually happened",
    );
    assert.equal(
      metrics.seriesCount("remembra_jobs_total") <= 6,
      true,
      "the jobs_total series count is bounded by the closed type set",
    );
  } finally {
    await queue.shutdown();
  }
});

test("METRIC-013: known job types keep their own series", async () => {
  const queue = new JobQueue({ concurrency: 1, maxQueue: 10 });
  await queue.register("maintenance", async () => "ok");
  try {
    await queue.enqueue("maintenance", {});
    await queue.drain();
    assert.match(metrics.render(), /remembra_jobs_total\{outcome="completed",type="maintenance"\}/);
  } finally {
    await queue.shutdown();
  }
});

test("METRIC-014: storage and provider latency series are recorded, not just declared", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-metrics-live-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  try {
    await svc.store({ type: "fact", content: "instrumented write" });
    const storage = metrics.summary("remembra_storage_latency_seconds", { operation: "store" });
    assert.ok(storage.count >= 1, "a store records a storage latency observation");
    assert.ok(storage.p50 >= 0);
    // With embeddings disabled there is no provider traffic, so the provider
    // series must stay absent rather than report a fabricated zero.
    assert.equal(metrics.get("remembra_provider_requests_total", { provider: "none", direction: "embed" }), undefined);
  } finally {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("METRIC-015: a failing provider call is counted by classified code and rethrown unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-metrics-provider-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
  try {
    const { embedText } = await import("../embeddings.js");
    const before = metrics.seriesCount("remembra_provider_requests_total");
    const boom = new RemembraError("PROVIDER_TIMEOUT", "provider timed out");
    await assert.rejects(
      () =>
        embedText("text", "openai", {
          adapter: {
            id: "openai",
            embed: async () => {
              throw boom;
            },
          },
        }),
      (err: unknown) => err === boom,
      "the caller sees the original error, not an instrumentation wrapper",
    );
    assert.equal(
      metrics.get("remembra_provider_requests_total", { provider: "openai", direction: "embed" }),
      1,
      "the attempt was counted",
    );
    assert.equal(
      metrics.get("remembra_provider_errors_total", { provider: "openai", code: "PROVIDER_TIMEOUT" }),
      1,
      "and so was the failure, by classified code",
    );
    assert.equal(
      metrics.get("remembra_provider_failures_total", { provider: "openai", code: "PROVIDER_TIMEOUT" }),
      1,
      "including the series that was previously declared and never recorded",
    );
    assert.ok(metrics.seriesCount("remembra_provider_requests_total") > before);
  } finally {
    await svc.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
