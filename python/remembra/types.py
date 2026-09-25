"""Typed request and response shapes for the Remembra Python SDK.

Requests are plain dictionaries validated locally before they are sent;
responses are returned as decoded JSON mappings so a caller can read exactly
what the server returned, with typed helpers where a stable field matters.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, MutableMapping, Sequence, TypedDict

from .errors import ValidationError

__all__ = [
    "Memory",
    "BatchResult",
    "BatchOutcome",
    "StoreRequest",
    "SearchRequest",
    "MAX_BATCH_ITEMS",
    "MAX_BATCH_BYTES",
    "MAX_BATCH_SEARCH_RESULTS",
    "BATCH_SEARCH_DEFAULT_LIMIT",
    "BATCH_OPERATIONS",
    "validate_store_request",
    "validate_batch_request",
]

API_VERSION = "v1"
API_PREFIX = "/api/v1"
IDEMPOTENCY_KEY_HEADER = "idempotency-key"
REQUEST_ID_HEADER = "x-remembra-request-id"
MAX_REQUEST_ID_LENGTH = 128
MAX_IDEMPOTENCY_KEY_LENGTH = 128
REQUEST_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._~:+/=-]{0,127}$"

#: Bounded batch limits, identical to the published `@hilbras/remembra` contract.
MAX_BATCH_ITEMS = 100
MAX_BATCH_BYTES = 10 * 1024 * 1024
MAX_BATCH_SEARCH_RESULTS = 1_000
BATCH_SEARCH_DEFAULT_LIMIT = 10

BATCH_OPERATIONS = ("store", "update", "delete", "export", "search")
#: Read-only batch operations reject an idempotency key, exactly like the server.
READ_ONLY_BATCH_OPERATIONS = frozenset({"export", "search"})

Memory = dict[str, Any]
BatchOutcome = dict[str, Any]
BatchResult = dict[str, Any]
StoreRequest = dict[str, Any]
SearchRequest = dict[str, Any]


def validate_request_id(request_id: str) -> str:
    import re

    if not isinstance(request_id, str) or len(request_id) > MAX_REQUEST_ID_LENGTH or not re.match(REQUEST_ID_PATTERN, request_id):
        raise ValidationError("request_id must be 1-128 safe ASCII characters")
    return request_id


def validate_idempotency_key(key: str) -> str:
    import re

    if not isinstance(key, str) or len(key) > MAX_IDEMPOTENCY_KEY_LENGTH or not re.match(IDEMPOTENCY_KEY_PATTERN, key):
        raise ValidationError("idempotency_key must be 1-128 safe ASCII characters")
    return key


def validate_store_request(payload: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    if not isinstance(payload.get("type"), str) or not payload["type"]:
        raise ValidationError("store requires a memory type")
    if not isinstance(payload.get("content"), str) or not payload["content"]:
        raise ValidationError("store requires content")
    # Server-managed identity is never accepted from a client.
    for field in ("id", "tenantId", "organizationId", "userId", "agentId", "embedding"):
        if field in payload:
            raise ValidationError(f"store must not include the server-managed field {field!r}")
    return payload


def validate_batch_request(payload: Any) -> MutableMapping[str, Any]:
    """Reject a batch the server could never accept, before spending a request.

    The server re-validates every batch; this only turns an avoidable round
    trip into a local :class:`ValidationError` and never truncates a batch.
    """
    import json

    if not isinstance(payload, Mapping):
        raise ValidationError("batch request must be an object")
    operation = payload.get("operation")
    if operation not in BATCH_OPERATIONS:
        raise ValidationError(f"batch operation must be one of {', '.join(BATCH_OPERATIONS)}")
    items = payload.get("ids") if operation in ("delete", "export") else payload.get("items")
    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)) or not items:
        raise ValidationError(f"batch {operation} requires a non-empty list")
    if len(items) > MAX_BATCH_ITEMS:
        raise ValidationError(f"batch {operation} accepts at most {MAX_BATCH_ITEMS} items")
    if operation == "search":
        budget = 0
        for item in items:
            limit = item.get("limit") if isinstance(item, Mapping) else None
            budget += limit if isinstance(limit, int) else BATCH_SEARCH_DEFAULT_LIMIT
        if budget > MAX_BATCH_SEARCH_RESULTS:
            raise ValidationError(f"batch search results must not exceed {MAX_BATCH_SEARCH_RESULTS}")
    try:
        encoded = json.dumps(payload, separators=(",", ":"), default=None)
    except (TypeError, ValueError) as error:
        raise ValidationError("batch request must be JSON-serializable") from error
    if len(encoded.encode("utf-8")) > MAX_BATCH_BYTES:
        raise ValidationError(f"batch request exceeds {MAX_BATCH_BYTES} bytes")
    return dict(payload)


def batch_operation(request: Mapping[str, Any]) -> str:
    operation = str(request.get("operation", ""))
    return operation


def iter_outcomes(response: Mapping[str, Any]) -> Iterable[BatchOutcome]:
    results = response.get("results")
    if isinstance(results, Sequence):
        for outcome in results:
            if isinstance(outcome, Mapping):
                yield dict(outcome)


def failed_outcomes(response: Mapping[str, Any]) -> list[BatchOutcome]:
    return [outcome for outcome in iter_outcomes(response) if outcome.get("ok") is False]
