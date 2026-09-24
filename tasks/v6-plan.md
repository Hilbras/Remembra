# V6.0.0 Implementation Plan: Security-First Memory Platform

## Overview

V6 evolves the released V5 platform into a provider-independent, offline-first
memory system with first-class trust, sensitivity, expiration, access, and
retention policy. The plan deliberately starts with contracts and fail-closed
security decisions, then builds the core runtime, provider boundary, versioned
API domains, migration/recovery tooling, and finally scale/release evidence.

This is an implementation plan, not a claim that V6 is implemented. The
architecture source of truth is [`docs/v6-architecture-spec.md`](../docs/v6-architecture-spec.md).
No V5 schema, API, package version, or release tag changes until the relevant
V6 compatibility and migration gates are green.

## Planning assumptions

These assumptions are explicit review targets, not hidden decisions:

1. V5 remains supported throughout the migration window.
2. V6 uses a new explicit API contract; V5 routes and tools do not silently
   change meaning.
3. The default V6 deployment is local/offline and provider-free.
4. External providers are optional capabilities, never authorization sources.
5. Policy denial wins over permission, and missing/ambiguous policy fails
   closed.
6. Trust and sensitivity are separate policy axes.
7. Expiration is distinct from archival, deletion, and supersession.
8. Every persisted policy, schema, snapshot, migration, provider adapter, and
   audit artifact carries an explicit version.
9. The current V5 file/SQLite backends remain the compatibility baseline; new
   storage semantics are introduced through versioned migrations.
10. Public request fields never become authoritative identity, sensitivity,
    trust, access, or expiration claims.

## Capability map and dependency graph

| Module ID | Responsibility | Depends on |
|---|---|---|
| `v6-policy-model` | Trust, sensitivity, access, retention, expiration, policy decisions | — |
| `v6-request-security` | Identity, authorization, tenant binding, replay/idempotency, request enforcement | `v6-policy-model` |
| `v6-core-runtime` | Offline storage, retrieval, context, lifecycle, policy-aware service | `v6-request-security` |
| `v6-provider-boundary` | Optional embeddings, classification, summarization, consolidation | `v6-core-runtime` |
| `v6-api-domains` | Versioned Memory, Knowledge, Context, Tenant, Policy, Snapshot, Audit, Provider APIs | `v6-core-runtime`, `v6-provider-boundary` |
| `v6-migration` | V5 analysis, report, dry-run, migration, verification, rollback | `v6-policy-model`, `v6-core-runtime` |
| `v6-reliability` | Atomic publication, crash recovery, corruption handling, replay safety | `v6-core-runtime`, `v6-migration` |
| `v6-observability` | Policy decisions, audit evidence, metrics, diagnostics, redaction | `v6-request-security`, `v6-core-runtime` |
| `v6-performance` | 10K/100K/1M/10M+ retrieval and context budgets | `v6-core-runtime`, `v6-reliability` |
| `v6-release` | Compatibility matrix, security review, package verification, publication | all capabilities |

```text
v6-policy-model
      ↓
v6-request-security
      ↓
v6-core-runtime
      ↓
v6-provider-boundary
      ↓
v6-api-domains
      ↓
v6-migration + v6-reliability + v6-observability
      ↓
v6-performance
      ↓
v6-release
```

## Task list

### Phase 0: Decision gates and contracts

#### V6-T01: Freeze V6 policy and version decisions

**Description:** Resolve the open semantic questions in the V6 architecture
specification before schema or API implementation begins. Record decisions for
sensitivity labels, expiration semantics, policy precedence, API versioning,
replay/idempotency, and the V5 compatibility window.

**Acceptance criteria:**

- [ ] Trust, sensitivity, access, retention, and expiration have precise,
  testable definitions and conflict rules.
- [ ] The V6 API/versioning strategy and V5 compatibility window are approved.
- [ ] Replay/idempotency scope covers writes, jobs, snapshots, migrations, and
  provider operations.
- [ ] Every unresolved decision has an owner, due version, and safe default.

**Verification:**

- [ ] Architecture/spec review recorded in the repository.
- [ ] Decision fixtures cover allow, deny, redact, quarantine, expired, and
  policy-invalid cases.
- [ ] No implementation task begins with an unresolved blocking decision.

**Dependencies:** None

**Files likely touched:**

- `docs/v6-architecture-spec.md`
- `docs/decisions/` or the repository's established ADR location
- `tasks/v6-plan.md`
- `tasks/v6-todo.md`

**Estimated scope:** S/M

#### V6-T02: Define versioned policy and decision schemas

