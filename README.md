# Remembra 🧠

**External memory for AI assistants.** Remembra stores facts, decisions, preferences, roles, and
everything else worth remembering outside the context window, and hands back only what's
relevant — so your AI stops forgetting when the conversation gets long.

[![npm](https://img.shields.io/npm/v/%40hilbras/remembra.svg)](https://www.npmjs.com/package/@hilbras/remembra)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-brightgreen.svg)](https://modelcontextprotocol.io)

One memory server, many clients:

| Client | Connection |
|--------|-----------|
| OpenCode | MCP (stdio) |
| Claude Code | MCP (stdio) |
| Cline | MCP (stdio) |
| Kimi Code | MCP (stdio) |
| ChatGPT | HTTP API + Custom GPT action ✅ |

## The problem

Every AI assistant has a context window. Fill it, and the model starts forgetting earlier
decisions, repeating questions, and losing track of roles and preferences. Remembra moves
long-term memory **out of the window and into storage**, then injects only the relevant
subset each session.

## How it works

```
Conversation ──► memory_store ──► ~/.remembra/ (markdown files)
                                        │
New session ──► memory_search ◄─────────┘ ──► relevant subset injected
```

Every memory has a **type** (eleven, since v4.1), a **scope**, tags, an
importance score, plus **provenance** (where it came from) and **trust**
(`system`/`verified`/`trusted`/`unverified`):

- **fact** — stable knowledge ("Project uses PostgreSQL 16")
- **preference** — how the user likes things ("prefers concise answers")
- **decision** — choices already made ("Chose JWT over sessions")
- **constraint** — hard limits ("Never commit secrets")
- **instruction** — standing directives ("Always run tests before a PR")
- **role** — personas & rule sets ("You are the architect"; *always* injected)
- **entity** — named people, services, repos ("billing-service → payments team")
- **relationship** — how entities relate ("billing-service depends on ledger-db")
- **event** — dated things that happened ("09-20: events table migrated")
- **history** — condensed chronology of past work
- **observation** — raw signal not yet validated ("p95 spiked after deploy")

Digest-extracted roles/instructions land `unverified` — listed and searchable,
but they never steer anything until you hit **Approve**.

**Scopes:**
- `global` — relevant everywhere (preferences, roles)
- any project path/id — only loaded when working in that scope, never leaks into other projects

**Retrieval ranking:** trusted roles/instructions always surface → scope match →
provenance → trust → pinned → importance → recency → keyword overlap.

## Quick start

Requires Node.js `18.14.1` or newer.

```bash
npm install -g @hilbras/remembra
```

**Claude Code:**

```bash
claude mcp add remembra -- remembra
```

**OpenCode** (`~/.config/opencode/opencode.json`):

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

More clients (Cline, Kimi Code) in **[docs/clients.md](docs/clients.md)**.

### ChatGPT (HTTP mode)

```bash
REMEMBRA_API_KEY="your-secret" remembra --http --port 8787
```

Then wire a Custom GPT to the API — full walkthrough in **[docs/chatgpt.md](docs/chatgpt.md)**.

### Web dashboard

The same `--http` server serves a full **web UI** — open the root:

```bash
REMEMBRA_API_KEY="your-secret" remembra --http
# → http://localhost:8787/
```

Browse & search with filters and pagination, open a memory to edit / archive /
link / view its diff history, audit roles & instructions (with one-click
**Approve** for unverified digests), explore the force-directed
relationship graph, run session digests, watch health + request sparklines,
and export/import snapshots — dark by default with a gold theme and a
light-mode toggle. Guide: **[docs/ui.md](docs/ui.md)**.

### HTTP API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/` · `/ui/*` | Web dashboard shell + assets (static, no auth) |
| GET | `/health` | Liveness + readiness (no auth) |
| GET | `/metrics` | Prometheus metrics (auth when keyed) |
| POST | `/memories` | Store a memory |
| POST | `/memories/batch` | Bounded store/update/delete/selected-export batch |
| PUT | `/memories/:id` | Patch fields incl. `trust`/`retention`; stale `expectedVersion` → 409 |
| GET | `/memories/search?query=&scope=` | Search |
| POST | `/api/v1/context` | Deterministic token-bounded context assembly (V5) |
| GET | `/memories?scope=&type=` | List |
| GET | `/memories/:id` | One memory + typed relations + backlinks |
| POST | `/memories/:id/relate` | Add / remove / retype typed links |
| GET | `/memories/:id/history` | Version history with line diffs |
| POST | `/memories/:id/archive` · `/revive` | Manual lifecycle (v4) |
| POST | `/memories/digest` | LLM extract + store from a transcript |
| POST | `/maintain` | Decay sweep + vector backfill |
| GET | `/snapshot` | Full export snapshot (v4, CLI parity) |
| POST | `/import` | Idempotent snapshot import (v4, CLI parity) |
| DELETE | `/memories/:id` | Forget |

All data routes require `x-api-key` (or `Authorization: Bearer`) when
`REMEMBRA_API_KEY` is set — only `/health` and the static dashboard shell are
exempt (the shell holds no data; every API call it makes still carries the
key). New integrations should use the additive `/api/v1/*` namespace; legacy
unversioned routes remain supported. `/api/v1/health` is public and v1
responses include `X-Remembra-API-Version: v1`. `REMEMBRA_UI=0` disables
serving the UI entirely.

> 🔒 **Auth is now default-deny**: without `REMEMBRA_API_KEY` the server binds
> to `127.0.0.1` only, and a non-loopback `REMEMBRA_HOST` without a key refuses
> to start. Public deployments (ChatGPT) must set a key. See
> [security.md](docs/security.md).

### TypeScript SDK

```ts
import { Remembra } from "@hilbras/remembra/sdk";

const memory = new Remembra({
  endpoint: "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

await memory.store({ type: "fact", content: "The project uses /api/v1" });
const results = await memory.search({ query: "api", limit: 5 });
```

The SDK is side-effect-free, uses the versioned HTTP namespace, and supports
pagination, cancellation, and structured API errors. See [docs/sdk.md](docs/sdk.md).

## Backup & restore

Your memories are plain files under `~/.remembra` — plus a portable snapshot
format for moving between machines or disaster recovery:

```bash
remembra export memories.json                    # full snapshot (incl. archived)
remembra import memories.json                    # idempotent: existing ids/dups skipped
```

Import validates the **whole file before writing anything** — a corrupt or
tampered snapshot is rejected atomically, never half-imported. Of course,
`rsync`/`git` on `~/.remembra` works too.

## Tools

| Tool | Purpose |
|------|---------|
| `memory_store` | Save a memory (11 semantic types) |
| `memory_batch` | Bounded store/update/delete/selected-export batch |
| `memory_update` | Patch a memory — content, scope, tags, trust, `expectedVersion`, … |
| `memory_archive` / `memory_revive` | Manually park a memory aside / bring it back |
| `memory_digest` | Extract + store memories from a transcript (LLM) |
| `memory_search` | Retrieve relevant memories (pass `scope` = current project) |
| `memory_context` | Build a deterministic token-bounded context (V5) |
| `memory_list` | Browse stored memories |
| `memory_get` | Fetch one memory with its links and backlinks |
| `memory_relate` | Typed links: supports/contradicts/supersedes/… (relationship graph) |
| `memory_history` | Version history of a memory with line diffs |
| `memory_maintain` | Archive decayed / delete expired / backfill vectors |
| `memory_forget` | Delete by id |

Full reference: **[docs/tools.md](docs/tools.md)**

## Documentation

| Doc | What's inside |
|-----|--------------|
| [Getting started](docs/getting-started.md) | Install, first MCP/HTTP/SDK setup |
| [Migration](docs/migration-v4.9.md) | Upgrade from 4.8 and compatibility notes |
| [Self-hosting](docs/self-hosting.md) | Deployment, backups, limits, agent mode |
| [Troubleshooting](docs/troubleshooting.md) | Common auth, provider, import, and SDK issues |
| [V4.9 compatibility](docs/v4.9-compatibility.md) | Release matrix and verification results |
| [V5 context contract](docs/v5-context-spec.md) | Token-budget API contract |
| [V5 policy configuration](docs/v5-policy.md) | Validated fail-closed policy settings |
| [V5 threat model](docs/v5-threat-model.md) | Context/tenant security boundaries |
| [Memory model](docs/memory-model.md) | Types, scopes, ranking, storage format |
| [Tool reference](docs/tools.md) | Every MCP tool with arguments |
| [Public API](docs/public-api.md) | Stability contract: tools, HTTP routes, error codes, snapshot format, CLI |
| [TypeScript SDK](docs/sdk.md) | Fetch-based client for the versioned HTTP API |
| [Storage format](docs/storage.md) | On-disk layout, file format, read validation, history |
| [Web dashboard](docs/ui.md) | Pages, theming, dashboard auth, static-serving security |
| [Client setup](docs/clients.md) | Config for each supported tool |
| [ChatGPT setup](docs/chatgpt.md) | HTTP API + Custom GPT walkthrough |
| [AI providers](docs/providers.md) | Digest LLM + embeddings configuration |
| [Lifecycle](docs/lifecycle.md) | Decay, archiving, auto-delete, contradiction merging |
| [Security](docs/security.md) | Trust model, enforced protections, deployment checklist |
| [Observability](docs/observability.md) | Structured logs, Prometheus metrics, health/readiness, alert rules |
| [Architecture](docs/architecture.md) | Backend interface, locking, crash recovery, error codes |
| [Contributing](CONTRIBUTING.md) | Dev workflow and guidelines |
| [Changelog](CHANGELOG.md) | Release history |

## Storage

Memories live as readable markdown files you can inspect, edit, and version:

```
~/.remembra/
├── global/            # always-relevant memories
└── scopes/
    └── <project>/     # project-scoped memories
```

Override the location with `REMEMBRA_HOME`.

## Development

```bash
git clone https://github.com/Hilbras/Remembra.git
cd Remembra
npm install
npm run build   # compile
npm test        # run tests
```

## Roadmap

- **v1** — MCP server for coding tools, file storage, layered retrieval ✅
- **v1.5** — HTTP API + ChatGPT Custom GPT action ✅
- **v2** — automatic session-digest extraction, embeddings behind `memory_search` ✅
- **v3** — memory lifecycle (archive/decay), contradiction merging, maintenance CLI ✅
- **v4** — full web dashboard, write API (`PUT`/archive/revive), HTTP snapshot I/O ✅
- **v4.1** — 11 semantic types, provenance + trust gate, typed relations, retention modes, optimistic concurrency ✅
- **v4.2** — multi-stage retrieval pipeline (RRF fusion, MMR diversity, temporal parsing, explainable scores, embedding cache) ✅
- **v4.8** — performance/scalability: bounded retrieval, batch operations, background jobs ✅
- **v4.9** — API/SDK compatibility stabilization ✅

> Package versions match milestones: `3.0.0` = v3, `4.0.0` = v4.

## License

[MIT](LICENSE) © Hilbras
