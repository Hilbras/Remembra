# Changelog

All notable changes to Remembra will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

> **Versioning:** from 3.0.0 on, package versions match roadmap milestones
> (3.0.0 = v3, 4.0.0 = v4). Earlier releases used independent semver:
> 0.1.0 = v1, 0.2.0 = v1.5, 0.3.0 = v2, 0.4.0 = v3.

## [Unreleased] — V5.0.0 development

**Production Memory Platform** — plan §13 of the Master Development Plan.
V5 work is additive until the tenant/schema migration contract is approved.

### Added

- **V5 context contract and threat model** covering token budgets, visibility,
  tenant boundaries, and release evidence.
- **Bounded context assembly** through `MemoryService.context`, the v1 HTTP
  route, the TypeScript SDK, and the additive `memory_context` MCP tool.
- **Conservative token estimator** with injectable counters, hard candidate and
  budget limits, deterministic ordering, and internal-vector omission.
- **Validated V5 policy configuration** with trusted file/env layering,
  fail-closed validation, lifecycle defaults, extraction control, retrieval
  toggles, and sensitive-data policy integration.
- **Effective embedding reranking** now honors the validated retrieval
  reranking policy with a deterministic cosine tie-breaker before MMR
  selection; unsupported/vectorless cases retain the fused order.
- **Bounded relation expansion** is available through validated retrieval
  policy, restricted to the already-authorized candidate pool with one-hop and
  32-edge caps.
- **V5 tenant contract and identity primitives** with opaque host contexts,
  canonical scoped identifiers, fail-closed matching, migration boundaries,
  versioned organization/user/project/agent directory verification, an atomic
  file-backed directory adapter with strict entity-reference validation, and a
  `TENANT_REQUIRED` error. Backend enforcement remains a staged task.
- **V5 tenant schema expansion** adds optional persisted organization/project/
  user/agent metadata while keeping tenantless V4 records at schema 3 and
  tenant records at schema 4. A canonical HMAC-SHA256 migration manifest now
  validates explicit organization/entity/ACL mappings, counts, checksums, and
  relation references before any future migration step consumes it.
- **V5 signed snapshot recovery** adds canonical HMAC-SHA256 snapshot
  envelopes, strict export/import verification, reference sanitization, and
  operator key configuration. Legacy mode continues to accept unsigned V4
  snapshots during migration.
- **V5 tenant migration runner** preflights explicit organization/entity/ACL
  mappings, signs and verifies manifests, validates source/reference checksums,
  and applies records idempotently to tenant-capable backends. Durable
  checkpoint/resume state and an explicit publication marker are now included;
  backend-specific atomic swap/rollback remains deployment work.
- **Atomic recovery files** write signed snapshots through fsync + rename,
  reject symlink/oversized/tampered inputs, and are used by keyed CLI
  export/import. Snapshot restore also has a no-write `previewSnapshot` and
  `import --dry-run` preflight path.
- **Strict HTTP ingress hardening** rejects tenant-bearing headers, query
  parameters, and request fields (while allowing signed snapshot records) so
  public callers cannot select an organization.
- **File-backend tenant boundary** adds encoded tenant namespaces and
  tenant-filtered point reads, writes, lifecycle operations, and history;
  unscoped legacy reads never enumerate tenant directories.
- **SQLite tenant boundary** adds nullable tenant/project/user/agent columns,
  tenant-filtered point/lifecycle/history/audit operations, FTS filtering, and
  candidate predicates before `LIMIT`/count calculation.
- **Strict tenant service and transport binding** adds opaque host contexts,
  fail-closed service authorization, tenant-aware CRUD/search/context/history/
  relations/import/export/maintenance paths, trusted HTTP resolution, strict
  MCP server binding, and SDK rejection of tenant-bearing body/header fields.
  Raw backend access is disabled in strict mode. Queued handlers support
  host membership re-checks, and embedding cache keys accept tenant-safe
  partitions. The CLI now has an explicit `REMEMBRA_TENANT_MODE=strict` operator
  binding and refuses legacy global backup/restore/migration/encryption forms;
  remaining work is broader derived-cache invalidation.

---

## [4.9.0] — 2026-09-24

**API, SDK & Compatibility Stabilization** — plan §12 of the Master
Development Plan.

### Added
- **Versioned HTTP namespace**: additive `/api/v1/*` aliases for the existing
  routes, with `X-Remembra-API-Version: v1` on success and transport errors,
  public health behavior, bounded CORS exposure, and legacy parity tests.
- **TypeScript SDK**: side-effect-free `@hilbras/remembra/sdk` fetch client with
  typed store/search/list/item/lifecycle/relation/digest/batch methods,
  pagination, cancellation, structured errors, and server-managed identity
  rejection.
- **Stable MCP manifest**: the 13 current tool names are centralized and tested
  through an in-memory `tools/list` contract without renaming legacy tools.
- **Provider adapters**: vendor-neutral LLM and embedding interfaces plus
  OpenAI-compatible, Anthropic, Ollama, and injected-local factories. Built-in
  adapters retain the bounded `providerFetch` policy and legacy environment
  configuration.
- **V4.9 documentation**: getting started, migration, self-hosting,
  troubleshooting, SDK, MCP manifest, and provider-adapter guidance.

### Compatibility notes
- Existing unversioned HTTP routes and MCP names remain supported.
- V1 preserves route-specific legacy response bodies; the SDK retains the raw
  body and supplies `HTTP_<status>` only when a server code is absent.
- Trusted agent context remains host-resolved; public identity fields are not
  authentication. The SDK rejects server-managed identity/access fields before
  transmission.

### Verification

- Full suite on Node 24: **340 passed, 0 failed**.
- Full suite on Node 18.20.8: **340 passed, 0 failed**.
- TypeScript build and SDK/provider import smoke tests pass on both runtimes.
- `npm run docs:check`: **27 Markdown files, no missing relative links**.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- `npm publish --dry-run`: package contents and prepublish checks passed; tests
  are excluded from the tarball.
- 10K/50K V4.8 scale benchmark remains the retrieval baseline; V4.9 does not
  change candidate planning or storage formats.