**Description:** Introduce typed, versioned policy documents and policy
decision results that can be validated, evaluated, explained, and migrated
without embedding security rules in request payloads.

**Acceptance criteria:**

- [ ] Policy documents have a version, bounded schema, source, and immutable
  identity.
- [ ] Decisions have a closed effect/reason vocabulary and policy version.
- [ ] Precedence is deterministic: system safety → tenant → resource →
  principal → memory → provider/export constraints.
- [ ] Invalid or unknown policy fails closed and never falls back to allow.

**Verification:**

- [ ] Unit/property tests for precedence, deny-wins, malformed input, unknown
  fields, and version mismatch.
- [ ] Fixtures demonstrate why each decision was allowed or denied without
  exposing private content.
- [ ] Typecheck/build succeeds.

**Dependencies:** V6-T01

**Files likely touched:**

- `src/v6-policy.ts` (new)
- `src/errors.ts`
- `src/test/v6-policy.test.ts` (new)
- `docs/v6-policy.md` (new)

**Estimated scope:** M

#### V6-T03: Define V6 memory metadata and schema contract

**Description:** Specify the persisted V6 memory representation for tenant
binding, trust, sensitivity, expiration, retention, policy references, and
versioned relations while preserving V5 schema readability.

**Acceptance criteria:**

- [ ] Every new field has type, default, owner, validation, serialization,
  redaction, indexing, and migration behavior.
- [ ] Expiration, archive, deletion, and supersession states are distinct.
- [ ] V5 records are classified explicitly as legacy/migrated/incompatible;
  they are not silently reinterpreted.
- [ ] Unknown/newer schema versions fail or quarantine according to an explicit
  compatibility policy.

**Verification:**

- [ ] Round-trip fixtures cover all eleven memory types and policy states.
- [ ] Upgrade/downgrade/read-only compatibility fixtures are documented.
- [ ] Reference and tenant foreign-key validation is covered.

**Dependencies:** V6-T01, V6-T02

**Files likely touched:**

- `src/types.ts`
- `src/backend.ts`
- `src/store.ts`
- `src/sqlite-backend.ts`
- `src/test/v6-schema.test.ts` (new)

**Estimated scope:** L (split during implementation into contract, file schema,
and SQLite schema tasks)

### Checkpoint: Contracts

- [ ] V6 policy and schema decisions are approved.
- [ ] V5 compatibility fixtures remain green.
- [ ] Security review confirms no public field can alter policy decisions.
- [ ] Human review approves moving to implementation.

### Phase 1: Request security and policy enforcement

#### V6-T04: Implement identity, authorization, and replay context

**Description:** Add immutable V6 request context types for authenticated
identity, tenant, operation, policy version, deadline, and idempotency/replay
identity.

**Acceptance criteria:**

- [ ] Identity and tenant are resolved by trusted host code only.
- [ ] Operation classes are explicit and bounded.
- [ ] Replay keys are scoped, validated, bounded, and never contain secrets.
- [ ] Missing, expired, malformed, or replayed context fails closed.

**Verification:**

- [ ] Unit tests for forged identity, stale membership, operation mismatch,
  expiry, duplicate requests, and secret-bearing keys.
- [ ] HTTP/MCP/SDK adapter tests prove public fields are rejected.

**Dependencies:** V6-T02, V6-T03

**Files likely touched:**

- `src/v6-request-context.ts` (new)
- `src/tenant.ts`
- `src/http.ts`
- `src/test/v6-request-security.test.ts` (new)

**Estimated scope:** M

#### V6-T05: Implement the policy evaluator

**Description:** Build the pure, deterministic evaluator for authorization,
sensitivity, trust, retention, expiration, and provider/export constraints.

**Acceptance criteria:**

- [ ] Evaluator is side-effect free and deterministic for a fixed policy/input.
- [ ] Explicit deny wins; missing or conflicting policy fails closed.
- [ ] Expiration is evaluated before normal retrieval eligibility.
- [ ] Decisions include bounded reason codes and policy version only; private
  content and secrets are excluded.

**Verification:**

- [ ] Table-driven tests for every policy axis and conflict pair.
- [ ] Property tests prove no invalid input can produce an allow decision.
- [ ] Decision explanations are stable and redacted.

**Dependencies:** V6-T02, V6-T04

**Files likely touched:**

- `src/v6-policy.ts`
- `src/v6-policy-evaluator.ts` (new)
- `src/test/v6-policy-evaluator.test.ts` (new)
- `docs/v6-policy.md`

**Estimated scope:** M

#### V6-T06: Enforce policy on direct memory operations

