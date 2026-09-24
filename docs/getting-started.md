# Getting Started

## Requirements

Node.js `18.14.1` or newer is required.

## Install

```bash
npm install -g @hilbras/remembra
```

Remembra defaults to keyword-only memory and needs no API key. Choose MCP for
OpenCode, Claude Code, Cline, or Kimi Code:

```bash
claude mcp add remembra -- remembra
```

See [client setup](clients.md) for configuration examples.

## Run HTTP mode

```bash
export REMEMBRA_API_KEY="replace-with-a-long-random-secret"
remembra --http --port 8787
```

The server binds to all interfaces when a key is configured. Without a key it
binds to loopback only. Verify readiness:

```bash
curl http://127.0.0.1:8787/health
```

## Use the TypeScript SDK

```ts
import { Remembra } from "@hilbras/remembra/sdk";

const memory = new Remembra({
  endpoint: "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

await memory.store({ type: "fact", content: "The API uses /api/v1" });
const results = await memory.search({ query: "API", limit: 5 });
```

The SDK is side-effect-free and does not start the CLI. New HTTP integrations
should use `/api/v1`; existing unversioned routes remain supported.

## Optional session digest

Set a provider key only when digest extraction is needed:

```bash
export OPENAI_API_KEY="..."
export REMEMBRA_LLM=openai
remembra --http
```

Embeddings are off by default. See [providers](providers.md) before enabling
semantic search or injecting a local adapter.

## Next steps

- [API and SDK reference](public-api.md) / [SDK details](sdk.md)
- [MCP tools](tools.md)
- [Security and deployment](security.md)
- [Backup and migration](migration-v4.9.md)
- [Troubleshooting](troubleshooting.md)