Published as `@hilbras/remembra@4.9.0` and
[GitHub Release v4.9.0](https://github.com/Hilbras/Remembra/releases/tag/v4.9.0).

---

## [4.8.0] — 2026-09-24

**Performance & Scalability** — plan §11 of the Master Development Plan.
Adds bounded retrieval planning, batch APIs, background work, and scale
observability without changing the existing single-memory API.

### Added
- **Bounded SQLite keyword candidates**: exact lexical matches plus the highest
  zero-signal modifier anchors are planned inside a hard budget; partial pages,
  semantic queries, type-filtered queries, agent mode, and legacy backends retain
  the full-scan fallback.
- **Scale benchmark**: deterministic 10K/50K SQLite benchmark with p50/p95
  latency, result counts, heap usage, and explicit legacy fallback mode.
- **Batch operations**: `MemoryService.batch`, `POST /memories/batch`, and the
  `memory_batch` MCP tool support bounded store/update/delete/selected-export
  requests with ordered per-item outcomes and whole-request validation.
- **Bounded embeddings**: `embedTexts` applies batch-size and provider-
  concurrency limits; embedding-enabled batch stores avoid duplicate provider
  calls when redaction/reject policy permits.
- **Background jobs**: typed `JobQueue` with capacity, concurrency, retries,
  cancellation, typed queue errors, maintenance/embedding/consolidation/
  validation/archive handlers, and graceful shutdown.
- **Resource metrics and configuration**: queue depth/running gauges, job and
  batch/embedding counters, and `REMEMBRA_JOB_*`, `REMEMBRA_MAX_BATCH_SIZE`,
  and `REMEMBRA_MAX_CONCURRENT_EMBEDDINGS` limits.
- **SQLite FTS maintenance**: idempotent rebuild plus update/archive/revive
  synchronization and actual memory IDs from `ftsSearch`.

### Compatibility and safety
- Existing single-item store/update/delete/export behavior and all eleven
  memory types remain available.
- Agent visibility remains fail-closed and is applied before batch or job
  mutations; inaccessible ids are reported as `NOT_FOUND`.
- Batch mutations are sequential, bounded, and explicitly not cross-item
  atomic; partial outcomes are returned in input order.
- File storage remains scan-based; SQLite receives the candidate planning path.

### Verification
- Full suite: **321 passed, 0 failed**.
- `npm run build` passes.
- 10K/50K scale benchmark completed with the bounded candidate path.
- Dependency audit completed with no high-severity production vulnerabilities.

---

## [4.7.0] — 2026-09-23

**Agent & Multi-Agent Memory** — plan §10 of the Master Development Plan.
Adds opt-in agent identity, attribution, scope-aware visibility, council/task
scope conventions, and trusted HTTP context resolution.

### Added
- **Agent attribution**: `agentType`, `agentVersion`, `conversationId`,
  `taskId`, and `runId` provenance fields, preserved by file and SQLite
  backends and snapshot import/export.
- **Ownership and access policy**: `owner` (`user`, `agent`, `project`,
  `organization`, `global`) and `access` (`private`, `shared`, `global`) on
  stored memories.
- **Agent mode**: opt-in fail-closed visibility for search, list, direct
  reads, updates, lifecycle operations, relationships, history, compression,
  maintenance, quality, audit, and snapshots.
- **Council conventions**: use existing scopes such as `agent:<id>`,
  `council:<name>`, and `task:<id>` with the existing eleven memory types.
- **Trusted HTTP context**: `createHttpServer` accepts an application-supplied
  `resolveAgentContext(req)` callback. It is never inferred from a public
  agent-id field or header.
- **`GET /agents/:id`**: non-content agent metadata and memory counts.
- **New environment variables**:
  | Variable | Default | Meaning |
  |----------|---------|---------|
  | `REMEMBRA_AGENT_MODE` | `0` | Enable fail-closed agent visibility policy |
  | `REMEMBRA_DEFAULT_ACCESS` | `global` | Default access for new memories |

### Security
- Private memories are never treated as authenticated merely because their
  payload contains an `agentId`; a host-authenticated context is required.
- Non-global direct access is scope-checked, including council and task
  scopes, so an agent cannot bypass retrieval filters with a guessed memory id.

### Tests
- Agent policy, attribution, persistence, snapshot, compression, summary, and
  HTTP resolver coverage in `src/test/agent.test.ts` and
  `src/test/http.test.ts`.
- SQLite attribution, ownership, access, and temporal round-trip coverage in
  `src/test/sqlite.test.ts`.

---

## [4.6.0] — 2026-09-23

**Observability & Evaluation** — plan §9 of the Master Development Plan.

### Added
- **Extended metrics**: `remembra_embedding_latency_seconds`,
  `remembra_llm_latency_seconds`, `remembra_storage_latency_seconds`,
  `remembra_provider_failures_total`, `remembra_token_usage_total`,
  `remembra_estimated_cost_usd`, `remembra_memory_count_active/archived/deleted`,
  `remembra_duplicate_rate`, `remembra_conflict_rate`,
  `remembra_stale_memory_rate` — all registered on the Prometheus
  registry (`GET /metrics`).
- **`GET /quality` endpoint** (auth-required): memory health dashboard
  reporting active/archived/deleted counts, duplicate/conflict/stale rates,
  lifecycle distribution, growth rate, and provider stats.
- **Evaluation harness** (`src/eval.ts`): Precision@K, Recall@K, MRR,
  NDCG@K, Hit Rate@K, latency percentiles over a query corpus.
- **Debug retrieval tracing** (`REMEMBRA_DEBUG_RETRIEVAL=1`): structured
  per-query pipeline logs covering normalize → candidate generation →
  keyword/vector scoring → RRF fusion → standing-instruction gate →
  MMR diversity → final selection.
- **Benchmark corpus** at `test-benchmarks/`: facts, preferences,
  contradictions, temporal, poisoning datasets with expected outcomes.
- **Baseline scores** at `test-benchmarks/baseline.json` for regression
  comparison.

### Changed
- `retrieval.ts`: emits `retrieval.debug` log event when
  `REMEMBRA_DEBUG_RETRIEVAL=1`.
- `service.ts`: new `quality()` method; `maintain()` reports
  `consolidation` findings in result.
- `http.ts`: `GET /quality` route added; `/quality` route label registered.
- `types.ts`: `SearchInput` / `ListInput` gain `includeExpired`,
  `includeFuture`, `includeQuarantined` flags.

### Tests
- 5 new tests in `src/test/eval.test.ts`
- 6 new tests in `src/test/benchmark.test.ts`
- 2 new tests in `src/test/security.test.ts` (quality endpoint)

---

## [4.5.0] — 2026-09-23

**Lifecycle & Memory Intelligence** — plan §8 of the Master Development Plan.
Introduces multi-signal decay, memory consolidation (duplicates, contradictions,
fragments), temporal knowledge fields, and a compression endpoint.

### Added
- **Multi-signal decay model** (`src/lifecycle.ts`): composite health score
  combining age, last-seen recency, importance, confidence, retrieval
  frequency, trust, and relationship strength. Configurable weights via
  `REMEMBRA_DECAY_WEIGHTS`; aging/archive thresholds via
  `REMEMBRA_HEALTH_AGE_THRESHOLD` / `REMEMBRA_HEALTH_ARCHIVE_THRESHOLD`.
- **Memory lifecycle states**: `active`, `aging`, `archived`, `quarantined`,
  `deleted`. Standing instructions and pinned memories are effectively immortal.
- **Consolidation detection** (`src/consolidation.ts`): exact-duplicate,
  near-duplicate (vector similarity ≥ threshold), contradiction (semantic
  opposition heuristic), and fragment (3+ short same-type memories within
  window) detection during `POST /maintain`.
- **Contradiction flagging**: detected contradictions set
  `meta.contradicted: true` on both memories; surfaced in search results.
- **Temporal knowledge fields**: `validFrom`, `validUntil`, `observedAt`,
  `supersededBy` accepted in store input; respected in search and list
  filters (`includeExpired`, `includeFuture`).
- **`POST /memories/compress`** endpoint: LLM-assisted compression of
  fragmented memories into a compact representation with provenance.
- **Search/list temporal filtering**: new query params
  `includeExpired`, `includeFuture`, `includeQuarantined`,
  `includeArchived`.
- **New env vars**:
  | Variable | Default | Purpose |
  |----------|---------|---------|
  | `REMEMBRA_DECAY_WEIGHTS` | auto | semicolon-separated `key=value` weights |
  | `REMEMBRA_HEALTH_AGE_THRESHOLD` | `0.35` | health score for aging transition |
  | `REMEMBRA_HEALTH_ARCHIVE_THRESHOLD` | `0.15` | health score for archive transition |
  | `REMEMBRA_AGE_THRESHOLD_DAYS` | `30` | days without activity before aging consideration |
  | `REMEMBRA_AGING_BOOST` | `-50` | search score penalty for aging memories |
  | `REMEMBRA_DUP_SIMILARITY` | `0.92` | vector similarity threshold for near-dupes |
  | `REMEMBRA_FRAGMENT_WINDOW_DAYS` | `7` | lookback window for fragment detection |

### Changed
- `MaintainResult` now includes a `consolidation` field with findings.
- `Memory` interface extended with `meta`, `validFrom`, `validUntil`,
  `observedAt`, `supersededBy`.
- `StoreInput` Zod schema extended with temporal fields and meta.
- `SearchInput` and `ListInput` extended with temporal filter flags.
- `POST /maintain` now runs consolidation analysis and flags contradictions.

### Tests
- 14 new tests in `src/test/lifecycle.test.ts`
- 9 new tests in `src/test/consolidation.test.ts`
- 7 new tests in `src/test/temporal.test.ts`

---

## [4.4.0] — 2026-09-23

**Security & Memory Integrity** — plan §7 of the Master Development Plan.
Hardens Remembra against malicious input, memory poisoning, and abuse with
HTTP-level protections and a sensitive-data policy engine.

### Added
- **Rate limiting** (`src/rate-limiter.ts`): per-API-key sliding window.
  Configurable via `REMEMBRA_RATE_LIMIT` (default 60) and
  `REMEMBRA_RATE_WINDOW_MS` (default 60000). Exceeded requests return 429
  with `Retry-After`. `/health`, `/metrics` unkeyed, and UI shell are exempt.
- **Secure response headers**: every JSON API response includes
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Strict-Transport-Security`, `X-XSS-Protection: 0`, `Referrer-Policy:
  no-referrer`, `Cache-Control: no-store`. Toggle off with
  `REMEMBRA_SECURE_HEADERS=0`.
- **CORS support** (`REMEMBRA_CORS_ORIGIN`): explicit origin allowed; wildcard
  rejected when an API key is set. `OPTIONS` preflight handled without auth.
- **Request timeouts** (`REMEMBRA_REQUEST_TIMEOUT_MS`, default 30s): in-flight
  requests exceeding the limit return 504.
- **Concurrency limits** (`REMEMBRA_MAX_CONCURRENT`, default 32): when the cap
  is reached, new requests return 503.
- **Prompt injection detection** (`src/injection-detector.ts`): pattern-based
  scan on every `store()` call flags attempts to override roles, leak system
  prompts, or manipulate metadata. Flagged memories carry `meta.injected: true`.
- **Sensitive data policy engine** (`src/sensitive-data.ts`): detects API keys,
  AWS credentials, private keys, passwords, and financial secrets. Policy modes:
  `allow` · `redact` · `reject` · `quarantine` (set via
  `REMEMBRA_SENSITIVE_POLICY`).
- **`GET /audit` endpoint** (auth-required): paginated audit event stream.
  Events include `memory.created`, `memory.updated`, `memory.archived`, etc.
- **New error codes**: `RATE_LIMITED` (429), `REQUEST_TIMEOUT` (504),
  `SERVICE_UNAVAILABLE` (503), `SENSITIVE_DATA` (400), `INJECTION_DETECTED` (400).

### Changed
- `MemoryBackend.getAudit()` optional method added to the interface.
- `Memory.meta` field added for V4.4 security flags (`injected`, `quarantined`).
- `StoreInput` Zod schema extended with optional `meta` object.
- HTTP server now applies secure headers and CORS to all JSON responses.

### New env vars
| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_RATE_LIMIT` | `60` | max requests per window per key |
| `REMEMBRA_RATE_WINDOW_MS` | `60000` | sliding window size |
| `REMEMBRA_REQUEST_TIMEOUT_MS` | `30000` | per-request timeout |
| `REMEMBRA_MAX_CONCURRENT` | `32` | simultaneous in-flight requests |
| `REMEMBRA_CORS_ORIGIN` | *(unset)* | allow this origin; `*` rejects with key |
| `REMEMBRA_SECURE_HEADERS` | `1` | set to `0` to disable |
| `REMEMBRA_SENSITIVE_POLICY` | `redact` | `allow` · `redact` · `reject` · `quarantine` |
| `REMEMBRA_INJECTION_PATTERNS` | *(unset)* | custom regex patterns, comma-separated |

### Tests
- 8 new tests in `src/test/security.test.ts`
- 6 new tests in `src/test/rate-limiter.test.ts`
- 8 new tests in `src/test/injection-detector.test.ts`
- 8 new tests in `src/test/sensitive-data.test.ts`

---

## [4.3.0] — 2026-09-23

**Storage & Index Architecture** — plan §6 of the Master Development Plan.
The flat-file backend is replaced by a SQLite-backed runtime while keeping
Markdown as the human-readable export format. Public APIs are unchanged.

### Added
- **SQLite backend** (`src/sqlite-backend.ts`): new `SqliteBackend` class
  implementing `MemoryBackend` with WAL mode, optimistic concurrency via
  `expectedVersion`, and full-text search backed by FTS5.
- **Schema**: `memories`, `memory_versions`, `memory_audit` tables with
  foreign-key relationships and indexes on scope, type, archived_at,
  updated_at, last_seen.
- **FTS5 full-text search**: keyword queries now use an FTS5 virtual table
  when available; graceful fallback to keyword-only scoring when the
  SQLite build lacks FTS5 support.
- **Embedding BLOB storage**: vectors are stored as raw `Float32Array` bytes
  in a `BLOB` column instead of comma-separated text in Markdown frontmatter.
- **CLI commands**:
  - `remembra export-markdown <dir>` — dump active memories as `.md` files
  - `remembra import-markdown <dir>` — import `.md` files into SQLite
  - `remembra backup <file>` — copy DB + write SHA-256 sidecar
  - `remembra restore <file>` — verify checksum and atomically replace DB
- **Auto-migration**: on first launch, legacy flat files are read and
  imported into SQLite; the old tree is moved to `<root>/.legacy/`.
- **10 new tests** covering SQLite CRUD, FTS search, embedding round-trip,
  history snapshots, and archive/revive lifecycle.

### Changed
- Default runtime backend switched from `MemoryStore` (flat files) to
  `SqliteBackend`. The file backend remains available for backward compat
  and export; existing `MemoryStore` tests continue to pass unchanged.

### Notes
- The `MemoryBackend` interface is unchanged — all HTTP endpoints, MCP
  tools, and dashboard behavior are identical.
- If FTS5 is unavailable on your SQLite build, retrieval degrades to
  keyword-only scoring without error.

---

## [4.2.0] — 2026-09-23

**Retrieval Engine** — plan §5 of the Master Development Plan. The monolithic
`search()` function is replaced by a staged multi-stage pipeline with
explainability, hybrid fusion, diversity, temporal parsing, and an
in-process embedding cache. Every existing `search()` call retains its
ranking; the new `searchQ()` entry point adds optional per-memory score
breakdowns.

### Added
- **Multi-stage retrieval pipeline** (`src/retrieval.ts`): normalize → hard
  filters → candidate generation → keyword scoring → vector scoring → RRF
  fusion → ranking modifiers → standing-instruction gate → MMR diversity →
  context selection.
- **Reciprocal Rank Fusion (RRF)** between keyword and vector signals with
  average-rank tie handling so tied items do not suffer positional bias.
- **Reranker interface** (`Reranker`, `identityReranker`, `EmbedReranker`)
  exported for future provider plugging; identity is the default so existing
  rankings are preserved.
- **MMR-lite diversity pass** that dampens redundant near-duplicate results
  in semantic mode (pool capped at `limit × 10` for O(K·N) bounded cost).
- **Retrieval explanations** (`SearchResults.explanations`): each memory gets
  a `{ components, totalScore, reasons }` breakdown when the caller sets
  `explain: true` on the query. HTTP `?explain=true` is wired end-to-end.
- **Temporal query parsing**: `latest [N]`, `recent [N]`, `before <date>`,
  `after <date>` recognised in the query string and applied as recency boosts
  or hard filters.
- **Embedding cache** (`embedCached`, `clearEmbedCache` in `embeddings.ts`):
  in-process TTL-based cache keyed by `(model, textHash)` — avoids redundant
  provider calls for repeated queries within the TTL window.
- **Confidence integrated into scoring** (user-decided during design):
  `confidence × 20` additive term alongside provenance/trust/retention.

### Changed
- `service.search()` now accepts `explain?: boolean` and returns it in the
  envelope when requested. HTTP `GET /memories/search?explain=true` surfaces
  the per-memory breakdown.
- `SearchQuery` gains optional `explain` field; `SearchResults` and
  `RetrievalExplanation` added to `types.ts`.

### Fixed
- Keyword and vector ranked lists use deterministic tie-breaking (id sort),
  eliminating input-order dependence in RRF positions.
- Embed reranker no longer overrides the RRF+modifier ranking; it is
  available as a composable hook for callers that opt in.
- Single-signal RRF short-circuit avoids unnecessary Map construction.

### Tests
- Six new tests in `src/test/retrieval.test.ts`: explain output, RRF tie
  fairness, temporal `latest`/`after` parsing, MMR deduplication, embed
  cache export shape. Full suite remains at 204 green.

## [4.1.1] — 2026-09-23

### Fixed
- Dashboard link picker: the relation-kind select no longer leaks the
  internal plan reference into its label (now just "Relation kind").
- Crash recovery: the `*.tmp` sweep is now age-gated (files younger than the
  stale-lock window are treated as in-flight writes, not orphans). The sweep
  could previously race a live atomic write under load and fail it with a
  spurious `ENOENT` on rename — a pre-existing intermittent flake in the
  concurrent-writes test. Crash orphans are still collected once they age
  past the window.

## [4.1.0] — 2026-09-23

**Memory Model & Provenance** — plan §4 of the Master Development Plan, plus
the structural §3 leftovers folded in per the version-collision decision
(formal metadata format, optimistic `expectedVersion`, UUIDv7). Backward
compatible for every pre-4.1 store: all new fields are additive, legacy shapes
migrate on read, and nothing is rewritten behind your back.

### Added — eleven semantic types (plan §4.1)
- **Type vocabulary 4 → 11**: `fact · preference · decision · constraint ·
  instruction · role · entity · relationship · event · history · observation`
  (was `fact · decision · role · history`). The four old types keep their
  exact semantics; new-type files are skipped — never deleted — by downgrade.
- Digest extraction, MCP tool schemas, HTTP validation, the dashboard
  (type filter, edit form, per-type badge colors ×11, graph legend derived
  from present types) and the Custom GPT action enum all cover the full set.

### Added — provenance & trust (plan §4.3, §4.5, §4.9)
- **`provenance` is a required object**: `{ sourceType, sessionId?,
  messageId?, agentId?, provider? }` — legacy `explicit`/`auto` strings
  migrate on read (`explicit` → `manual`, `auto` → `conversation`); digest
  extractions stamp **which LLM produced them** (`provider`).
- **Required `trust` classification**: `system +8 / verified +6 / trusted +2 /
  unverified −8` ranking points (`TRUST_POINTS`), derived from provenance when
  absent (conversation → `unverified`, system → `system`, else `trusted`).
  Direct stores stay `trusted`; digest extraction always lands `unverified`.
- **Instruction gate**: `role`/`instruction` memories earn the +1000 standing
  boost only at `trust ≥ trusted` — unverified ones stay listed, searchable
  and badged, but never surface first. Promote via the dashboard **Approve**
  button (→ `verified`) or `memory_update { trust }`; a trust change stamps
  `lastValidated` (new metadata field).
- **Required `confidence`** with sane legacy defaults (0.7 conversation /
  1.0 otherwise).

### Added — retention modes (plan §4.8)
- **`retention`**: `pinned · persistent · ephemeral · neverExpire` (absent =
  `decaying`). `pinned`/`neverExpire` are fully exempt from decay sweeps,
  `pinned` also gets +50 rank points, `persistent` is archivable but never
  auto-deleted; `role`/`instruction` never decay regardless. Editable from the
  dashboard form and `memory_store`/`memory_update`.

### Added — typed relations (plan §4.7)
- **`memory_relate` gains `kind`**: `supports · contradicts · supersedes ·
  refines · duplicates · related` (default `related`). Re-linking retypes the
  edge in place (never duplicates); backlinks carry the kind; legacy
  `related: [ids]` frontmatter migrates to kind `related` on read. Dashboard
  link picker shows a kind selector and kind chips.

### Added — storage & concurrency (plan §3.4, §3.5, §3.6, §4.2)
- **Spec-parsed YAML frontmatter** (`yaml@^2.9.1`) + zod validation on every
  read — YAML-ambiguous scopes/tags/sources now round-trip; the hand-rolled
  parser remains only as the legacy fallback.
- **Schema `version: 1 → 2`**: 4.0.x readers skip `version: 2` files (logged,
  never deleted) instead of honoring them without trust gating — downgrades
  can no longer silently bypass the instruction gate. 4.1.0 reads all
  pre-4.1 files unchanged.
- **Optimistic concurrency**: `memory_update`/`PUT` accept `expectedVersion`
  (compared against the fresh on-disk counter *inside the lock*) — mismatch →
  `CONFLICT` (HTTP 409), nothing written; every write bumps `revision`
  (exposed as JSON `version`).
- **UUIDv7 ids**: time-ordered, unique from entropy — the collision-scan
  retry loop is gone (legacy 8–32 hex ids remain valid).

### Changed
- **History reasons (plan §4.6)**: updates accept `reason` (≤500 chars),
  recorded as `{ reason, supersededAt }` in `.history/<id>/reasons.json`
  (encrypted with the tree) and returned by `memory_history` /
  `GET /memories/:id/history`.
- **Digest merges no longer inline** the `> superseded (…)` note into the new
  content — the pre-image snapshot in version history carries it, with the
  reason `digest merge (superseded by a newer extraction)`.
- **Retrieval ranking** gains the trust layer and pinned boost on top of the
  existing provenance/importance/recency/keyword layers.
- **Frontmatter layout**: `version` = schema guard, `revision` = per-memory
  write counter; `tags`, `provenance`, `relations` serialize as proper YAML
  structures; `embedding` as a comma scalar.
- Snapshot envelope exports `version: 2`; pre-4.1 snapshots (string
  provenance, untyped `related`) still import cleanly.

### Docs
- `storage.md` rewritten for the v2 format (field table, downgrade contract,
  reasons.json); `memory-model.md` covers all 11 types + provenance/trust/
  retention sections; `tools.md`, `public-api.md`, `architecture.md`,
  `lifecycle.md`, `ui.md`, `providers.md`, `chatgpt.md`, `security.md`,
  `clients.md` and the README updated to match.

### Verification
- **198 tests, 0 failures** — 15 new behavioral tests in
  `src/test/model.test.ts` (type round-trips, trust derivation + gate,
  expectedVersion CAS at service and HTTP level, legacy frontmatter/snapshot
  migration, relation retype/removal, retention decay exemptions, ranking
  layers, snapshot round-trip) on top of the existing suite.

## [4.0.1] — 2026-09-23

**Foundation & Correctness** — the non-breaking subset of the Master
Development Plan's §3 milestone (4.0.0 already shipped as the dashboard
release; per the split decision, structural items — formal metadata format,
optimistic `expectedVersion`, UUIDv7 — land in 4.1.0 "Memory Model &
Provenance" instead).

### Added — provider reliability (plan §3.7)
- **`src/provider.ts`**: every LLM/embedding call now runs through one
  policy — per-attempt **timeout** (`REMEMBRA_PROVIDER_TIMEOUT_MS`, 60s),
  **bounded retries** with capped exponential backoff
  (`REMEMBRA_PROVIDER_RETRIES`=2, `REMEMBRA_PROVIDER_BACKOFF_MS`=250; only
  network/408/429/5xx — 4xx fails fast), an **overall wall-clock budget**
  (`REMEMBRA_PROVIDER_BUDGET_MS`, 180s), and **cancellation** via
  `AbortSignal`. A hung provider could previously block a store/digest call
  **forever** (bare `fetch`); now it is bounded and observable.
- **Error normalization**: new `PROVIDER_TIMEOUT` code (HTTP **504**);
  exhausted retries, network failures, malformed bodies/vectors and
  cancellations normalize to `LLM_ERROR` (502). Digest rethrows already-
  classified errors instead of double-wrapping them.
- **Cancellation end-to-end**: an HTTP client disconnecting mid-digest aborts
  the in-flight provider call (and stops retrying) — signal plumbed
  `res.close → service.digest → extract/merge/embed → fetch`.
- **Response shape guards**: missing `choices[0].message.content` /
  `content[0].text` / `message.content`, non-JSON bodies, and junk embedding
  vectors are rejected as `LLM_ERROR` — never half-parsed.
- New log events: `provider_retry`, `provider_failed`, `provider_cancelled`
  (low-cardinality fields only — no URLs/keys/bodies, log-hygiene rule).

### Added — read-side metadata validation (plan §3.4 / §3.8)
- Every read now validates the parsed object (`store.parse`):
  - **skip** (file untouched, logged once as `memory_parse_skipped`):
    broken frontmatter, non-numeric or **future schema version**, bad id,
    unknown type, scope with `..`, empty content — unknown-version files from
    a newer Remembra are never served;
  - **normalize** (served, logged once as `memory_normalized`):
    importance clamped 1–5 (non-numeric → 3), confidence clamped 0–1,
    unparseable dates fall back instead of propagating `NaN` into decay
    math, id/filename mismatch resolves to the filename, bad
    provenance/embedding/related entries are dropped or filtered.
- **ID allocation tested** (plan §3.6/§3.8): collision → fresh-id retry
  (via a new `idGen` store test hook), exhaustion → `CONFLICT`; an existing
  memory is never overwritten.

### Added — tests & docs (plan §3.8 / §3.1)
- `src/test/foundation.test.ts` — 23 tests: provider retry/timeout/budget/
  cancel/normalize, malformed LLM & embedding responses, invalid-type/
  future-version/unsafe-scope/empty-content skips, NaN-proof clamping,
  warn-once behavior, simultaneous writes across instances,
  delete-during-search, archive/revive races (single-tree invariant),
  ID collision + CONFLICT, a seeded **serialization property test**
  (40 random memories round-trip byte-faithfully), and HTTP
  client-disconnect cancellation. **160 → 183 tests.**
- New **`docs/public-api.md`** (stability contract: tools, HTTP routes,
  error→status table, snapshot format, CLI, provider policy) and
  **`docs/storage.md`** (layout, file format field table, read-validation
  rules, history) — completing the §3.1 audit doc list alongside the existing
  architecture/memory-model/security/providers docs.
- Updated: providers (policy envs + bounded failure behavior), clients
  (env index), observability (new events), README docs table.

## [4.0.0] — 2026-09-23

**v4 — the complete web dashboard**, shipped as one release: every read and
write surface of Remembra in a modern gold-on-charcoal UI (dark default,
light-mode toggle), served by the same `--http` binary with zero new
dependencies.

### Added — dashboard
- **Full web UI at `/`** — hash-routed SPA, hand-written TypeScript compiled
  to native ES modules by the existing `tsc` (no bundler, no framework):
  - **Memories**: debounced search, type/scope/archived filters,
    pagination, type badges, tags, importance, relative ages.
  - **Detail**: metadata grid, tag chips, related + backlinks with a link
    picker, Archive/Revive, Delete (confirm dialog), lazy **History**
    panel with unified diffs (current version open).
  - **Forms**: create/edit (type, content, scope, tags, importance,
    confidence, source) — scope edits move the file, content edits snapshot
    history.
  - **Roles auditor** with an instructions-first warning banner.
  - **Graph**: force-directed canvas of `related()` edges — drag, click to
    open, legend, gold-ringed role nodes.
  - **Digest**: transcript box → LLM extraction with result breakdown and
    provider-setup hints.
  - **Ops**: health card, stat tiles with 5-minute sparklines (requests,
    errors, p95 computed from the Prometheus histogram buckets, searches,
    stores, cache hit %), Run maintain, Export/Import buttons.
- **Theming** — CSS-variable design system, **dark default**, light mode via
  the header toggle (persisted in `localStorage`), gold `#d4af37` accents,
  system fonts, responsive/off-canvas sidebar,
  `prefers-reduced-motion` respected.

### Added — write API (drives the dashboard; CLI/MCP parity)
- **`memory_update`** MCP tool + **`PUT /memories/:id`** — partial patch
  (type/content/scope/tags/importance/source/confidence); empty patch and
  unsafe scopes rejected; content changes snapshot the pre-image to history
  and re-embed fail-open; scope changes move the file between trees without
  dual-homing (old path unlinked, recovery reconciles a crash between the
  two writes).
- **`memory_archive` / `memory_revive`** MCP tools + **`POST
  /memories/:id/archive|revive`** — manual lifecycle alongside automatic
  decay; archived memories drop out of default list/search until revived
  (**12 MCP tools total**, was 9).
- **`GET /snapshot` + `POST /import`** — HTTP parity with `remembra
  export`/`remembra import` (same handlers; whole-file Zod validation stays
  atomic, idempotent on re-import).

### Security (dashboard static serving)
- `/` + `/ui/*` serve an extension whitelist from `dist/ui/` only:
  decode-then-**path-containment** check, regular files, generic 404 —
  traversal pen tests (`..`, `%2e%2e`, `%2f`, NUL, absolute, non-whitelisted
  extensions) in `src/test/ui.test.ts`.
- **CSP with no `unsafe-inline`** on HTML (`default-src 'none'`,
  same-origin script/style/API only) + `nosniff`; the shell contains no
  inline script or style at all.
- Shell/assets are unauthenticated like `/health` (static bytes, zero data);
  every API call the page makes still requires the key, entered once and
  kept in **`sessionStorage`** (per-tab, never persisted).
  `REMEMBRA_UI=0` disables UI serving entirely.
- New metrics route labels: `ui` (static shell), `data_io`
  (`/snapshot`/`/import`); `memory_sub` now also covers `archive`/`revive`.

### Changed
- Build: `tsc && node scripts/copy-ui.mjs` (copies `src/ui/index.html` +
  `styles.css` into `dist/ui/`; `dist/ui` ships in the npm package).
- Docs: new **`docs/ui.md`**; tools reference (now 12 tools), README route/
  tool tables + dashboard quick start, clients/chatgpt/security/
  observability updated for the new routes, labels and `REMEMBRA_UI`.

### Tests
- 148 → **160**: static shell (CSP/nosniff/no inline script), asset MIME +
  nested modules, traversal pen test, shell-vs-data auth boundary, route
  labels, `REMEMBRA_UI=0`, service-level patch/scope-move/history/stale-
  vector clearing, archive/revive visibility, HTTP PUT/archive/revive
  validation, snapshot export → import roundtrip (same store idempotent +
  fresh store restore) and atomic invalid-snapshot rejection.

## [3.8.0] — 2026-09-23

**Phase 8 of the deep audit — Advanced Capabilities.** All five roadmap
items covered; both storage-altering features are **opt-in** (scope review:
plain markdown and byte-faithful storage remain the defaults).

### Added
- **Relationship graph** — `related: [ids]` frontmatter (directed, single
  write; backlinks derived at read time), `memory_relate` MCP tool
  (add/remove, targets validated, self-links rejected, idempotent), plus the
  missing read surfaces: **`memory_get`** / `GET /memories/:id` return a
  memory with resolved `related` + `backlinks`. Retrieval ranking untouched —
  graph is structure for the consumer, not a score.
- **Confidence scores** — `confidence: 0–1` frontmatter: explicit stores
  default `1.0`, digest extractions `0.7` (the extraction LLM may supply its
  own via the extended prompt/schema). Surfaced everywhere and carried through
  merge/export/import; **deliberately not ranked** — importance answers
  "relevant?", confidence answers "true?" (Phase 4 weight decisions stay
  closed).
- **PII redaction filter** (opt-in `REMEMBRA_REDACT=1`) — pattern filter at
  the *ingest layer* (`memory_store`, digest items, merge output): emails,
  Luhn-valid cards, SSNs, phone numbers, provider tokens / ≥40-char entropy
  blobs → typed placeholders (`<EMAIL>` …). Cards must pass Luhn; phone
  matching requires separators + 10–15 digits, so dates/versions never match.
  Irreversible by design; `remembra_redactions_total{kind}` + `redacted`
  log event (counts only, never matched text). Reverses the former "no PII
  filter" non-goal — documented with its limits in `docs/security.md`.
- **Encrypted storage mode** (opt-in `REMEMBRA_ENCRYPT_KEY`) — AES-256-GCM
  per file via `node:crypto` (zero deps): magic-header detection, transparent
  decrypt-on-read, encrypt-on-write, mixed plain/cipher trees supported;
  `remembra encrypt` / `remembra decrypt` migrate the whole tree (incl.
  history) idempotently under the advisory lock. Missing/wrong key fails
  **loudly**: `ENCRYPTED_NO_KEY` (HTTP 503, `/health` `storage` field) —
  never warn-skipped into silent partial results. GCM makes wrong-key ≡
  tampered. Reverses the former "no encryption at rest" non-goal with an
  explicit threat-model section (protects stolen backups / copied dirs, not
  a runtime attacker with your env).
- **Diff/history view** — content-changing updates snapshot the raw
  on-disk pre-image into `.history/<id>/<epochMs>-<seq>.md` first (content-
  equality gate: embedding backfills and linking never snapshot);
  `memory_history` MCP tool + `GET /memories/:id/history?limit=` return
  versions newest-first, each with a **unified line diff** against its
  predecessor (own ~60-line LCS, zero deps, cell-budget fallback for huge
  contents). Pruned to `REMEMBRA_HISTORY_LIMIT` (default 20, `0` disables);
  `.history` is never walked by `all()`/search.

### Changed
- Error classification gains `ENCRYPTED_NO_KEY` (503) and documents why it
  breaks the skip-malformed-file rule; `metrics` route enum gains
  `memory_sub` (the relate/history sub-routes).
- Extraction system prompt optionally returns `confidence` (0–1).

### Docs
`tools` (+3 tools, 9 total, encrypt/decrypt CLI), `memory-model`
(relationships, version history, metadata rows, layout incl. `.history`),
`security` (encryption + redaction sections replace the two reversed
non-goals, checklist items), `architecture` (encryption format, history
snapshot design, error table), `clients` (+3 env vars), `observability`
(+4 counters, `memory_sub`, `redacted` event), `chatgpt` (+3 routes),
`lifecycle` (merge → history cross-ref), README (9 tools, 11 routes).

### Tests
- **148 tests** (+16: redaction patterns + false-positive guards + service
  on/off, digest redaction & confidence pass-through, confidence round-trip,
  relations incl. backlinks/validation/idempotence/persistence, diff unit,
  merge → snapshot → diff view, embedding-gate + limit pruning, encryption
  round-trip / missing-key loud failure / wrong-key / mixed trees /
  idempotent both-way migration incl. history, HTTP GET/relate/history
  routes + `memory_sub` metric label). Suite verified stable across 3
  consecutive runs.

## [3.7.0] — 2026-09-23

**Phase 7 of the deep audit** — observability. All five roadmap items
covered (error-rate alerting taken as the *pragmatic substrate*: counters +
documented rules, no built-in notifier — decided in scope review).

### Added
- **Structured JSON logging** (`src/log.ts`) — every server-side event goes
  through one logger on **stderr** (stdout stays reserved for MCP stdio/CLI).
  Format: `REMEMBRA_LOG=json|text` forces it; unset → auto — JSON when stderr
  is piped (containers, CI, shippers), text on a TTY. Text mode prints the
  exact legacy strings, so existing greps and the Phase 2/3 tests still hold.
  JSON lines carry `{"ts","level","event","msg",...fields}`.
- **`GET /metrics`** (`src/metrics.ts`) — zero-dependency Prometheus text
  endpoint: request/digest/search/cache counters, latency histograms,
  `errors_total{code,transport}`, cache-entry gauge, `remembra_info`. Route
  labels are a fixed low-cardinality enum (never raw paths). Sits **after**
  the API-key check — keyed deployments must not leak counters; `/health`
  stays exempt.
- **Search query logging** — one structured `search` event per call (scope,
  term count, results, limit, `duration_ms`). Raw query text only under
  `REMEMBRA_DEBUG` (Phase 2 log-hygiene rule unchanged).
- **`/health` readiness probe** — now runs a real storage read: `200 ok`
  with `version`/`uptime_s`/`storage`/`cache` fields, **`503 unready`** with
  the failing error code when storage cannot be read — the probe fails
  instead of lying. Field `status:"ok"` kept for existing consumers.
- **Alerting infrastructure** — `docs/observability.md`: metric reference,
  scrape config (incl. `x-api-key`), and ready-to-paste Prometheus rules
  (down, internal error rate with 4xx excluded, readiness, lock contention,
  search p95, cache thrash). No built-in notifier by design: a local tool
  alerts through the operator's existing stack.
- `src/version.ts` single-sources `VERSION` (MCP server id, `/health`,
  `remembra_info`); a test pins it to `package.json`.

### Fixed
- **Prometheus bucket labels** — histogram series emitted `{le="…"route="…"}`
  (missing comma), caught by the exposition-format test.

### Changed
- Conversion to `logEvent` at 8 sites (listening banners, shutdown, parse
  skip, crash recovery, embedding/touch/merge/decay failures) — messages
  unchanged in text mode.

### Tests
- **132 tests** (+13: log formats + auto-detection, `/metrics` content,
  label enum + exposition grammar, auth on `/metrics`, counter movement for
  store/search/cache, MCP + HTTP error counters, hygiene-first query logging
  (and `REMEMBRA_DEBUG` opt-in), healthy + broken-storage `/health`,
  version pin). Suite verified stable across 3 consecutive runs.

## [3.6.0] — 2026-09-23

**Phase 6 of the deep audit** — testing depth. All six roadmap items now
covered (traversal pen test, 413, and content-length checks already shipped in
earlier phases). The new tests found **three live production bugs**, fixed
here:

### Fixed
- **Cross-scope role leak (isolation, security-relevant)** — `search()`'s
  filter included `m.type === "role" || score > 0`, so a role scoped to
  *another project* (score 0 from the scope gate) was re-included and surfaced
  in **every** project's searches — a cross-project prompt-injection vector.
  No existing test pinned it; a Phase 6 property test caught it on round 1.
  Roles now surface within their scope (global or current), foreign-scope
  roles are gated like everything else — code now matches what
  `docs/providers.md` already promised ("memories from other scopes are never
  returned"). Trust-model + role docs updated in four places.
- **Sibling lock steal** — a fresh `.remembra.lock` carrying this process's
  own pid was treated as stale and stolen instantly: a second `MemoryStore`
  instance in the same process broke mutual exclusion. Own-pid + fresh now
  waits (a live sibling may hold it); abandoned own-pid files are still
  recovered by the age rule (`REMEMBRA_LOCK_STALE_MS`).
- **Poisoned recovery** — if the first-ever access failed (e.g.
  `LOCK_TIMEOUT`), the rejected recovery promise stayed cached and *every*
  later operation re-threw it forever. Failures now clear the promise so
  recovery is retryable.

### Added (tests — 15 new, **119 total**)
- **Concurrency stress**: the lock regression above (wait-not-steal +
  age-rescue + retryable recovery); two store instances hammering one root
  (51 interleaved store/all/get/update/archive/revive ops — no dual-homed
  ids, exact file counts); concurrent reads while writing (no throws, no torn
  data).
- **Traversal angles**: digest path with the caller skipping validation —
  both inherited and per-item evil scopes rejected as `INVALID_INPUT`, nothing
  written outside the root.
- **Large payloads**: 2 MiB content round-trip over HTTP + searchable;
  declared overflow → 413 with the server proven still alive; mid-body
  overflow with *no* content-length (streaming counter path).
- **Malformed recovery**: four corruption shapes (empty, binary,
  unterminated frontmatter, no frontmatter) skipped-but-*preserved*,
  idempotent across repeated passes, list/search survive.
- **Cross-scope under load**: 4 scopes × (10 stores + 1 digest) written
  concurrently with globals — exact per-scope totals, zero sibling leakage in
  list and search.
- **Property-based scoring** (seeded LCG, zero new deps, both modes): roles
  rank first & scopes never leak; determinism + input-order independence;
  importance/recency/provenance monotonicity (raising any never lowers rank);
  limit bounds → unique subset of input. ~200 random rounds per run.

### Docs
`memory-model`, `security` (trust model now notes the cross-project rule),
`providers`, `clients`: "roles always surface" qualified with scope.

## [3.5.0] — 2026-09-23

**Phase 5 of the deep audit** — performance & scalability.

### Added
- **mtime-validated LRU parse cache** (audit: in-memory cache for parsed
  memories + the lazy-loading item deferred from Phase 4) — reads cost one
  `stat()` when the file hasn't changed (validated by mtime+size, so writers
  in *other* processes are caught automatically); writes refresh their own
  entry, deletes/renames evict. Configurable via `REMEMBRA_CACHE_SIZE`
  (default 10000 entries, `0` disables); `store.cacheStats()` exposes
  size/capacity. The directory walk still runs every query — discovering
  new/deleted files is its job.
- **Pagination** (audit: paginate `/memories`) — `offset`/`limit` on
  `GET /memories` and the `memory_list` MCP tool (opt-in: absent = full list,
  so existing clients don't break), `total` always returned, and a
  `Showing X–Y of Z` text header when paginated. Invalid query params fall
  back to unpaginated behavior.
- **Chunked streaming** (audit: streaming large search results) — list/search
  responses estimated ≥ 64 KiB stream as chunked JSON (no `content-length`,
  item-per-write); smaller responses keep the Phase-1 Content-Length shape.

### Declined with evidence
- **Vector index (FAISS/HNSW)** — native dependencies for double-digit-ms
  savings: the new benchmark measures brute-force cosine over **10,000 ×
  768-dim vectors in ~32 ms**. Revisit at >50k vectors or p95 >100 ms;
  rationale and both thresholds documented in `docs/architecture.md`, seam
  identified (`MemoryBackend` + rebuildable index over frontmatter vectors).

### Added (tests)
8 Phase-5 tests: cache staleness (external edit), cross-instance coherence,
validated-hit proof (read is skipped), LRU capacity/disable, pagination
(service + HTTP + schema), chunked-vs-Content-Length streaming, and the
10K×768 brute-force benchmark with a <1000 ms ceiling. **104/104 total.**

## [3.4.0] — 2026-09-23

**Phase 4 of the deep audit** — retrieval & memory quality.

### Changed
- **Exponential recency decay** — ~30-day half-life replaces the linear ramp
  that hit a hard zero at 60 days (audit #20): a 60-day-old memory now earns
  ~5 points instead of 0, and old-but-important facts stop falling off a
  cliff. Future-dated files clamp to "fresh"; invalid dates score 0.
- **Importance normalized across modes** — keyword mode drops ×10 → ×4 to
  match semantic mode (audit: "same memory ranks differently depending on
  embedding enablement"). The delta for importance 1→5 is now identical
  (+16) in both modes.

### Added
- **Provenance weighting** (audit: "source stored but never ranked") —
  memories carry `provenance: explicit | auto` in frontmatter: direct
  tool/API stores are `explicit` (+10 in ranking, both modes), digest
  extractions are `auto`. Pre-3.4.0 files have no field and score neutrally.
  Preserved through export/import.
- **Fuzzy dedup fast path** (audit: "dedup tolerance for fuzzy matches") —
  three dedup tiers now: exact → textual near-identity (Sørensen–Dice ≥ 0.9
  over bigrams; punctuation/case/typos) skipped **without an LLM call** →
  LLM merge for everything semantically evolved. Changed quantities
  (100→500 rpm, v2→v3) are explicitly *not* near-duplicates — they always
  reach the merge arbiter. Works against active, revives archived, and
  dedupes within a single digest batch.
- `docs/memory-model.md`: dedup tiers, corrected ranking weights, provenance
  row, stale "8-char id"/"embeddings planned for v2" text fixed.

### Deferred (recorded, not dropped)
- **Lazy loading for >10K stores** (audit Phase 4, P2) — the mechanism that
  actually serves this is the parsed-memory cache scheduled for Phase 5
  (performance); building a separate metadata index now would duplicate it.
  Tracked here per scope decision.

### Added (tests)
10 Phase-4 tests: decay curve + half-life + no-cliff, importance-delta
equality across modes, provenance deltas + ordering + persistence + snapshot
round trip, fuzzy skip (punctuation/typo/quantity guard), in-batch dedup,
archived revive, cross-scope isolation. **96/96 total.**

## [3.3.0] — 2026-09-23

**Phase 3 of the deep audit** — architecture: swappable backend, cross-process
locking, crash recovery, structured errors.

### Added
- **`MemoryBackend` interface** (`src/backend.ts`) — `MemoryService` now
  depends on the storage contract, not the file store; a DB backend can be
  dropped in without touching service/transport code. Tested against an
  in-memory implementation. Fixes audit Phase 3 item.
- **Advisory file locking** — `<root>/.remembra.lock` (`O_EXCL` create) around
  every mutation *including its read*, plus an in-process FIFO queue. Stale
  locks (dead pid or older than `REMEMBRA_LOCK_STALE_MS`) are stolen;
  waiters fail with typed `LOCK_TIMEOUT` after `REMEMBRA_LOCK_TIMEOUT_MS`.
  Fixes audit Phase 2 item (concurrent writers) and closes the
  touch-vs-archive resurrection window.
- **Crash-recovery pass** (the audit's "journal", recovery-pass flavor —
  documented rationale in `docs/architecture.md`): on first access per
  process, deletes orphaned `*.tmp` files and reconciles ids left in *both*
  active and archived trees by an interrupted archive/revive (finding #19);
  newest `updatedAt` wins. Logged when it does anything.
- **Structured error classification** — `RemembraError` with stable codes
  (`INVALID_INPUT`, `SNAPSHOT_INVALID`, `SCOPE_ESCAPES_ROOT`, `NOT_FOUND`,
  `CONFLICT`, `LOCK_TIMEOUT`, `IO_ERROR`, `LLM_ERROR`). HTTP maps codes →
  statuses and includes `code` in error bodies (423 for locked, 502 for LLM
  failures); MCP tools return `[CODE] message` with `isError: true`; raw fs
  failures wrap as `IO_ERROR`. Fixes audit Phase 2 item.
- **`docs/architecture.md`** — backend seam, locking model, recovery pass,
  error-code table, schema-versioning notes.

### Changed
- `archive()` now bumps `updatedAt` (state change updates recency; also makes
  crash-recovery tie-breaks deterministic).
- All six MCP tool handlers catch and classify failures instead of throwing
  through the SDK.

### Added (tests)
15 Phase-3 tests: non-file backend swappability, lock release/steal/timeout,
HTTP 423, mixed-concurrency single-tree invariant, tmp + both recovery
directions, error codes on every boundary, `formatToolError`/`statusFor`
units. **86/86 total.**

## [3.2.0] — 2026-09-23

**Phase 2 of the deep audit** — data integrity, portability, and shared schemas.

### Added
- **`remembra export <file>.json` / `remembra import <file>.json`** — full
  snapshot backup incl. archived memories. Import validates the *whole* file
  before writing (atomic rollback on any invalid entry) and is idempotent
  (existing ids and exact duplicates are skipped). Fixes audit #8.
- **Schema version field** — every memory file now carries `version: 1` in
  frontmatter; files without it (v1–v3.1) parse as v1. Fixes audit #10.
- `REMEMBRA_DEBUG=1` — opt-in storage-root path logging.

### Fixed
- **Log hygiene (audit #7)**: startup no longer prints the storage root path
  (gated behind `REMEMBRA_DEBUG`); embedding errors truncated to 200 chars;
  swallowed `touch()` errors now logged (audit #15); unparseable memory files
  warn once instead of being silently skipped.
- **Simultaneous digests** — digest runs are serialized through a lock, so
  parallel sessions can no longer double-store duplicates.
- **Merge LLM failure fails open** — a failed merge stores the new fact fresh
  instead of aborting the digest mid-way (never lose data).
- **Shared input schemas (audit #13)** — MCP tools, HTTP routes and the
  service all parse the same Zod shapes from `types.ts` (single source of
  truth; the `type` enum is no longer declared twice).
- `?limit=abc` on `/memories/search` no longer yields empty results (NaN guard).

### Changed
- MCP `memory_store` now applies `.default()` for `tags`/`importance` at the
  schema layer (behavior unchanged; validation moved to shared schemas).

### Added (tests)
12 Phase-2 tests: schema version + backward compat, malformed-file recovery,
empty transcript, extraction rollback, merge fail-open, parallel stores,
serialized digests, export/import round-trip, cross-id dedup, atomic import
rollback. **71/71 total.**

## [3.1.0] — 2026-09-23

**Security hardening** in response to the deep audit (`HILBRAS-MEMORY-DEEP-AUDIT.md`).

### Fixed
- **P0 directory traversal**: scopes containing `..` are rejected by validation,
  and `fileFor()` verifies the resolved path stays under `REMEMBRA_HOME`
  (defense in depth). Penetration test added.
- **Default-deny HTTP**: no API key → binds `127.0.0.1` only; non-loopback
  `REMEMBRA_HOST` without a key refuses to start.
- **Timing-safe API key comparison** (`crypto.timingSafeEqual`).
- **Request body size limit** (10 MiB default, `REMEMBRA_MAX_BODY`) → `413`.
- **Atomic writes** (temp file + `rename`) — crash can no longer leave
  half-written memory files.
- **ID length** 8 → 12 hex chars (2⁴⁸) + existence check on store (collision-safe).
- **Digest validation** on both transports (`DigestInput` Zod schema).
- **`Content-Length`** on all HTTP responses.
- `memory_list` MCP tool now exposes `includeArchived`; HTTP accepts
  `includeArchived=true`.

### Added
- `docs/security.md` — trust model (incl. role prompt-injection guidance),
  enforced protections, deployment checklist.
- 14 security tests (traversal pen test ×2, listen policy, body limit,
  digest validation, atomic-write leftovers, ID uniqueness).

## [3.0.0] — 2026-09-23

**Same content as 0.4.0** — version renumbered so the package version equals the
roadmap milestone (v3). No behavior changes.

## [0.4.0] — 2026-09-23

### Added
- **Memory lifecycle**: active → downrank → archived (unused 90d, `REMEMBRA_ARCHIVE_AFTER_DAYS`)
  → deleted (365d after archive, `REMEMBRA_ARCHIVE_TTL_DAYS`). Only archived memories are
  ever auto-deleted; roles never decay.
- **Decay piggybacks on search** (debounced 1/hour) — free file math; search hits refresh a
  memory's `lastSeen` clock, so used memories stay alive.
- **Contradiction merge**: digest LLM decisions are now `store | skip | merge` — evolved facts
  update the stored memory in place, preserving the old value as a
  `> superseded (date): ...` note. Fail-open: LLM failure stores fresh.
- **Revival**: digesting an exact duplicate of an archived memory revives it.
- **`memory_maintain` tool** + **`POST /maintain`** + **`remembra maintain` CLI** — explicit
  decay sweep + embedding vector backfill.
- `memory_list` gained `includeArchived`; archived memories show a `[archived]` flag.
- Store ops: `archive()`, `revive()`, `update()`, `touch()`; `archived/` storage tree.
- `docs/lifecycle.md` — full lifecycle + merge documentation.
- 11 new tests (decay, TTL delete, revival, merge decisions, backfill).

### Changed
- Storage stays file-based (decision: no SQLite — files remain source of truth).

## [0.3.0] — 2026-09-23

### Added
- **Session digest**: `memory_digest` tool + `POST /memories/digest` — LLM extracts
  facts/decisions/roles/history from a transcript and stores them.
- **Pluggable LLM provider**: `REMEMBRA_LLM=openai|anthropic|ollama` (+ `REMEMBRA_LLM_MODEL`).
- **Pluggable embeddings**: `REMEMBRA_EMBEDDINGS=openai|ollama|none` (default `none`).
- **Semantic search**: cosine similarity becomes the primary ranking signal when enabled;
  vectors cached in memory frontmatter (computed once on write).
- Scope and role rules remain hard gates in both ranking modes.
- Keyword fallback: memories without vectors, and any embedding API failure, degrade
  gracefully to keyword scoring (writes never blocked by embedding errors).
- Exact-match dedup in digest (type + scope + normalized content) — digests are idempotent.
- `docs/providers.md` — configuration guide for digest + embeddings.
- 18 new tests (digest, embeddings, retrieval modes, LLM output parsing).

### Changed
- `MemoryService` now accepts optional injected deps (embed/extract) for testing.

## [0.2.0] — 2026-09-23

### Added
- HTTP API mode: `remembra --http [--port N]` — same handlers as the MCP tools.
- Routes: `GET /health`, `POST /memories`, `GET /memories/search`, `GET /memories`,
  `DELETE /memories/:id`.
- API-key auth via `REMEMBRA_API_KEY` (`x-api-key` header or `Authorization: Bearer`).
- `REMEMBRA_PORT` env var as default port.
- Shared `MemoryService` core used by both MCP and HTTP transports.
- ChatGPT setup guide with full Custom GPT OpenAPI action schema (`docs/chatgpt.md`).
- HTTP and service test suites.

## [0.1.0] — 2026-09-23

### Added
- Initial release: MCP memory server for AI assistants.
- Four memory types: `fact`, `decision`, `role`, `history`.
- Hybrid scopes: `global` + per-project isolation (no cross-project leaks).
- File-based storage (`~/.remembra`, markdown + frontmatter), override via `REMEMBRA_HOME`.
- Layered retrieval: roles always surface → scope → importance → recency → keywords.
- MCP tools: `memory_store`, `memory_search`, `memory_list`, `memory_forget`.
- Client setup docs for OpenCode, Claude Code, Cline, and Kimi Code.
- Test suite (store round-trip, scope isolation, role priority, ranking, delete).