**Description:** Integrate the evaluator into memory create, read, update,
archive, revive, delete, history, relation, batch, and snapshot paths before
storage access.

**Acceptance criteria:**

- [ ] No direct CRUD path bypasses identity, authorization, tenant, and policy.
- [ ] Expired or unauthorized records are not returned through alternate IDs,
  history, relations, batches, or exports.
- [ ] Policy failures use stable codes and normalized not-found behavior where
  required to prevent existence leaks.
- [ ] Successful decisions emit bounded audit metadata.

**Verification:**

- [ ] Cross-tenant, cross-project, sensitivity, expiration, and privilege
  escalation tests for every direct operation.
- [ ] Batch partial-failure behavior cannot expose unauthorized item existence.
- [ ] Existing V5 legacy-mode behavior remains unchanged.

**Dependencies:** V6-T04, V6-T05

**Files likely touched:**

- `src/service.ts`
- `src/backend.ts`
- `src/store.ts`
- `src/test/v6-service-policy.test.ts` (new)

**Estimated scope:** L (split direct reads, writes, and exports into separate
implementation tasks if needed)

#### V6-T07: Enforce policy before retrieval candidates and ranking

**Description:** Apply the V6 policy decision before candidate generation,
joins, ranking, counts, relation expansion, context selection, and cursor
creation in both storage backends.

**Acceptance criteria:**

- [ ] Tenant/sensitivity/expiration predicates occur before SQL/file limits.
- [ ] Keyword, vector, FTS, relation, temporal, and cache paths share the same
  policy boundary.
- [ ] Candidate, edge, context, and provider budgets remain hard bounded.
- [ ] No fallback path turns an unauthorized query into a global scan.

**Verification:**

- [ ] Backend query-plan/SQL predicate tests and file namespace tests.
- [ ] Adversarial candidate, relation-cycle, cache, and context tests.
- [ ] Retrieval quality and isolation regression suite remains green.

**Dependencies:** V6-T05, V6-T06

**Files likely touched:**

- `src/sqlite-backend.ts`
- `src/store.ts`
- `src/retrieval.ts`
- `src/context.ts`
- `src/test/v6-retrieval-policy.test.ts` (new)

**Estimated scope:** L

#### V6-T08: Add policy decision audit and redaction

**Description:** Emit low-cardinality, content-free audit events for policy
decisions and expose safe explanations to authorized operators.

**Acceptance criteria:**

- [ ] Audit events identify actor, tenant, operation, policy version, effect,
  reason, resource class, and outcome.
- [ ] Events never contain memory content, secrets, raw provider payloads, or
  unbounded identifiers.
- [ ] Correlation and replay identifiers are bounded and access-controlled.
- [ ] Audit queries are paginated and tenant-filtered.

**Verification:**

- [ ] Audit schema, redaction, pagination, and denial tests.
- [ ] Log and metrics review confirms no sensitive fixture values appear.
- [ ] Operators can explain a decision without reading private content.

**Dependencies:** V6-T05, V6-T06, V6-T07

**Files likely touched:**

- `src/audit.ts` (new or extended)
- `src/metrics.ts`
- `src/http.ts`
- `src/test/v6-audit.test.ts` (new)
- `docs/observability.md`

**Estimated scope:** M

### Checkpoint: Security foundation

- [ ] Every data-plane path has identity → authorization → tenant → policy
  enforcement.
- [ ] Adversarial security matrix is green.
- [ ] Policy decisions are explainable without content leakage.
- [ ] Human security review approves provider and storage work.

### Phase 2: Offline-first core runtime

#### V6-T09: Define provider-neutral core capability contracts

**Description:** Separate durable core operations from optional intelligence
capabilities through versioned interfaces and capability negotiation.

**Acceptance criteria:**

- [ ] Core interfaces cover storage, retrieval, context, policy, lifecycle,
  audit, and snapshots without provider types.
- [ ] Provider interfaces declare capability, privacy, cost, latency, and
  availability metadata.
- [ ] Provider absence is a supported runtime state, not a startup error.
- [ ] Provider output cannot mutate authorization or policy state.

**Verification:**

- [ ] Contract tests run with no provider, a local provider, and a failing
  remote provider.
- [ ] Dependency graph confirms core packages do not import provider SDKs.
- [ ] Public type/API compatibility checks pass.

**Dependencies:** V6-T05, V6-T08

**Files likely touched:**

- `src/core-contract.ts` (new)
- `src/provider-boundary.ts` (new)
- `src/service.ts`
- `src/test/v6-core-contract.test.ts` (new)
- `docs/architecture.md`

