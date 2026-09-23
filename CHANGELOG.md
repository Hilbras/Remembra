# Changelog

All notable changes to Remembra will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

> **Versioning:** from 3.0.0 on, package versions match roadmap milestones
> (3.0.0 = v3). Earlier releases used independent semver: 0.1.0 = v1,
> 0.2.0 = v1.5, 0.3.0 = v2, 0.4.0 = v3.

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
