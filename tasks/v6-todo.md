# V6.0.0 Task List

Status: planning only. No task below authorizes implementation until the
capability map and Phase 0 decision gate are approved.

Source plan: [`v6-plan.md`](v6-plan.md)
Architecture contract: [`docs/v6-architecture-spec.md`](../docs/v6-architecture-spec.md)

## Phase 0: Decision gates and contracts

- [ ] **V6-T01 — Freeze V6 policy and version decisions**
  - Acceptance: trust, sensitivity, expiration, policy precedence, API versioning, replay/idempotency, and V5 compatibility decisions are approved.
  - Verify: architecture review and decision fixtures recorded; no blocking open question remains.
  - Depends on: none.

- [ ] **V6-T02 — Define versioned policy and decision schemas**
  - Acceptance: versioned bounded policy documents, closed decision effects/reasons, deterministic precedence, and fail-closed validation.
  - Verify: unit/property policy tests, invalid/unknown/version-mismatch fixtures, build/typecheck.
  - Depends on: V6-T01.

- [ ] **V6-T03 — Define V6 memory metadata and schema contract**
  - Acceptance: trust/sensitivity/expiration/retention/policy fields have defaults, validation, serialization, redaction, indexing, and migration rules; V5 records are classified explicitly.
  - Verify: eleven-type round trips, compatibility/downgrade fixtures, tenant/reference validation.
  - Depends on: V6-T01, V6-T02.

### Checkpoint: Contracts

- [ ] V6 policy/schema decisions approved.
- [ ] V5 compatibility fixtures green.
- [ ] Security review confirms public fields cannot alter policy.
- [ ] Maintainer review approves implementation.

## Phase 1: Request security and policy enforcement

- [ ] **V6-T04 — Implement identity, authorization, and replay context**
  - Acceptance: trusted immutable request context, explicit operation classes, bounded scoped idempotency keys, and fail-closed expiry/replay handling.
  - Verify: forged identity, stale membership, operation mismatch, expiry, duplicate request, and secret-key tests.
  - Depends on: V6-T02, V6-T03.

- [ ] **V6-T05 — Implement the policy evaluator**
  - Acceptance: deterministic side-effect-free evaluator for authorization, sensitivity, trust, retention, expiration, and provider/export constraints; deny wins.
  - Verify: table/property tests for every axis/conflict, malformed input never allows, stable redacted explanations.
  - Depends on: V6-T02, V6-T04.

- [ ] **V6-T06 — Enforce policy on direct memory operations**
  - Acceptance: CRUD, update, lifecycle, history, relations, batches, and snapshots cannot bypass identity/authorization/tenant/policy.
  - Verify: cross-tenant/project/sensitivity/expiration/privilege tests, normalized not-found, V5 regression tests.
  - Depends on: V6-T04, V6-T05.

- [ ] **V6-T07 — Enforce policy before retrieval candidates and ranking**
  - Acceptance: tenant/sensitivity/expiration predicates precede SQL/file limits, joins, counts, ranking, relations, caches, and context selection.
  - Verify: query-plan/file namespace tests, adversarial candidate/cycle/cache/context tests, retrieval quality regression.
  - Depends on: V6-T05, V6-T06.

- [ ] **V6-T08 — Add policy decision audit and redaction**
  - Acceptance: content-free bounded audit events and safe operator explanations for allow/deny/redact/quarantine/expired decisions.
  - Verify: audit schema/redaction/pagination/denial tests and log/metrics secret review.
  - Depends on: V6-T05, V6-T06, V6-T07.

### Checkpoint: Security foundation

- [ ] Every data-plane path enforces identity → authorization → tenant → policy.
- [ ] Adversarial security matrix is green.
- [ ] Decisions are explainable without content leakage.
- [ ] Security review approves provider/storage work.

## Phase 2: Offline-first core runtime

- [ ] **V6-T09 — Define provider-neutral core capability contracts**
  - Acceptance: core storage/retrieval/context/policy/lifecycle/audit/snapshot contracts do not require provider types; capability negotiation is versioned.
  - Verify: no-provider/local/failing-provider contract tests and dependency review.
  - Depends on: V6-T05, V6-T08.

