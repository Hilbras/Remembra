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
  decides the winner;
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
