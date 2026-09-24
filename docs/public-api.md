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
Current legacy schema version: `SCHEMA_VERSION = 3`; V5 tenant records use
`TENANT_SCHEMA_VERSION = 4` (see [storage.md](storage.md)). Files above
`MAX_SCHEMA_VERSION` are refused on read, never served partially; older
readers skip V5 tenant files (logged, never deleted) instead of serving them
half-understood.

## MCP tools (V4.9: 13; V5 adds `memory_context`)

One stdio server, identical behavior in every MCP client. Full argument
tables: [tools.md](tools.md).

| Tool | Purpose |
|------|---------|
| `memory_store` | persist a memory (11 semantic types) |
| `memory_update` | patch fields incl. `trust`/`retention`; `expectedVersion` → `CONFLICT`; scope change = file move; content change = history snapshot with `reason` |
| `memory_archive` / `memory_revive` | manual lifecycle |
| `memory_search` | layered retrieval (standing-instruction + scope gates → provenance → trust → pinned → importance → recency → match) |
| `memory_context` | V5 token-bounded context assembled from authorized ranked results |
| `memory_list` | browse with filters |
| `memory_get` | one memory + typed relations + backlinks |
| `memory_relate` | add / remove / retype typed edges |
| `memory_history` | version history with line diffs |
| `memory_digest` | LLM extraction from a transcript |
| `memory_maintain` | decay sweep + vector backfill |
| `memory_batch` | bounded store/update/delete/selected-export batch |
| `memory_forget` | delete by id |

**Error envelope:** service failures generally come back as a text result
`[CODE] message` with `isError: true`. `memory_forget` preserves its legacy
missing-id response (`isError: true` with the service message rather than a
`[NOT_FOUND]` prefix); protocol/schema validation is handled by the MCP SDK.
The V4.9 contract does not rename existing tools or change those legacy error
shapes.

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

