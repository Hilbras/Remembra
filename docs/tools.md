# Tool Reference

Remembra exposes nine MCP tools. All of them work the same way across every
MCP-compatible client.

## `memory_store`

Persist a memory so it survives context-window resets.

| Argument | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `type` | `fact \| decision \| role \| history` | ✅ | — | What kind of memory this is |
| `content` | string | ✅ | — | The memory, written as a standalone statement |
| `scope` | string | no | `global` | `global`, or a project path/id |
| `tags` | string[] | no | `[]` | Keywords that boost retrieval |
| `importance` | 1–5 | no | `3` | Ranking weight |
| `source` | string | no | — | Originating session/client |
| `confidence` | 0–1 | no | auto | Trust in this claim — defaults to `1.0` for explicit stores, `0.7` for digest extractions (the LLM may supply its own) |

**When to use which type:**
- Something the model should *know* → `fact`
- Something already *decided* → `decision`
- A standing *instruction* or persona → `role`
- A summary of *what happened* → `history`

Returns the assigned memory id.

## `memory_search`

Retrieve relevant memories. Call at the **start of a session** (to recover prior context)
and whenever earlier work might be referenced.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `query` | string | no | Keywords; omit for a scope/recency-ranked list |
| `scope` | string | no | Current project path/id — pass it whenever you have one |
| `type` | memory type | no | Restrict to one type |
| `limit` | 1–50 | no | Max results (default 10) |

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

## `memory_get`

Fetch one memory by id with its full content, its `related` links resolved,
and its **backlinks** (memories that point at it). Use after `memory_search`
when you need the whole statement, not the snippet.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | ✅ | Memory id |

Returns `[NOT_FOUND] …` with `isError: true` if no memory matches.

## `memory_relate`

Create or remove directed links between memories — the relationship graph.
Tie a decision to the facts it depends on, or a history entry to the decision
it records. Targets must exist; backlinks are derived at read time, so one
write keeps the edge consistent. See [memory-model.md](memory-model.md#relationships-380).

| Argument | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `id` | string | ✅ | — | Source memory id |
| `related` | string[] | ✅ | — | Target memory ids (1–50; must exist on `add`) |
| `action` | `add \| remove` | no | `add` | Create or delete the links |

Idempotent: re-linking what's already linked is a no-op (no `updatedAt` churn).
A memory cannot be related to itself (`INVALID_INPUT`).

## `memory_history`

Version history of one memory with unified line diffs — every
content-changing update (e.g. a contradiction merge) snapshots the previous
version first. Newest version first; each entry diffs against its
predecessor. See [lifecycle.md](lifecycle.md#contradiction-merging).

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | ✅ | Memory id |
| `limit` | 1–100 | no | Max *past* versions to return |

Snapshots live in `~/.remembra/.history/<id>/`, pruned to
`REMEMBRA_HISTORY_LIMIT` (default 20) per memory; `0` disables history.
Non-content updates (embedding backfills, linking) never snapshot.

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
vectors. Roles never decay. Takes no arguments. See [lifecycle.md](lifecycle.md).

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
