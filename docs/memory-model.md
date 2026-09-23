# The Memory Model

Remembra stores eleven kinds of memories. Every memory you save carries one of
these types, and the type controls how it's used at retrieval time.

## Types

### `fact`
Stable knowledge about the world, a project, or the user.

```
type: fact
content: The API rate limit is 100 requests/minute.
```

### `preference`
How the user likes things — tone, tooling, formats, defaults.

```
type: preference
content: User prefers concise answers without filler.
```

### `decision`
Choices that have already been made — so they don't get re-litigated every session.

```
type: decision
content: Chose PostgreSQL over MongoDB for the events table (decided 2026-09-20).
```

### `constraint`
Hard limits that must never be crossed — the laws of the project.

```
type: constraint
content: Never store secrets in the repo — use the vault.
```

### `instruction`
Standing directives for the assistant — imperatives that apply across
sessions. Instructions (with roles) are **standing guidance**: they surface
first within their scope, never decay, and since 4.1.0 they only earn that
boost when `trust` is at least `trusted` — see [Trust](#trust-410-plan-45).

```
type: instruction
content: Always run the test suite before opening a PR.
```

### `role`
Standing instructions and roles. **Roles always surface in search results —
within their scope** (a `global` or current-project role can never be
 outranked or filtered out) — they are treated as instructions, not
suggestions. Roles stored under a *different* project's scope stay gated with
everything else: isolation beats instructions (enforced since 3.6.0). Since
4.1.0 the same trust gate as instructions applies: an unverified role never
earns the standing boost — see [Trust](#trust-410-plan-45).

```
type: role
content: You are the architect. Never modify test files without asking.
```

### `entity`
A named thing that matters to the work — a person, service, repo, team.

```
type: entity
content: billing-service is owned by the payments team.
```

### `relationship`
How two entities relate — the connective tissue between `entity` memories.

```
type: relationship
content: billing-service depends on ledger-db for idempotency keys.
```

### `event`
Dated things that happened — releases, incidents, meetings.

```
type: event
content: 2026-09-20: migrated the events table to PostgreSQL.
```

### `history`
Condensed chronology of what already happened — a lean summary instead of a raw transcript.

```
type: history
content: Phase 1: built the auth API, hit a token refresh bug, resolved by rotating keys.
```

### `observation`
Something noted but not yet validated — raw signal before it graduates
into a `fact`.

```
type: observation
content: p95 latency jumped after the 09-22 deploy; not yet diagnosed.
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
| `type` | 11 semantic types | required — see [Types](#types) |
| `content` | string | required — written as a standalone statement |
| `scope` | string | defaults to `global` |
| `tags` | string[] | boosts keyword matching |
| `importance` | 1–5 | defaults to 3; higher ranks higher (same weight in both modes) |
| `source` | string | originating session/client (optional) |
| `provenance` | object | required since 4.1.0 — see [Provenance](#provenance-410-plan-43) |
| `confidence` | 0–1 | required since 4.1.0: deliberate stores default `1.0`, conversation extraction `0.7` (the extraction LLM may supply its own). **Displayed, not ranked** — importance answers "relevant?", confidence answers "true?"; preserved through merge/import/export |
| `trust` | 4 levels | required since 4.1.0 — see [Trust](#trust-410-plan-45) |
| `retention` | 5 modes | optional decay protection — see [Retention](#retention-410-plan-48) |
| `relations` | `{id, kind}[]` | typed links since 4.1.0 — see [Relationships](#relationships-410-plan-47) |
| `version` | int | the write counter (frontmatter `revision`) used for optimistic concurrency — see [Version history](#version-history-380) |
| `lastValidated` | ISO timestamp | stamped whenever `trust` changes (4.1.0, plan §4.2) |
| `id` | UUIDv7 | assigned automatically (legacy 8–32 hex ids remain valid) |
| `createdAt` / `updatedAt` | ISO timestamps | assigned automatically |

## Provenance (4.1.0, plan §4.3)

Every memory records where it came from — an object in frontmatter,
required since 4.1.0:

```yaml
provenance:
  sourceType: manual
  sessionId: sess-8f1c
```

| `sourceType` | Who wrote it | Default `trust` |
|--------------|--------------|-----------------|
| `manual` | a person (dashboard, MCP `memory_store`, API `POST`) | `trusted` |
| `conversation` | digest extraction from a transcript | `unverified` |
| `agent` | an assistant writing directly through the API | `trusted` |
| `import` | snapshot / CLI import | `trusted` |
| `system` | Remembra itself | `system` |

Optional context fields: `sessionId` / `messageId` (which conversation it came
from), `agentId`, and `provider` — **which LLM produced it**, stamped on
digest extractions. Pre-4.1.0 files (`provenance: explicit | auto`) migrate
on read: `explicit` → `manual`, `auto` → `conversation`.

## Trust (4.1.0, plan §4.5)

Trust is a standing confidence classification — additive in ranking, and a
hard gate for standing guidance:

| Level | Rank points | Set by |
|-------|-------------|--------|
| `system` | +8 | Remembra itself |
| `verified` | +6 | a human approved it (dashboard **Approve** → `verified`) |
| `trusted` | +2 | deliberate store (manual / agent / import) |
| `unverified` | −8 | conversation extraction, not yet reviewed |

**The gate (plan §4.9):** `role` and `instruction` memories only earn the
+1000 standing boost when their trust is at least `trusted`. Digest
extraction therefore lands roles/instructions as `unverified`: they are still
listed, searchable and badged — but they never surface first, and never steer
anything, until someone approves them:

- dashboard: open the memory → **Approve** (sets `verified`, stamps
  `lastValidated`), or
- API/MCP: `memory_update { "id": …, "trust": "trusted" }`.

Trust is never promoted automatically from extracted user text. A change of
trust stamps `lastValidated`; content edits don't.

## Retention (4.1.0, plan §4.8)

Per-memory decay protection — `retention` in frontmatter / store input:

| Mode | Behavior |
|------|----------|
| *(absent = `decaying`)* | the normal clocks: archive after `ARCHIVE_AFTER_DAYS` unseen, delete `ARCHIVE_TTL_DAYS` after archiving |
| `pinned` | fully exempt from decay — never archived or deleted, and gets +50 rank points |
| `persistent` | archivable, but **never auto-deleted** — history worth keeping |
| `neverExpire` | never archived, never deleted |
| `ephemeral` | declared short-lived — accepted and stored now; behaves like `decaying` until the accelerated clock ships |

Critical memories must not disappear merely because they were not recently
retrieved. `role`/`instruction` memories are exempt from decay regardless of
their retention mode.

## Relationships (4.1.0, plan §4.7)

Memories link to each other with **typed** directed edges, managed with
`memory_relate` / `POST /memories/:id/relate`:

| `kind` | Meaning |
|--------|---------|
| `supports` | evidence for the source |
| `contradicts` | conflicts with the source |
| `supersedes` | replaces the source (newer wins) |
| `refines` | narrows or extends the source |
| `duplicates` | the same thing, restated |
| `related` | generic link (the default; pre-4.1.0 links migrate to this) |

Frontmatter:

```yaml
relations:
  - id: 01a0cdfe-930f-7b25-962f-b2f64bf48a90
    kind: supports
```

- Edges are **stored on the source only**; backlinks (with their kind) are
  derived at read time (`memory_get` / `GET /memories/:id` return both
  directions), so a link is a single write with no consistency dance.
- Targets are validated on `add` (they must exist); self-links are rejected.
- Re-linking an existing target with a new kind **retypes the edge in place**
  (never duplicates it); adding the same edge again is an idempotent no-op.
- Links do not affect ranking — retrieval is unchanged; they are structure for
  the consumer to follow (decision → facts it rests on, history → decision it
  records).

## Version history (3.8.0)

Any content-changing update (`memory_update`, `PUT`, contradiction merge)
first snapshots the on-disk pre-image into
`~/.remembra/.history/<id>/<epoch>-<seq>.md` — a byte-for-byte copy of the
file as it was. `memory_history` / `GET /memories/:id/history` return the
versions newest-first, each with a unified line diff against its predecessor
and, when supplied, the **`reason`** the update gave plus a `supersededAt`
timestamp (4.1.0, plan §4.6 — kept beside the snapshots in `reasons.json`,
never inlined into the current text). Every successful write also bumps the
memory's `version` counter; pass `expectedVersion` to `memory_update` for
optimistic concurrency (mismatch → `CONFLICT` / HTTP 409). Snapshots prune to
`REMEMBRA_HISTORY_LIMIT` (default 20, `0` disables); embedding backfills,
trust-only writes and linking never snapshot (content unchanged). History
files are invisible to `all()`/search — `.history` is never walked as data.

## Retrieval ranking

When `memory_search` runs, memories are scored in layers:

1. **Standing-boost gate** (+1000) — an in-scope `role`/`instruction` with
   `trust ≥ trusted` always surfaces first; unverified ones (digest-extracted,
   not yet approved) get no boost but stay searchable — and roles under
   another project's scope stay gated with everything else (isolation beats
   instructions).
2. **Scope gate** — other projects' memories are excluded entirely;
   the current scope scores highest (+150), `global` always passes (+100).
3. **Provenance** — deliberately stored memories +10 over auto-extracted ones.
4. **Trust** — additive layer: system +8, verified +6, trusted +2,
   unverified −8 (plan §4.5).
5. **Pinned** — `pinned` retention +50, so pins surface near the top
   regardless of age (plan §4.8).
6. **Importance** — ×4 (up to +20 for importance 5) — *identical weight in
   keyword and semantic mode, so enabling embeddings never reorders by
   importance*.
7. **Recency** — exponential decay, ~30-day half-life (up to +20; half weight
   in semantic mode). Never a hard cutoff: a 90-day-old memory still earns
   a few points.
8. **Match signal** — keyword overlap up to +60 (keyword mode), or cosine
   similarity up to +100 as the primary signal (semantic mode), while
   importance, provenance, trust and recency keep the same weights.

## Duplicate handling

Digest extraction dedupes in three tiers:

1. **Exact** — normalized `type + scope + content` match → skip (or revive if
   archived).
2. **Fuzzy fast path** — textually near-identical (punctuation/case/typos,
   Sørensen–Dice ≥ 0.9 over bigrams) *and* unchanged quantities → skip
   without an LLM call. A changed number (100→500 rpm, v2→v3) is a different
   fact and always falls through.
3. **LLM merge** — similar-but-evolved memories go to the model, which stores,
   skips, or merges them. The superseded text is **not inlined into the new
   content** (since 4.1.0, plan §4.6): the pre-image lives in version history
   with the merge reason recorded beside it.

## Storage format

Memories are plain markdown files with frontmatter — greppable, editable by hand,
git-friendly:

```markdown
---
id: 01a0cdfe-930f-7b25-962f-b2f64bf48a90
version: 3
revision: 1
type: fact
scope: global
importance: 4
confidence: 1
trust: trusted
created: 2026-09-23T11:20:08.207Z
updated: 2026-09-23T11:20:08.207Z
provenance:
  sourceType: manual
---

The API rate limit is 100 requests/minute.
```

`version` is the **schema** guard (currently `3`); `revision` is the memory's
own write counter — exposed as `version` in JSON. The full field reference,
validation rules and downgrade contract live in
[storage.md](storage.md).

Layout:

```
$REMEMBRA_HOME/            # defaults to ~/.remembra
├── global/
│   └── <id>.md
├── scopes/
│   └── <scope>/
│       └── <id>.md
├── archived/               # same shape, out of search (lifecycle.md)
└── .history/<id>/          # superseded pre-images + reasons.json (version history)
```

> Opt-in: with `REMEMBRA_ENCRYPT_KEY` set, every file above is written as
> AES-256-GCM ciphertext instead (same names, detected by magic bytes) —
> see [security.md](security.md#encryption-at-rest-opt-in-380). With
> `REMEMBRA_REDACT=1`, PII patterns are replaced with typed placeholders
> (`<EMAIL>`, `<CARD>`, …) *before* this file is ever written — see
> [security.md](security.md#pii-redaction-opt-in-380).
