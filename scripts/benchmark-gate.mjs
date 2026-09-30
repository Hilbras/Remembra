#!/usr/bin/env node
/**
 * The §38 benchmark gate.
 *
 * §38 asks that every retrieval-engine change be measured against a benchmark
 * set, and that the measurement be able to fail. This is that measurement. It
 * runs the real retrieval pipeline over the labelled set in `src/benchmark-set.ts`,
 * compares the result to a committed baseline, and exits non-zero on a regression
 * in precision, recall, MRR, nDCG, duplicate rate, or a latency percentile.
 *
 * Two things are deliberate:
 *
 * - It runs the benchmark **alone**. A p95 wall-clock number measured while the
 *   test suite runs files in parallel says more about scheduling than about
 *   retrieval, so latency is only gated here, and the suite's copy of this check
 *   asserts quality alone.
 * - `--update` re-records the baseline. Both directions of movement are reported,
 *   so a change that improves things still shows up and the baseline gets moved on
 *   purpose rather than rotting.
 *
 * Usage:
 *   node scripts/benchmark-gate.mjs            # gate, including latency
 *   node scripts/benchmark-gate.mjs --update   # re-record the baseline
 *   node scripts/benchmark-gate.mjs --no-latency
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const argv = new Set(process.argv.slice(2));
const update = argv.has("--update");
const includeLatency = !argv.has("--no-latency");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "benchmark", "baseline.json");

const { runRetrievalBenchmark, toBaseline, compareToBaseline } = await import(
  path.join(root, "dist", "benchmark-set.js")
);

const run = await runRetrievalBenchmark();
const current = toBaseline(run);
const agg = current.aggregate;

const summary = [
  `corpus ${current.corpus} documents, ${current.scenarios} scenarios, k=${current.k}`,
  `precision@${current.k} ${agg.precision_at_k.toFixed(4)}  recall ${agg.recall_at_k.toFixed(4)}`,
  `MRR ${agg.mrr.toFixed(4)}  nDCG ${agg.ndcg_at_k.toFixed(4)}`,
  `token efficiency ${agg.token_efficiency.toFixed(4)}  duplicate rate ${agg.duplicate_rate.toFixed(4)}`,
  `p50 ${agg.p50_latency_ms.toFixed(2)}ms  p95 ${agg.p95_latency_ms.toFixed(2)}ms`,
];
console.log(summary.join("\n"));

if (run.misses.length > 0) {
  console.error(`\nbenchmark: ${run.misses.length} scenario(s) found nothing relevant: ${run.misses.join(", ")}`);
  process.exit(1);
}

if (update) {
  await mkdir(path.dirname(baselinePath), { recursive: true });
  // Sorted keys, so re-recording an unchanged benchmark produces an empty diff
  // rather than a reordering.
  await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`\nBaseline written to ${path.relative(root, baselinePath)}.`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await (await import("node:fs/promises")).readFile(baselinePath, "utf8"));
} catch (error) {
  console.error(
    `\nNo readable baseline at ${path.relative(root, baselinePath)}: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("Record one deliberately with: npm run bench:gate -- --update");
  process.exit(2);
}

const report = compareToBaseline(baseline, current, { includeLatency });

if (report.improvements.length > 0) {
  console.log(`\n${report.improvements.length} metric(s) moved in the improving direction:`);
  for (const finding of report.improvements) console.log(`  + ${finding.detail}`);
  console.log("\n  Re-record the baseline with: npm run bench:gate -- --update");
}

if (!report.ok) {
  console.error(`\nBenchmark gate FAILED — ${report.regressions.length} regression(s):`);
  for (const finding of report.regressions) console.error(`  - ${finding.detail}`);
  console.error(
    "\n  If the change is intended, re-record the baseline with: npm run bench:gate -- --update",
  );
  process.exit(1);
}

console.log("\nBenchmark gate passed.");
