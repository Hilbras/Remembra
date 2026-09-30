/**
 * The §38 benchmark gate, inside the suite.
 *
 * `scripts/benchmark-gate.mjs` is the release-stage version and also checks
 * latency percentiles. This one deliberately does not. The suite runs its files in
 * parallel under load, so a p95 wall-clock number asserted here would measure
 * scheduling rather than retrieval, and a gate that fires for reasons outside the
 * change under review is a gate people learn to re-run until it goes green.
 *
 * The quality metrics are safe to assert here because they are deterministic: a
 * fixed clock, no provider, no network, and no wall-clock input to any of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_CORPUS,
  BENCHMARK_SCENARIOS,
  compareToBaseline,
  runRetrievalBenchmark,
  toBaseline,
  type BenchmarkBaseline,
} from "../benchmark-set.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const baseline = JSON.parse(readFileSync(path.join(root, "benchmark", "baseline.json"), "utf8")) as BenchmarkBaseline;

test("BENCH-GATE-001: the benchmark set is well formed", async () => {
  // A broken benchmark is worse than none: it would report a green gate for a
  // corpus and scenario set that no longer exercise anything.
  assert.equal(new Set(BENCHMARK_SCENARIOS.map((s) => s.id)).size, BENCHMARK_SCENARIOS.length, "scenario ids are unique");
  for (const scenario of BENCHMARK_SCENARIOS) {
    assert.ok(scenario.guards.trim().length > 0, `${scenario.id} names the regression it guards`);
    assert.ok(scenario.relevantIds.length > 0, `${scenario.id} has at least one relevant document`);
    // A scenario with a private corpus searches that corpus instead, so its
    // relevant ids are resolved there. Checking only the shared corpus is how a
    // whole set of documents went missing once without anything noticing.
    const ids = new Set((scenario.corpus ?? BENCHMARK_CORPUS).map((m) => m.id));
    for (const id of scenario.relevantIds) {
      assert.ok(ids.has(id), `${scenario.id} references ${id}, which is not in the corpus it searches`);
    }
  }
  // The shared corpus is the default, so a scenario that means to be isolated has
  // to say so — otherwise it quietly inherits everything above.
  const shared = new Set(BENCHMARK_CORPUS.map((m) => m.id));
  for (const scenario of BENCHMARK_SCENARIOS) {
    if (!scenario.corpus) continue;
    for (const id of scenario.relevantIds) {
      assert.ok(!shared.has(id), `${scenario.id} has a private corpus but labels a shared document`);
    }
  }
  // A scenario that names the same document as every other scenario is measuring
  // nothing; and a corpus with no breadth cannot show a ranking change.
  assert.ok(BENCHMARK_CORPUS.length >= 30, "the corpus is big enough for a ranking to have room to move");
  assert.ok(new Set(BENCHMARK_SCENARIOS.map((s) => s.group)).size >= 5, "the set covers several subsystems");
});

test("BENCH-GATE-002: the baseline describes this benchmark", async () => {
  const current = toBaseline(await runRetrievalBenchmark());
  assert.equal(current.corpus, baseline.corpus, "the corpus size in the baseline is current");
  assert.equal(current.k, baseline.k, "as is the result window");
  assert.equal(current.scenarios, baseline.scenarios, "as is the scenario count");
  assert.deepEqual(current.scenarioIds, baseline.scenarioIds, "as is the scenario list, in order");
});

test("BENCH-GATE-003: quality has not regressed against the baseline", async () => {
  const current = toBaseline(await runRetrievalBenchmark());
  const report = compareToBaseline(baseline, current, { includeLatency: false });
  assert.deepEqual(
    report.regressions,
    [],
    `regressions against benchmark/baseline.json:\n${report.regressions.map((r) => `  - ${r.detail}`).join("\n")}\n` +
      "If the change is intended, re-record deliberately with: npm run bench:gate -- --update",
  );
  assert.ok(report.ok);
});

test("BENCH-GATE-004: no scenario finds nothing", async () => {
  // Recall at k can be gamed by a ranker that returns nothing, so the miss count
  // is checked separately: a scenario with no relevant result in the window is a
  // broken scenario, not a hard one.
  const run = await runRetrievalBenchmark();
  assert.deepEqual(run.misses, [], `scenarios that returned nothing relevant: ${run.misses.join(", ")}`);
});

test("BENCH-GATE-005: the gate fails on a deliberately degraded ranking", () => {
  // §38's rule only means something if a bad ranking is caught. Degrade the
  // current run in the two ways that matter — a quality drop and a duplicate
  // spike — and confirm each is reported by name.
  const now = toBaseline({ result: synthetic, topIds: {}, misses: [] });
  const degradedQuality: BenchmarkBaseline = {
    ...now,
    aggregate: { ...now.aggregate, mrr: now.aggregate.mrr - 0.1 },
  };
  const qualityReport = compareToBaseline(baseline, degradedQuality, { includeLatency: false });
  assert.equal(qualityReport.ok, false, "a quality drop fails the gate");
  assert.ok(
    qualityReport.regressions.some((r) => r.metric === "MRR" && r.scope === "aggregate"),
    `and names the metric: ${JSON.stringify(qualityReport.regressions)}`,
  );

  const degradedDuplicates: BenchmarkBaseline = {
    ...now,
    aggregate: { ...now.aggregate, duplicate_rate: baseline.aggregate.duplicate_rate + 0.05 },
  };
  const duplicateReport = compareToBaseline(baseline, degradedDuplicates, { includeLatency: false });
  assert.equal(duplicateReport.ok, false, "a duplicate spike fails the gate");
  assert.ok(
    duplicateReport.regressions.some((r) => r.metric === "duplicate rate"),
    `and names the metric: ${JSON.stringify(duplicateReport.regressions)}`,
  );

  // A latency regression is invisible without opting in, which is the whole point:
  // the suite cannot make that claim, so it does not pretend to.
  const degradedLatency: BenchmarkBaseline = {
    ...now,
    aggregate: { ...now.aggregate, p95_latency_ms: 9_999_999 },
  };
  assert.equal(compareToBaseline(baseline, degradedLatency, { includeLatency: false }).ok, true, "latency is not gated here");
  assert.equal(compareToBaseline(baseline, degradedLatency, { includeLatency: true }).ok, false, "but it is gated in the release script");
});

test("BENCH-GATE-006: an improvement is reported but does not fail the gate", () => {
  const now = toBaseline({ result: synthetic, topIds: {}, misses: [] });
  const improved: BenchmarkBaseline = { ...now, aggregate: { ...now.aggregate, mrr: now.aggregate.mrr + 0.05 } };
  const report = compareToBaseline(baseline, improved, { includeLatency: false });
  assert.equal(report.ok, true, "getting better is not a failure");
  assert.ok(report.improvements.some((r) => r.metric === "MRR"), "but it is reported so the baseline gets moved on purpose");
});

test("BENCH-GATE-007: a changed benchmark cannot be silently compared", () => {
  // Otherwise a developer who edits the corpus can make any regression disappear
  // by re-recording, with the shape change looking like an ordinary baseline bump.
  const now = toBaseline({ result: synthetic, topIds: {}, misses: [] });
  const resized: BenchmarkBaseline = { ...now, corpus: baseline.corpus + 1 };
  const report = compareToBaseline(baseline, resized, { includeLatency: false });
  assert.equal(report.ok, false, "a corpus change is refused");
  assert.match(report.regressions[0]!.detail, /changed shape/);

  // Reordering is *not* a change, and the gate is right to accept it: every
  // aggregate here is a mean of per-scenario ratios, and the per-scenario
  // comparison is keyed by id, so nothing downstream can depend on the order. I
  // asserted otherwise first and was wrong — the aggregate is order-independent.
  // `BENCH-GATE-002` is where ordering is checked, and it checks the *file*
  // against the code, which is a different and legitimate thing to pin.
  const reordered: BenchmarkBaseline = { ...now, scenarioIds: [...now.scenarioIds].reverse() };
  assert.equal(compareToBaseline(baseline, reordered, { includeLatency: false }).ok, true, "reordering alone is not a change");

  // Adding or removing a scenario *is*: the baseline no longer describes the same
  // set of questions, and every number would shift for that reason alone.
  // One id swapped, count held constant, so this reaches the scenario-list check
  // rather than the shape check that runs first.
  const added: BenchmarkBaseline = {
    ...now,
    scenarioIds: [...now.scenarioIds.slice(0, -1), "a-new-scenario"],
  };
  const addedReport = compareToBaseline(baseline, added, { includeLatency: false });
  assert.equal(addedReport.ok, false, "a swapped scenario is refused");
  assert.match(addedReport.regressions[0]!.detail, /scenario list changed/);
  assert.match(addedReport.regressions[0]!.detail, /a-new-scenario/, "and says which one");

  // A count change is caught by the earlier shape check, with its own message.
  const grown: BenchmarkBaseline = { ...now, scenarios: now.scenarios + 1 };
  const grownReport = compareToBaseline(baseline, grown, { includeLatency: false });
  assert.equal(grownReport.ok, false, "a scenario-count change is refused too");
  assert.match(grownReport.regressions[0]!.detail, /changed shape/);
});

/**
 * An EvalResult-shaped stand-in that agrees with the baseline exactly.
 *
 * It is derived from the baseline rather than written out by hand, because a
 * hand-written one is a second set of numbers to keep correct: when I hardcoded
 * precision 0.2 against a baseline of 0.2125, every test using it failed on a
 * precision regression nobody was testing for. The tests below then move exactly
 * one metric, so a failure names the metric they meant.
 */
const synthetic = {
  queries: baseline.perScenario.map((s) => ({
    id: s.id,
    precision_at_k: 0,
    recall_at_k: 0,
    mrr: s.mrr,
    ndcg_at_k: s.ndcg_at_k,
    hit_rate_at_k: 1,
    latency_ms: 0,
    top_ids: [],
    token_efficiency: 0,
    duplicate_rate: 0,
    tokens_total: 0,
    tokens_relevant: 0,
    duplicates: 0,
    returned: 0,
  })),
  aggregate: { ...baseline.aggregate },
};
