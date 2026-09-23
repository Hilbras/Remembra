# Client Setup

Remembra speaks MCP over stdio — one server process, any compatible client.

> Replace `/home/gin/work/Hilbras/Memory` with wherever you installed Remembra,
> or use the global install: `npx @hilbras/remembra`.

## OpenCode

Add to `~/.config/opencode/opencode.json` (global) or a project's `opencode.json`:

```json
{
  "mcp": {
    "remembra": {
      "type": "local",
      "command": ["node", "/home/gin/work/Hilbras/Memory/dist/index.js"]
    }
  }
}
```

## Claude Code

```bash
claude mcp add remembra -- node /home/gin/work/Hilbras/Memory/dist/index.js
```

Or in `.mcp.json` (project) / `~/.claude.json` (user):

```json
{
  "mcpServers": {
    "remembra": {
      "command": "node",
      "args": ["/home/gin/work/Hilbras/Memory/dist/index.js"]
    }
  }
}
```

## Cline

Cline settings → MCP Servers → Add:

```json
{
  "mcpServers": {
    "remembra": {
      "command": "node",
      "args": ["/home/gin/work/Hilbras/Memory/dist/index.js"]
    }
  }
}
```

## Kimi Code

Add to the MCP config file used by Kimi CLI:

```json
{
  "mcpServers": {
    "remembra": {
      "command": "node",
      "args": ["/home/gin/work/Hilbras/Memory/dist/index.js"]
    }
  }
}
```

## ChatGPT

Uses the HTTP mode instead of MCP — see the full walkthrough in
**[chatgpt.md](chatgpt.md)** (server start, API reference, Custom GPT action schema,
tunneling options).

```bash
REMEMBRA_API_KEY="your-secret" remembra --http
```

## Web dashboard

Any `--http` run also serves the full web UI at the server root — point a
browser at `http://localhost:8787/` (behind the same key, entered in the
page). Browse, edit, audit roles, view history diffs, run digests, watch
metrics, export/import. See **[ui.md](ui.md)**; disable with
`REMEMBRA_UI=0`.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_HOME` | `~/.remembra` | Where memory files live |
| `REMEMBRA_API_KEY` | *(unset)* | Enables auth on the HTTP API |
| `REMEMBRA_PORT` | `8787` | HTTP API port (`--port` overrides) |
| `REMEMBRA_UI` | `1` | `0` disables serving the web dashboard (`/`, `/ui/*`) |
| `REMEMBRA_LLM` | `openai` | Digest LLM: `openai` \| `anthropic` \| `ollama` |
| `REMEMBRA_EMBEDDINGS` | `none` | Semantic search: `openai` \| `ollama` \| `none` |
| `REMEMBRA_ARCHIVE_AFTER_DAYS` | `90` | Unused active memory → archived |
| `REMEMBRA_ARCHIVE_TTL_DAYS` | `365` | Archived memory → deleted |
| `REMEMBRA_HOST` | *(see security.md)* | HTTP bind address (loopback without key) |
| `REMEMBRA_MAX_BODY` | `10485760` | Max HTTP request body bytes |
| `REMEMBRA_LOCK_TIMEOUT_MS` | `5000` | Max wait for the cross-process storage lock |
| `REMEMBRA_LOCK_STALE_MS` | `10000` | Age after which a lock with a dead/unknown pid is stolen |
| `REMEMBRA_CACHE_SIZE` | `10000` | Parse-cache LRU capacity (entries); `0` disables caching |
| `REMEMBRA_HISTORY_LIMIT` | `20` | Max version snapshots kept per memory; `0` disables history |
| `REMEMBRA_REDACT` | *(unset)* | `1` enables PII redaction at ingest (irreversible) — see [security.md](security.md#pii-redaction-opt-in-380) |
| `REMEMBRA_ENCRYPT_KEY` | *(unset)* | 64-hex 32-byte key → AES-256-GCM at rest; run `remembra encrypt` — see [security.md](security.md#encryption-at-rest-opt-in-380) |
| `REMEMBRA_PROVIDER_TIMEOUT_MS` | `60000` | Per-attempt timeout for LLM/embedding calls (4.0.1) |
| `REMEMBRA_PROVIDER_RETRIES` | `2` | Bounded provider retries (network/408/429/5xx) |
| `REMEMBRA_PROVIDER_BUDGET_MS` | `180000` | Wall-clock cap across all provider attempts |
| `REMEMBRA_PROVIDER_BACKOFF_MS` | `250` | Provider retry backoff base |
| `REMEMBRA_DEBUG` | *(unset)* | `1` logs the storage root path at startup (off by default: log hygiene) |
| `REMEMBRA_LOG` | *(auto)* | Force log format: `json` or `text`. Unset → auto: JSON when stderr is piped, text on a TTY. See [observability.md](observability.md) |

LLM/embedding key setup: see **[providers.md](providers.md)**.

## Tips

- **Pass `scope`** — every client should give Remembra its current project path when
  calling `memory_search`, so project memories don't mix across repos.
- **Roles are always injected** — put standing instructions in `type: "role"` and they'll
  never be filtered out by ranking (store them `global` or in the scopes where
  you want them followed — other projects' roles stay out).
- **One server, shared brain** — all clients write to the same storage, so a decision made
  in Claude Code is visible in OpenCode.
