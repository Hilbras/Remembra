# Implementation Plan: V4.8.0 Performance & Scalability

## Overview

Prepare Remembra for large memory collections without changing existing single-memory APIs. Establish reproducible scale benchmarks first, then remove measured bottlenecks in retrieval, add bounded batch operations, and move expensive work behind a resource-limited internal queue.

## Architecture Decisions

- Preserve existing `MemoryBackend` behavior and add optional capabilities rather than breaking current backends.
- Measure before optimizing: compare the same corpus/query before and after each change.
- Keep correctness and scope/agent policy ahead of throughput; a faster result that leaks or changes semantics is rejected.
- Batch operations are bounded, validated as a whole where possible, and return per-item outcomes.
- Jobs are cooperative in-process work items with explicit concurrency and queue limits; no unbounded worker spawning.
- SQLite indexes and candidate limits are backend-specific; file storage remains correct without pretending to have SQL indexes.

## Task List

### Phase 1: Measurement and bounded retrieval

- [x] Task 1: Add deterministic scale benchmark harness for 10K and 50K memories.
  - Acceptance: reports corpus size, query latency percentiles, result count, and peak memory where available.
  - Verification: `npm run bench:scale`; results are reproducible with a fixed seed.
  - Files: `scripts/bench-scale.mjs`, `scripts/seed-scale.mjs`, `package.json`, `docs/performance.md`.
  - Scope: S.

- [x] Task 2: Add bounded backend candidate generation and retrieval integration.
  - Acceptance: semantic/keyword search does not rank an unbounded full collection when a backend can provide candidates; fallback remains correct; agent scope/access filters remain applied.
  - Verification: focused retrieval/service/SQLite tests plus before/after benchmark.
  - Files: `src/backend.ts`, `src/sqlite-backend.ts`, `src/retrieval.ts`, `src/service.ts`, tests.
  - Scope: M.

### Checkpoint: Retrieval

- [x] Full existing suite remains green.
- [x] Benchmark shows a measurable, non-regressive improvement or the experiment is reverted.

### Phase 2: Batch APIs

- [x] Task 3: Add bounded batch store/update/delete/export service APIs.
  - Acceptance: input limits are enforced; each item is validated; existing single-item APIs and error envelopes remain unchanged; agent policy applies to every item.
  - Verification: service and HTTP integration tests, including partial-failure behavior.
  - Files: `src/service.ts`, `src/http.ts`, `src/types.ts`, tests.
  - Scope: M.

- [x] Task 4: Add batch embedding and provider concurrency limits.
  - Batch store precomputes vectors only when redaction/reject policy cannot be bypassed; per-item fallback remains available.
  - Acceptance: embedding batches respect `maxBatchSize` and `maxConcurrentEmbeddings`; failures are isolated and observable.
  - Verification: fake-provider tests with call counters and deterministic limits.
  - Files: `src/embeddings.ts`, `src/service.ts`, tests.
  - Scope: M.

### Checkpoint: Batch operations

- [x] Full suite green; no unbounded request-body or batch memory growth.

### Phase 3: Background work

- [x] Task 5: Add internal `JobQueue` with typed jobs, bounded capacity, retry/error policy, and drain/shutdown.
  - Handlers cover maintenance, embedding, consolidation, validation, and archiving with policy checks.
  - Acceptance: embedding, consolidation, maintenance, and validation jobs can be enqueued; queue-full and worker errors are typed; no job runs after shutdown begins.
  - Verification: deterministic fake-worker tests for ordering, concurrency, capacity, retries, and shutdown.
  - Files: `src/job-queue.ts`, `src/service.ts`, tests.
  - Scope: M.

- [x] Task 6: Add resource-limit configuration and metrics.
  - Queue, batch, embedding limits are configurable; lifecycle, queue-depth, and batch/embedding metrics are exposed.
  - Acceptance: queue, batch, embedding, and LLM limits are configurable, bounded, and exposed through existing metrics conventions.
  - Verification: configuration and metrics tests; audit shows no secrets.
  - Files: `src/metrics.ts`, `src/service.ts`, `docs/observability.md`, tests.
  - Scope: S/M.

### Checkpoint: Background work

- [x] Full suite green; shutdown leaves no active handles or pending jobs.

### Phase 4: Scale validation and release

- [x] Task 7: Run 10K/50K benchmark comparison and document thresholds.
  - Acceptance: `docs/performance.md` contains methodology, baseline, optimized result, and known limits.
  - Verification: benchmark command and reproducibility check.
  - Files: `docs/performance.md`, `PERF.md` if needed.
  - Scope: S.

- [x] Task 8: Prepare V4.8.0 changelog, version, tag, GitHub Release, and npm publish.
  - Acceptance: all exit criteria pass; release artifacts point to the same commit.
  - Verification: build, full tests, audit, tag/release/package checks.
  - Files: `CHANGELOG.md`, `src/version.ts`, `package.json`, `package-lock.json`.
  - Scope: S.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Candidate limits change ranking | High | Keep fallback path; add golden-result and scope-policy tests |
| Batch partial writes surprise callers | High | Validate/prepare first where possible and return per-item outcomes |
| Queue retries duplicate external work | Medium | Job IDs/idempotency keys and explicit retry policy |
| Benchmark becomes flaky | Medium | Fixed seed, warmup, repeated samples, percentile reporting |
| Agent visibility bypass through optimization | Critical | Apply policy before candidate/ranking boundaries and test adversarial scopes |

## Open Questions

- Should batch HTTP endpoints be `/memories/batch/*` or a single `/memories/batch` action in the first release? Default: one action endpoint with an explicit operation discriminator.
- Should the file backend receive a separate persistent index, or remain scan-based while SQLite receives indexed candidate queries? Default: keep file backend simple; optimize SQLite first and document the boundary.
