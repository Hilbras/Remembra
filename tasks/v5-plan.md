# Implementation Plan: V5.0.0 Production Memory Platform

## Overview

V5 turns Remembra into a stable memory-infrastructure platform for
long-running and multi-tenant agent workloads. It preserves the V4 memory
model, local-first deployment, MCP/HTTP/SDK compatibility, Markdown export,
and provider abstraction while adding explicit context budgeting, policy
configuration, tenant isolation, recovery verification, and measurable release
gates.

V5 is a major-version boundary. New storage or identity semantics must be
versioned and migration-tested; existing V4 data must not be silently
reinterpreted.

## Product principles

1. **Memory is data, not executable policy.** Retrieval may surface memories,
   but trust, authorization, deletion, and standing-instruction behavior remain
   deterministic server-side decisions.
2. **No unbounded context or work.** Context budgets, candidate generation,
   provider calls, queues, request bodies, and tenant operations all have hard
   limits.
3. **Isolation before sharing.** Tenant and agent identity are established by
   trusted host context after authentication; public fields are never treated
   as authorization.
4. **Measure before claiming scale.** Retrieval quality, latency, memory use,
   and recovery behavior are benchmarked with reproducible corpora.
5. **Compatibility is a feature.** V4.9 clients and stored memories remain
   readable through the V5 migration window.

## Capability map and dependency order

| Capability | Responsibility | Depends on |
|---|---|---|
| `v5-contract` | Versioned context/policy/tenant contracts and threat model | — |
| `context-budget` | Token accounting and bounded context assembly | `v5-contract` |
| `policy-config` | Validated extraction/retrieval/lifecycle policy | `v5-contract` |
| `tenant-isolation` | Organization/user/project/agent namespaces and authorization | `v5-contract`, `policy-config` |
| `retrieval-quality` | Query understanding, hybrid retrieval, reranking, diversity, evaluation | `context-budget`, `tenant-isolation` |
| `recovery` | Verified snapshot, restore, migration, integrity metadata | `v5-contract` |
| `security-gates` | Threat-model tests, poisoning/isolation/audit checks | all data-plane capabilities |
| `performance-gates` | 10K/100K+ benchmarks and resource budgets | retrieval, context, recovery |
| `release-compat` | V4→V5 migration matrix, docs, package/release gates | all capabilities |

Build bottom-up: contracts → context → policy → tenancy → retrieval →
recovery/security/performance → release.

## Task list

### Phase 0 — Contract and threat model

- [x] Task 1: Define V5 public contracts and threat model.
  - Acceptance: context request/response, policy schema, tenant identity,
    version/migration rules, token-count semantics, and trust boundaries are
    written before implementation; every new field has storage/API/security/
    test/migration treatment.
  - Verification: contract review, fixture schemas, threat-model checklist.
  - Scope: S/M.

### Phase 1 — Context budgeting

- [x] Task 2: Add deterministic token accounting and `memory.context`.
  - Acceptance: a bounded context request accepts `query`, `scope`,
    `maxTokens`, and policy options; returns ranked memories, serialized
    context, token count, and retrieval metadata; never exceeds the budget;
    preserves trusted visibility, role/instruction gates, and deterministic
    ordering; supports a pluggable token counter.
  - Verification: unit/property tests for budget boundaries, Unicode/long
    memories, no-query context, agent isolation, and HTTP/SDK/MCP parity.
  - Scope: M.

- [x] Task 3: Publish the context API through stable transports.
  - Acceptance: `/api/v1/context`, SDK `context()`, and an explicit MCP tool
    use the same service contract; legacy search/store behavior is unchanged;
    response size and token inputs are bounded.
  - Verification: transport contract tests and package smoke tests.
  - Scope: M.

### Checkpoint: Context platform

- [x] Existing V4.9 search and memory APIs remain green.
- [x] Context output is deterministic and hard-bounded.
- [x] Agent/private-memory isolation is verified in context results.

### Phase 2 — Policy configuration

- [x] Task 4: Add validated, fail-closed policy configuration.
  - Acceptance: extraction, sensitive-data, lifecycle, retrieval diversity,
    reranking, and provenance requirements have typed defaults, environment
    or file loading, validation errors, and no request-body override of
    security policy.
  - Verification: policy parsing, precedence, invalid-value, and migration
    tests; documentation of precedence and safe defaults.
  - Scope: M.

### Phase 3 — Tenant and identity isolation

- [ ] Task 5: Design and implement tenant namespaces.
  - Acceptance: organization → user → project → agent relationships are
    explicit; trusted host context resolves tenant identity; every read,
    write, relation, export, job, and retrieval candidate is tenant-filtered;
    cross-tenant access fails closed and is audited.
  - Verification: adversarial isolation matrix, concurrent tenant tests,
    migration fixtures, and no unscoped backend query paths.
  - Scope: L.

Implementation slices:

1. [x] Tenant principal/filter validators and opaque directory-key contract.
2. [x] Versioned tenant fields and explicit signed migration manifest (the
   migration executor and readiness gate remain part of slice 6).
3. [x] Tenant-aware `MemoryBackend` contract plus file backend enforcement.
4. [ ] SQLite tenant columns, predicates, history/audit, and candidate SQL.
5. [ ] Service authorization, immutable job context, and transport binding.
6. [ ] Cross-tenant relation/import/export/maintenance hardening and matrix.

### Phase 4 — Retrieval quality and scale

- [ ] Task 6: Complete the bounded hybrid retrieval/context pipeline.
  - Acceptance: query understanding, keyword/vector candidates, relationship
    expansion, fusion, reranking, trust/temporal adjustment, diversity, and
    context budgeting are measurable and bounded; unsupported cases use safe
    documented fallbacks.
  - Verification: quality regression suite, adversarial retrieval cases, and
    benchmark reports against V4.9.
  - Scope: L.

- [ ] Task 7: Establish 10K/100K+ performance budgets.
  - Acceptance: indexed lookup, hybrid retrieval, context assembly, writes,
    provider failures, and memory use have measured p50/p95 targets; no normal
    path silently scans the full database.
  - Verification: reproducible benchmark harness, resource telemetry, and
    documented hardware/dataset assumptions.
  - Scope: M/L.

### Phase 5 — Recovery and security

- [ ] Task 8: Add verified backup/restore/migration workflows.
  - Acceptance: snapshot export, checksum/integrity verification, restore
    dry-run, atomic import, schema migration, and failure recovery are explicit
    and tested for file and SQLite backends.
  - Verification: corruption, interrupted restore, downgrade, and disaster
    recovery fixtures.
  - Scope: M/L.

- [ ] Task 9: Complete the V5 security baseline.
  - Acceptance: authenticated API, authorization, rate limits, request limits,
    timeouts, audit logs, scope/tenant isolation, poisoning protection, secret
    detection, safe provider handling, and secure defaults have automated
    evidence.
  - Verification: threat-model tests, dependency audit, penetration-oriented
    test cases, and release security review.
  - Scope: M/L.

### Phase 6 — Compatibility and release

- [ ] Task 10: Run the V4→V5 compatibility and release-gate matrix.
  - Acceptance: legacy MCP/HTTP/SDK/local-first/Markdown/provider behavior,
    migration, docs, 10K/100K benchmarks, Node support, full tests, build,
    audit, package, recovery, and security gates are green.
  - Verification: compatibility report, release checklist, package smoke test,
    and maintainer sign-off before tagging.
  - Scope: S/M.

## First vertical slice

The first implementation slice is Task 2 followed by Task 3:

```ts
memory.context({ query, scope, maxTokens: 4000 })
```

It reuses the V4.9 `MemoryService.search` authorization and ranking path, adds
an explicit token-budget selector, and exposes the same response through SDK,
HTTP, and MCP. It does not change the memory schema or tenant model yet. A
later slice can add tenant fields only after the threat model and migration
contract are approved.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Token estimates differ across model providers | High | Pluggable counter, explicit estimator metadata, conservative default, never exceed hard budget |
| Context assembly leaks private memories | Critical | Reuse trusted visibility filters before selection; adversarial agent tests |
| V5 schema fields are silently written by V4 clients | High | Versioned schema, migration manifest, fail-closed readers, compatibility fixtures |
| Tenant IDs become client-authoritative | Critical | Host-resolved tenant context, authorization at every backend/service boundary |
| Reranking or relationship expansion becomes unbounded | High | Candidate, relation-hop, time, and output budgets with metrics |
| Recovery writes partial state | Critical | Checksums, dry-run, atomic rename/import, interruption tests |
| V5 breaks V4 clients | High | Preserve V4.9 contracts, additive APIs first, explicit migration guide and matrix |
| Raw backend or pre-LIMIT candidates bypass tenant filters | Critical | Private strict-mode backend, tenant predicates in SQL/file enumeration, capability checks |
| Global jobs, decay, caches, or CLI paths cross tenants | Critical | Immutable tenant context, partitioned state, operator capability checks |
| Relation/reference fields leak foreign IDs | High | Tenant-aware resolution and normalized missing/not-found semantics |

## Open questions

- Should the default token counter be a conservative deterministic estimator,
  or should V5 require a provider-specific tokenizer? Default: estimator with
  an injectable counter; report the counter id in metadata.
- Should V5 tenant isolation be represented in the persisted memory object,
  a separate authorization index, or both? Default: persisted tenant metadata
  plus a separate policy index, with migration fixtures before implementation.
- What is the safe default context budget? Default: no implicit budget for
  existing `search`, but a bounded required/default budget for the new
  `context` API.
- Should V5 introduce `/api/v2` or extend `/api/v1`? Default: keep `/api/v1`
  compatible and add V5 fields/routes only under an explicitly versioned
  namespace after contract review.
