# Tool Reference

Remembra exposes four MCP tools. All of them work the same way across every
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

---

## Suggested session flow

```
1. memory_search { scope: <current project> }   → recover roles, facts, decisions
2. ... work happens; model calls memory_store when something worth keeping emerges ...
3. memory_digest { transcript, scope }           → end-of-session sweep (v2, LLM extracts)
   (decay + backfill run opportunistically on search; memory_maintain when explicit)
```