**Estimated scope:** M

#### V6-T10: Implement offline and degraded operation modes

**Description:** Ensure local storage, retrieval, context, tenant enforcement,
policy, snapshots, audit, and recovery work without remote services and degrade
predictably when optional providers fail.

**Acceptance criteria:**

- [ ] A disconnected local installation passes the core user journey.
- [ ] Provider timeout, malformed output, rate limit, and cancellation have
  documented fail-open/fail-closed behavior per operation.
- [ ] No provider error creates a partial tenant or policy state.
- [ ] Operational status distinguishes core unavailable from provider degraded.

**Verification:**

- [ ] Offline test profile with network access denied.
- [ ] Provider fault-injection tests for every optional capability.
- [ ] Health/readiness and metrics report core/provider status separately.

**Dependencies:** V6-T09

**Files likely touched:**

- `src/service.ts`
- `src/provider-boundary.ts`
- `src/health.ts` or existing health module
- `src/test/v6-offline.test.ts` (new)
- `docs/self-hosting.md`

**Estimated scope:** M

#### V6-T11: Implement expiration and lifecycle orchestration

**Description:** Add deterministic expiration evaluation, renewal, archive,
deletion, legal-hold/operator override, and lifecycle audit behavior.

**Acceptance criteria:**

- [ ] Expiration clock and timezone semantics are explicit and tested.
- [ ] Expired content is excluded from normal context/search by default.
- [ ] Retention, legal hold, archive, deletion, and supersession cannot be
  confused or silently overridden.
- [ ] Lifecycle jobs are bounded, idempotent, tenant-aware, and recheck policy.

**Verification:**

- [ ] Boundary tests for now, future, past, clock skew, renewal, and malformed
  timestamps.
- [ ] Concurrent lifecycle and retrieval tests.
- [ ] Failure/restart tests prove no duplicate deletion or resurrection.

**Dependencies:** V6-T03, V6-T05, V6-T09

**Files likely touched:**

- `src/service.ts`
- `src/job-queue.ts`
- `src/lifecycle.ts` (new or extended)
- `src/test/v6-lifecycle.test.ts` (new)
- `docs/lifecycle.md`

**Estimated scope:** L

### Checkpoint: Core runtime

- [ ] Offline CRUD/search/context/tenant/policy flows pass.
- [ ] Provider absence and provider failure are explicitly tested.
- [ ] Lifecycle/expiration behavior is deterministic and auditable.
- [ ] No V5 compatibility regression is present.

### Phase 3: Provider boundary

#### V6-T12: Add provider capability and privacy metadata

**Description:** Add provider manifests describing data classes, regions,
retention, cost, latency, and whether a provider may receive sensitive content.

**Acceptance criteria:**

- [ ] Every provider declares supported capabilities and data-handling limits.
- [ ] Policy can deny provider transmission based on sensitivity and tenant
  rules before network work begins.
- [ ] Provider configuration is versioned and validated.
- [ ] Credentials never enter memory records, audit events, or logs.

**Verification:**

- [ ] Provider manifest schema and validation tests.
- [ ] Sensitive-content transmission denial tests.
- [ ] Secret/log redaction tests.

**Dependencies:** V6-T09, V6-T10

**Files likely touched:**

- `src/provider-boundary.ts`
- `src/provider-adapters.ts`
- `src/test/v6-provider-boundary.test.ts` (new)
- `docs/providers.md`

**Estimated scope:** M

#### V6-T13: Add local and remote intelligence adapters

**Description:** Implement optional local/remote adapters for embeddings,
classification, summarization, and consolidation without making them core
dependencies.

**Acceptance criteria:**

- [ ] Local adapters work without network access.
- [ ] Remote adapters are optional, bounded, cancellable, and policy-gated.
- [ ] Unsupported capabilities return a typed capability result.
- [ ] Provider output is schema-validated and cannot grant trust/access.

**Verification:**

- [ ] Adapter contract suite runs against local, fake, and remote-test servers.
- [ ] Timeout, retry, cancellation, malformed response, and rate-limit tests.
- [ ] Core tests pass with every provider disabled.

**Dependencies:** V6-T12

**Files likely touched:**

- `src/provider-adapters.ts`
- `src/providers/` (new, if modularization is approved)
- `src/test/v6-provider-adapters.test.ts` (new)
- `docs/providers.md`

**Estimated scope:** L

#### V6-T14: Add provider-safe jobs, caching, and replay handling

**Description:** Make provider work cancellable, tenant-partitioned, replay-safe,
and observable without allowing a retry to duplicate writes or bypass policy.

