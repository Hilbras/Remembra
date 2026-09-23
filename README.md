# Remembra 🧠

**External memory for AI assistants.** Remembra stores facts, decisions, roles, and history
outside the context window, and hands back only what's relevant — so your AI stops forgetting
when the conversation gets long.

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

Every memory has a **type**, a **scope**, tags, and an importance score:

- **fact** — stable knowledge ("Project uses PostgreSQL 16")
- **decision** — choices already made ("Chose JWT over sessions")
- **role** — standing instructions ("Answer concisely"; *always* injected)
- **history** — condensed chronology of past work

**Scopes:**
- `global` — relevant everywhere (preferences, roles)
- any project path/id — only loaded when working in that scope, never leaks into other projects

**Retrieval ranking:** roles always surface → scope match → importance → recency → keyword overlap.

## Quick start

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

### HTTP API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/health` | Liveness (no auth) |
| POST | `/memories` | Store a memory |
| GET | `/memories/search?query=&scope=` | Search |
| GET | `/memories?scope=&type=` | List |
| POST | `/memories/digest` | LLM extract + store from a transcript |
| POST | `/maintain` | Decay sweep + vector backfill |
| DELETE | `/memories/:id` | Forget |

All routes except `/health` require `x-api-key` (or `Authorization: Bearer`) when
`REMEMBRA_API_KEY` is set.

> 🔒 **Auth is now default-deny**: without `REMEMBRA_API_KEY` the server binds
> to `127.0.0.1` only, and a non-loopback `REMEMBRA_HOST` without a key refuses
> to start. Public deployments (ChatGPT) must set a key. See
> [security.md](docs/security.md).

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
| `memory_store` | Save a fact / decision / role / history |
| `memory_digest` | Extract + store memories from a transcript (LLM) |
| `memory_search` | Retrieve relevant memories (pass `scope` = current project) |
| `memory_list` | Browse stored memories |
| `memory_maintain` | Archive decayed / delete expired / backfill vectors |
| `memory_forget` | Delete by id |

Full reference: **[docs/tools.md](docs/tools.md)**

## Documentation

| Doc | What's inside |
|-----|--------------|
| [Memory model](docs/memory-model.md) | Types, scopes, ranking, storage format |
| [Tool reference](docs/tools.md) | Every MCP tool with arguments |
| [Client setup](docs/clients.md) | Config for each supported tool |
| [ChatGPT setup](docs/chatgpt.md) | HTTP API + Custom GPT walkthrough |
| [AI providers](docs/providers.md) | Digest LLM + embeddings configuration |
| [Lifecycle](docs/lifecycle.md) | Decay, archiving, auto-delete, contradiction merging |
| [Security](docs/security.md) | Trust model, enforced protections, deployment checklist |
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
- **v3** *(current)* — memory lifecycle (archive/decay), contradiction merging, maintenance CLI ✅

> Package versions match milestones: `3.0.0` = v3, next ships as `4.0.0`.

## License

[MIT](LICENSE) © Hilbras
