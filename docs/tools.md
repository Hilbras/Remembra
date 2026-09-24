# Tool Reference

Remembra exposes thirteen MCP tools. All of them work the same way across every
MCP-compatible client.

The V4.9 stable manifest is version `1` and contains exactly these names:
`memory_store`, `memory_batch`, `memory_digest`, `memory_maintain`,
`memory_search`, `memory_list`, `memory_forget`, `memory_get`,
`memory_relate`, `memory_history`, `memory_update`, `memory_archive`, and
`memory_revive`. Existing names are not renamed or removed; aliases are only
introduced through an explicit compatibility table in a future minor release.
The manifest is covered by an automated `tools/list` test.

## `memory_store`

Persist a memory so it survives context-window resets.

| Argument | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `type` | one of 11 types | ✅ | — | What kind of memory: `fact · preference · decision · constraint · instruction · role · entity · relationship · event · history · observation` |
| `content` | string | ✅ | — | The memory, written as a standalone statement |
| `scope` | string | no | `global` | `global`, or a project path/id |
| `tags` | string[] | no | `[]` | Keywords that boost retrieval |
| `importance` | 1–5 | no | `3` | Ranking weight |
| `source` | string | no | — | Originating session/client |
| `confidence` | 0–1 | no | auto | Confidence in this claim (not the `trust` gate) — defaults to `1.0` for deliberate stores, `0.7` for digest extractions (the LLM may supply its own) |
| `provenance` | object | no | `{ sourceType: manual }` | Where it came from: `sourceType` = `manual \| conversation \| agent \| import \| system`, plus optional `sessionId`/`messageId`/`agentId`/`provider` (plan §4.3) |
| `trust` | level | no | derived from `provenance` | Override `unverified \| trusted \| verified \| system` — usually leave alone; digest extraction always lands `unverified` (plan §4.5) |
| `retention` | mode | no | `decaying` | Decay protection: `pinned \| persistent \| ephemeral \| neverExpire` (plan §4.8) |

**When to use which type:**
- Something the model should *know* → `fact`
- How the user *likes things* → `preference`
- Something already *decided* → `decision`
- A hard *limit / must-not* → `constraint`
- A standing *directive* ("always X") → `instruction`
- A standing *persona / rule set* → `role`
- A named *person, service, repo* → `entity`
- How two entities *relate* → `relationship`
- A dated *thing that happened* → `event`
- A *chronology* of past work → `history`
- Raw signal *not yet validated* → `observation`

Returns the assigned memory id.

## `memory_batch`

Run a bounded store, update, delete, or selected-export batch through one
operation-dispatched call. The service validates the complete request before
writing; operational failures are returned per item and the batch is not a
cross-item transaction.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `operation` | `store \| update \| delete \| export` | ✅ | Batch operation |
| `items` | object[] | store/update | Store inputs or `{id, ...patch}` update items |
| `ids` | string[] | delete/export | Unique memory ids to delete or export |

Limits are 100 items and 10 MiB of compact JSON. Store duplicates are not
coalesced. Missing or inaccessible ids are reported as `NOT_FOUND` inside the
result envelope; top-level malformed requests return `[INVALID_INPUT]`.

## `memory_update`

