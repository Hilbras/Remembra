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
is internal and is never accepted from a public request. Agent mode remains on
the full path until policy predicates can be applied before a SQL `LIMIT`.

The benchmark intentionally runs SQLite with FTS5 disabled to isolate the
main-table candidate planner. FTS synchronization and rebuild behavior are
covered by SQLite regression tests; vector search remains on the exact path
until a vector candidate index exists.

## Reference measurements

These are local reference results from the V4.8 development machine. They are
not universal service-level objectives; rerun the benchmark on deployment
hardware.

| Mode | Corpus | p50 | p95 | Heap after run |
|------|--------:|----:|----:|---------------:|
| bounded candidates | 10,000 | 45.35 ms | 48.37 ms | 10.54 MB |
| bounded candidates | 50,000 | 216.32 ms | 258.64 ms | 9.83 MB |
| legacy full scan | 5,000 | 116.45 ms | 143.67 ms | 93.11 MB |

The comparison is intentionally conservative: the legacy run is smaller
because a full scan materializes the complete collection, while the bounded
path is verified at the planned 10K and 50K sizes. A performance result is not
accepted unless the existing correctness and agent-visibility tests remain
green. Candidate generation must preserve scope, access, temporal, quarantine,
and standing-instruction behavior.
