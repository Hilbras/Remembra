# V5 Tenant Performance Gates

This document records reproducible local scale evidence for the strict tenant
search path. It is a regression budget, not a universal hardware claim.

## Reproduce

```bash
npm run build
npm run bench:tenant
# Optional:
REMEMBRA_BENCH_SIZES=10000,100000 REMEMBRA_BENCH_QUERIES=5 npm run bench:tenant
```

The harness seeds two organizations into a temporary SQLite database, opens a
strict `MemoryService` with host-minted contexts, disables FTS maintenance to
isolate candidate-query cost, and searches only organization A. The default is
five repeated queries per size; the benchmark runs each size in a separate
worker so native SQLite cleanup cannot contaminate the next measurement.

## Regression ceilings

These are conservative release ceilings for the documented local run. A change
that exceeds one is investigated rather than silently widening the budget.

| Corpus | Strict tenant search p95 | Heap after run | Seed budget |
|---|---:|---:|---:|
| 10,000 records | 1,000 ms | 128 MB | 15 s |
| 100,000 records | 2,000 ms | 256 MB | 30 s |

The benchmark measures latency, result count, and heap use; it does not replace
correctness tests. Cross-tenant candidate filtering, count/pagination behavior,
and malformed-tenant failures remain covered by the tenant test matrix.

## Recorded baseline

Environment: Node `24.21.0`, Linux local workspace, FTS5 unavailable in the
runtime and therefore keyword candidate fallback enabled. Results from
2026-09-24:

| Corpus | Seed ms | Search p50 ms | Search p95 ms | Heap MB |
|---|---:|---:|---:|---:|
| 10,000 | 1,291.72 | 39.36 | 45.57 | 11.97 |
| 100,000 | 12,106.68 | 442.30 | 737.35 | 11.99 |

FTS5-enabled environments must publish a separate result set; the fallback
baseline is not presented as an FTS performance claim.
