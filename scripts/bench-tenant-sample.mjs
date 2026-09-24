#!/usr/bin/env node
import { performance } from "node:perf_hooks";

const root = process.env.REMEMBRA_BENCH_ROOT;
const target = Number(process.env.REMEMBRA_BENCH_TARGET);
const limit = Number(process.env.REMEMBRA_BENCH_LIMIT ?? 10);
if (!root || !Number.isInteger(target)) {
  console.error("REMEMBRA_BENCH_ROOT and integer REMEMBRA_BENCH_TARGET are required");
  process.exit(2);
}

const [{ SqliteBackend }, { MemoryService }, { createTenantContext }] = await Promise.all([
  import("../dist/sqlite-backend.js"),
  import("../dist/service.js"),
  import("../dist/tenant.js"),
]);
const store = new SqliteBackend({ root, ftsEnabled: false });
await store.migrate();
store.touch = async () => {};
const tenant = createTenantContext({
  organizationId: "org-a",
  membershipVersion: "bench-membership-v1",
  scopes: ["global"],
  capabilities: ["tenant:read", "tenant:write"],
});
const service = new MemoryService(store, {
  tenantMode: "strict",
  embeddingProvider: "none",
  decayIntervalMs: Number.MAX_SAFE_INTEGER,
  snapshotKey: Buffer.from("tenant benchmark snapshot key"),
});
const started = performance.now();
const result = await service.search({ query: `hit${target}`, limit, tenant });
const latency = performance.now() - started;
await service.shutdownBackgroundJobs();
store.close();
console.log(JSON.stringify({
  latency_ms: Math.round(latency * 100) / 100,
  result_count: result.results.length,
  heap_mb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
}));
