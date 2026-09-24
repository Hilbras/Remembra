# TypeScript SDK

The V4.9 SDK is a small fetch-based client for the stable HTTP API. It has no
server-side imports and importing it does not start the CLI.

```ts
import { Remembra } from "@hilbras/remembra/sdk";

const memory = new Remembra({
  endpoint: "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

const stored = await memory.store({
  type: "fact",
  content: "The project uses PostgreSQL",
});

const results = await memory.search({
  query: "PostgreSQL",
  limit: 5,
});
```

## Client options

- `endpoint` — required `http://` or `https://` base URL. An existing
  `/api/v1` suffix is accepted and normalized.
- `apiKey` — optional key sent as `x-api-key`.
- `fetch` — injectable fetch implementation for tests or custom runtimes.
- `headers` — additional headers sent with every request.

The SDK sends API credentials only. It does not accept or synthesize a trusted
agent identity; agent context remains server-side.

## Methods

- `store(input)`
- `search(params)`
- `list(params)`
- `get(id)`
- `update(id, patch)`
- `forget(id)`
- `digest(input)`
- `maintain()`
- `history(id, { limit })`
- `related(id, ids, { action, kind })`
- `archive(id)` / `revive(id)`
- `batch(request)`

All methods return typed decoded JSON. Non-2xx responses throw
`RemembraApiError`, which exposes `status`, machine-readable `code`, and the
decoded response `body`.

```ts
try {
  await memory.get("missing");
} catch (error) {
  if (error instanceof RemembraApiError && error.code === "NOT_FOUND") {
    // Handle a missing or inaccessible memory.
  }
}
```

Pass an `AbortSignal` through the optional final request argument:

```ts
const controller = new AbortController();
const pending = memory.search({ query: "open questions" }, {
  signal: controller.signal,
});
controller.abort();
await pending;
```

## API version

Requests are sent under `/api/v1`. Legacy unversioned HTTP routes remain
available on the server for compatibility, but new integrations should use the
versioned namespace.