**Acceptance criteria:**

- [ ] Every provider job carries immutable request, tenant, policy, and
  idempotency context.
- [ ] Retries cannot repeat a committed mutation or expand its authorization.
- [ ] Provider cache keys include tenant-safe partitions and policy-relevant
  inputs.
- [ ] Queue capacity, concurrency, timeout, and replay budgets are bounded.

**Verification:**

- [ ] Duplicate delivery, cancellation, retry, and worker-restart tests.
- [ ] Cache isolation and invalidation tests.
- [ ] Queue exhaustion and provider outage tests.

**Dependencies:** V6-T08, V6-T12, V6-T13

**Files likely touched:**

- `src/job-queue.ts`
- `src/provider-boundary.ts`
- `src/service.ts`
- `src/test/v6-provider-jobs.test.ts` (new)
- `docs/observability.md`

**Estimated scope:** M

### Checkpoint: Provider independence

- [ ] Core works with no providers installed or configured.
- [ ] Optional intelligence cannot change authorization, trust, or sensitivity.
- [ ] Remote provider data handling is policy-gated and audited.
- [ ] Provider failure/retry behavior is deterministic.

### Phase 4: Versioned API domains

#### V6-T15: Define V6 API versioning and domain schemas

**Description:** Establish the V6 transport version, compatibility rules,
request/response envelopes, error model, pagination, idempotency, and domain
schemas before route implementation.

**Acceptance criteria:**

- [ ] Versioning strategy is explicit and preserves V5 behavior.
- [ ] Each domain has a bounded request/response schema and error mapping.
- [ ] Public identity and server-managed policy fields are rejected.
- [ ] Compatibility aliases and deprecation windows are documented.

**Verification:**

- [ ] Contract fixtures for every V6 domain.
- [ ] Version negotiation and unknown-version tests.
- [ ] V5 client compatibility smoke tests remain green.

**Dependencies:** V6-T02, V6-T03, V6-T04

**Files likely touched:**

- `src/http.ts`
- `src/api/` (new, if approved)
- `src/test/v6-api-contract.test.ts` (new)
- `docs/public-api.md`

**Estimated scope:** L

#### V6-T16: Implement Memory, Knowledge, and Context APIs

**Description:** Deliver the first vertical V6 API slice: policy-aware memory
operations, typed relations/history, and deterministic context assembly.

**Acceptance criteria:**

- [ ] CRUD, relations, history, search, and context use the V6 policy path.
- [ ] Context budgets, candidate limits, sensitivity, and expiration are
  enforced before response serialization.
- [ ] Normalized errors do not disclose foreign resource existence.
- [ ] API behavior is covered through service and transport tests.

**Verification:**

- [ ] End-to-end HTTP/SDK contract tests.
- [ ] Adversarial cross-tenant, sensitivity, expiration, and prompt-injection
  fixtures.
- [ ] V5 legacy route regression tests.

**Dependencies:** V6-T06, V6-T07, V6-T15

**Files likely touched:**

- `src/http.ts`
- `src/sdk.ts`
- `src/service.ts`
- `src/test/v6-memory-api.test.ts` (new)
- `docs/public-api.md`

**Estimated scope:** L

#### V6-T17: Implement Tenant, Policy, and Provider APIs

**Description:** Expose trusted organization/membership administration,
policy inspection/simulation, and optional provider capability/health
operations.

**Acceptance criteria:**

- [ ] Tenant resource selectors cannot become authoritative identity.
- [ ] Policy simulation is side-effect free and redacts resource content.
- [ ] Provider configuration requires explicit host authorization and secret
  handling.
- [ ] All mutations are versioned, bounded, idempotent, and audited.

**Verification:**

- [ ] Cross-tenant and privilege-escalation API tests.
- [ ] Policy simulation/decision explanation tests.
- [ ] Provider secret and configuration boundary tests.

**Dependencies:** V6-T08, V6-T12, V6-T15

**Files likely touched:**

- `src/http.ts`
- `src/tenant-entities.ts`
- `src/provider-boundary.ts`
- `src/test/v6-tenant-policy-api.test.ts` (new)
- `docs/public-api.md`

**Estimated scope:** L

#### V6-T18: Implement Snapshot, Audit, and recovery APIs

**Description:** Deliver versioned snapshot preview/import/export, audit
queries, policy decision history, and recovery state visibility.

**Acceptance criteria:**

- [ ] Snapshot operations are signed, bounded, preflighted, and idempotent.
- [ ] Audit queries are tenant-filtered, paginated, and content-free.
- [ ] Recovery state exposes progress/failure without leaking private data.
- [ ] V5 snapshot compatibility is explicit and tested.

