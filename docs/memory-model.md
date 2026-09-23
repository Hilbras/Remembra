# The Memory Model

Remembra stores four kinds of memories. Every memory you save carries one of these types,
and the type controls how it's used at retrieval time.

## Types

### `fact`
Stable knowledge about the world, a project, or the user.

```
type: fact
content: The API rate limit is 100 requests/minute.
content: User prefers concise answers without filler.
```

### `decision`
Choices that have already been made — so they don't get re-litigated every session.

```
type: decision
content: Chose PostgreSQL over MongoDB for the events table (decided 2026-09-20).
```

### `role`
Standing instructions and roles. **Roles always surface in search results** — they are
treated as instructions, not suggestions.

```
type: role
content: You are the architect. Never modify test files without asking.
```

### `history`
Condensed chronology of what already happened — a lean summary instead of a raw transcript.

```
type: history
content: Phase 1: built the auth API, hit a token refresh bug, resolved by rotating keys.
```

## Scopes

Every memory belongs to exactly one scope:

| Scope | Meaning | Injected when |
|-------|---------|---------------|
| `global` | Relevant everywhere (preferences, roles, general facts) | Any session |
| `<project path or id>` | Belongs to one project/workspace | Only sessions in that scope |

Scope isolation is strict: memories scoped to `/repo/a` are **never** returned to a session
in `/repo/b`. Global memories are always visible.

```json
{ "type": "decision", "content": "...", "scope": "/home/gin/work/Hilbras/Memory" }
```

## Metadata

| Field | Type | Notes |
|-------|------|-------|
| `type` | `fact \| decision \| role \| history` | required |
| `content` | string | required — written as a standalone statement |
| `scope` | string | defaults to `global` |
| `tags` | string[] | boosts keyword matching |
| `importance` | 1–5 | defaults to 3; higher ranks higher |
| `source` | string | originating session/client (optional) |
| `id` | 8-char id | assigned automatically |
| `createdAt` / `updatedAt` | ISO timestamps | assigned automatically |

## Retrieval ranking

When `memory_search` runs, memories are scored in layers:

1. **Roles always pass** (+1000) — instructions never get filtered out.
2. **Scope gate** — other projects' memories are excluded entirely;
   the current scope scores highest (+150), `global` always passes (+100).
3. **Importance** — up to +50 for importance 5.
4. **Recency** — decays over roughly a 30-day half-life (up to +20).
5. **Keyword overlap** — up to +60 based on the fraction of query terms matched
   in content and tags.

Embeddings are planned for v2 and will slot in behind the same `memory_search`
interface without changing any client.

## Storage format

Memories are plain markdown files with frontmatter — greppable, editable by hand,
git-friendly:

```markdown
---
id: 7133edba
type: decision
scope: global
tags: [architecture]
importance: 4
created: 2026-09-23T02:51:41.999Z
updated: 2026-09-23T02:51:41.999Z
---

Chose file-based storage for v1
```

Layout:

```
$REMEMBRA_HOME/            # defaults to ~/.remembra
├── global/
│   └── <id>.md
└── scopes/
    └── <scope>/
        └── <id>.md
```
