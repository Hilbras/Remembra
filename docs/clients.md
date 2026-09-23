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

*Planned for v1.5* — an HTTP layer exposing the same handlers, wired to a
Custom GPT action with API-key auth.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `REMEMBRA_HOME` | `~/.remembra` | Where memory files live |

## Tips

- **Pass `scope`** — every client should give Remembra its current project path when
  calling `memory_search`, so project memories don't mix across repos.
- **Roles are always injected** — put standing instructions in `type: "role"` and they'll
  never be filtered out by ranking.
- **One server, shared brain** — all clients write to the same storage, so a decision made
  in Claude Code is visible in OpenCode.