**Verification:**

- [ ] Snapshot/audit/recovery API contract tests.
- [ ] Cross-tenant export and audit access tests.
- [ ] Dry-run/no-write and interrupted-publication tests.

**Dependencies:** V6-T08, V6-T10, V6-T15

**Files likely touched:**

- `src/http.ts`
- `src/recovery.ts`
- `src/migration-state.ts`
- `src/test/v6-snapshot-audit-api.test.ts` (new)
- `docs/public-api.md`

**Estimated scope:** L

### Checkpoint: API domains

- [ ] All V6 domain contracts are versioned and documented.
- [ ] V5 clients and routes remain compatible where promised.
- [ ] Every route shares identity, authorization, tenant, and policy enforcement.
- [ ] API security and contract review passes before migration work.

### Phase 5: V5 migration and reliability

#### V6-T19: Build the V5 migration analyzer and compatibility report

**Description:** Inventory V5 databases, snapshots, policy metadata, tenant
records, relations, and provider state without modifying the source.

**Acceptance criteria:**

- [ ] Analyzer detects schema, tenant, policy, sensitivity, expiration, orphan,
  and compatibility issues.
- [ ] Report is machine-readable and human-readable with counts and blockers.
- [ ] Analysis is read-only, bounded, deterministic, and secret-safe.
- [ ] V5 unknown/newer records are classified rather than guessed.

**Verification:**

- [ ] Golden V5/V6/mixed fixture reports.
- [ ] Read-only filesystem/database assertions.
- [ ] Large-corpus analyzer benchmark.

**Dependencies:** V6-T03, V6-T15

**Files likely touched:**

- `src/v6-migration-analyzer.ts` (new)
- `src/migration-state.ts`
- `src/test/v6-migration-analyzer.test.ts` (new)
- `docs/v6-migration.md` (new)

**Estimated scope:** M/L

#### V6-T20: Implement migration dry-run and durable execution

**Description:** Apply a signed, versioned V5→V6 migration plan in bounded
batches with checkpoints, idempotency, failure records, and verified resume.

**Acceptance criteria:**

- [ ] Dry-run performs the complete transformation without publishing.
- [ ] Execution records checksums, counts, references, and checkpoint state.
- [ ] Retried batches do not duplicate records or weaken policy.
- [ ] Interrupted execution resumes only after validating prior state.

**Verification:**

- [ ] Dry-run, interruption, retry, partial failure, and resume fixtures.
- [ ] Cross-tenant/reference integrity tests.
- [ ] Migration state file corruption and permission tests.

**Dependencies:** V6-T19, V6-T06, V6-T08

**Files likely touched:**

- `src/v6-migration-runner.ts` (new)
- `src/migration-state.ts`
- `src/test/v6-migration-runner.test.ts` (new)
- `docs/v6-migration.md`

**Estimated scope:** L

#### V6-T21: Implement verification, publication, and rollback

**Description:** Verify migrated data and publish only after an explicit
operator marker; retain a tested rollback path to V5 or the pre-migration V6
state.

**Acceptance criteria:**

- [ ] Verification compares counts, checksums, policy decisions, references,
  lifecycle state, and representative retrieval.
- [ ] Publication is atomic per backend and requires explicit confirmation.
- [ ] Rollback is documented, bounded, and tested after partial failure.
- [ ] Source V5 data remains untouched until publication.

**Verification:**

- [ ] Successful migration, failed publication, rollback, and disaster fixtures.
- [ ] Backup/restore and SQLite sidecar/corruption tests.
- [ ] Old-reader/new-reader compatibility tests.

**Dependencies:** V6-T20

**Files likely touched:**

- `src/v6-migration-runner.ts`
- `src/sqlite-recovery.ts`
- `src/recovery.ts`
- `src/test/v6-migration-recovery.test.ts` (new)
- `docs/v6-migration.md`

**Estimated scope:** L

#### V6-T22: Add crash, corruption, replay, and disaster-recovery fixtures

**Description:** Build a unified adversarial recovery matrix covering all
backends, transports, jobs, providers, and migration states.

**Acceptance criteria:**

- [ ] Interrupted writes, archive/revive, publication, and migration recover
  without duplicate or resurrected data.
- [ ] Corrupted files, databases, snapshots, sidecars, and state are rejected
  loudly or quarantined according to policy.
- [ ] Replay and retry scenarios cannot bypass idempotency or authorization.
- [ ] Rollback evidence is retained for each supported backend.

**Verification:**

