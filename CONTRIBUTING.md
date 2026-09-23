# Contributing to Remembra

Thanks for your interest in making AI assistants remember better.

## Development

```bash
git clone https://github.com/Hilbras/Remembra.git
cd Remembra
npm install
npm run build
npm test
```

- `npm run build` — compile TypeScript to `dist/`
- `npm run dev` — watch mode
- `npm test` — run the test suite (Node's built-in runner)

## Testing the MCP server manually

Pipe JSON-RPC messages into it:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

## Guidelines

- **Keep storage human-readable** — memories are markdown files users may open, edit, or
  version by hand. Don't break the frontmatter format without a migration.
- **Keep retrieval layered** — roles must always surface; scope isolation must never leak
  across projects. New ranking signals (like embeddings) go behind the same interface.
- **Scope changes to one concern** per pull request.
- **Add tests** for anything in `store.ts` or `retrieval.ts`.

## Reporting issues

Open an issue with:
1. What you expected vs. what happened
2. Your client (OpenCode / Claude Code / Cline / Kimi Code) and version
3. Relevant memory files (redact contents if needed — structure is enough)

## Roadmap context

See the README roadmap before picking up work: v1.5 is the HTTP/ChatGPT layer,
v2 is session-digest extraction and embeddings, v3 is storage scaling.
