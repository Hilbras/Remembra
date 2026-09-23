# Changelog

All notable changes to Remembra will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

> **Versioning:** from 3.0.0 on, package versions match roadmap milestones
> (3.0.0 = v3). Earlier releases used independent semver: 0.1.0 = v1,
> 0.2.0 = v1.5, 0.3.0 = v2, 0.4.0 = v3.

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
