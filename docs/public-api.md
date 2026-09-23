# Public API & Stability Contract

Everything Remembra exposes outside its own process — the compatibility
surface the project commits to (Master Plan §3.1 / §12). If it isn't listed
here, it's internal and may change in any release.

## Stability policy (semver)

| Change | Release |
|--------|---------|
| Bug fixes, performance, docs, new **optional** fields/args/env vars | patch (`4.0.x`) |
| New tools/routes/fields/commands, new **opt-in** behavior | minor (`4.x.0`) |
| Removing/renaming a tool, route, field, or env var; changing a type/range/meaning; storage format breaks | major (`x.0.0`) |

Package versions match roadmap milestones for `.0` releases (4.0.0 = v4 …).
Current schema version: `SCHEMA_VERSION = 3` (see [storage.md](storage.md));
files with a **higher** version are refused on read, never served partially —
older readers skip newer files (logged, never deleted) instead of serving
them half-understood.

## MCP tools (12)

One stdio server, identical behavior in every MCP client. Full argument
tables: [tools.md](tools.md).

| Tool | Purpose |
|------|---------|
| `memory_store` | persist a memory (11 semantic types) |
| `memory_update` | patch fields incl. `trust`/`retention`; `expectedVersion` → `CONFLICT`; scope change = file move; content change = history snapshot with `reason` |
| `memory_archive` / `memory_revive` | manual lifecycle |
| `memory_search` | layered retrieval (standing-instruction + scope gates → provenance → trust → pinned → importance → recency → match) |
| `memory_list` | browse with filters |
| `memory_get` | one memory + typed relations + backlinks |
| `memory_relate` | add / remove / retype typed edges |
| `memory_history` | version history with line diffs |
| `memory_digest` | LLM extraction from a transcript |
| `memory_maintain` | decay sweep + vector backfill |
| `memory_forget` | delete by id |

**Error envelope:** failures come back as a text result
`[CODE] message` with `isError: true` — the codes below are the same across
transports.

## HTTP API

Server: `remembra --http` (same binary). Auth: `x-api-key` or
`Authorization: Bearer` when `REMEMBRA_API_KEY` is set; `/health` and the
static dashboard shell (`/`, `/ui/*`) are exempt. Errors are JSON with an
`error` field.

