# Storage Format & Layout

The file format and on-disk contract for Remembra's file backend, plus the
SQLite runtime layout. SQLite is the default runtime backend and is **not
application-level encrypted**; the Markdown tree is the portable/legacy file
representation. Process concerns (locking details,
crash-recovery mechanics, the backend interface) live in
[architecture.md](architecture.md); this document is the **format reference**.

## Layout

```text
~/.remembra/                        ← REMEMBRA_HOME
├── global/<id>.md                  active memories with scope "global"
├── scopes/<scope>/<id>.md          active project-scoped memories
│                                   (scope chars outside [A-Za-z0-9._/-] → "_")
├── archived/global/<id>.md         archived (removed from default list/search)
├── archived/scopes/<scope>/...     archived scoped memories
├── tenants/<tenant-key>/...        V5 tenant namespaces (encoded key; strict filter required)
├── .history/<id>/<epochMs>-<seq>.md   version snapshots (raw pre-images)
├── .history/<id>/reasons.json         why each snapshot was superseded (4.1.0)
├── .remembra.lock                  advisory cross-process lock (transient)
├── data.sqlite                     default SQLite runtime database (+ WAL/SHM sidecars)
├── .recovery-state.json            durable recovery state (V5.0.3; 0600)
├── .tenant-migration-state.json    durable signed tenant-migration checkpoints (0600)
├── .snapshot-import-journal.json   interrupted file-import rollback journal (transient)
├── .idempotency/                   durable keyed-batch claim ledger (0700)
│   ├── claims.sqlite               HMAC-protected claim + generation metadata (0600)
│   ├── claims.key                  local row-integrity key (0600)
│   ├── claims.identity             ledger identity bound to that database (0600)
│   └── restore.pending             durable data-restore gate (0600, transient)
└── <id>.<rand>.tmp                 atomic-write staging files (transient;
                                    orphans are deleted by the recovery pass)
```

`data.sqlite` and its sidecars are absent when the explicitly enabled file
fallback is used. The `.idempotency` directory is independent of the selected
memory backend: `claims.identity` must always match `claims.sqlite`, and
`restore.pending` blocks normal serving rather than acting as a disposable lock.

- The **id is the filename**: a **UUIDv7** since 4.1.0 (plan §3.6) — a
  48-bit millisecond timestamp plus entropy, so ids sort by creation time
  and are unique from randomness alone (no collision scan, no retry loop;
  an existing memory can never be overwritten). Legacy 8–32 hex ids stay
  valid forever — files are never renamed on read.
- Active vs archived is encoded in the **tree**, and `archivedAt` in the
  metadata mirrors it. A crash between the two writes of an archive/revive
  move can dual-home an id — the recovery pass reconciles it (newest
  `updatedAt` wins).

## File format

Plain markdown: a `---` frontmatter block, one `key: value` per line, then the
content body:

```text
---
id: 01a0cdfe-9306-7453-9558-72a8bab41162
version: 3
revision: 3
type: decision
scope: /home/me/project
tags:
  - storage
  - md
importance: 4
confidence: 1
trust: trusted
created: 2026-09-23T11:20:08.197Z
updated: 2026-09-23T11:20:08.227Z
source: opencode
provenance:
  sourceType: manual
  sessionId: sess-8f1c
retention: pinned
relations:
  - id: 01a0cdfe-930f-7b25-962f-b2f64bf48a90
    kind: supports
embedding: [0.012,-0.045,...]
---

Chose file-based storage for markdown greppability.
```

