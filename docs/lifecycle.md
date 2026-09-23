# Memory Lifecycle & Maintenance (v3)

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
| **Deleted** | `REMEMBRA_ARCHIVE_TTL_DAYS` (default **365**) after archiving | file removed permanently |

### Rules

- **Search hits refresh the clock** — a memory that surfaces in results gets its
  `lastSeen` bumped (throttled to once/hour), pushing its archive date out.
  Used memories stay alive; forgotten ones fade.
- **Roles never decay** — standing instructions are excluded from archiving.
- **Only archived memories are ever auto-deleted** — an active memory must
  survive the full 90 + 365 days of neglect first.
- **Revival is automatic** — digesting an exact duplicate of an archived memory
  brings it back to active with a fresh clock.
- **Reversible until deleted** — archived files sit in plain markdown under
  `~/.remembra/archived/`; move one back by hand or re-store it.

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

Merged files preserve the old value:

```markdown
API rate limit is 500 rpm

> superseded (2026-09-23): API rate limit is 100 rpm
```

Candidate detection is cheap (keyword overlap or cosine similarity ≥ 0.4,
same type + scope) — the LLM is only called when two memories are plausibly
about the same thing. If the merge LLM fails, the item is **stored fresh**
(fail-open: extraction never loses data).

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
└── archived/
    ├── global/<id>.md         # archived (excluded from search)
    └── scopes/<scope>/<id>.md
```
