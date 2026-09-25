# Python SDK

Remembra ships a dependency-free Python client, `hilbras-remembra`, with
synchronous and asynchronous surfaces. It targets the same `/api/v1` contract
as the TypeScript SDK, and the repository's own contract tests fail if the two
drift apart.

```bash
pip install hilbras-remembra
```

## Client

```python
from remembra import Remembra

client = Remembra("http://127.0.0.1:8787", api_key="your-key")

client.store({"type": "fact", "content": "the release train leaves at 09:00"})
page = client.search({"query": "release train", "limit": 5})
client.update(page["results"][0]["id"], {"importance": 5})
client.delete(page["results"][0]["id"])
```

The asynchronous client has the same surface and the same policy:

```python
import asyncio
from remembra import AsyncRemembra

async def main() -> None:
    async with AsyncRemembra("http://127.0.0.1:8787", api_key="your-key") as client:
        stored = await client.store({"type": "fact", "content": "deploy window is tuesday 02:00"})
        print(stored["id"])

asyncio.run(main())
```

Both clients take an optional `transport`, which is how the test suite runs
without a server and without installing anything.

## Methods

| Method | Route | Notes |
|---|---|---|
| `capabilities()` | `GET /api/v1/capabilities` | Published contract manifest |
| `store(payload)` | `POST /api/v1/memories` | Rejects server-managed identity fields |
| `get(id)` | `GET /api/v1/memories/{id}` | |
| `update(id, payload)` | `PUT /api/v1/memories/{id}` | Requires at least one field |
| `delete(id)` | `DELETE /api/v1/memories/{id}` | |
| `search(payload, attempts=…)` | `POST /api/v1/search` | Read-only, so retries are allowed |
| `history(id, limit=…)` | `GET /api/v1/memories/{id}/history` | |
| `context(payload, attempts=…)` | `POST /api/v1/context` | Read-only |
| `list(options, attempts=…)` | `GET /api/v1/memories` | Opaque cursor pagination |
| `iter_list(options)` | — | Walks every page once |
| `create_snapshot(payload)` | `POST /api/v1/snapshot` | Server-managed envelope |
| `restore_snapshot(envelope)` | `POST /api/v1/import` | Sends the envelope unchanged |
| `batch(payload, idempotency_key=…)` | `POST /api/v1/memories/batch` | Mutation-only idempotency |

## Guarantees

- **No runtime dependencies.** The client uses the standard library only, so it
  installs and runs anywhere Python 3.9+ does.
- **Writes are never retried automatically.** `attempts` above 1 on a write
  raises `ValidationError`, so a retry can never duplicate a mutation.
- **Bounded inputs.** Timeouts (≤120s), retry attempts (1–3), list and search
  limits, page size, and the batch item/size/aggregate budgets are validated
  before a request is sent. Nothing is truncated for you.
- **Server-managed identity is rejected.** `store` refuses `id`, `tenantId`,
  `organizationId`, `userId`, `agentId`, and `embedding`.
- **Typed errors.** `ApiError` (status, code, decoded body), `NetworkError`,
  `RequestTimeout`, and `ValidationError` all derive from `RemembraError`. A
  legacy response without a machine-readable code falls back to `HTTP_<status>`
  while the raw body is preserved.
- **Request IDs.** Every request carries `x-remembra-request-id`; pass
  `request_id=` to supply your own correlation id.
- **Idempotency parity.** `idempotency_key` is accepted only for batch
  mutations, is bounded to 1–128 safe ASCII characters, and a keyed response
  containing a failed item is rejected rather than treated as replay-safe.

## Errors

```python
from remembra import ApiError, RemembraError, ValidationError

try:
    client.get("missing")
except ApiError as error:
    if error.code == "NOT_FOUND":
        ...
except RemembraError:
    # NetworkError, RequestTimeout, and ValidationError share this base.
    ...
```

## Tests

The SDK ships standard-library tests that need no server and no third-party
package:

```bash
npm run python:test
# or
python3 -m unittest discover -s python/tests -t python
```

`python/tests/test_contract_parity.py` reads `src/api-contract.ts` and asserts
that the namespace, headers, batch limits, operations, and capabilities match,
so the two SDKs cannot drift apart silently.