Patch an existing memory in place — the write path behind the web dashboard's
edit form (`PUT /memories/:id`). Pass only the fields you want to change;
everything else is preserved.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | ✅ | Memory id |
| `type` | memory type | no | Change the type |
| `content` | string | no | New content — snapshots the previous version to history first |
| `scope` | string | no | New scope — **moves the file** between trees (same id) |
| `tags` | string[] | no | Replace tags |
| `importance` | 1–5 | no | New ranking weight |
| `source` | string | no | New source label |
| `confidence` | 0–1 | no | New confidence |
| `trust` | level | no | New trust level — `memory_update { trust }` is the approval path for unverified digests (see [memory-model.md](memory-model.md#trust-410-plan-45)) |
| `retention` | mode | no | New decay protection mode |
| `expectedVersion` | int ≥ 1 | no | Optimistic concurrency: pass the `version` you read; mismatch → `CONFLICT` (HTTP 409), nothing written |
| `reason` | string ≤ 500 | no | Why this version supersedes the last — recorded beside the history snapshot (plan §4.6) |

Rules: at least one field is required (empty patch → `INVALID_INPUT`), scopes
with `..` are rejected, unknown ids return `NOT_FOUND`. Content changes
re-embed (or clear the stale vector when embeddings are off); non-content
changes never touch history. A `trust` change stamps `lastValidated`.
See [lifecycle.md](lifecycle.md#contradiction-merging).

## `memory_search`

Retrieve relevant memories. Call at the **start of a session** (to recover prior context)
and whenever earlier work might be referenced.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `query` | string | no | Keywords; omit for a scope/recency-ranked list |
| `scope` | string | no | Current project path/id — pass it whenever you have one |
| `type` | memory type | no | Restrict to one type |
| `limit` | 1–50 | no | Max results (default 10) |
| `explain` | boolean | no | Include per-memory score breakdown (V4.2.0+) |

Returns formatted memories:

```
[7133edba] DECISION (scope: global, importance: 4, 2026-09-23)
Chose file-based storage for v1
```

## `memory_list`

Browse what's stored — useful for auditing or showing the user their memory.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `scope` | string | no | Filter by scope (includes `global`) |
| `type` | memory type | no | Filter by type |

Returns one line per memory, newest first.

## `memory_forget`

Permanently delete a memory.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | ✅ | Memory id (from `memory_store` or `memory_list`) |

Returns an error result if no memory matches the id.

## `memory_archive` / `memory_revive`

Manual lifecycle — the same two operations the dashboard's Archive/Revive
buttons call (`POST /memories/:id/archive` / `…/revive`):

- **`memory_archive`** `{ id }` — sets `archivedAt: now`. Archived memories
  drop out of default `memory_list` / `memory_search` results (opt back in
  with `includeArchived: true`) but nothing is deleted.
- **`memory_revive`** `{ id }` — clears `archivedAt`, back to active.

Automatic decay (`memory_maintain`) still owns time-based archiving/deletion;
these are for when *you* decide something is dormant or should return.
Unknown ids return `NOT_FOUND`.

## `memory_get`

Fetch one memory by id with its full content, its typed `relations`
resolved (`{ id, kind }`), and its **backlinks** (memories that point at it,
each with its kind). Use after `memory_search`
when you need the whole statement, not the snippet.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | ✅ | Memory id |

Returns `[NOT_FOUND] …` with `isError: true` if no memory matches.

## `memory_relate`

Create, remove, or **retype** directed links between memories — the
relationship graph. Tie a decision to the facts it depends on, or a history
entry to the decision it records. Targets must exist; backlinks are derived
at read time, so one write keeps the edge consistent. See
[memory-model.md](memory-model.md#relationships-410-plan-47).

| Argument | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `id` | string | ✅ | — | Source memory id |
| `related` | string[] | ✅ | — | Target memory ids (1–50; must exist on `add`) |
| `action` | `add \| remove` | no | `add` | Create or delete the links |
| `kind` | `supports \| contradicts \| supersedes \| refines \| duplicates \| related` | no | `related` | Edge kind (plan §4.7) — linking an already-linked target with a new kind **retypes the edge in place** |

Idempotent: re-linking what's already linked with the same kind is a no-op
(no `updatedAt` churn). A memory cannot be related to itself
(`INVALID_INPUT`).

## `memory_history`

Version history of one memory with unified line diffs — every
content-changing update (e.g. a contradiction merge) snapshots the previous
version first. Newest version first; each entry diffs against its
predecessor and carries the `reason` + `supersededAt` recorded when it was
superseded (4.1.0, plan §4.6). See
[lifecycle.md](lifecycle.md#contradiction-merging).

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | ✅ | Memory id |
| `limit` | 1–100 | no | Max *past* versions to return |

Snapshots live in `~/.remembra/.history/<id>/`, pruned to
`REMEMBRA_HISTORY_LIMIT` (default 20) per memory; `0` disables history.
Non-content updates (embedding backfills, trust-only writes, linking) never
snapshot.

## `memory_digest`

Extract memories from a conversation transcript using the configured LLM and
store them, skipping exact duplicates. See [providers.md](providers.md).

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `transcript` | string | ✅ | Full transcript or a detailed session summary |
| `scope` | string | no | Scope for extracted memories (default `global`) |
| `source` | string | no | Originating session/client |

Requires `REMEMBRA_LLM` + its API key (or Ollama). Returns counts:
extracted / stored / duplicates skipped, plus stored ids.

## `memory_maintain`

Run maintenance on demand: archive memories unused past
`REMEMBRA_ARCHIVE_AFTER_DAYS` (default 90), auto-delete archived memories past
`REMEMBRA_ARCHIVE_TTL_DAYS` (default 365), and backfill missing embedding
vectors. Roles and instructions never decay; `pinned`/`neverExpire` are
exempt from archiving entirely and `persistent` is never auto-deleted
(plan §4.8). Takes no arguments. See [lifecycle.md](lifecycle.md).

Returns counts + affected ids. Also available as `POST /maintain` and the
`remembra maintain` CLI command.

## CLI commands

```bash
remembra maintain            # decay sweep + vector backfill (one-shot, prints JSON)
remembra export <file>.json  # full backup snapshot incl. archived memories
remembra import <file>.json  # restore; validates whole file first (atomic), idempotent
remembra encrypt             # migrate the whole tree to ciphertext at rest (needs REMEMBRA_ENCRYPT_KEY)
remembra decrypt             # migrate back to plain markdown (also needs the key)
```

Import skips existing ids and exact-duplicate contents, so running it twice —
or importing into a machine that already has the data — is always safe.

---

## Suggested session flow

```
1. memory_search { scope: <current project> }   → recover roles, facts, decisions
2. ... work happens; model calls memory_store when something worth keeping emerges ...
3. memory_digest { transcript, scope }           → end-of-session sweep (v2, LLM extracts)
   (decay + backfill run opportunistically on search; memory_maintain when explicit)
```
