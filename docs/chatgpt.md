# ChatGPT Setup (v1.5)

ChatGPT doesn't speak MCP, so Remembra exposes the same memory handlers over a plain
HTTP API. You connect it by creating a **Custom GPT** with API actions.

## 1. Start the HTTP server

```bash
export REMEMBRA_API_KEY="pick-a-long-random-secret"
remembra --http --port 8787
# or, from source:
node dist/index.js --http --port 8787
```

Check it's up:

```bash
curl http://localhost:8787/health
# {"status": "ok"}
```

- `REMEMBRA_API_KEY` **mandatory for public exposure** — without it the server
  binds to `127.0.0.1` only, and a non-loopback `REMEMBRA_HOST` without a key
  refuses to start (default-deny, see [security.md](security.md)).
- The server binds to localhost by default. For ChatGPT to reach it you must expose it
  publicly (see [§4](#4-exposing-the-server)).

## 2. HTTP API reference

All data endpoints require the key via `x-api-key` or `Authorization: Bearer`.
`/health`, `/`, and `/ui/*` are intentionally public shell/readiness routes;
they do not return memory data.

### Store a memory

```bash
curl -X POST http://localhost:8787/memories \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  -d '{
    "type": "decision",
    "content": "Chose monthly billing over annual",
    "scope": "global",
    "tags": ["pricing"],
    "importance": 4
  }'
```

### Search memories

```bash
curl "http://localhost:8787/memories/search?query=billing&scope=global&limit=5" \
  -H "x-api-key: $REMEMBRA_API_KEY"
```

| Query param | Description |
|-------------|-------------|
| `query` (or `q`) | keywords to match |
| `scope` | project/workspace filter |
| `type` | `fact` \| `preference` \| `decision` \| `constraint` \| `instruction` \| `role` \| `entity` \| `relationship` \| `event` \| `history` \| `observation` |
| `limit` | max results (default 10) |

### List memories

```bash
curl "http://localhost:8787/memories?scope=global&type=role" \
  -H "x-api-key: $REMEMBRA_API_KEY"
```

### Delete a memory

```bash
curl -X DELETE http://localhost:8787/memories/<id> \
  -H "x-api-key: $REMEMBRA_API_KEY"
```

### Digest a session (LLM extraction)

```bash
curl -X POST http://localhost:8787/memories/digest \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  -d '{"transcript":"<conversation text>","scope":"chatgpt"}'
```

Requires `REMEMBRA_LLM` + key — see [providers.md](providers.md).

### Get one memory (with links)

```bash
curl http://localhost:8787/memories/<id> \
  -H "x-api-key: $REMEMBRA_API_KEY"
# → { "memory": {...}, "related": [...], "backlinks": [...] }
```

### Update a memory (patch)

```bash
curl -X PUT http://localhost:8787/memories/<id> \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  -d '{"content": "Chose monthly billing with a 14-day trial"}'
```

Send only the fields to change (`type`, `content`, `scope`, `tags`,
`importance`, `source`, `confidence`, `trust`, `retention`). A `scope`
change moves the file; a `content` change snapshots the previous version to
history — optionally guarded with `expectedVersion` (mismatch → `409`) and
annotated with a `reason`.

### Archive / revive a memory

```bash
curl -X POST http://localhost:8787/memories/<id>/archive -H "x-api-key: $REMEMBRA_API_KEY"
curl -X POST http://localhost:8787/memories/<id>/revive  -H "x-api-key: $REMEMBRA_API_KEY"
```

Archived memories drop out of list/search until revived (or listed with
`includeArchived=true`).

### Link two memories (relationship graph)

```bash
curl -X POST http://localhost:8787/memories/<id>/relate \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  -d '{"related": ["<other-id>"], "action": "add", "kind": "supports"}'
```

Optional `kind`: `supports · contradicts · supersedes · refines · duplicates ·
related` (default `related`).

### Version history with diffs

```bash
curl "http://localhost:8787/memories/<id>/history?limit=5" \
  -H "x-api-key: $REMEMBRA_API_KEY"
# → { "id": "...", "versions": [{ "content": "...", "diff": "--- ..." }, ...] }
```

### Export / import a snapshot

```bash
curl http://localhost:8787/snapshot -H "x-api-key: $REMEMBRA_API_KEY" > memories.json

curl -X POST http://localhost:8787/import \
  -H "content-type: application/json" \
  -H "x-api-key: $REMEMBRA_API_KEY" \
  --data-binary @memories.json
# → { "imported": 2, "skipped": 0 }   (re-import: everything skipped — idempotent)
```

Same format and handlers as the `remembra export` / `remembra import` CLI
commands; the whole file is validated before anything is written.

### Web dashboard

The server root also serves the web UI — open `http://localhost:8787/` in a
browser (enter the API key in the page). See [ui.md](ui.md).

## 3. Create the Custom GPT

1. Go to **chatgpt.com → Explore GPTs → Create a GPT**.
2. **Name**: Remembra (or whatever you like).
3. **Instructions** — paste this:

   > You have long-term memory powered by Remembra. At the start of every conversation,
   > call `search_memories` with no query to load your roles, facts and decisions.
   > Whenever the user tells you something worth remembering (a fact, a decision,
   > their role or preferences) or a decision is made, call `store_memory`.
   > Scope for this chat is `chatgpt` unless the user is discussing a specific project.
   > If the model asks you to forget something, call `delete_memory` with its id.

4. **Capabilities** → enable **Actions**.
5. Under **Actions → Create new action**, paste this schema (fill in your domain and key):

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Remembra Memory", "version": "1.0.0" },
  "servers": [{ "url": "https://YOUR-DOMAIN.example" }],
  "paths": {
    "/memories": {
      "post": {
        "operationId": "store_memory",
        "summary": "Store a memory (any of the 11 types)",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["type", "content"],
                "properties": {
                  "type": { "type": "string", "enum": ["fact", "preference", "decision", "constraint", "instruction", "role", "entity", "relationship", "event", "history", "observation"] },
                  "content": { "type": "string", "description": "Standalone statement" },
                  "scope": { "type": "string", "default": "global" },
                  "tags": { "type": "array", "items": { "type": "string" } },
                  "importance": { "type": "integer", "minimum": 1, "maximum": 5 }
                }
              }
            }
          }
        },
        "responses": { "201": { "description": "Stored" } }
      },
      "get": {
        "operationId": "list_memories",
        "summary": "List stored memories",
        "parameters": [
          { "name": "scope", "in": "query", "schema": { "type": "string" } },
          { "name": "type", "in": "query", "schema": { "type": "string" } }
        ],
        "responses": { "200": { "description": "OK" } }
      }
    },
    "/memories/search": {
      "get": {
        "operationId": "search_memories",
        "summary": "Search memories",
        "parameters": [
          { "name": "query", "in": "query", "schema": { "type": "string" } },
          { "name": "scope", "in": "query", "schema": { "type": "string" } },
          { "name": "type", "in": "query", "schema": { "type": "string" } },
          { "name": "limit", "in": "query", "schema": { "type": "integer" } }
        ],
        "responses": { "200": { "description": "OK" } }
      }
    },
    "/memories/{id}": {
      "delete": {
        "operationId": "delete_memory",
        "summary": "Delete a memory by id",
        "parameters": [
          { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }
        ],
        "responses": { "200": { "description": "Deleted" } }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "apiKeyAuth": { "type": "apiKey", "in": "header", "name": "x-api-key" }
    }
  },
  "security": [{ "apiKeyAuth": [] }]
}
```

6. In **Authentication**, choose **API Key → Custom → Header → `x-api-key`**, and paste
   your `REMEMBRA_API_KEY`.
7. **Save** (Only me / Anyone, your choice) and test:

   > *"Remember that I prefer metric units."* → the GPT should call `store_memory`.
   > Then in a **new chat**: *"What units do I prefer?"* → it calls `search_memories`
   > and answers. That's the whole point of Remembra — the memory survived the
   > context reset.

## 4. Exposing the server

ChatGPT must reach your server over HTTPS. Options, easiest first:

| Approach | Notes |
|----------|-------|
| **Cloud VM / VPS** | Run `remembra --http` behind nginx/Caddy with TLS. Simplest for a personal server. |
| **Tunnel** | `cloudflared tunnel` or `ngrok http 8787` — quick HTTPS URL for testing. |
| **Serverless** | Port `service.ts` handlers to a Lambda/Cloudflare Worker (v2 territory). |

> ⚠️ Always set `REMEMBRA_API_KEY` when the server is reachable from the internet,
> and prefer a tunnel with access restrictions while testing.

## 5. Sharing memory with your coding tools

Because both transports use the same storage (`~/.remembra`), memories written by
ChatGPT appear in OpenCode/Claude Code and vice versa — just point both at the same
`REMEMBRA_HOME`. Use scope `chatgpt` for chat-specific memories and `global` for
anything that should follow you everywhere.
