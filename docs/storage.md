# Storage Format & Layout

The file format and on-disk contract for Remembra's store — the human-readable,
local-first source of truth (no database). Process concerns (locking details,
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
├── .history/<id>/<epochMs>-<seq>.md   version snapshots (raw pre-images)
├── .remembra.lock                  advisory cross-process lock (transient)
└── <id>.<rand>.tmp                 atomic-write staging files (transient;
                                    orphans are deleted by the recovery pass)
```

- The **id is the filename**: 12 hex chars (2⁴⁸) from `randomUUID`.
  Collisions are detected with an existence check and retried (up to 10
  times), then rejected with `CONFLICT` — an existing memory is never
  overwritten.
- Active vs archived is encoded in the **tree**, and `archivedAt` in the
  metadata mirrors it. A crash between the two writes of an archive/revive
  move can dual-home an id — the recovery pass reconciles it (newest
  `updatedAt` wins).

## File format

Plain markdown: a `---` frontmatter block, one `key: value` per line, then the
content body:

```text
---
id: 7133edba0c44
version: 1
type: decision
scope: /home/me/project
tags: [storage, md]
importance: 4
created: 2026-09-23T05:53:50.366Z
updated: 2026-09-23T06:10:00.000Z
lastSeen: 2026-09-23T07:00:00.000Z
source: opencode
provenance: explicit
confidence: 1
related: [a1b2c3d4e5f6]
embedding: [0.012,-0.045,...]
---

Chose file-based storage for v1.
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `[A-Za-z0-9._-]+` | ✅ | equals the filename (path is the source of truth) |
| `version` | int | ✅ on new files | schema version (`SCHEMA_VERSION = 1`); missing on legacy v1-era files (treated as 1) |
| `type` | `fact \| decision \| role \| history` | ✅ | memory semantics — see [memory-model.md](memory-model.md) |
| `scope` | string | ✅ | `global` or a project path/id; no `..` segments |
| `tags` | `[a, b]` | ✅ | comma-separated inside brackets |
| `importance` | int 1–5 | ✅ | ranking weight |
| `created` / `updated` | ISO 8601 | ✅ | written as UTC with milliseconds |
| `lastSeen` | ISO 8601 | — | decay refresh (set when a memory surfaces in search) |
| `archivedAt` | ISO 8601 | — | present ⇔ the file lives in the archived tree |
| `source` | string | — | originating session/client |
| `provenance` | `explicit \| auto` | — | manually stored vs digest-extracted |
| `confidence` | 0–1 | — | trust in the claim; displayed, not ranked |
| `related` | `[id, id]` | — | relationship-graph links |
| `embedding` | `[f,f,…]` | — | vector cache (comma-separated, no spaces) |

**Encryption (opt-in, 3.8.0):** with `REMEMBRA_ENCRYPT_KEY` set, the entire
file (frontmatter + body) is stored as AES-256-GCM ciphertext after
`remembra encrypt`. Reads without the key fail **loudly**
(`ENCRYPTED_NO_KEY`, health 503) — they are never warn-skipped.

**Writes are atomic**: temp file in the same directory + `rename()` — a crash
mid-write can never leave a half-written memory.

## Read validation (4.0.1, plan §3.4)

Every read validates the parsed object before it reaches ranking or a
transport. Two outcomes:

**Skipped** — the file's structure or semantics are unusable. It is excluded
from `get`/`all`/`search`, **left untouched on disk**, and logged once as
`memory_parse_skipped`:

| Reason | Trigger |
|--------|---------|
| missing/invalid frontmatter | no well-formed `---` block |
| invalid/unsupported schema version | non-numeric, or `version > SCHEMA_VERSION` (data from a newer Remembra) |
| invalid id | fails `[A-Za-z0-9._-]+` |
| invalid type | not one of the four memory types |
| invalid scope | empty, `..` segment, or backslash |
| empty content | nothing after the frontmatter |

**Normalized** — recoverable value problems are fixed at read time and logged
once as `memory_normalized`, so the memory is still served and ranking math
can never see `NaN`:

| Field | Rule |
|-------|------|
| `importance` | non-numeric → `3`; otherwise clamped to 1–5 |
| `confidence` | non-numeric → dropped; otherwise clamped to 0–1 |
| `created`/`updated`/`lastSeen`/`archivedAt` | unparseable → epoch fallback / dropped |
| `id` ≠ filename | filename wins |
| `provenance` | unknown value → dropped |
| `embedding` | non-finite entries → dropped (keyword fallback) |
| `related` | entries failing the id pattern are filtered out |

Skipped files become readable again by fixing them by hand or re-storing them
through the API — nothing is ever deleted automatically for being invalid.

## History (version snapshots)

Content-changing updates (`memory_update`, `PUT`, merge) copy the on-disk
pre-image to `.history/<id>/<epochMs>-<seq>.md` **before** writing —
byte-for-byte (ciphertext preserved in encrypted mode). Pruned beyond
`REMEMBRA_HISTORY_LIMIT` (default 20, `0` disables). Non-content changes
(tags, importance, embedding backfill, scope moves) never snapshot.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_HOME` | `~/.remembra` | Storage root |
| `REMEMBRA_LOCK_TIMEOUT_MS` | `5000` | Max wait for the cross-process lock |
| `REMEMBRA_LOCK_STALE_MS` | `10000` | Age after which a lock with a dead pid is stolen |
| `REMEMBRA_CACHE_SIZE` | `10000` | Parse-cache LRU capacity; `0` disables |
| `REMEMBRA_HISTORY_LIMIT` | `20` | Version snapshots kept per memory; `0` disables |
| `REMEMBRA_ENCRYPT_KEY` | *(unset)* | 64-hex key → AES-256-GCM at rest |

Full env index: [clients.md](clients.md#environment). Migration/export:
`remembra export` / `remembra import` (see [public-api.md](public-api.md)).