Strict V5 tenant mode additionally accepts
`resolveTenantContext(req)`, also after authentication. It must return an
opaque host-minted tenant context; no public tenant header, query parameter,
or JSON field is trusted. A strict service without a successful resolver
returns `TENANT_REQUIRED` for data routes while `/health` remains a
content-free liveness check.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/` · `/ui/*` | dashboard shell + assets (static, no auth) |
| GET | `/health` | liveness/readiness (no auth) |
| GET | `/api/v1/capabilities` | authenticated bounded API capability discovery |
| GET | `/metrics` | Prometheus text (auth when keyed) |
| GET | `/audit` | bounded audit-event listing |
| GET | `/quality` | memory quality/health summary |
| GET | `/agents/:id` | agent attribution and memory counts (no memory content) |
| POST | `/memories` | store |
| POST | `/memories/batch` | bounded store/update/delete/selected-export batch |
| PUT | `/memories/:id` | patch |
| GET | `/memories/search` | search (`query`/`q`, `scope`, `type`, `limit`, `explain`) |
| GET | `/memories` | list (`scope`, `type`, `includeArchived`, pagination) |
| POST | `/memories/compress` | bounded compression of selected/scope memories |
| GET | `/memories/:id` | one memory + related + backlinks |
| POST | `/memories/:id/relate` | link / unlink |
| GET | `/memories/:id/history` | versions + unified diffs |
| POST | `/memories/:id/archive` · `/revive` | manual lifecycle |
| POST | `/memories/digest` | LLM extraction (cancels if the client disconnects) |
| POST | `/api/v1/context` | V5 deterministic token-bounded context assembly |
| POST | `/maintain` | decay sweep + backfill |
| GET | `/snapshot` | full export |
| POST | `/import` | preflighted, idempotent import; SQLite uses a transaction and file batches roll back operational failures |
| DELETE | `/memories/:id` | forget |

### Versioned API

V4.9 introduces the additive `/api/v1` namespace. Every legacy HTTP route
listed above is also available with the `/api/v1` prefix; this includes the
administrative, snapshot, import, quality, and compression routes. Requests
such as `POST /api/v1/memories`, `GET /api/v1/memories/search`, and
`POST /api/v1/memories/batch` use the same authentication, trusted agent
resolver, limits, and route-specific response shapes as their unversioned
equivalents. Every `/api/v1` response, including transport errors, includes:

```http
X-Remembra-API-Version: v1
X-Remembra-Request-Id: <bounded correlation id>
```

Clients may provide a safe request ID using `X-Remembra-Request-Id`; invalid
values are replaced with a server-generated bounded ID. The header is
correlation metadata only and is never used as an authorization or metric
label.

`/api/v1/health` is intentionally public, matching `/health`; all other v1
routes retain the legacy auth requirements. `/api/v1/capabilities` is an
authenticated, content-free discovery response containing the bounded v1
capability manifest. The established `/api/v1` prefix is the compatibility
authority; the roadmap's illustrative `/v1/...` spelling is not a second alias.
Future breaking changes require a separately documented major namespace.

The UI is not served below the v1
prefix. When CORS is enabled, the version, request-ID, and `Retry-After`
headers are exposed to browser clients.

The v1 stabilization release deliberately preserves legacy response bodies
rather than introducing a breaking wrapper. Typed service errors normally use
`{ "error": "...", "code": "..." }`; authentication, rate-limit, overload,
unknown-route, and timeout responses may contain only `error`. A missing
`DELETE /memories/:id` remains the legacy `{ "ok": false, "text": "..." }`
result. The SDK exposes the raw body and uses `HTTP_<status>` only when a
server response has no `code`.

Legacy routes remain supported for compatibility. The v1 namespace does not
**authenticate** a client-supplied agent identity; trusted host resolution
remains the only source of agent context. Existing non-agent attribution
metadata may still be stored as untrusted provenance, and the SDK rejects
server-managed `owner`/`access` and agent-attribution fields before
transmission. Provenance IDs used for ordinary audit correlation remain
non-authenticating metadata.

V5.0.2 routes use the same centralized operation policy: project/user/agent
selectors cannot widen visibility, export requires `tenant:export`, and
ordinary restore cannot assign tenantless records. See
[`v5.0.2-authorization.md`](v5.0.2-authorization.md).

### V5 context assembly

`POST /api/v1/context` reuses the authenticated search and trusted
visibility path, then selects ranked memories in order until the requested
`maxTokens` budget is full. The response contains `memories`, a deterministic
`context` string, `tokenCount`, and bounded `retrievalMetadata`. The default
budget is 4,000 tokens; the hard maximum is 100,000 and the candidate cap is
100. Oversized memories are skipped and counted in `omittedCount` rather than
being silently truncated. Internal embedding vectors are omitted from returned
memory objects. See [v5-context-spec.md](v5-context-spec.md).

### Tenant migration and recovery host API

Trusted host/operator code can import `@hilbras/remembra/tenant-directory-file`
for the durable local directory adapter and
`@hilbras/remembra/tenant-migration` to build and apply a signed, checksummed
migration plan. `@hilbras/remembra/migration-state` provides an atomic, bounded
checkpoint file. `@hilbras/remembra/tenant-entities` provides the trusted,
organization-derived CRUD/pagination service; mutations require an
organization-admin context and emit an audit callback. Organization
provisioning is a separate host-authorized operation and is default-deny
unless `authorizeBootstrap` is supplied. When injected into
`createHttpServer`, the versioned routes are `GET /api/v1/tenant/organization`,
`GET/POST/PUT/DELETE /api/v1/tenant/entities/{kind}[/{id}]`,
`GET /api/v1/tenant/memberships/{projectId}`, and
`POST/DELETE /api/v1/tenant/memberships/{projectId}/{userId}`. Entity resource
IDs are path selectors; callers still cannot submit an authoritative tenant
identity. The SDK exposes matching `tenant*` methods.
`runDurableTenantMigration` verifies the manifest and destination capability
before writes, resumes only after checking prior records, and records failures.
`publishTenantMigration` is an explicit operator-confirmed marker; callers are
responsible for any backend-specific atomic swap and rollback. The state file
contains no snapshot key and is not a substitute for the signed manifest.
The V5.0.1 CLI exposes read-only `migrate analyze`, signed `migrate plan`, and
explicit `migrate apply --dry-run`/apply commands. Ordinary snapshot import
never assigns a tenantless record; tenantless data requires the signed,
target-bound plan workflow described in [v5.0.1-security-and-migration.md](v5.0.1-security-and-migration.md).
`MemoryService.previewSnapshot` and `remembra import <file> --dry-run` perform
the complete snapshot/tenant/reference preflight without writing. Trusted local
recovery code can import `@hilbras/remembra/sqlite-recovery` for verified
standalone SQLite backups, same-directory atomic restore, and explicit
rollback of a retained pre-restore database; the live service must be closed
and active SQLite sidecars are rejected.

### Durable recovery state

V5.0.3 persists the last recovery transition in
`<REMEMBRA_HOME>/.recovery-state.json`. The file contains only a bounded state,
event, and timestamp; it is replaced atomically and is never a source of memory
content. `Healthy`, `Degraded`, `Recovering`, `Failed`, and `ReadOnly` are the
only states. Ordinary health probes cannot clear `Failed` or `ReadOnly`.
`ReadOnly` blocks service and direct legacy CLI mutations. Use
`remembra recover read-only` to enter it and `remembra recover verify` after
repairing and verifying the backend. A malformed or unsafe state file prevents
startup rather than silently resetting the state.

### Batches

`POST /memories/batch` accepts one discriminated `operation`:

```json
{"operation":"store","items":[{"type":"fact","content":"Redis is the queue backend"}]}
{"operation":"update","items":[{"id":"...","content":"Updated","expectedVersion":2}]}
{"operation":"delete","ids":["..."]}
{"operation":"export","ids":["..."]}
```

Structural validation (shape, count, duplicate IDs, and the 10 MiB compact JSON
limit) completes before any write. Valid mutations then run sequentially;
operational failures are returned per item and successful/failed rows retain
input order. The first batch slice is **not** a cross-item transaction. Export
returns a normal import-compatible snapshot plus per-item selection outcomes;
relations to unselected memories are omitted. In strict mode the export branch
requires the explicit `tenant:export` capability and signs its result when a
snapshot key is configured.

Batch limits are 100 items and 10 MiB. HTTP mixed results use status `200`;
top-level malformed requests use the normal `INVALID_INPUT` envelope.

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
| `ENCRYPTED_NO_KEY` | 503 | file-backend memory/history is encrypted and the key is missing/wrong; SQLite/snapshot encryption is not implied |
| `QUEUE_FULL` | 429 | bounded background job queue is full |
| `QUEUE_CLOSED` | 503 | background job queue is shutting down |
| `INTERNAL` | 500 | anything unclassified |

Transport-only responses (for example authentication `401`, request-size
`413`, unknown-route `404`, concurrency `503`, and handler timeout `504`) may
contain only `error` for legacy compatibility; the metrics label is the
operational classification. The SDK retains the raw body and uses
`HTTP_<status>` when no service code is present.

Metrics count these under `remembra_errors_total{code}` and requests under
`remembra_http_requests_total{route,…}`. Legacy labels use the fixed enum
(`health|metrics|memories|search|digest|batch|maintain|compress|audit|quality|agents|memory_item|memory_sub|data_io|ui|other`).
Versioned requests use the bounded `api_v1_` prefix on the corresponding label
(for example, `api_v1_search` and `api_v1_memories`); raw paths and memory IDs
are never used.

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
- Import validates the **whole file before the first write** and preserves ids.
  SQLite imports run in one transaction; file-backend batch imports publish a
  durable rollback journal and remove it only after success. An interrupted
  file import is rolled back on the next startup, so re-running remains
  idempotent.
- Strict tenant services add an `integrity` object with an HMAC-SHA256 value
  over the canonical envelope. This authenticates plaintext content; it does
  not encrypt it or provide anti-replay freshness. Unsigned, tampered, or
  wrongly keyed snapshots return `SNAPSHOT_INVALID` before any record is
  written. Legacy mode continues to accept unsigned V4 snapshots during
  migration.
- Strict HTTP data requests reject tenant-bearing headers, query parameters,
  and body fields with `400`; signed snapshot records are the only permitted
  exception and are still bound to the authenticated tenant context.
- Keyed CLI export/import uses signed snapshot files (temporary file, fsync,
  rename); readers reject symlinks, oversized files, and tampering before
  invoking the service. Snapshot JSON and SQLite backups remain plaintext
  artifacts unless the surrounding storage/transport protects them.

## CLI

| Command | Behavior |
|---------|----------|
| `remembra` | MCP server on stdio (default) |
| `remembra --http [--port N]` | HTTP API + dashboard |
| `remembra export <file>` | write a snapshot; a filename is required |
| `remembra import <file>` | preflighted, idempotent import; SQLite transaction or file-batch rollback |
| `remembra maintain` | one-shot decay sweep + backfill, prints JSON |
| `remembra recover read-only` | durably enter read-only recovery; reads remain available, mutations fail closed |
| `remembra recover verify` | verify the backend, then durably return to `Healthy` |
| `remembra encrypt` / `remembra decrypt` | legacy/non-tenant file-root conversion (needs `REMEMBRA_ENCRYPT_KEY`; strict mode refuses it) |
| `remembra migrate` | manually trigger file → SQLite migration (V4.3.0; strict mode uses signed tenant migration) |
| `remembra export-markdown <dir>` | legacy file-backend Markdown export; strict mode refuses it |
| `remembra import-markdown <dir>` | legacy Markdown import; strict mode refuses it |
| `remembra backup <file>` | plaintext SQLite copy + SHA-256 sidecar (not application encryption) |
| `remembra restore <file>` | verify checksum and atomically replace DB (V4.3.0; strict mode uses recovery workflow) |

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