- [ ] Dedicated recovery test command covers file and SQLite matrices.
- [ ] Fault injection runs repeatedly without flaky cleanup.
- [ ] Recovery time and resource use are recorded.

**Dependencies:** V6-T10, V6-T14, V6-T20, V6-T21

**Files likely touched:**

- `src/test/v6-disaster-recovery.test.ts` (new)
- `scripts/` recovery fixtures
- `src/recovery.ts`
- `src/sqlite-recovery.ts`
- `docs/v6-release-gates.md` or successor gate document

**Estimated scope:** L

### Checkpoint: Migration and recovery

- [ ] V5 analysis, dry-run, migration, verification, publication, and rollback
  are green.
- [ ] Mixed/unknown data is never served silently.
- [ ] Disaster fixtures pass repeatedly on supported Node versions.
- [ ] Operator runbook is reviewed.

### Phase 6: Observability and scale

#### V6-T23: Add policy-aware observability and diagnostics

**Description:** Expose bounded metrics, traces, audit evidence, health, and
decision explanations for V6 without logging private memory content.

**Acceptance criteria:**

- [ ] Metrics distinguish policy denies, expiration, sensitivity quarantine,
  provider degradation, replay, migration, and recovery outcomes.
- [ ] Labels are low-cardinality and contain no raw IDs, content, or secrets.
- [ ] Operators can trace a request from identity to policy decision to
  retrieval without exposing the resource.
- [ ] Health distinguishes core unavailable, policy invalid, and provider
  degraded states.

**Verification:**

- [ ] Metrics/audit/tracing redaction tests.
- [ ] Cardinality and bounded-label tests.
- [ ] Operational dashboard/runbook review.

**Dependencies:** V6-T08, V6-T10, V6-T18

**Files likely touched:**

- `src/metrics.ts`
- `src/log.ts`
- `src/http.ts`
- `src/test/v6-observability.test.ts` (new)
- `docs/observability.md`

**Estimated scope:** M

#### V6-T24: Build 10K/100K/1M/10M+ benchmark profiles

**Description:** Extend reproducible benchmarks to measure V6 policy overhead,
offline behavior, retrieval quality, context budgets, memory use, and recovery.

**Acceptance criteria:**

- [ ] Fixed datasets and seeds produce comparable runs.
- [ ] Reports include backend, hardware, policy profile, p50/p95, memory,
  candidate counts, token counts, and failure behavior.
- [ ] 10K, 100K, 1M, and supported 10M+ profiles are reproducible.
- [ ] No benchmark claims a scale level without a passing evidence artifact.

**Verification:**

- [ ] `npm run bench:scale` and tenant/offline profiles.
- [ ] Repeated-run comparison and resource telemetry.
- [ ] Documented thresholds for correctness, latency, and memory.

**Dependencies:** V6-T07, V6-T10, V6-T22

**Files likely touched:**

- `scripts/bench-scale.mjs`
- `scripts/bench-tenant.mjs`
- `scripts/` seed/profile helpers
- `src/test/v6-performance.test.ts` (new)
- `docs/v6-performance.md` (new)

**Estimated scope:** L

#### V6-T25: Run the V5 compatibility and security release matrix

**Description:** Produce the final cross-runtime evidence for V5 APIs,
snapshots, Markdown, MCP, SDK, tenant behavior, policy security, recovery, and
supported Node versions.

**Acceptance criteria:**

- [ ] V5 promised APIs and clients pass without semantic regressions.
- [ ] V5 snapshots/migration fixtures pass through V6 migration preview.
- [ ] Security matrix covers auth, authorization, tenant isolation, traversal,
  injection, secrets, rate limits, replay, and privilege escalation.
- [ ] Node support, build, audit, package contents, and install smoke tests pass.

**Verification:**

- [ ] `npm test`, focused security/recovery suites, and `npm run release:check`.
- [ ] Published/installed package compatibility smoke test.
- [ ] Human maintainer sign-off recorded.

**Dependencies:** V6-T16, V6-T17, V6-T18, V6-T22, V6-T23, V6-T24

**Files likely touched:**

- `scripts/release-gate.mjs`
- `src/test/` compatibility/security fixtures
- `docs/v5-tenant-spec.md`
- `docs/v6-release-gates.md` (new)
- `CHANGELOG.md`

**Estimated scope:** L

### Checkpoint: V6 release candidate

- [ ] All capability modules have evidence artifacts.
- [ ] No unresolved critical/high security finding remains.
- [ ] Performance and compatibility thresholds pass.
- [ ] Version, README, architecture, security, migration, and changelog docs
  are current.