When agent mode is enabled, programmatic HTTP integrations may provide
`resolveAgentContext(req)` to `createHttpServer`. The resolver runs **after**
API-key authentication and is the only supported HTTP identity source;
Remembra does not trust an `agentId` JSON field or public agent header. See
[multi-agent.md](multi-agent.md).

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/` · `/ui/*` | dashboard shell + assets (static, no auth) |
| GET | `/health` | liveness/readiness (no auth) |
| GET | `/metrics` | Prometheus text (auth when keyed) |
| GET | `/agents/:id` | agent attribution and memory counts (no memory content) |
| POST | `/memories` | store |
| PUT | `/memories/:id` | patch |
| GET | `/memories/search` | search (`query`/`q`, `scope`, `type`, `limit`, `explain`) |
| GET | `/memories` | list (`scope`, `type`, `includeArchived`, pagination) |
| GET | `/memories/:id` | one memory + related + backlinks |
| POST | `/memories/:id/relate` | link / unlink |
| GET | `/memories/:id/history` | versions + unified diffs |
| POST | `/memories/:id/archive` · `/revive` | manual lifecycle |
| POST | `/memories/digest` | LLM extraction (cancels if the client disconnects) |
| POST | `/maintain` | decay sweep + backfill |
| GET | `/snapshot` | full export |
| POST | `/import` | idempotent, atomic import |
| DELETE | `/memories/:id` | forget |

### Error codes → HTTP status

| Code | Status | Meaning |
|------|--------|---------|
| `INVALID_INPUT` | 400 | Zod validation failed |
| `SNAPSHOT_INVALID` | 400 | import file failed validation (nothing written) |
| `SCOPE_ESCAPES_ROOT` | 400 | scope resolves outside the storage root |
| `NOT_FOUND` | 404 | unknown id / route |
| `CONFLICT` | 409 | stale `expectedVersion` on update (CAS, plan §3.5) / state conflict |
| `LOCK_TIMEOUT` | 423 | storage lock not acquired in time |
| `IO_ERROR` | 500 | filesystem failure |
| `LLM_ERROR` | 502 | provider failure after bounded retries / malformed provider response / cancelled |
| `PROVIDER_TIMEOUT` | 504 | provider exceeded the timeout or overall budget (4.0.1, plan §3.7) |
| `ENCRYPTED_NO_KEY` | 503 | files encrypted, key missing/wrong |
| `QUEUE_FULL` | 429 | bounded background job queue is full |
| `QUEUE_CLOSED` | 503 | background job queue is shutting down |
| `INTERNAL` | 500 | anything unclassified |

Metrics count these under `remembra_errors_total{code}` and requests under
`remembra_http_requests_total{route,…}` with a fixed route enum
(`health|metrics|memories|search|digest|maintain|audit|memory_item|memory_sub|data_io|ui|other`).

## Snapshot format (export / import)

Envelope written by `remembra export` and `GET /snapshot`:

```json
{
  "format": "remembra-export",
  "version": 3,
  "exportedAt": "2026-09-23T00:00:00.000Z",
  "memories": [ { "id": "01a0cdfe-930f-7b25-962f-b2f64bf48a90", "type": "fact", "content": "…", "scope": "global",
                  "tags": [], "importance": 3, "createdAt": "…", "updatedAt": "…",
                  "confidence": 1, "trust": "trusted", "version": 1,
                  "provenance": { "sourceType": "manual" },
                   "owner": "global", "access": "global",
                  "relations": [ { "id": "…", "kind": "supports" } ] } ]
}
```

- ids must match [storage.md](storage.md)'s id pattern (legacy 8–32 hex or
  UUIDv7); ≤ 100 000 memories per file.
- Pre-4.1.0 snapshots (string `provenance`, untyped `related: […]`, no
  `trust`) import cleanly — those shapes are normalized on read/import.
- Import validates the **whole file before writing** (atomic), preserves ids,
  and is idempotent — re-importing skips existing ids (`{imported, skipped}`).

## CLI

| Command | Behavior |
|---------|----------|
| `remembra` | MCP server on stdio (default) |
| `remembra --http [--port N]` | HTTP API + dashboard |
| `remembra export [file]` | write a snapshot (stdout if omitted) |
| `remembra import [file]` | atomic, idempotent import |
| `remembra maintain` | one-shot decay sweep + backfill, prints JSON |
| `remembra encrypt` / `remembra decrypt` | convert the tree at rest (needs `REMEMBRA_ENCRYPT_KEY`) |
| `remembra migrate` | manually trigger file → SQLite migration (V4.3.0) |
| `remembra export-markdown <dir>` | dump active memories as `.md` files (V4.3.0) |
| `remembra import-markdown <dir>` | import `.md` files into SQLite (V4.3.0) |
| `remembra backup <file>` | copy DB + write SHA-256 sidecar (V4.3.0) |
| `remembra restore <file>` | verify checksum and atomically replace DB (V4.3.0) |

## Provider policy (4.0.1, plan §3.7)

Every outbound LLM/embedding call is bounded — never a hang:

| Variable | Default | Meaning |
|----------|---------|---------|
| `REMEMBRA_PROVIDER_TIMEOUT_MS` | `60000` | per-attempt timeout |
| `REMEMBRA_PROVIDER_RETRIES` | `2` | retries after the first attempt (network/408/429/5xx only) |
| `REMEMBRA_PROVIDER_BUDGET_MS` | `180000` | wall-clock cap across all attempts |
| `REMEMBRA_PROVIDER_BACKOFF_MS` | `250` | retry backoff base (doubles, capped 2s) |

Failures normalize to `LLM_ERROR` (502) or `PROVIDER_TIMEOUT` (504); retries
and final failures are logged as `provider_retry` / `provider_failed`. See
[providers.md](providers.md).

## Environment variables

The canonical index lives in [clients.md](clients.md#environment) (core +
storage) and [providers.md](providers.md#configuration) (LLM/embeddings).
New optional variables are always additive; removing one is a breaking change.

### Audit endpoint (V4.4)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/audit` | required | Paginated audit event stream; query params `?limit=50&since=ISO` |

Response envelope: `{ events: [{ memory_id, action, details, created_at }, ...] }`.
Events include `store`, `update`, `archive`, `revive`, `forget`, `import`.

### Environment variables (V4.4 additions)

| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_RATE_LIMIT` | `60` | max requests per window per key |
| `REMEMBRA_RATE_WINDOW_MS` | `60000` | sliding window size in ms |
| `REMEMBRA_REQUEST_TIMEOUT_MS` | `30000` | per-request timeout |
| `REMEMBRA_MAX_CONCURRENT` | `32` | simultaneous in-flight request cap |
| `REMEMBRA_CORS_ORIGIN` | *(unset)* | allow origin; `*` rejected when key is set |
| `REMEMBRA_SECURE_HEADERS` | `1` | set to `0` to disable secure headers |
| `REMEMBRA_SENSITIVE_POLICY` | `redact` | `allow` · `redact` · `reject` · `quarantine` |
| `REMEMBRA_INJECTION_PATTERNS` | *(unset)* | custom comma-separated regex patterns |