- [ ] **V6-T10 — Implement offline and degraded operation modes**
  - Acceptance: local CRUD/search/context/tenant/policy/snapshot/audit/recovery works offline; provider failures have documented operation-specific behavior.
  - Verify: network-denied profile, provider fault injection, separate core/provider health.
  - Depends on: V6-T09.

- [ ] **V6-T11 — Implement expiration and lifecycle orchestration**
  - Acceptance: explicit clock semantics, renewal, archive/delete/legal-hold distinction, bounded idempotent lifecycle jobs, and tenant recheck.
  - Verify: boundary/concurrency/restart tests for expiration, archive, deletion, and supersession.
  - Depends on: V6-T03, V6-T05, V6-T09.

### Checkpoint: Core runtime

- [ ] Offline core flow passes with no provider.
- [ ] Provider absence/failure is explicit and tested.
- [ ] Expiration/lifecycle behavior is deterministic and audited.
- [ ] V5 regression suite remains green.

## Phase 3: Provider boundary

- [ ] **V6-T12 — Add provider capability and privacy metadata**
  - Acceptance: providers declare capability, privacy, cost, latency, retention, and sensitivity transmission rules; policy blocks disallowed transmission before network work.
  - Verify: manifest validation, sensitive-content denial, secret/log redaction.
  - Depends on: V6-T09, V6-T10.

- [ ] **V6-T13 — Add local and remote intelligence adapters**
  - Acceptance: optional local/remote embeddings, classification, summarization, and consolidation adapters are bounded, cancellable, schema-validated, and unable to grant trust/access.
  - Verify: local/fake/remote contract suites, timeout/retry/cancellation/malformed/rate-limit tests, all-provider-disabled core tests.
  - Depends on: V6-T12.

- [ ] **V6-T14 — Add provider-safe jobs, caching, and replay handling**
  - Acceptance: immutable tenant/policy/idempotency job context, no duplicate committed mutations on retry, tenant-partitioned caches, bounded queues/providers.
  - Verify: duplicate delivery, cancellation, worker restart, cache isolation, queue exhaustion, and outage tests.
  - Depends on: V6-T08, V6-T12, V6-T13.

### Checkpoint: Provider independence

- [ ] Core works with no providers.
- [ ] Optional intelligence cannot change authorization/trust/sensitivity.
- [ ] Remote data handling is policy-gated and audited.
- [ ] Retry/failure behavior is deterministic.

## Phase 4: Versioned API domains

- [ ] **V6-T15 — Define V6 API versioning and domain schemas**
  - Acceptance: version strategy, envelopes, errors, pagination, idempotency, bounded domain schemas, and V5 compatibility rules are approved.
  - Verify: contract fixtures, unknown-version tests, V5 client smoke tests.
  - Depends on: V6-T02, V6-T03, V6-T04.

- [ ] **V6-T16 — Implement Memory, Knowledge, and Context APIs**
  - Acceptance: policy-aware CRUD/relations/history/search/context share the V6 service path and preserve bounded/error semantics.
  - Verify: HTTP/SDK end-to-end, cross-tenant/sensitivity/expiration/injection fixtures, V5 route regression.
  - Depends on: V6-T06, V6-T07, V6-T15.

- [ ] **V6-T17 — Implement Tenant, Policy, and Provider APIs**
  - Acceptance: resource selectors are non-authoritative, policy simulation is side-effect-free/redacted, provider config requires host authorization and secret handling.
  - Verify: cross-tenant/privilege/policy/provider-secret contract tests.
  - Depends on: V6-T08, V6-T12, V6-T15.

- [ ] **V6-T18 — Implement Snapshot, Audit, and recovery APIs**
  - Acceptance: signed bounded snapshot operations, tenant-filtered paginated audit, safe recovery progress/failure visibility, explicit V5 snapshot compatibility.
  - Verify: snapshot/audit/recovery contracts, cross-tenant export/audit tests, dry-run/interrupted publication.
  - Depends on: V6-T08, V6-T10, V6-T15.

### Checkpoint: API domains

- [ ] All V6 domains are versioned and documented.
- [ ] V5 routes/clients remain compatible where promised.
- [ ] Every route shares identity/authorization/tenant/policy enforcement.
- [ ] API security and contract review passes.

## Phase 5: V5 migration and reliability