- [ ] Maintainers approve the release candidate.

### Phase 7: V6.0.0 release

#### V6-T26: Prepare and publish V6.0.0

**Description:** Execute the 20-step release discipline from the V6
specification for the approved V6 release candidate.

**Acceptance criteria:**

- [ ] Version metadata, schema/API versions, package exports, and manifest are
  synchronized.
- [ ] Git commit, tag, GitHub Release, and npm package point to the same commit.
- [ ] Published package is downloaded/installed and smoke-tested.
- [ ] Post-release audit records migration, security, compatibility, and
  performance evidence.

**Verification:**

- [ ] `npm run release:check -- --expect-version 6.0.0`.
- [ ] `git verify-tag`, `gh release view`, `npm view`, and package install checks.
- [ ] Post-release audit is complete before the work is marked done.

**Dependencies:** V6-T25

**Files likely touched:**

- `package.json`
- `package-lock.json`
- `src/version.ts`
- `CHANGELOG.md`
- `README.md`
- `docs/v6-release-gates.md`

**Estimated scope:** M

## Parallelization opportunities

Safe parallel work after contracts are approved:

- policy evaluator tests and provider manifest tests;
- file-backend and SQLite migration fixtures;
- API contract fixtures after the common version/envelope is frozen;
- benchmark harness extensions after retrieval metrics are stable;
- documentation and threat-model updates alongside implementation.

Must remain sequential:

- policy/schema contract decisions;
- storage schema migrations;
- common API versioning and shared error envelopes;
- migration executor/publication/rollback;
- release tag and package publication.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| V6 policy fields are interpreted as client authority | Critical | Trusted request context, schema ownership, deny-by-default tests |
| Sensitivity/expiration semantics leak or delete data incorrectly | Critical | Explicit state machine, dry-run, legal-hold decision gate, recovery fixtures |
| V5 compatibility is broken by a schema/API change | High | Explicit versions, compatibility matrix, old-reader fixtures, no silent migration |
| Core accidentally depends on a provider | High | Provider-neutral contract tests and dependency review |
| Remote provider receives sensitive data | Critical | Pre-network policy gate, provider privacy manifest, redaction tests |
| Replay/retry duplicates mutations | High | Scoped idempotency keys, durable checkpoints, commit-aware job state |
| Migration partially publishes mixed data | Critical | Analyzer, dry-run, checksums, durable checkpoints, explicit publication/rollback |
| Policy evaluation becomes a retrieval bottleneck | High | Pure bounded evaluator, decision caching only with invalidation, benchmark early |
| Distributed mode weakens tenant or consistency guarantees | Critical | Define consistency/failure model before V5.2 implementation; default local mode |
| 10M+ benchmark is unreproducible or misleading | High | Fixed data/seed, hardware manifest, isolated workers, evidence artifact |
| Release process becomes ceremonial | High | Machine-readable gates, published evidence, post-release audit |

## Definition of done for V6 planning

- [ ] Capability map and dependency order approved.
- [ ] Every task has acceptance, verification, dependencies, file scope, and
  size.
- [ ] V6 schema/policy/API/migration open questions have owners and decisions.
- [ ] V5 compatibility and security tests are identified before implementation.
- [ ] Benchmarks have documented datasets, hardware, thresholds, and profiles.
- [ ] Release gates are executable and fail closed.
- [ ] Human maintainers approve the plan before implementation begins.

## Open questions requiring explicit decisions

1. Which sensitivity labels and inheritance rules are normative for V6?
2. What exact expiration clock, renewal, legal-hold, and deletion semantics apply?
3. Is policy evaluation built-in, host-provided, or composed through a stable
   interface?
4. Does V6 use `/api/v6`, content negotiation, or a domain-specific versioning
   scheme while preserving `/api/v1`?
5. What is the canonical idempotency/replay model across HTTP, MCP, jobs,
   snapshots, and providers?
6. Which local vector/index backends are supported for offline mode?
7. What consistency model does distributed Remembra require before V6.0.0?
8. What are the exact 1M and 10M+ performance/quality thresholds?
9. How long must V5 remain supported after V6.0.0?
10. Which audit evidence must be retained, for how long, and under which
    jurisdiction?

## Related documents

- [V6 architecture specification](../docs/v6-architecture-spec.md)
- [V5 implementation plan](v5-plan.md)
- [V5 tenant contract](../docs/v5-tenant-spec.md)
- [V5 policy configuration](../docs/v5-policy.md)
- [V5 release gates](../docs/v5-release-gates.md)
- [Public API and stability contract](../docs/public-api.md)
