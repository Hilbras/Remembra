# Architecture

How Remembra is put together, and where the extension seams are.

```
┌──────────────┐   ┌──────────────┐
│ MCP tools    │   │ HTTP API     │      Transports (thin adapters)
│ (index.ts)   │   │ (http.ts)    │
└──────┬───────┘   └──────┬───────┘
       │  both call the same handlers
       ▼                  ▼
┌──────────────────────────────────┐
│ MemoryService (service.ts)       │  Search orchestration, digest/dedup/merge,
│  ← depends on MemoryBackend only │  decay lifecycle, snapshots, embed/LLM fail-open
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐
│ MemoryBackend (backend.ts)       │  The storage contract
└──────────────┬───────────────────┘
               ▼
┌──────────────────────────────────┐   ┌──────────────────────────┐
│ SqliteBackend (sqlite-backend.ts)│   │ MemoryStore (store.ts)   │
│  WAL mode · FTS5 · BLOB vectors  │◄─►│  Plain markdown files    │
│  optimistic concurrency          │   │  (export target / legacy)│
│  auto-migration from flat files  │   │                          │
└──────────────────────────────────┘   └──────────────────────────┘
```

## MemoryBackend: the swap seam (audit Phase 3)

`MemoryService` never touches the filesystem directly — it talks to the
`MemoryBackend` interface (`src/backend.ts`). Today's implementation is
`MemoryStore` (markdown files). A future SQLite/vector-DB backend only has to
satisfy that interface; the tests include an `InMemoryBackend` proving the
service runs unchanged against a non-file implementation.

Contract highlights:

- mutations must be safe under same-process **and** cross-process concurrency;
- a memory id exists in **exactly one tree** (active or archived) at rest;
- `importMemory` refuses ids that already exist;
- V5 strict mode supplies a `TenantFilter` to every data-plane method and
  requires `tenantCapable` backends; the file backend keeps tenant namespaces
  out of unscoped legacy reads.

## Concurrency model (audit Phase 2: advisory locking)

Three layers, from narrowest to widest:

| Layer | Mechanism | Guards against |
|-------|-----------|----------------|
| Single write | temp file + `rename()` (POSIX-atomic) | torn/corrupt files on crash |
| One process | FIFO queue inside `MemoryStore` | same-instance async races (touch vs archive, parallel stores) |
| Many processes | `<root>/.remembra.lock` (`O_EXCL` create) | MCP server vs `remembra maintain` CLI vs a second session |

Lock rules:

- acquired around every mutating operation (store/update/archive/revive/
  touch/forget/import) **including its read**, so read-modify-write cycles are
  whole;
- **stale steal**: a lock whose pid is dead (or older than
  `REMEMBRA_LOCK_STALE_MS`, default 10 s) is removed; the `O_EXCL` re-create
  decides the winner. A *fresh* lock carrying this process's own pid is **not**
  stale — a sibling store instance in the same process may hold it live (the
  in-process FIFO only serializes within one instance); abandoned own-pid
  files are still recovered by the age rule;
- **timeout**: waiting longer than `REMEMBRA_LOCK_TIMEOUT_MS` (default 5 s)
  fails with the typed `LOCK_TIMEOUT` error (HTTP 423);
- **optimistic concurrency** (4.1.0, plan §3.5): `update()` compares the
  caller's `expectedVersion` against the *fresh* on-disk `revision`
  **inside the lock**, then writes `disk + 1` — a stale writer loses with
  `CONFLICT` (HTTP 409) instead of silently clobbering;
- released in a `finally`, verified by pid before unlinking.

Reads (`get`/`all`) don't lock — atomic rename means they always see a
consistent file.

## Crash recovery (audit Phase 3: "journal")

Atomic `rename()` already guarantees no half-written memory files, so instead
of a write-ahead log (which would itself need journaling) Remembra runs a
one-time **recovery pass** on first store access per process:

1. delete orphaned `*.tmp` files (crash between write and rename);
2. reconcile ids found in **both** active and archived trees (crash between
   archive/revive's write and unlink, audit finding #19) — newest `updatedAt`
   wins, ties go to the archived copy.

Anything it fixes is logged:
`Remembra: crash recovery — removed N orphaned temp file(s), reconciled N interrupted move(s)`.

## Error classification (audit Phase 2)

All actionable failures are `RemembraError` with a stable `code`
(`src/errors.ts`): `INVALID_INPUT`, `SNAPSHOT_INVALID`, `SCOPE_ESCAPES_ROOT`,
`NOT_FOUND`, `CONFLICT`, `LOCK_TIMEOUT`, `IO_ERROR`, `LLM_ERROR`,
`PROVIDER_TIMEOUT` (4.0.1), `INTERNAL`, `ENCRYPTED_NO_KEY`.

- **HTTP** maps codes → statuses (400/404/409/423/500/502/503/504) and returns
  `{ error, code }` bodies;
- **MCP tools** return `[CODE] message` text with `isError: true`;
- raw filesystem failures are wrapped as `IO_ERROR`; Zod failures crossing a
  service boundary become `INVALID_INPUT`/`SNAPSHOT_INVALID` with a field
  summary;
- `ENCRYPTED_NO_KEY` (Phase 8) deliberately breaks the "skip unparseable
  files" rule: an encrypted file without `REMEMBRA_ENCRYPT_KEY` (or with a
  wrong one) is **data you must be able to read**, so it propagates —
  searches fail with 503 and `/health` reports
  `storage: "ENCRYPTED_NO_KEY"` instead of silently serving partial results.

