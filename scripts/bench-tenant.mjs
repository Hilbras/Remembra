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
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SqliteBackend } from "../dist/sqlite-backend.js";
import { MemoryService } from "../dist/service.js";
import { createTenantContext } from "../dist/tenant.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
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

function context(organizationId) {
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

function seedInChild(root, size) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(SCRIPT_DIR, "seed-tenant-scale.mjs"), root, String(size)],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`tenant seed failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function runSize(size) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-bench-"));
  let store;
  try {
    const seedStarted = performance.now();
    await seedInChild(root, size);
    const seedMs = round(performance.now() - seedStarted);
    store = new SqliteBackend({ root, ftsEnabled: false });
    await store.migrate();
    const tenantA = context("org-a");
    store.touch = async () => {};
    const service = new MemoryService(store, {
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
    // better-sqlite3 11.x can abort during Node 24 cleanup after a large
    // number of dynamically shaped tenant statements. The benchmark process
    // owns this temporary connection; remove the tree and let the OS reclaim
    // it after the JSON result is emitted rather than turning a measurement
    // into a native-cleanup crash.
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function runWorker() {
  if (sizes.length !== 1 || !resultFile) throw new Error("tenant benchmark worker requires one size and a result file");
  const result = await runSize(sizes[0]);
  await fs.writeFile(resultFile, JSON.stringify(result), "utf8");
  process.exit(0);
}

async function runParent() {
  const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-bench-results-"));
  const results = [];
  try {
    for (const [index, size] of sizes.entries()) {
      const resultPath = path.join(resultDir, `${index}.json`);
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
          stdio: "ignore",
          env: {
            ...process.env,
            REMEMBRA_BENCH_WORKER: "1",
            REMEMBRA_BENCH_SIZES: String(size),
            REMEMBRA_BENCH_RESULT: resultPath,
          },
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`tenant benchmark worker failed (${signal ?? `exit ${code}`})`));
        });
      });
      results.push(JSON.parse(await fs.readFile(resultPath, "utf8")));
    }
  } finally {
    await fs.rm(resultDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    benchmark: "tenant-scale-search",
    backend: "sqlite",
    mode: "strict-bounded-candidates",
    organizations: 2,
    results,
  }, null, 2));
  process.exit(0);
}

if (workerMode) await runWorker();
else await runParent();
