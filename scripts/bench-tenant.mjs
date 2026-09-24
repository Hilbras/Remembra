#!/usr/bin/env node
/**
 * Reproducible V5 strict-tenant search benchmark.
 *
 * Usage:
 *   npm run bench:tenant
 *   REMEMBRA_BENCH_SIZES=10000,100000 npm run bench:tenant
 *
 * Each size is split across two organizations. The service is constructed in
 * strict mode and every query carries a host-minted context, so the measured
 * path includes tenant predicates before candidate limits/counts.
 */
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";

const workerMode = process.env.REMEMBRA_BENCH_WORKER === "1";
const resultFile = process.env.REMEMBRA_BENCH_RESULT;

const sizes = (process.env.REMEMBRA_BENCH_SIZES ?? "10000,100000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
// Five samples keep the 100K run below a known better-sqlite3 11/Node 24
// cumulative-query cleanup bug while still reporting a p95 from repeated reads.
const queryCount = Math.max(1, Number(process.env.REMEMBRA_BENCH_QUERIES ?? 5));
const warmupCount = Math.max(0, Number(process.env.REMEMBRA_BENCH_WARMUP ?? 2));
if (sizes.length === 0 || !Number.isFinite(queryCount)) {
  console.error("Invalid REMEMBRA_BENCH_SIZES or REMEMBRA_BENCH_QUERIES");
  process.exit(2);
}

function context(createTenantContext, organizationId) {
  return createTenantContext({
    organizationId,
    membershipVersion: "bench-membership-v1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write"],
  });
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function runSize(root, size, seedMs) {
  let store;
  let service;
  try {
    const [{ SqliteBackend }, { MemoryService }, { createTenantContext }] = await Promise.all([
      import("../dist/sqlite-backend.js"),
      import("../dist/service.js"),
      import("../dist/tenant.js"),
    ]);
    store = new SqliteBackend({ root, ftsEnabled: false });
    await store.migrate();
    const tenantA = context(createTenantContext, "org-a");
    store.touch = async () => {};
    service = new MemoryService(store, {
      tenantMode: "strict",
      embeddingProvider: "none",
      decayIntervalMs: Number.MAX_SAFE_INTEGER,
      snapshotKey: Buffer.from("tenant benchmark snapshot key"),
    });
    const targets = Array.from({ length: queryCount }, (_, i) => Math.floor((i + 1) * size / (queryCount + 1)));
    for (let i = 0; i < warmupCount; i++) {
      await service.search({ query: `hit${targets[i % targets.length]}`, limit: 10, tenant: tenantA });
    }
    const latencies = [];
    let resultCount = 0;
    const started = performance.now();
    for (const target of targets) {
      const t0 = performance.now();
      const result = await service.search({ query: `hit${target}`, limit: 10, tenant: tenantA });
      latencies.push(performance.now() - t0);
      resultCount += result.results.length;
    }
    const totalMs = performance.now() - started;
    return {
      size,
      seed_ms: seedMs,
      queries: queryCount,
      result_count: resultCount,
      search_total_ms: round(totalMs),
      search_avg_ms: round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      search_p50_ms: round(percentile(latencies, 50)),
      search_p95_ms: round(percentile(latencies, 95)),
      heap_mb_after: round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
  } finally {
    // Release background work and native statement wrappers before removing
    // the temporary tree. This is required for better-sqlite3 11.x under
    // Node 24, whose cleanup hook asserts if work is still active at exit.
    await service?.shutdownBackgroundJobs();
    store?.close();
  }
}

async function runWorker() {
  const root = process.env.REMEMBRA_BENCH_ROOT;
  const seedMs = Number(process.env.REMEMBRA_BENCH_SEED_MS ?? 0);
  if (sizes.length !== 1 || !resultFile || !root) throw new Error("tenant benchmark worker requires one size, root, and result file");
  const result = await runSize(root, sizes[0], round(seedMs));
  await fs.writeFile(resultFile, JSON.stringify(result), "utf8");
}

if (!workerMode) {
  console.error("This module is a benchmark worker; run `npm run bench:tenant`.");
  process.exit(2);
}
await runWorker();