## Provider boundary

LLM and embedding calls sit behind vendor-neutral adapters
(`src/provider-adapters.ts`). Built-in OpenAI-compatible, Anthropic, and
Ollama adapters translate their request/response shapes, while injected local
adapters can use any runtime implementation. Every HTTP adapter delegates to
`providerFetch` for timeout, cancellation, retry, budget, and normalized error
handling. The service only depends on the adapter interfaces, so provider
selection does not leak into memory storage or retrieval policy. See
[providers.md](providers.md).

## V5 context assembly

`MemoryService.context` reuses the same candidate generation, ranking, and
trusted visibility filters as `search`, then applies a hard token budget while
walking ranked results. It is read-only (`touch` and opportunistic decay are
disabled), omits internal embedding vectors from returned memory objects, and
never serializes a candidate that exceeds the budget. The HTTP, SDK, and MCP
transports call this same service method; see
[v5-context-spec.md](v5-context-spec.md).

## V5 policy configuration

`src/policy.ts` loads a bounded, validated policy once during service
construction. Defaults are merged with an optional trusted YAML file and
explicit environment overrides; invalid configuration fails closed. Request
payloads cannot override extraction, sensitive-data, lifecycle, retrieval, or
provenance policy. See [v5-policy.md](v5-policy.md).

## V5 tenant boundary

`src/tenant.ts` defines the host-minted, immutable tenant context and
fail-closed identifier/matching primitives. `src/tenant-directory.ts` defines
the versioned organization/user/project/agent membership authority used to
re-authorize queued work; its in-memory implementation is a reference adapter
and `tenant-directory-file.ts` provides an atomic local durable adapter, both
replaceable by the host's production identity store. `tenant-entities.ts`
adds the trusted organization-derived CRUD/pagination and membership-audit
service.
`src/tenant-migration.ts` defines the canonical HMAC-signed migration manifest;
`src/tenant-migration-runner.ts` preflights and idempotently applies a mapped
plan to a tenant-capable backend. `src/migration-state.ts` adds an atomic,
bounded, checkpointed state file, verified resume points, explicit failure
state, and an operator-confirmed publication marker. A backend-specific atomic
swap/publication hook remains a separate deployment concern.
The file and SQLite backends now
accept optional tenant filters, hide tenant rows from unscoped legacy reads,
and apply tenant predicates to point/candidate/history/audit paths. The strict
service path now requires opaque contexts, and HTTP/MCP transports bind them
through trusted host resolvers. Queued handlers can re-check host membership,
and embedding calls accept tenant-safe cache partitions. The CLI binds strict
mode to an explicit local operator context and refuses legacy global recovery
commands. Broader derived-cache invalidation remains staged in
[v5-tenant-spec.md](v5-tenant-spec.md).

## Schema versioning

Every memory file carries `version: <n>` in frontmatter. Tenantless V4
records use `SCHEMA_VERSION = 3`; V5 records with an organization boundary use
`TENANT_SCHEMA_VERSION = 4`. Files without the field (v1–v3.1) parse through
the legacy path. Two different numbers, deliberately:

- frontmatter `version` is the **schema guard** — readers refuse versions
  above `MAX_SCHEMA_VERSION`; older V4 readers skip V5 tenant files (logged,
  never deleted), while legacy records remain round-trippable;
- frontmatter `revision` is the memory's own **write counter** — exposed as
  JSON `version` and compared by `expectedVersion` (§3.5).

To change the format: bump the relevant constant, add a migration branch in
`parse()`, and cover it with a fixture test. SQLite expands nullable tenant
columns before strict mode; the strict database migration is a later rollout
step described in [v5-tenant-spec.md](v5-tenant-spec.md).

Ids are **UUIDv7** since 4.1.0 (plan §3.6): time-ordered, unique from
entropy alone, so allocation needs no collision scan (legacy 8–32 hex ids
remain valid forever).

## Encryption at rest (audit Phase 8, opt-in — `src/crypto.ts`)

