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

const context = await memory.context({
  query: "PostgreSQL",
  maxTokens: 1200,
});
// context.tokenCount <= 1200; context.memories is visibility-filtered.
```

## Client options

- `endpoint` — required `http://` or `https://` base URL. An existing
  `/api/v1` suffix is accepted and normalized.
- `apiKey` — optional key sent as `x-api-key`.
- `fetch` — injectable fetch implementation for tests or custom runtimes.
- `headers` — additional headers sent with every request.
- `timeoutMs` — optional per-request timeout, bounded to 1–120 seconds; caller aborts remain distinct.
- `requestId` — optional bounded correlation ID; the SDK generates one when omitted and sends it as `X-Remembra-Request-Id`.
- `idempotencyKey` — optional 1–128 character key for replay-safe batch mutations; sent as `Idempotency-Key`.
- `retry` — opt-in bounded retries for GET/HEAD reads only (`attempts` 1–3, bounded backoff); write requests reject retry configuration.

The SDK sends API credentials only. It does not accept or synthesize trusted
agent or tenant identity; both contexts remain server-side. Server-managed
`owner`/`access`, agent-attribution, tenant/organization/project/user fields,
and tenant-bearing headers are rejected before a request is sent. Ordinary
provenance IDs are audit metadata and do not authenticate a caller. The V5
opaque tenant contract is available from `@hilbras/remembra/tenant`.

## Methods

- `capabilities()` — fetch the bounded authenticated v1 capability manifest
- `store(input)`
- `search(params)`
- `context({ query, scope, maxTokens })` — deterministic token-bounded context (V5)
- `list(params)` — supports legacy `offset` pagination or stable opaque `cursor` pagination (do not combine them)
- `get(id)`
- `update(id, patch)`
- `forget(id)`
- `digest(input)`
- `maintain()`
- `history(id, { limit })`
- `related(id, ids, { action, kind })`
- `archive(id)` / `revive(id)`
- `batch(request)` — SDK-friendly store/update/delete/export/search input types
  (`LegacyBatchRequest` remains a deprecated compile-time overload frozen to the
  four pre-V5.4 operations; server-managed identity fields are still rejected
  at runtime)

### Read-only batch search

Batch search accepts 1–100 ordinary search option objects and preserves input
order:

```ts
const searches = await memory.batch({
  operation: "search",
  items: [
    { query: "queue backend", limit: 5 },
    { query: "database", limit: 5 },
  ],
});
```

Each successful outcome contains the same `text`, `results`, and optional
`explanations` as `search()`, without internal embedding vectors. The server
fans out through the authorized single-search path with touch and decay
disabled, rechecking host authorization for each item and stopping when the
HTTP caller disconnects. The SDK validates the returned summary, order,
outcome key sets, sanitized failures, and read-only execution metadata before
resolving.

Batch search accepts at most 100 items and 1,000 aggregate requested results;
each search retains the normal 1–50 result limit. The request and serialized
response are each limited to 10 MiB, with response bytes accounted
incrementally. `Idempotency-Key` is rejected because it is a mutation-only
header. Batch search uses `POST`; the SDK's opt-in retry option remains limited
to `GET`/`HEAD`, so configure retries on single-search calls rather than
assuming automatic batch-search retries. Public batch embedding is not exposed.

### Replay-safe batch mutations

Pass `idempotencyKey` as the final request argument to `batch()` for `store`,
`update`, or `delete`:

```ts
const result = await memory.batch(
  { operation: "store", items: [{ type: "fact", content: "Redis is the queue" }] },
  { idempotencyKey: "import-2026-09-25-001" },
);
```

The first response reports `execution.idempotency: "stored"`. Repeating the
same authenticated scope and canonical request returns the original response
with `"replayed"` and does not write again. Reusing a key for a different body
returns `CONFLICT`; a claim left in progress fails closed until the host
verifies and explicitly invalidates the ledger. Keys supplied through the
final `idempotencyKey` argument and through request headers follow the same
response validation; a keyed response containing any failed item is rejected as
invalid. Ambiguous storage/provider failures are not finalized as replayable
responses. An all-deterministic failed batch releases its reservation, but the
key stays bound to that operation: a different operation under the same key
returns `CONFLICT` and the identical operation may be retried. A partially
successful or ambiguous batch keeps its claim. The SDK never retries unsafe
writes automatically. Keyed requests are limited to 256 KiB.

`client.batch()` also applies the published limits before sending: more than 100
items, a search aggregate above 1,000 results, a body above 10 MiB, or a body
that cannot be serialized throws a `TypeError` without a request. The service
re-validates every batch, and nothing is truncated for you.

All methods return typed decoded JSON. Non-2xx responses throw
`RemembraApiError`, which exposes `status`, machine-readable `code`, and the
decoded response `body`. Unexpected transport failures throw
`RemembraNetworkError`; caller aborts and configured timeouts remain distinct.
If a legacy-compatible response has no machine-readable `code`, the SDK uses
`HTTP_<status>` as a fallback while retaining the raw body.

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

Requests are sent under `/api/v1`. The shared contract also exposes
`memory.apiVersion` and `memory.capabilities()`; the response is bounded and
content-free. Legacy unversioned HTTP routes remain available on the server
for compatibility, but new integrations should use the versioned namespace. A
future breaking release will use a separately documented major namespace.
