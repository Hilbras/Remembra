# Memory Lifecycle & Maintenance (V5)

Remembra memories age. Instead of the store growing forever and stale facts
competing with current ones, memories move through a lifecycle — and nothing
active is ever auto-deleted.

## The lifecycle

```
active ──(unused 90d)──► archived ──(365d past archive)──► deleted
  ▲                          │
  └────── revive ◄───────────┘   (exact duplicate re-digest / re-store)
```

| Stage | Trigger | Effect |
|-------|---------|--------|
| **Active** | normal storage | fully searchable |
| **Downrank** | age (recency score decays naturally) | older memories rank lower |
| **Archived** | unused for `REMEMBRA_ARCHIVE_AFTER_DAYS` (default **90**) | moved to `archived/` — out of search, still visible via `memory_list {includeArchived: true}` |
| **Deleted** | `REMEMBRA_ARCHIVE_TTL_DAYS` (default **365**) after archiving | current file/backend row removed; this is not secure erasure of history, exports, backups, replicas, or provider copies |

### Rules

- **Search hits refresh the clock** — a memory that surfaces in results gets its
  `lastSeen` bumped (throttled to once/hour), pushing its archive date out.
  Used memories stay alive; forgotten ones fade.
- **Standing guidance never decays** — `role`/`instruction` memories are
  excluded from archiving.