`REMEMBRA_ENCRYPT_KEY` (64 hex chars, a 32-byte symmetric key used directly —
no KDF for high-entropy material) flips two chokepoints in `MemoryStore`:

- **write** (`writeCached`): serialized bytes → `encryptBuffer` → atomic
  rename. One random 12-byte nonce per write, AES-256-GCM.
- **read** (`parse`): bytes → `decryptBuffer` → frontmatter parse. Detection
  is by the `RMBENC1` magic prefix, so **plain and encrypted files coexist**
  — mixed trees read fine, cache validation stays stat-based, and history
  snapshots (raw byte copies) keep whatever form they were written in.

Migration is an explicit locked operation, not a lazy rewrite:
`remembra encrypt` / `remembra decrypt` walk `global/`, `scopes/`,
`archived/` and `.history/`, convert in place under the advisory lock, and
skip files already in the target state (idempotent). Writes after enabling
the key are encrypted immediately — migration only covers what's already on
disk.

Failure semantics: `decryptBuffer` passes plain bytes through untouched;
ciphertext without/with a wrong key throws `ENCRYPTED_NO_KEY` (503). The
warn-once "skip malformed file" path explicitly re-throws `RemembraError`s —
unreadable storage must never degrade into *smaller* search results.

## Version history (audit Phase 8 — `snapshotHistory` / `history`)

`MemoryStore.update()` is the single content-mutation chokepoint (merge
today; anything future). Before rewriting a file whose **content differs**
from what's on disk, it copies the raw pre-image to
`.history/<id>/<epochMs>-<seq>.md`:

- `epochMs-seq` names sort lexicographically = chronologically (seq breaks
  same-millisecond ties; the advisory lock serializes writers);
- raw copy ⇒ encrypted files stay encrypted, plain stay plain, byte-for-byte;
- content-equality gate ⇒ embedding backfills, trust-only writes and
  `memory_relate` never create snapshots;
- when the update carries a `reason`, `{ reason, supersededAt }` is stored
  beside the snapshots in `.history/<id>/reasons.json` (encrypted with the
  tree; 4.1.0, plan §4.6) and returned by `history(id)` — superseded text is
  never inlined into the current content;
- pruning keeps the newest `REMEMBRA_HISTORY_LIMIT` (default 20, `0`
  disables) per id;
- `.history/` is *data-adjacent but never walked by `all()`* — reads go
  through the explicit `history(id)` path only (`.tmp` cleanup in crash
  recovery does cover it).

## Parse cache (audit Phase 5: LRU + lazy loading)

Every read goes through an LRU keyed by file path and **validated by
`(mtimeMs, size)`** on every access:

- **hit** → one `stat()` instead of read+parse (the "lazy loading" the audit
  asked for: content bytes are only touched when the file actually changed);
- **miss** → read + parse, then remember with the stat just taken;
- **writes** remember the exact object + stat they produced; `forget`/
  archive-move evict;
- **another process** (server vs `remembra maintain`, concurrent CLI) edits a
  file → its stat no longer matches → automatic re-parse. Correctness never
  depends on cache coherence, only speed does.

Config: `REMEMBRA_CACHE_SIZE` (default 10000 entries — a full audit-scale
store fits; `0` disables). Observability: `store.cacheStats() → { size,
capacity }`. Trade-off kept deliberately: the directory walk (`readdir`) still
runs on every query — it is how new/deleted files are discovered; only the
read+parse cost is cached.

## Pagination & streaming (audit Phase 5)

- `GET /memories` and `memory_list` accept optional `offset`/`limit`
  (opt-in — absent means the full list, preserving the original contract) and
  always report `total`. Text output gains a `Showing X–Y of Z` header when
  paginated.
- Responses estimated at **≥ 64 KiB** (list/search — embeddings dominate the
  estimate) are written as **chunked JSON**: headers go out without
  `content-length` and each item is serialized as its own write instead of
  buffering one giant string. Smaller responses keep `Content-Length` and
  pretty JSON.

## Scale posture: no ANN index (audit Phase 5, declined with evidence)

Brute-force cosine **is** the vector index at our target scale: the benchmark
in `src/test/phase5.test.ts` measures a full search over **10,000 ×
768-dimensional vectors in ~74 ms** — a single-threaded file walk with JS math
comfortably inside an interactive budget. Native ANN libraries
(FAISS/HNSW bindings) would add a compiled toolchain to every
`npm install` for double-digit milliseconds of savings.

Revisit when either holds: **> 50k vectors**, or measured p95 search >
100 ms on typical hardware. At that point the seam already exists —
`MemoryBackend` can front an index without touching the service, and
embeddings live in frontmatter so the index is a rebuildable cache, not a
source of truth.
