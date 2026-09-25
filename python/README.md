"""Remembra Python client.

A dependency-free client for the [Remembra](https://github.com/Hilbras/Remembra)
memory API. It mirrors the published `@hilbras/remembra` TypeScript SDK in paths,
authentication, error classes, retry policy, pagination, and idempotency rules.

## Install

```bash
pip install hilbras-remembra
```

## Use

```python
from remembra import Remembra

client = Remembra("http://127.0.0.1:8787", api_key="your-key")

client.store({"type": "fact", "content": "the release train leaves at 09:00"})
results = client.search({"query": "release train", "limit": 5})
for page in client.iter_list({"limit": 50}):
    ...
```

The asynchronous client has the same surface and the same policy:

```python
import asyncio
from remembra import AsyncRemembra

async def main() -> None:
    async with AsyncRemembra("http://127.0.0.1:8787", api_key="your-key") as client:
        await client.store({"type": "fact", "content": "deploy window is tuesday 02:00"})

asyncio.run(main())
```

## Guarantees

- **No runtime dependencies.** The client uses the standard library only.
- **Writes are never retried automatically.** Retries apply to read-only
  requests only, so a retry can never duplicate a mutation.
- **Bounded everything.** Timeouts, retry attempts, pagination limits, search
  limits, and batch size/count budgets are validated before a request is sent.
- **Server-managed identity is never sent.** `store` rejects `id`, `tenantId`,
  `organizationId`, `userId`, `agentId`, and `embedding` fields.
- **Typed errors.** `ApiError` (status, code, body), `NetworkError`,
  `RequestTimeout`, and `ValidationError` all derive from `RemembraError`.
- **Idempotency parity.** `Idempotency-Key` is accepted only for batch
  mutations, and a keyed response containing a failed item is rejected.
