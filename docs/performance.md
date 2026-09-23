# Remembra Performance & Scale

V4.8 performance work is measurement-first. The scale benchmark exercises the
real SQLite persistence path and the public `MemoryService.search` path; it
uses deterministic data and does not replace the database with a mocked index.

## Running the scale benchmark

```bash
npm run bench:scale
```

The default corpus sizes are 10,000 and 50,000 memories. Override them with:

```bash
REMEMBRA_BENCH_SIZES=1000,10000,50000 npm run bench:scale
REMEMBRA_BENCH_QUERIES=25 REMEMBRA_BENCH_WARMUP=5 npm run bench:scale
```

To measure the legacy full-scan path explicitly:

```bash
REMEMBRA_BENCH_FALLBACK=1 npm run bench:scale
```

The output is JSON and includes:

- corpus size, mode, and deterministic seed time;
- number of queries and total returned results;
- average, p50, and p95 search latency;
- process heap usage after the measured run.

The benchmark seeds SQLite in an isolated child process, then measures searches
in the main process. This keeps corpus construction separate from retrieval
latency and avoids conflating native driver setup with search performance.
Each run uses an isolated temporary database and removes it afterward.

## Current V4.8 retrieval slice

SQLite implements an optional, bounded keyword candidate planner. It:

1. returns every lexical match when the match set fits the hard candidate budget;
2. returns the highest-ranked zero-signal rows using the same modifier, scope,
   recency, and standing-instruction rules as the JavaScript ranker;
3. returns `partial` when the budget cannot prove a safe result set.

The service falls back to the established full scan for partial pages, semantic
(vector) queries, type-filtered queries, agent mode, caller-supplied candidate
IDs, and legacy backends without the optional capability. The candidate budget
is internal (`max(16, min(128, resultLimit × 2))` in the current slice) and is
never accepted from a public request. Agent mode remains on the full path until
policy predicates can be applied before a SQL `LIMIT`.

Embedding-enabled batches use bounded provider calls. The defaults are
`REMEMBRA_MAX_BATCH_SIZE=32` and
`REMEMBRA_MAX_CONCURRENT_EMBEDDINGS=4`; per-item failures remain fail-open and
are reported in the batch result. Redaction and reject-sensitive-data policies
force the per-item store path so precomputation cannot bypass content
normalization.

## Reference measurements

These are local reference results from the V4.8 development machine. They are
not universal service-level objectives; rerun the benchmark on deployment
hardware.

| Mode | Corpus | p50 | p95 | Heap after run |
|------|--------:|----:|----:|---------------:|
| bounded candidates | 10,000 | 41.85 ms | 334.56 ms | 105.82 MB |
| bounded candidates | 50,000 | 310.70 ms | 1499.00 ms | 480.47 MB |
| legacy full scan | 5,000 | 116.45 ms | 143.67 ms | 93.11 MB |

The comparison is intentionally conservative: the legacy run is smaller
because a full scan materializes the complete collection, while the bounded
path is verified at the planned 10K and 50K sizes. The current local guardrail
for the selective keyword benchmark is p95 below 2 seconds and heap below
600 MB at 50K; broad lexical queries, semantic queries, and explicit type
filters may fall back and should be benchmarked separately. A performance
result is not accepted unless the existing correctness and agent-visibility
tests remain green. Candidate generation must preserve scope, access,
temporal, quarantine, and standing-instruction behavior.