- [ ] **V6-T19 — Build V5 migration analyzer and compatibility report**
  - Acceptance: read-only bounded analyzer detects schema/tenant/policy/sensitivity/expiration/orphan issues and emits machine/human reports.
  - Verify: V5/V6/mixed golden reports, no-write assertions, large-corpus analyzer benchmark.
  - Depends on: V6-T03, V6-T15.

- [ ] **V6-T20 — Implement migration dry-run and durable execution**
  - Acceptance: complete no-publish dry-run, signed plan, bounded idempotent batches, checkpoints, failure records, verified resume.
  - Verify: interruption/retry/partial failure/resume/corrupt-state/permission fixtures.
  - Depends on: V6-T19, V6-T06, V6-T08.

- [ ] **V6-T21 — Implement verification, publication, and rollback**
  - Acceptance: count/checksum/policy/reference/lifecycle/retrieval verification, explicit atomic publication, tested rollback, untouched V5 source until publish.
  - Verify: success/failure/rollback/disaster/old-reader/new-reader fixtures.
  - Depends on: V6-T20.

- [ ] **V6-T22 — Add crash, corruption, replay, and disaster-recovery fixtures**
  - Acceptance: interrupted writes/lifecycle/publication/migration recover without duplicate/resurrected data; corruption and replay fail safely; backend rollback evidence retained.
  - Verify: repeated fault-injection matrix, recovery timing/resource evidence, supported Node versions.
  - Depends on: V6-T10, V6-T14, V6-T20, V6-T21.

### Checkpoint: Migration and recovery

- [ ] Analyze/dry-run/migrate/verify/publish/rollback flow is green.
- [ ] Mixed/unknown data is never served silently.
- [ ] Disaster fixtures pass repeatedly.
- [ ] Operator runbook reviewed.

## Phase 6: Observability and scale

- [ ] **V6-T23 — Add policy-aware observability and diagnostics**
  - Acceptance: bounded metrics/traces/audit/health distinguish policy, expiration, sensitivity, replay, migration, recovery, and provider outcomes without content/secrets.
  - Verify: redaction, cardinality, request-to-decision tracing, and operator dashboard/runbook tests.
  - Depends on: V6-T08, V6-T10, V6-T18.

- [ ] **V6-T24 — Build 10K/100K/1M/10M+ benchmark profiles**
  - Acceptance: fixed datasets/seeds report backend/hardware/policy/p50/p95/memory/candidates/tokens/failures for all supported scale points.
  - Verify: repeated scale/offline/tenant runs and documented correctness/latency/memory thresholds.
  - Depends on: V6-T07, V6-T10, V6-T22.

- [ ] **V6-T25 — Run V5 compatibility and security release matrix**
  - Acceptance: V5 APIs/clients/snapshots/Markdown/MCP/SDK, tenant/policy security, recovery, Node support, build, audit, package, and install checks pass.
  - Verify: full/security/recovery suites, release gate, published-package smoke test, maintainer sign-off.
  - Depends on: V6-T16, V6-T17, V6-T18, V6-T22, V6-T23, V6-T24.

### Checkpoint: V6 release candidate

- [ ] All capability modules have evidence artifacts.
- [ ] No critical/high security finding remains.
- [ ] Performance and compatibility thresholds pass.
- [ ] Documentation/version/changelog are current.
- [ ] Maintainers approve release candidate.

## Phase 7: V6.0.0 release

- [ ] **V6-T26 — Prepare and publish V6.0.0**
  - Acceptance: version/schema/API/package metadata synchronized; commit/tag/GitHub Release/npm point to one commit; published package installs and post-release audit passes.
  - Verify: `npm run release:check -- --expect-version 6.0.0`, tag/release/npm checks, installed-package smoke test, post-release audit.
  - Depends on: V6-T25.

### Checkpoint: V6.0.0 complete

- [ ] Release evidence manifest published.
- [ ] V5 compatibility window and migration runbook active.
- [ ] V6 support ownership and security response process recorded.
- [ ] Post-release audit complete.

## Definition of done for the planning phase

- [ ] Capability map and dependency order approved.
- [ ] Every task has acceptance, verification, dependencies, scope, and size.
- [ ] Open policy/schema/API/migration questions have owners and safe defaults.
- [ ] V5 compatibility/security/performance evidence is identified.
- [ ] Release gates are executable and fail closed.
- [ ] Maintainer review approves the plan before implementation.
