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
| `confidence` | 0–1 | trust in this claim (3.8.0): explicit stores default `1.0`, digests `0.7` (the extraction LLM may supply its own). **Displayed, not ranked** — importance answers "relevant?", confidence answers "true?"; preserved through merge/import/export |
| `related` | string[] | ids of linked memories (3.8.0) — see [Relationships](#relationships-380) |
| `id` | 12-char id | assigned automatically (collision-safe) |
| `createdAt` / `updatedAt` | ISO timestamps | assigned automatically |

## Relationships (3.8.0)

Memories can link to each other — a directed `related: [ids]` list in
frontmatter, managed with `memory_relate`:

```markdown
related: [7133edba, 9f2e01aa]
```

- Edges are **stored on the source only**; backlinks are derived at read time
  (`memory_get` / `GET /memories/:id` return both directions), so a link is a
  single write with no consistency dance.
- Targets are validated on `add` (they must exist); self-links are rejected.
- Links do not affect ranking — retrieval is unchanged; they are structure for
  the consumer to follow (decision → facts it rests on, history → decision it
  records).

## Version history (3.8.0)

Any content-changing update (today: contradiction merges) first snapshots the
on-disk pre-image into `~/.remembra/.history/<id>/<epoch>-<seq>.md` — a
byte-for-byte copy of the file as it was. `memory_history` /
`GET /memories/:id/history` return the versions newest-first, each with a
unified line diff against its predecessor. Snapshots prune to
`REMEMBRA_HISTORY_LIMIT` (default 20, `0` disables); embedding backfills and
linking never snapshot (content unchanged). History files are invisible to
`all()`/search — `.history` is never walked as data.

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
├── scopes/
│   └── <scope>/
│       └── <id>.md
├── archived/               # same shape, out of search (lifecycle.md)
└── .history/<id>/          # superseded pre-images (version history, 3.8.0)
```

> Opt-in: with `REMEMBRA_ENCRYPT_KEY` set, every file above is written as
> AES-256-GCM ciphertext instead (same names, detected by magic bytes) —
> see [security.md](security.md#encryption-at-rest-opt-in-380). With
> `REMEMBRA_REDACT=1`, PII patterns are replaced with typed placeholders
> (`<EMAIL>`, `<CARD>`, …) *before* this file is ever written — see
> [security.md](security.md#pii-redaction-opt-in-380).
