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
Standing instructions and roles. **Roles always surface in search results —
within their scope** (a `global` or current-project role can never be
 outranked or filtered out) — they are treated as instructions, not
suggestions. Roles stored under a *different* project's scope stay gated with
everything else: isolation beats instructions (enforced since 3.6.0).

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
| `importance` | 1–5 | defaults to 3; higher ranks higher (same weight in both modes) |
| `source` | string | originating session/client (optional) |
| `provenance` | `explicit \| auto` | set automatically: `explicit` = stored deliberately, `auto` = digest-extracted; pre-3.4.0 files are neutral |
| `id` | 12-char id | assigned automatically (collision-safe) |
| `createdAt` / `updatedAt` | ISO timestamps | assigned automatically |

## Retrieval ranking

When `memory_search` runs, memories are scored in layers:

1. **Roles always pass** (+1000) — instructions never get filtered out *of
   their scope*: a `global` or current-scope role always surfaces first, but
   roles stored under another project's scope stay gated with everything
   else (isolation beats instructions).
2. **Scope gate** — other projects' memories are excluded entirely;
   the current scope scores highest (+150), `global` always passes (+100).
3. **Provenance** — deliberately stored memories +10 over auto-extracted ones.
4. **Importance** — up to +20 for importance 5 — *identical weight in keyword
   and semantic mode, so enabling embeddings never reorders by importance*.
5. **Recency** — exponential decay, ~30-day half-life (up to +20). Never a
   hard cutoff: a 90-day-old memory still earns ~2.5 points.
6. **Keyword overlap** — up to +60 based on the fraction of query terms matched
   in content and tags (keyword mode). With embeddings on, cosine similarity
   (up to +100) takes over as the primary signal while importance, provenance
   and recency keep the same weights.

## Duplicate handling

Digest extraction dedupes in three tiers:

1. **Exact** — normalized `type + scope + content` match → skip (or revive if
   archived).
2. **Fuzzy fast path** — textually near-identical (punctuation/case/typos,
   Sørensen–Dice ≥ 0.9 over bigrams) *and* unchanged quantities → skip
   without an LLM call. A changed number (100→500 rpm, v2→v3) is a different
   fact and always falls through.
3. **LLM merge** — similar-but-evolved memories go to the model, which stores,
   skips, or merges them (the old text is preserved under a `> superseded`
   note).

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
