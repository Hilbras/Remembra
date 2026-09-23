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
┌──────────────────────────────────┐
│ MemoryStore (store.ts)           │  Plain markdown files + frontmatter
│  .remembra lock · crash recovery │  (no database, by decision — Q5-A)
└──────────────────────────────────┘
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
- `importMemory` refuses ids that already exist.

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
`NOT_FOUND`, `CONFLICT`, `LOCK_TIMEOUT`, `IO_ERROR`, `LLM_ERROR`.

- **HTTP** maps codes → statuses (400/404/409/423/500/502) and returns
  `{ error, code }` bodies;
- **MCP tools** return `[CODE] message` text with `isError: true`;
- raw filesystem failures are wrapped as `IO_ERROR`; Zod failures crossing a
  service boundary become `INVALID_INPUT`/`SNAPSHOT_INVALID` with a field
  summary.

## Schema versioning

Every memory file carries `version: <n>` in frontmatter (`SCHEMA_VERSION` in
`types.ts`). Files without the field (v1–v3.1) parse as v1. To change the
format: bump the constant, add a migration branch in `parse()`, and cover it
with a fixture test.

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
768-dimensional vectors in ~32 ms** — a single-threaded file walk with JS math
comfortably inside an interactive budget. Native ANN libraries
(FAISS/HNSW bindings) would add a compiled toolchain to every
`npm install` for double-digit milliseconds of savings.

Revisit when either holds: **> 50k vectors**, or measured p95 search >
100 ms on typical hardware. At that point the seam already exists —
`MemoryBackend` can front an index without touching the service, and
embeddings live in frontmatter so the index is a rebuildable cache, not a
source of truth.
