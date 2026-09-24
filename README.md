# Remembra 🧠

> External memory for AI assistants that remains useful after the context window ends.

[![npm](https://img.shields.io/npm/v/%40hilbras/remembra.svg)](https://www.npmjs.com/package/@hilbras/remembra)
[![Release](https://img.shields.io/github/v/release/Hilbras/Remembra)](https://github.com/Hilbras/Remembra/releases/tag/v5.0.2)
[![Node](https://img.shields.io/badge/node-%3E%3D18.14.1-5fa3e6)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-brightgreen.svg)](https://modelcontextprotocol.io)

Remembra stores facts, decisions, preferences, roles, constraints, relationships, and project history outside a model context window. It then retrieves only the authorized, relevant subset for the current session. The same memory service is available through MCP, HTTP, a TypeScript SDK, and a web dashboard.

**Current release:** [`@hilbras/remembra@5.0.2`](https://www.npmjs.com/package/@hilbras/remembra/v/5.0.2) · [V5.0.2 release notes](https://github.com/Hilbras/Remembra/releases/tag/v5.0.2)

---

## Why Remembra?

Long-running assistants fail in predictable ways: they repeat questions, lose decisions, confuse project context, and treat untrusted transcript text as trusted instructions. Remembra separates memory storage from the conversation and gives the host a small, inspectable control plane.

```text
conversation ──► memory_store / memory_digest ──► durable memory
                                                       │
new session ──► memory_context / memory_search ◄───────┘
                         │
                         └─► bounded, relevant context only
```

V5 adds the production boundaries needed for shared deployments:

- **Deterministic context assembly** with explicit token and candidate budgets.
- **Host-resolved tenant identity**; public callers cannot select an organization.
- **Strict and legacy modes** with fail-closed migration/readiness checks.
- **Bounded hybrid retrieval** across keyword, vector, trust, scope, time, and relations.
- **Verified recovery** with signed snapshots, migration manifests, checkpoints, and rollback.
- **Compatibility first:** V4.9 clients, Markdown, the eleven memory types, and the original thirteen MCP tools remain available.

---

## Choose an integration

| Integration | Best for | Identity/auth model |
|---|---|---|
| **MCP over stdio** | OpenCode, Claude Code, Cline, Kimi Code | Local process; no network API key required |
| **HTTP API** | Web apps, ChatGPT actions, service-to-service calls | `REMEMBRA_API_KEY` plus a trusted host tenant resolver in strict mode |
| **TypeScript SDK** | Node and edge-compatible fetch clients | API key; SDK rejects caller-supplied identity fields |
| **Host TypeScript APIs** | Multi-tenant services and operators | Opaque, host-minted `TenantContext` objects |
| **Web dashboard** | Browsing, editing, auditing, graph, operations | Served by the HTTP process; data calls remain authenticated |

---

## Quick start

### Requirements

- Node.js `18.14.1` or newer.
- No API key is needed for keyword-only local MCP or HTTP-on-loopback use.
- SQLite is used by the CLI when `better-sqlite3` is available; the Markdown backend remains supported for compatibility and library integrations.

### Install

```bash
npm install -g @hilbras/remembra
```

### Run the MCP server

MCP is the default mode. Configure your client to launch the `remembra` binary over stdio:

```bash
remembra
```

For Claude Code:

```bash
claude mcp add remembra -- remembra
```

For OpenCode, add the following to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "remembra": {
      "type": "local",
      "command": ["remembra"]
    }
  }
}
```

See [client setup](docs/clients.md) for Cline, Kimi Code, and other clients.

### Run HTTP mode and the dashboard

```bash
export REMEMBRA_API_KEY="$(openssl rand -hex 32)"
export REMEMBRA_HOME="$HOME/.remembra"
remembra --http --port 8787
```

The server binds to loopback when no key is configured. A non-loopback host without a key is refused. Put a TLS reverse proxy in front of any public deployment.

```bash
curl http://127.0.0.1:8787/health
```

Open [http://127.0.0.1:8787/](http://127.0.0.1:8787/) for the dashboard. The shell is static and public on a keyed server; all data requests made by the page still require the API key.

### Store and search over HTTP

```bash
curl -X POST http://127.0.0.1:8787/api/v1/memories \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  -d '{"type":"decision","content":"The project uses the /api/v1 namespace","scope":"project/demo","importance":4}'

curl "http://127.0.0.1:8787/api/v1/memories/search?query=api&scope=project/demo&limit=5" \
  -H "x-api-key: $REMEMBRA_API_KEY"
```

New integrations should use `/api/v1/*`. Existing unversioned routes remain supported for V4.9 compatibility.

### Use the TypeScript SDK

The SDK is a side-effect-free fetch client; importing it does not start the CLI.

```ts
import { Remembra } from "@hilbras/remembra/sdk";

const memory = new Remembra({
  endpoint: "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

await memory.store({
  type: "fact",
  content: "The project uses /api/v1",
  scope: "project/demo",
});

const results = await memory.search({ query: "api", scope: "project/demo", limit: 5 });

const context = await memory.context({
  query: "What architecture decisions should I remember?",
  scope: "project/demo",
  maxTokens: 4000,
  limit: 50,
});

console.log(context.context);
console.log(context.tokenCount, context.retrievalMetadata.selectedCount);
```

The SDK supports pagination, cancellation, structured errors, lifecycle operations, history, relations, batch operations, and the trusted tenant entity methods documented in [docs/sdk.md](docs/sdk.md).

---

## The memory model

Every memory has a type, scope, provenance, trust level, importance, retention policy, and optional typed relations. The model deliberately separates **what was observed** from **whether it should be trusted**.

### Eleven semantic types

| Type | Use it for | Example |
|---|---|---|
| `fact` | Stable knowledge | “The project uses PostgreSQL 16.” |
| `preference` | User or team preferences | “Prefer concise answers.” |
| `decision` | A choice already made | “Chose JWT over server sessions.” |
| `constraint` | A hard limit or prohibition | “Never commit secrets.” |
| `instruction` | Standing behavior | “Run tests before opening a PR.” |
| `role` | Persona or operating rule set | “Act as the staff engineer.” |
| `entity` | A named person, service, or repository | “billing-service belongs to payments.” |
| `relationship` | A typed connection between entities | “billing-service depends on ledger-db.” |
| `event` | A dated occurrence | “The events table was migrated.” |
| `history` | Condensed chronology of work | “Authentication was redesigned in March.” |
| `observation` | Raw signal awaiting validation | “p95 spiked after deployment.” |

### Trust is a gate, not a score

`system` and `verified` content is treated as stronger evidence than `trusted` content; `unverified` content remains searchable but does not receive the standing-instruction boost. Conversation-derived roles and instructions land unverified until explicitly approved.

Treat retrieved memories as **data with provenance**, not automatically as commands. In particular, a global `role` or `instruction` is intentionally powerful and should be audited before it is trusted in a shared deployment. See [security](docs/security.md#role-memories-are-instructions--the-prompt-injection-surface).

### Scope and retrieval

A scope narrows relevance; it never replaces tenant authorization. In V5, `global` means global **within the authenticated organization**, not global across all tenants. Retrieval combines:

- authorized tenant/project filters;
- standing role and instruction gates;
- keyword and optional embedding candidates;
- trust, provenance, pinned retention, importance, and recency;
- temporal filters and bounded one-hop relation expansion;
- deterministic tie-breaking and diversity selection.

Oversized context candidates are skipped and counted. Remembra never silently truncates a memory or returns an over-budget context.

---

## V5 context retrieval

`memory_context` and `POST /api/v1/context` use the same ranked, authorized retrieval path as search, then apply a deterministic token budget while walking the ranked results.

```bash
curl -X POST http://127.0.0.1:8787/api/v1/context \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  -d '{"query":"release and migration decisions","scope":"project/demo","maxTokens":4000,"limit":50,"explain":true}'
```

The response contains:

```json
{
  "memories": [
    {
      "id": "memory-id",
      "type": "decision",
      "content": "The project uses the /api/v1 namespace",
      "scope": "project/demo",
      "trust": "trusted"
    }
  ],
  "context": "[memory-id] DECISION (scope: project/demo, trust: trusted)\nThe project uses the /api/v1 namespace",
  "tokenCount": 812,
  "retrievalMetadata": {
    "query": "release and migration decisions",
    "scope": "project/demo",
    "maxTokens": 4000,
    "tokenCounter": "conservative-estimate-v1",
    "candidateCount": 50,
    "selectedCount": 3,
    "omittedCount": 2
  }
}
```

The default budget is `4000` tokens, the hard maximum is `100000`, and the candidate cap is `100`. Internal embedding vectors are never included in context responses. The context API is read-only and does not refresh recency.

Full contract: [V5 context specification](docs/v5-context-spec.md).

---

## HTTP API

The HTTP process exposes the dashboard, health/readiness, metrics, memory operations, snapshots, administration, and V5 context/tenant routes.

| Surface | Examples | Purpose |
|---|---|---|
| Health and metrics | `GET /health`, `GET /metrics` | Readiness, liveness, Prometheus metrics |
| Memory CRUD | `POST /api/v1/memories`, `GET /api/v1/memories/:id`, `PUT`, `DELETE` | Store, inspect, patch, and forget memories |
| Retrieval | `GET /api/v1/memories/search`, `POST /api/v1/context` | Ranked search and bounded context |
| Lifecycle | `POST /api/v1/memories/:id/archive`, `.../revive`, `POST /api/v1/maintain` | Archive, restore, decay, and vector backfill |
| Graph/history | `GET .../:id/history`, `POST .../:id/relate` | Diffs, typed relations, and backlinks |
| Batch/digest | `POST /api/v1/memories/batch`, `POST /api/v1/memories/digest` | Bounded writes and LLM extraction |
| Snapshots | `GET /api/v1/snapshot`, `POST /api/v1/import` | Portable backup and idempotent restore |
| Administration | `GET /api/v1/audit`, `GET /api/v1/quality`, `GET /api/v1/agents/:id` | Audit and operational visibility |
| Tenant entities | `/api/v1/tenant/organization`, `/tenant/entities/...`, `/tenant/memberships/...` | Trusted organization, user, project, agent, and membership administration |

When `REMEMBRA_API_KEY` is set, data routes accept `x-api-key` or `Authorization: Bearer`. `/health` and the static dashboard shell are intentionally public; the shell contains no memory data. `/api/v1` responses include `X-Remembra-API-Version: v1`.

The SDK preserves legacy response shapes and exposes server-managed identity rejection. For the complete route/error compatibility contract, see [public API and stability](docs/public-api.md).

---

## MCP tools

The V4.9 manifest contains thirteen tools. V5 manifest version `2` adds `memory_context` without renaming or removing an existing tool.

| Tool | Purpose |
|---|---|
| `memory_store` | Persist one of eleven memory types |
| `memory_batch` | Bounded store, update, delete, or selected export |
| `memory_update` | Patch fields with optional optimistic concurrency |
| `memory_archive` | Park a memory without deleting it |
| `memory_revive` | Return an archived memory to active storage |
| `memory_digest` | Extract and store memories from a transcript |
| `memory_search` | Retrieve relevant memories |
| `memory_context` | Build deterministic, token-bounded V5 context |
| `memory_list` | Browse stored memories with filters/pagination |
| `memory_get` | Fetch one memory, relations, and backlinks |
| `memory_relate` | Add, remove, or retype graph relationships |
| `memory_history` | View version history and line diffs |
| `memory_maintain` | Run decay, deletion, and embedding backfill |
| `memory_forget` | Permanently delete one memory |

Full argument schemas and session-flow guidance are in [docs/tools.md](docs/tools.md).

---

## Tenant-safe deployments (V5)

V5 models an organization as the security boundary:

```text
organization
├── users
├── projects
├── agents
└── memories
```

The host authenticates the caller, resolves current membership, and mints an opaque `TenantContext`. Remembra does **not** trust a tenant ID, organization ID, user ID, project ID, or agent ID supplied in an ordinary HTTP body, query parameter, MCP argument, or SDK payload.

### Legacy and strict modes

| Mode | Behavior |
|---|---|
| `legacy` | Explicit V4.9 compatibility. Reads/writes only the legacy namespace and refuses mixed tenant data. |
| `strict` | Requires a current host-minted context for every data-plane operation; missing, stale, or mixed data fails closed. |

V4.9 memories do not silently acquire a tenant. A migration must explicitly assign them to an organization and produce a signed, checksummed manifest before strict rollout.

### Local operator binding

The CLI can bind a local process to one trusted tenant through environment variables:

```bash
export REMEMBRA_TENANT_MODE=strict
export REMEMBRA_TENANT_ID=org-demo
export REMEMBRA_TENANT_MEMBERSHIP_VERSION=membership-42
export REMEMBRA_TENANT_PROJECT_ID=project-demo
export REMEMBRA_SNAPSHOT_KEY="$(openssl rand -hex 32)"

remembra --http
```

`REMEMBRA_TENANT_ID` is the opaque organization selector. The membership version must match the host's current directory state. Raw HTTP headers, CLI arguments, and SDK fields cannot replace these bindings.

### Host integration

```ts
import { createTenantContext } from "@hilbras/remembra/tenant";

const tenant = createTenantContext({
  organizationId: "org-demo",
  membershipVersion: "membership-42",
  projectId: "project-demo",
  scopes: ["global", "project/project-demo"],
  capabilities: ["tenant:read", "tenant:write"],
});

// Pass this opaque object only from trusted host code.
// A public transport resolver must return it after authentication.
```

For organization administration, inject a `TenantDirectory` and `TenantEntityService` into the host application. Organization provisioning is default-deny unless an explicit `authorizeBootstrap` hook is supplied. Membership changes are versioned, bounded, and audited.

The complete isolation and migration contract is in [V5 tenant specification](docs/v5-tenant-spec.md). The security evidence requirements are in [V5 threat model](docs/v5-threat-model.md).

---

## Storage, lifecycle, and recovery

### Storage backends

The CLI prefers SQLite for local durability and search:

```text
$REMEMBRA_HOME/
├── data.sqlite                 # default SQLite database
├── data.sqlite-wal/-shm        # only while SQLite is open
├── .history/                   # file-backend history, when applicable
└── .remembra.lock              # cross-process mutation lock
```

`MemoryStore` provides the readable Markdown backend and remains compatible with legacy data and explicit Markdown export/import. SQLite adds FTS5 when available, bounded candidate SQL, WAL mode, vector blobs, audit tables, and online backup support.

Memory IDs are globally unique. Relations, superseded references, snapshot references, and compressed references are validated against the same store before publication.

### Lifecycle

- **Store**: durable write with atomic file/database semantics.
- **Update**: optimistic concurrency through `expectedVersion`; a stale writer receives `CONFLICT` and writes nothing.
- **Archive/revive**: reversible lifecycle transitions.
- **Decay**: unused memories may be archived; expired archived memories may be deleted.
- **History**: content changes retain bounded pre-images and line diffs.
- **Maintenance**: `remembra maintain` performs decay and embedding backfill.

### Snapshots and migration

```bash
# Portable snapshot; legacy mode accepts unsigned V4 snapshots.
remembra export backup.json

# Validate the entire snapshot without writing.
remembra import backup.json --dry-run

# Idempotent restore; existing IDs/duplicates are skipped.
remembra import backup.json
```

In strict mode, exports and imports use a canonical HMAC envelope and require `REMEMBRA_SNAPSHOT_KEY`. The complete snapshot/reference preflight happens before any write; per-record restore is idempotent but an operational failure after preflight can leave a partial application, so keep a verified backup. Tenant migration adds a signed manifest, checksum preflight, durable checkpoints, verified resume, failure records, and an explicit publication marker. For the V5.0.1 analyze/plan/apply commands, see the [security and migration guide](docs/v5.0.1-security-and-migration.md).

SQLite operators can use the verified recovery helpers from `@hilbras/remembra/sqlite-recovery` for online backup, integrity/schema checks, atomic restore, and retained-previous rollback. Close the live service before restoring and reject active SQLite sidecars.

See [storage](docs/storage.md), [migration](docs/migration-v4.9.md), and [public API](docs/public-api.md#tenant-migration-and-recovery-host-api).

---

## Providers and optional intelligence

Storage and keyword retrieval work without any provider key. Configure providers only when you need digest extraction or semantic search.

```bash
# Hosted providers
export OPENAI_API_KEY=...
export REMEMBRA_LLM=openai
export REMEMBRA_EMBEDDINGS=openai

# Fully local Ollama
export REMEMBRA_LLM=ollama
export REMEMBRA_LLM_MODEL=llama3.2
export REMEMBRA_EMBEDDINGS=ollama
export REMEMBRA_EMBEDDING_MODEL=nomic-embed-text
```

Provider calls have per-attempt timeouts, bounded retries/backoff, a wall-clock budget, cancellation, and normalized errors. Embedding failure degrades to keyword search; LLM digest failure does not partially store a transcript. The provider adapter contract is public through `@hilbras/remembra/providers`.

See [provider configuration](docs/providers.md) for all variables and adapter examples.

---

## Security and operations

Remembra is designed to fail closed at the boundaries that matter:

- API keys are compared with timing-safe equality; a non-loopback server without a key refuses to start.
- Request bodies, batches, queues, provider calls, retrieval candidates, context budgets, and page sizes are bounded.
- Tenant predicates are applied inside backend queries before limits, counts, ranking, and cursor creation.
- Caches and provider work use tenant-safe partitions.
- Public identity fields and tenant headers are rejected rather than trusted.
- Snapshots, migrations, directories, and SQLite restores reject symlinks, oversized inputs, tampering, and invalid references.
- Audit, structured logs, and Prometheus metrics are available for operational review.
- Optional PII redaction (`REMEMBRA_REDACT=1`) and AES-256-GCM file-backend encryption (`REMEMBRA_ENCRYPT_KEY`) are available for higher-risk deployments; SQLite, snapshots, and transport need separate volume/backup/TLS controls.

### Deployment checklist

- [ ] Use a long random `REMEMBRA_API_KEY` for every non-loopback HTTP deployment.
- [ ] Terminate TLS at a reverse proxy; do not expose plain HTTP directly to the internet.
- [ ] Keep `REMEMBRA_HOME`, snapshots, migration manifests, and encryption keys access-controlled.
- [ ] Use strict mode with a host-resolved identity system for shared or multi-tenant deployments.
- [ ] Audit global roles and instructions regularly.
- [ ] Test encrypted/signed backups and restore procedures before relying on them.
- [ ] Monitor `/health`, `/metrics`, structured logs, and queue/provider failures.
- [ ] Use filesystem encryption and OS process isolation in addition to application-level controls.

Read [security](docs/security.md), [self-hosting](docs/self-hosting.md), [V5.0.2 authorization](docs/v5.0.2-authorization.md), the [final V5 threat model](docs/v5-threat-model.md), and [observability](docs/observability.md) before exposing a deployment.

---

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `REMEMBRA_HOME` | `~/.remembra` | Local data root |
| `REMEMBRA_API_KEY` | unset | HTTP API/UI data authentication |
| `REMEMBRA_HOST` | loopback-safe | HTTP bind address |
| `REMEMBRA_PORT` | `8787` | HTTP port; `--port` overrides it |
| `REMEMBRA_UI` | enabled | Set `0` to disable dashboard routes |
| `REMEMBRA_REDACT` | disabled | Set `1` for irreversible ingest-time PII redaction |
| `REMEMBRA_ENCRYPT_KEY` | disabled | 32-byte hex key for AES-256-GCM file-backend memory/history encryption (not SQLite/snapshots/transport) |
| `REMEMBRA_LLM` | `openai` | Digest provider |
| `REMEMBRA_EMBEDDINGS` | `none` | Embedding provider; `none` keeps keyword mode |
| `REMEMBRA_TENANT_MODE` | `legacy` | `legacy` or fail-closed `strict` |
| `REMEMBRA_TENANT_ID` | — | Required organization selector in strict local mode |
| `REMEMBRA_TENANT_MEMBERSHIP_VERSION` | — | Required current membership version in strict local mode |
| `REMEMBRA_SNAPSHOT_KEY` | — | 64-character hex HMAC key for strict snapshots |

Additional limits and provider controls are documented in [self-hosting](docs/self-hosting.md), [security](docs/security.md), and [providers](docs/providers.md).

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Transport adapters                                          │
│ MCP stdio · HTTP /api/v1 · TypeScript SDK · dashboard        │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ MemoryService                                               │
│ authorization · ranking · context · lifecycle · snapshots     │
│ digest · relations · jobs · provider policy                  │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ MemoryBackend                                               │
│ SqliteBackend (default CLI) · MemoryStore (file backend)     │
└──────────────────────────┬───────────────────────────────────┘
                           │
       ┌───────────────────┴───────────────────┐
       ▼                                       ▼
┌───────────────┐                       ┌────────────────────┐
│ Provider      │                       │ Tenant directory    │
│ adapters      │                       │ in-memory / file    │
└───────────────┘                       └────────────────────┘
```

Key design properties:

- transports are thin; policy and authorization live in the service/backend boundary;
- V5.0.2 makes project/user/agent selectors conjunctive and requires explicit export authority;
- SQLite and file backends implement the same tenant-aware contract;
- atomic writes, advisory locking, and crash recovery protect local durability;
- relation/history/audit/job paths apply the same tenant filter as primary reads;
- provider failures are bounded and do not weaken storage correctness.

See [architecture](docs/architecture.md), [memory model](docs/memory-model.md), and [storage format](docs/storage.md) for the detailed contracts.

---

## Development

```bash
git clone https://github.com/Hilbras/Remembra.git
cd Remembra
npm install
npm run build
npm test
npm run docs:check
```

Useful commands:

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript and copy the dashboard |
| `npm test` | Run the full test suite |
| `npm run docs:check` | Validate relative documentation links |
| `npm run security:check` | Run the tenant/security adversarial matrix |
| `npm run recovery:check` | Run migration, snapshot, and SQLite recovery tests |
| `npm run bench:scale` | Run deterministic 10K/50K scale benchmarks |
| `npm run bench:tenant` | Run isolated strict-tenant 10K/100K benchmarks |
| `npm run release:check` | Run the complete fail-closed release gate |
| `npm run dev` | Run TypeScript in watch mode |

The release gate includes build, tests, security/recovery matrices, documentation, audit, package contents, and benchmarks. See [V5 release gates](docs/v5-release-gates.md) before publishing.

---

## Documentation map

| Area | Documentation |
|---|---|
| First install | [Getting started](docs/getting-started.md) |
| Clients and MCP setup | [Clients](docs/clients.md) · [Tools](docs/tools.md) |
| HTTP and SDK | [Public API](docs/public-api.md) · [SDK](docs/sdk.md) |
| V5 context | [Context contract](docs/v5-context-spec.md) · [Policy](docs/v5-policy.md) |
| Tenants and migration | [Tenant contract](docs/v5-tenant-spec.md) · [V5.0.2 authorization](docs/v5.0.2-authorization.md) · [V4.9 migration](docs/migration-v4.9.md) · [V5.0.1 migration guide](docs/v5.0.1-security-and-migration.md) |
| Security | [Security model](docs/security.md) · [Threat model](docs/v5-threat-model.md) |
| Storage and recovery | [Storage](docs/storage.md) · [Architecture](docs/architecture.md) |
| Providers | [Providers](docs/providers.md) |
| Operations | [Self-hosting](docs/self-hosting.md) · [Observability](docs/observability.md) · [UI](docs/ui.md) |
| Project process | [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [V5 gates](docs/v5-release-gates.md) |
| Future architecture | [V6 architecture specification](docs/v6-architecture-spec.md) |

---

## Compatibility and roadmap

- **V4.9 remains supported:** legacy HTTP routes, Markdown, existing clients, and all thirteen original MCP tools remain available.
- **V5 is additive:** `memory_context`, tenant entities, and versioned APIs do not rename or remove the V4.9 surface.
- **Current focus:** hardening the production memory platform, operational recovery, and measurable retrieval quality.
- **V6 direction:** see the [V6 architecture specification](docs/v6-architecture-spec.md) for the security-first policy model, provider independence, offline-first core, migration lifecycle, and release roadmap.
- **Schema boundary:** tenantless V4 records use schema `3`; tenant records use schema `4`.

## License

[MIT](LICENSE) © Hilbras
