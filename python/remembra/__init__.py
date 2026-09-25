"""Remembra Python SDK.

A dependency-free client for the Remembra memory API, matching the published
``@hilbras/remembra`` TypeScript SDK in paths, authentication, error classes,
retry policy, pagination, and idempotency rules.

    from remembra import Remembra

    client = Remembra("http://127.0.0.1:8787", api_key="...")
    client.store({"type": "fact", "content": "the release train leaves at 09:00"})

The asynchronous client has the same surface:

    from remembra import AsyncRemembra

    async with AsyncRemembra("http://127.0.0.1:8787", api_key="...") as client:
        await client.search({"query": "release train"})
"""

from __future__ import annotations

from .client import (
    DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
    AsyncRemembra,
    Remembra,
)
from .errors import (
    ApiError,
    NetworkError,
    RemembraError,
    RequestTimeout,
    ValidationError,
)
from .transport import AsyncTransport, SyncTransport
from .types import (
    API_PREFIX,
    API_VERSION,
    BATCH_OPERATIONS,
    MAX_BATCH_BYTES,
    MAX_BATCH_ITEMS,
    MAX_BATCH_SEARCH_RESULTS,
)

__version__ = "5.4.0"

__all__ = [
    "Remembra",
    "AsyncRemembra",
    "RemembraError",
    "ApiError",
    "NetworkError",
    "RequestTimeout",
    "ValidationError",
    "SyncTransport",
    "AsyncTransport",
    "API_PREFIX",
    "API_VERSION",
    "MAX_BATCH_ITEMS",
    "MAX_BATCH_BYTES",
    "MAX_BATCH_SEARCH_RESULTS",
    "BATCH_OPERATIONS",
    "MAX_TIMEOUT_SECONDS",
    "DEFAULT_TIMEOUT_SECONDS",
    "__version__",
]