- **Retention modes override the clocks** (4.1.0, plan §4.8) — `pinned` and
  `neverExpire` are fully exempt (never archived or deleted), `persistent` is
  archivable but never auto-deleted; see
  [memory-model.md](memory-model.md#retention-410-plan-48).
- **Only archived memories are ever auto-deleted** — an active memory must
  survive the full 90 + 365 days of neglect first.
- **Revival is automatic** — digesting an exact duplicate of an archived memory
  brings it back to active with a fresh clock.
- **Reversible until deleted** — file-backend records sit under the selected
  backend's archived namespace; move one back by hand or re-store it. SQLite
  lifecycle operations follow the same service policy.

## When maintenance runs

| Path | What runs | Cost |
|------|-----------|------|
| **On search** (piggyback, debounced 1/hour) | decay sweep + `lastSeen` refresh | free (file math) |
| **`memory_maintain` tool** / **`POST /maintain`** / **`remembra maintain`** CLI | decay sweep **+ embedding backfill** | backfill uses your embedding API |

Heavy/quotad work (embedding backfill) is always explicit; decay sweeps
opportunistically because they cost nothing.

```bash
# CLI one-shot (prints JSON, exits)
remembra maintain
```

```json
{ "archived": ["a1b2c3d4"], "deleted": ["e5f6a7b8"], "embedded": 12 }
```

## Contradiction merging

When a digest extracts something that *evolved* from a stored memory
("API limit is 100 rpm" → "API limit is 500 rum"), an LLM decides per item:

| Decision | Behavior |
|----------|----------|
| `store` | unrelated/complementary — stored fresh alongside |
| `skip` | same fact, paraphrased — counted as duplicate, nothing written |
| `merge` | newer version of the same fact — stored memory **updated in place** |

Since 4.1.0 (plan §4.6) merges **don't inline** the old value into the new
text — the superseded pre-image stays recoverable from version history with
`reason: "digest merge (superseded by a newer extraction)"` recorded beside
it, instead of polluting the current content with a `> superseded` note.

Candidate detection is cheap (keyword overlap or cosine similarity ≥ 0.4,
same type + scope) — the LLM is only called when two memories are plausibly
about the same thing. If the merge LLM fails, the item is **stored fresh**
(fail-open: extraction never loses data).

Since 3.8.0 a merge also snapshots the **pre-merge file** into
`.history/<id>/` first — every past version stays recoverable with
`memory_history` / `GET /memories/:id/history`, which renders a unified line
diff of old → new for each version plus the `reason`/`supersededAt` recorded
in `.history/<id>/reasons.json` (pruned to `REMEMBRA_HISTORY_LIMIT`,
default 20).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_ARCHIVE_AFTER_DAYS` | `90` | Unused active memory → archive after this |
| `REMEMBRA_ARCHIVE_TTL_DAYS` | `365` | Archived memory deleted after this |

## Storage layout

```
~/.remembra/
├── global/<id>.md             # active, global
├── scopes/<scope>/<id>.md     # active, project-scoped
├── archived/
│   ├── global/<id>.md         # archived (excluded from search)
│   └── scopes/<scope>/<id>.md
└── .history/<id>/<epoch>-<seq>.md   # superseded pre-images (3.8.0)
    └── reasons.json                 # {reason, supersededAt} per snapshot (4.1.0)
```

---

## V6 expiration semantics

The V6 lifecycle model (`src/v6-lifecycle.ts`) makes expiration, retention, legal hold,
archive, deletion and supersession **separate dispositions**. They all sound like "the
memory is gone", and conflating them is not a wrong answer but a *destructive* one:
deleting under a retention policy when a legal hold applied cannot be undone.

### The clock

Expiry is an **instant in UTC milliseconds**, and every evaluation takes an explicit
`now`. Nothing in the module reads the ambient clock, because a boundary is the only
interesting part of an expiry and it cannot be tested without an injected clock.

A timestamp **must carry an explicit offset or `Z`**. A naive local timestamp is
refused: it resolves to a different instant on different machines, so the same data
expires at different times depending on which machine evaluates it.

A malformed timestamp is **refused, not coerced**. Coercing to `NaN` turns a typo into
"expires immediately"; coercing to `0` turns it into "never expires". Both are silent
corruption of retention intent, so both are errors.

### Boundaries

| Case | Result |
|---|---|
| `expiresAt` undefined | `never_expires` — distinct from `active`, because the two are different retention intents and must not look alike in an audit |
| `expiresAt > now` | `active` |
| `expiresAt == now` | **`expired`** — expiry is exclusive. The alternative makes "expires at T" mean "usable until T", which is the more surprising reading. |
| `expiresAt < now` | `expired` |

Clock skew widens an **announcement**, never the expiry: a record within
`skewToleranceMs` of expiry reports `expiring` and stays retrievable. Skew must never
make something expire early.

### Actions

| Action | Effect | Notes |
|---|---|---|
| `expire` | marks expirable | **not** a deletion; deleting is a separate, separately audited step |
| `delete` | deletes | requires the record to actually be **expired** — retention is not a licence to delete early |
| `archive` | archives | reversible; distinct from deletion |
| `supersede` | records `supersededBy` | does **not** delete; the audit trail is the point |
| `renew` | extends expiry from `now` | bounded by `maxRenewals` |

Every action returns a new record and a `disposition` naming which one happened, or a
`blockedBy` saying why it did not. Actions are idempotent: a repeated action is a no-op
and the version does not move.

### Legal hold

A legal hold blocks **deletion and archive**, and is absolute. There is deliberately no
`force` flag — an operator override is a legitimate need, but it belongs in a separate,
audited path. Burying a bypass in a job parameter is how holds stop meaning anything.

A hold does **not** block visibility. A held memory stays readable by id and appears in
operator tooling; it is excluded from *retrieval candidates*, so it does not surface in
search results or assembled context. (A hold blocks destruction, not visibility — see
ADR §3.)

### The job

`runLifecycleJob` is bounded (`batchLimit`, with the overflow **reported** rather than
silently dropped), tenant-scoped (foreign rows are counted as skipped and left
untouched), and **rechecks** expiry itself rather than reading the record's field — a
record claiming to be expiring is not evidence.

It **returns its effects** in `updated`. This is load-bearing: a job that counts
deletions without returning the updated records leaves a restarted job with nothing to
skip, so it deletes the same rows twice.