YAML is spec-parsed (`yaml@^2`) and zod-validated on every read since 4.1.0,
so scopes/tags/sources containing YAML-ambiguous characters round-trip.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | hex8–32 or UUIDv7 | ✅ | equals the filename (path is the source of truth); UUIDv7 since 4.1.0 |
| `version` | int | ✅ on new files | Legacy records use `SCHEMA_VERSION = 3`; V5 tenant records use `TENANT_SCHEMA_VERSION = 4`. Readers accept up to `MAX_SCHEMA_VERSION`; V4 readers skip V5 tenant records. |
| `revision` | int | ✅ on new files | this memory's write counter — the JSON `version` used for optimistic concurrency (§3.5); missing on legacy files → 1 |
| `type` | 11 semantic types | ✅ | `fact · preference · decision · constraint · instruction · role · entity · relationship · event · history · observation` — see [memory-model.md](memory-model.md) |
| `scope` | string | ✅ | `global` or a project path/id; no `..` segments; V5 project authorization uses `projectId` |
| `tenantId` | string | V5 tenant records | organization boundary; server-derived, never a public request field |
| `projectId` | string | — | explicit V5 project dimension; cannot widen access beyond `scope` |
| `userId` | string | — | V5 creator/user dimension |
| `agentId` | string | — | V5 authorization-bearing agent; distinct from provenance |
| `tags` | YAML list | ✅ | one `- item` per line |
| `importance` | int 1–5 | ✅ | ranking weight |
| `confidence` | 0–1 | ✅ | trust in the claim; displayed, not ranked |
| `trust` | `unverified \| trusted \| verified \| system` | ✅ | gates instruction injection + ranks (4.1.0, §4.5); legacy files derive it from `provenance` on read |
| `created` / `updated` | ISO 8601 | ✅ | written as UTC with milliseconds |
| `lastSeen` | ISO 8601 | — | decay refresh (set when a memory surfaces in search) |
| `lastValidated` | ISO 8601 | — | stamped when `trust` changes (4.1.0, §4.2) |
| `archivedAt` | ISO 8601 | — | present ⇔ the file lives in the archived tree |
| `source` | string | — | originating session/client |
| `provenance` | nested object | ✅ | `{ sourceType, sessionId?, messageId?, agentId?, agentType?, agentVersion?, conversationId?, taskId?, runId?, provider? }` — where it came from (4.1.0, §4.3); legacy `explicit`/`auto` strings migrate on read |
| `owner` | enum | — | `user · agent · project · organization · global` (4.7.0) |
| `access` | enum | — | `private · shared · global`; agent-mode visibility policy (4.7.0) |
| `meta` | nested object | — | security/lifecycle/compression flags such as `quarantined`, `injected`, `contradicted` (4.7.0) |
| `retention` | decay mode | — | `pinned \| persistent \| ephemeral \| neverExpire` — omit = `decaying` (4.1.0, §4.8) |
| `relations` | list of `{id, kind}` | — | typed edges `supports · contradicts · supersedes · refines · duplicates · related` (4.1.0, §4.7); legacy `related: [ids]` migrates on read |
| `embedding` | `[f,f,…]` | — | vector cache (comma-separated, no spaces) |

**File-backend encryption (opt-in):** with `REMEMBRA_ENCRYPT_KEY` set, covered
file-backend memory/history files (frontmatter + body) are stored as
AES-256-GCM ciphertext. The migration command is legacy/non-tenant scoped;
reads without the key fail loudly (`ENCRYPTED_NO_KEY`). This does not encrypt
SQLite pages, exports, or transport.

**Writes are atomic**: temp file in the same directory + `rename()` — a crash
mid-write can never leave a half-written memory.

## Recovery state and staged operations

V5.0.3 stores the bounded recovery vocabulary (`Healthy`, `Degraded`,
`Recovering`, `Failed`, `ReadOnly`) in `.recovery-state.json`. Each transition
is written through a same-directory temporary file, `fsync`, and `rename`; the
reader rejects symlinks, malformed records, and oversized files. A normal
health probe cannot clear `Failed` or `ReadOnly`. `remembra recover read-only`
intentionally blocks service and CLI mutations, and `remembra recover verify`
performs a backend read before explicitly returning to `Healthy`.

SQLite restore additionally uses a `data.sqlite.restore-journal.json` state
file. Startup reconciliation verifies and publishes a staged database, keeps a
verified target, or restores the retained pre-restore database before the
backend is served. File-backend snapshot batches publish a
`.snapshot-import-journal.json` before writing and remove it only after the
batch succeeds; an interrupted process is rolled back on the next startup.
SQLite snapshot imports use a transaction, and file batches roll back
operational failures. Neither path reports an operational failure as a
successful import.

## Read validation (4.0.1, plan §3.4)

Every read validates the parsed object before it reaches ranking or a
transport. Two outcomes:

**Skipped** — the file's structure or semantics are unusable. It is excluded
from `get`/`all`/`search`, **left untouched on disk**, and logged once as
`memory_parse_skipped`:

| Reason | Trigger |
|--------|---------|
| missing/invalid frontmatter | no well-formed `---` block |
| invalid/unsupported schema version | non-numeric, or `version > MAX_SCHEMA_VERSION` (data from a newer Remembra) |
| invalid id | fails `[A-Za-z0-9._-]+` |
| invalid type | not one of the eleven memory types |
| invalid scope | empty, `..` segment, or backslash |
| empty content | nothing after the frontmatter |

