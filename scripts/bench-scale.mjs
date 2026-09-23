#!/usr/bin/env node
/**
 * Reproducible V4.8 scale benchmark.
 *
 * Usage:
 *   npm run bench:scale
 *   REMEMBRA_BENCH_SIZES=1000,10000 npm run bench:scale
 *   REMEMBRA_BENCH_QUERIES=25 npm run bench:scale
 *
 * The benchmark seeds a real SQLite backend and measures the public service
 * search path. It intentionally does not use a mocked index so the baseline
 * reflects production behavior.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { SqliteBackend } from "../dist/sqlite-backend.js";
import { MemoryService } from "../dist/service.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const sizes = (process.env.REMEMBRA_BENCH_SIZES ?? "10000,50000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const queryCount = Math.max(1, Number(process.env.REMEMBRA_BENCH_QUERIES ?? 10));
const warmupCount = Math.max(0, Number(process.env.REMEMBRA_BENCH_WARMUP ?? 2));
const forceFallback = process.env.REMEMBRA_BENCH_FALLBACK === "1";

if (sizes.length === 0 || !Number.isFinite(queryCount)) {
  console.error("Invalid REMEMBRA_BENCH_SIZES or REMEMBRA_BENCH_QUERIES");
  process.exit(2);
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
      [path.join(SCRIPT_DIR, "seed-scale.mjs"), root, String(size)],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`scale seed failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function runSize(size) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-bench-"));
  let store;
  try {
    const seedStarted = performance.now();
    await seedInChild(root, size);
    const seedMs = round(performance.now() - seedStarted);
    // Candidate planning uses the main-table predicates and does not require
    // FTS5. Disabling it isolates retrieval latency from FTS index maintenance.
    store = new SqliteBackend({ root, ftsEnabled: false });
    // The constructor starts migration asynchronously; wait for it so the
    // benchmark cannot close a native SQLite connection while it is active.
    await store.migrate();
    // Search normally refreshes recency asynchronously. Disable that write
    // side effect here so the close below cannot race queued touches.
    store.touch = async () => {};
    const service = new MemoryService(store, {
      embeddingProvider: "none",
      // Keep the benchmark focused on retrieval rather than the opportunistic
      // maintenance pass, which is fire-and-forget during search.
      decayIntervalMs: Number.MAX_SAFE_INTEGER,
    });
    if (forceFallback) {
      // Preserve the pre-V4.8 full-scan path for an explicit before/after run.
      store.searchCandidates = undefined;
    }
    const targets = Array.from({ length: queryCount }, (_, i) => Math.floor((i + 1) * size / (queryCount + 1)));

    for (let i = 0; i < warmupCount; i++) {
      await service.search({ query: `hit${targets[i % targets.length]}`, limit: 10 });
    }

    const latencies = [];
    let resultCount = 0;
    const started = performance.now();
    for (const target of targets) {
      const t0 = performance.now();
      const result = await service.search({ query: `hit${target}`, limit: 10 });
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
    store?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const size of sizes) results.push(await runSize(size));
console.log(JSON.stringify({
  benchmark: "scale-search",
  backend: "sqlite",
  mode: forceFallback ? "fallback-full-scan" : "bounded-candidates",
  results,
}, null, 2));
