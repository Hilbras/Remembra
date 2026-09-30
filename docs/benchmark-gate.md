# The retrieval benchmark gate

Roadmap §38 asks that every retrieval-engine change be measured against a
benchmark set, and that the measurement be able to fail. This is that
measurement. It runs the real retrieval pipeline over a labelled set, compares the
result against a committed baseline, and fails the release on a regression in
precision, recall, MRR, nDCG, duplicate rate, or a latency percentile.

```bash
npm run bench:gate                    # the gate, including latency
npm run bench:gate -- --update        # re-record the baseline
npm run bench:gate -- --no-latency    # quality only
```

It runs as a stage in `npm run release:check`, ahead of the security matrix: a
retrieval regression is a correctness problem, and this is the only stage that can
see one.

## What is measured

`src/benchmark-set.ts` holds a corpus and 23 scenarios. Every scenario names, in
its own `guards` field, the regression it exists to catch — a scenario nobody can
break is a scenario whose gate never fires, and that is much cheaper to notice in
review than in production.

| Group | Guards |
|---|---|
| `tokenisation` | hyphen, underscore and camelCase boundaries; case folding; prefix matching |
| `phrases` | adjacent-in-order terms beat the same terms out of order |
| `idf` | one rare term outweighs two common ones |
| `field-weights` | a tag match outranks the same word buried in body text |
| `dedup` | a byte-identical re-ingest does not take two slots; identical text from two sources survives |
| `superseded` | a memory with an available replacement is not returned |
| `modifiers` | trust, importance, confidence, pinning and recency each decide a ranking on their own |
| `hard` | a plausible wrong answer that scores well for the wrong reason |
| `breadth` | ordinary questions still rank correctly |

## Why it is built the way it is

**It runs the real pipeline.** The pre-existing `benchmark.test.ts` passes a
hand-written substring `searchFn`, so it measures the eval harness and not the
engine. A gate over that cannot detect a broken ranker, because the ranker is not
in the loop.

**The vector side is synthetic, and says so.** `benchmarkEmbed` is a hashed bag of
character trigrams. It is not an embedding model and does not pretend to be one. It
is deterministic — a gate compared against a committed baseline cannot tolerate a
run that varies by machine, and a provider call would. Trigrams rather than whole
words because whole words made paraphrase untestable: a query sharing no vocabulary
with its answer scored exactly zero, so the "semantic" signal was the keyword signal
in different arithmetic and the set could not see a fusion change at all.

**Some scenarios carry a private corpus.** A bonus larger than the entire spread
between two fused scores — pinning is +50 — wins every query it appears in, so it
cannot be tested in a shared corpus. Those scenarios replace the corpus rather than
extending it. This is not a stylistic choice: one attempt produced a benchmark
where a single memory topped all 19 scenarios, which measures pinning and nothing
else.

**Scenarios need headroom.** Every scenario with an unambiguous winner can only
detect a catastrophic regression. The `hard` group exists so a ranking that drifts
by a place or two is visible.

## What it does not detect

Stated plainly, because a gate that overstates itself is worse than none:

- **A mis-scaled recency term.** Recency is monotone in age and the weight is a
  positive multiplier on both sides, so no scale reorders a pair that is already
  ordered correctly.
- **A removed recency term.** The tie-break is `final`, then `updatedAt`
  descending, then id, so two documents that tie are still ordered newest-first.
  Deleting the modifier leaves the answer unchanged. The code is more robust here
  than the gate can measure.
- **Non-ASCII queries.** `extractQuery` filters query terms with `/^[a-z0-9]+$/u`,
  so a CJK query produces zero terms and no lexical match at all. That is a real
  defect (audit finding S7) and it is deliberately not gated: a stage that fails on
  correct code is not a gate.

## Latency

Checked only by `scripts/benchmark-gate.mjs`, which runs alone. Two bounds: a
relative one (p95 must not exceed the baseline's by more than 2.5x, because that
baseline was measured on a different machine) and an absolute ceiling of 1000 ms
that catches the pathological case no amount of machine variation explains.

The in-suite test asserts quality only. The suite runs its files in parallel under
load, so a wall-clock number measured there describes scheduling rather than
retrieval.

## When the gate fails

```
Benchmark gate FAILED — 2 regression(s):
  - MRR for "idf-rare-term-wins" fell from 1 to 0.5000
  - duplicate rate rose from 0 to 0.0125 (tolerance 0.001)
```

Per-scenario findings name the behaviour that broke, so the failure is a starting
point rather than a number to interpret. If a change is an intended improvement it
is reported in the improving direction and does not fail the gate; re-record the
baseline deliberately with `--update` so the change is a decision rather than
drift.

The gate also refuses to compare against a baseline whose corpus, result window or
scenario list has changed. Otherwise editing the benchmark would make any
regression disappear by re-recording, with the shape change looking like an
ordinary baseline bump.