**Downgrade contract:** tenantless V4 records remain `version: 3`, so a
V4.9 reader can round-trip the legacy namespace during migration. V5 records
with `tenantId` are `version: 4`; V4 readers **skip** those files — logged,
never deleted — because they cannot enforce organization isolation. Upgrading
again restores them untouched. Readers accept earlier versions and normalize
legacy shapes.

**Normalized** — recoverable value problems are fixed at read time and logged
once as `memory_normalized`, so the memory is still served and ranking math
can never see `NaN`:

| Field | Rule |
|-------|------|
| `importance` | non-numeric → `3`; otherwise clamped to 1–5 |
| `confidence` | missing/non-numeric → `0.7` (conversation provenance) or `1.0`; otherwise clamped to 0–1 |
| `trust` | missing/invalid → derived from `provenance` (`conversation` → `unverified`, `system` → `system`, else `trusted`) |
| `created`/`updated`/`lastSeen`/`archivedAt` | unparseable → epoch fallback / dropped |
| `id` ≠ filename | filename wins |
| `provenance` | legacy string `auto` → `{ sourceType: conversation }`, `explicit` → `{ sourceType: manual }`; invalid object → `{ sourceType: manual }` |
| `embedding` | non-finite entries → dropped (keyword fallback) |
| `relations` | entries failing the id pattern are filtered out; legacy `related` entries → kind `related` |

Skipped files become readable again by fixing them by hand or re-storing them
through the API — nothing is ever deleted automatically for being invalid.

## History (version snapshots)

Content-changing updates (`memory_update`, `PUT`, merge) copy the on-disk
pre-image to `.history/<id>/<epochMs>-<seq>.md` **before** writing —
byte-for-byte (ciphertext preserved in encrypted mode). When the update
supplies a `reason`, it plus a `supersededAt` timestamp is recorded in
`.history/<id>/reasons.json` (encrypted with the rest of the store in 4.1.0,
plan §4.6) — the superseded text is **never inlined into the new content**;
`memory_history` returns both beside each version. Pruned beyond
`REMEMBRA_HISTORY_LIMIT` (default 20, `0` disables — snapshots and their
reasons go together). Non-content changes (tags, importance, trust-only
writes, embedding backfill, scope moves, linking) never snapshot — content
changed or it didn't.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_HOME` | `~/.remembra` | Storage root |
| `REMEMBRA_LOCK_TIMEOUT_MS` | `5000` | Max wait for the cross-process lock |
| `REMEMBRA_LOCK_STALE_MS` | `10000` | Age after which a lock with a dead pid is stolen |
| `REMEMBRA_CACHE_SIZE` | `10000` | Parse-cache LRU capacity; `0` disables |
| `REMEMBRA_HISTORY_LIMIT` | `20` | Version snapshots kept per memory; `0` disables |
| `REMEMBRA_ENCRYPT_KEY` | *(unset)* | 64-hex key for covered file-backend memory/history encryption; not SQLite/snapshot/transport encryption |

Full env index: [clients.md](clients.md#environment). Migration/export:
`remembra export` / `remembra import` (see [public-api.md](public-api.md)).
Migration CLI (`remembra migrate`, `export-markdown`, `import-markdown`,
`backup`, `restore`) is documented in [public-api.md](public-api.md).

## SQLite Backend (V4.3.0)

Since 4.3.0 the **runtime** backend is SQLite (`SqliteBackend`). The file tree
remains the **export format** and the source for migration. On first launch,
legacy `.md` files are read into the database and moved to `<root>/.legacy/`.

Schema (auto-created):

| Table | Purpose |
|-------|---------|
| `memories` | Main memory rows; BLOB embeddings; nullable V5 tenant/project/user/agent columns |
| `memories_fts` | FTS5 virtual table for keyword search |
| `memory_versions` | Content-change snapshots (history) |
| `memory_audit` | Best-effort backend mutation log; tenant columns scope strict reads, but it is not immutable/complete anti-repudiation evidence |

Tenant columns are nullable during the expand phase so V4.9 SQLite databases
remain readable. Strict mode requires the service to supply a tenant filter;
candidate SQL applies organization/project/user/agent predicates before limits
and count calculation. Unscoped reads exclude tenant rows. The exact
visibility and capability contract is in
[`v5.0.2-authorization.md`](v5.0.2-authorization.md).

FTS5 is optional: if the SQLite build lacks FTS5 support the backend starts
without the virtual table and degrades to keyword-only scoring with a startup
warning. See [v4.3.0-spec.md](v4.3.0-spec.md) for the full schema SQL.
