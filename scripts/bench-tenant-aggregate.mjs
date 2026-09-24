#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const directory = process.argv[2];
if (!directory) {
  console.error("usage: bench-tenant-aggregate.mjs <result-directory>");
  process.exit(2);
}
const files = await fs.readdir(directory);
const results = [];
for (const metaFile of files.filter((file) => file.endsWith(".meta.json")).sort()) {
  const meta = JSON.parse(await fs.readFile(path.join(directory, metaFile), "utf8"));
  const prefix = metaFile.slice(0, -".meta.json".length);
  const samples = [];
  for (const file of files.filter((name) => name.startsWith(`${prefix}.sample-`) && name.endsWith(".json")).sort()) {
    samples.push(JSON.parse(await fs.readFile(path.join(directory, file), "utf8")));
  }
  const latencies = samples.map((sample) => sample.latency_ms).sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1))] ?? 0;
  results.push({
    size: meta.size,
    seed_ms: meta.seed_ms,
    queries: samples.length,
    result_count: samples.reduce((sum, sample) => sum + sample.result_count, 0),
    search_total_ms: Math.round(latencies.reduce((sum, value) => sum + value, 0) * 100) / 100,
    search_avg_ms: Math.round((latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)) * 100) / 100,
    search_p50_ms: percentile(50),
    search_p95_ms: percentile(95),
    heap_mb_after: Math.max(0, ...samples.map((sample) => sample.heap_mb)),
  });
}
console.log(JSON.stringify({
  benchmark: "tenant-scale-search",
  backend: "sqlite",
  mode: "strict-bounded-candidates",
  organizations: 2,
  results,
}, null, 2));
