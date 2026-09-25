"""Remembra Python client (synchronous and asynchronous).

The surface mirrors the published TypeScript SDK: the same ``/api/v1`` paths,
the same ``x-api-key`` authentication, the same typed error classes, the same
read-only retry policy, the same bounded timeouts and request IDs, the same
opaque cursor pagination, and the same ``Idempotency-Key`` rules for batch
mutations. Writes are never retried automatically, so a retry can never
duplicate a mutation.

Both clients accept an injected transport, which is how the test suite runs
without a server and without any third-party dependency.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import uuid
from typing import Any, Iterable, Iterator, Mapping, MutableMapping, Sequence

from .errors import ApiError, NetworkError, RemembraError, RequestTimeout, ValidationError
from .transport import (
    AsyncTransport,
    DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
    SyncTransport,
    raise_for_status,
)
from .types import (
    API_PREFIX,
    IDEMPOTENCY_KEY_HEADER,
    READ_ONLY_BATCH_OPERATIONS,
    REQUEST_ID_HEADER,
    batch_operation,
    failed_outcomes,
    validate_batch_request,
    validate_idempotency_key,
    validate_request_id,
    validate_store_request,
)

__all__ = ["Remembra", "AsyncRemembra", "MAX_TIMEOUT_SECONDS", "DEFAULT_TIMEOUT_SECONDS"]

RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
MAX_RETRY_ATTEMPTS = 3
MIN_TIMEOUT_SECONDS = 0.001
USER_AGENT = "remembra-python/5.4"


class _BaseRemembra:
    """Shared request construction, validation, and policy."""

    def __init__(
        self,
        endpoint: str,
        api_key: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> None:
        if not isinstance(endpoint, str) or not endpoint.startswith(("http://", "https://")):
            raise ValidationError("endpoint must be an absolute http(s) URL")
        if timeout is not None and (not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > MAX_TIMEOUT_SECONDS):
            raise ValidationError(f"timeout must be greater than 0 and at most {MAX_TIMEOUT_SECONDS} seconds")
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._headers = dict(headers or {})
        self._timeout = float(timeout) if timeout is not None else DEFAULT_TIMEOUT_SECONDS

    @property
    def endpoint(self) -> str:
        return self._endpoint

    @property
    def api_version(self) -> str:
        from .types import API_VERSION

        return API_VERSION

    def _path(self, path: str, query: Mapping[str, Any] | None = None) -> str:
        from urllib.parse import urlencode

        url = f"{self._endpoint}{API_PREFIX}{path}"
        if query:
            pairs = [(key, value) for key, value in query.items() if value is not None]
            if pairs:
                url = f"{url}?{urlencode(pairs)}"
        return url

    def _build_headers(
        self,
        method: str,
        body: bytes | None,
        request_id: str | None,
        idempotency_key: str | None,
    ) -> dict[str, str]:
        headers = {"accept": "application/json", "user-agent": USER_AGENT}
        if body is not None:
            headers["content-type"] = "application/json"
        if self._api_key:
            headers["x-api-key"] = self._api_key
        headers.update(self._headers)
        headers[REQUEST_ID_HEADER] = validate_request_id(request_id) if request_id else uuid.uuid4().hex
        if idempotency_key is not None:
            if method != "POST":
                raise ValidationError("idempotency_key is only supported for batch mutations")
            headers[IDEMPOTENCY_KEY_HEADER] = validate_idempotency_key(idempotency_key)
        return headers

    def _encode(self, payload: Any) -> bytes | None:
        if payload is None:
            return None
        try:
            return json.dumps(payload, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise ValidationError("request body must be JSON-serializable") from error

    def _validate_batch(self, payload: Any, idempotency_key: str | None) -> MutableMapping[str, Any]:
        request = validate_batch_request(payload)
        if idempotency_key is not None and batch_operation(request) in READ_ONLY_BATCH_OPERATIONS:
            raise ValidationError("idempotency_key is only supported for batch mutations")
        if idempotency_key is not None and len(json.dumps(request).encode("utf-8")) > 256 * 1024:
            raise ValidationError("idempotent batch requests are limited to 262144 bytes")
        return request

    @staticmethod
    def _check_retry(method: str, attempts: int) -> None:
        if method not in ("GET", "HEAD") and attempts > 1:
            raise ValidationError("retry is only supported for read-only requests")
        if not isinstance(attempts, int) or attempts < 1 or attempts > MAX_RETRY_ATTEMPTS:
            raise ValidationError(f"retry attempts must be an integer between 1 and {MAX_RETRY_ATTEMPTS}")

    @staticmethod
    def _retryable(error: RemembraError) -> bool:
        if isinstance(error, (NetworkError, RequestTimeout)):
            return True
        return isinstance(error, ApiError) and error.status in RETRYABLE_STATUS

    def _validate_search(self, payload: Any) -> MutableMapping[str, Any]:
        if not isinstance(payload, Mapping):
            raise ValidationError("search requires an object")
        request = dict(payload)
        limit = request.get("limit")
        if limit is not None and (not isinstance(limit, int) or limit < 1 or limit > 50):
            raise ValidationError("search limit must be between 1 and 50")
        return request

    # -- request builders shared by both clients ---------------------------

    def _memory_write(self, path: str, method: str, payload: Any, request_id: str | None = None) -> tuple[str, str, bytes | None, dict[str, str]]:
        body = self._encode(validate_store_request(dict(payload)) if method == "POST" and path.endswith("/memories") else payload)
        return method, path, body, self._build_headers(method, body, request_id, None)

    def _list_query(self, options: Mapping[str, Any]) -> dict[str, Any]:
        query: dict[str, Any] = {}
        for key in ("scope", "type", "cursor", "limit"):
            if options.get(key) is not None:
                query[key] = options[key]
        for key in ("includeArchived", "includeQuarantined", "includeExpired", "includeFuture", "offset"):
            if options.get(key) is not None:
                query[key] = "true" if options[key] is True else options[key]
        if query.get("cursor") and query.get("offset") is not None:
            raise ValidationError("cursor and offset cannot be combined")
        limit = query.get("limit")
        if limit is not None and (not isinstance(limit, int) or limit < 1 or limit > 200):
            raise ValidationError("list limit must be between 1 and 200")
        return query


class Remembra(_BaseRemembra):
    """Synchronous client."""

    def __init__(self, endpoint: str, api_key: str | None = None, headers: Mapping[str, str] | None = None,
                 timeout: float | None = None, transport: Any | None = None) -> None:
        super().__init__(endpoint, api_key=api_key, headers=headers, timeout=timeout)
        self._transport = transport or SyncTransport()

    def _send(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        attempts: int = 1,
        base_delay: float = 0.1,
        max_delay: float = 1.0,
    ) -> Any:
        self._check_retry(method, attempts)
        if not isinstance(base_delay, (int, float)) or base_delay < 0 or base_delay > 1.0:
            raise ValidationError("retry base delay must be between 0 and 1 second")
        if not isinstance(max_delay, (int, float)) or max_delay < base_delay or max_delay > 5.0:
            raise ValidationError("retry max delay must be between the base delay and 5 seconds")
        last: RemembraError | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = self._transport.request(method, url, headers, body, self._timeout)
                return raise_for_status(response)
            except RemembraError as error:
                last = error
                if attempt >= attempts or not self._retryable(error):
                    raise
                time.sleep(min(max_delay, base_delay * (2 ** (attempt - 1))))
        raise last or NetworkError("the request failed")

    # -- capabilities and memory -------------------------------------------

    def capabilities(self, request_id: str | None = None) -> Any:
        headers = self._build_headers("GET", None, request_id, None)
        return self._send("GET", self._path("/capabilities"), headers, None)

    def store(self, payload: Mapping[str, Any], request_id: str | None = None, attempts: int = 1) -> Any:
        self._check_retry("POST", attempts)
        body = self._encode(validate_store_request(dict(payload)))
        headers = self._build_headers("POST", body, request_id, None)
        return self._send("POST", self._path("/memories"), headers, body)

    def get(self, memory_id: str, request_id: str | None = None) -> Any:
        headers = self._build_headers("GET", None, request_id, None)
        return self._send("GET", self._path(f"/memories/{memory_id}"), headers, None)

    def update(self, memory_id: str, payload: Mapping[str, Any], request_id: str | None = None, attempts: int = 1) -> Any:
        self._check_retry("PUT", attempts)
        if not isinstance(payload, Mapping) or not payload:
            raise ValidationError("update requires at least one field")
        body = self._encode(dict(payload))
        headers = self._build_headers("PUT", body, request_id, None)
        return self._send("PUT", self._path(f"/memories/{memory_id}"), headers, body)

    def delete(self, memory_id: str, request_id: str | None = None, attempts: int = 1) -> Any:
        self._check_retry("DELETE", attempts)
        headers = self._build_headers("DELETE", None, request_id, None)
        return self._send("DELETE", self._path(f"/memories/{memory_id}"), headers, None)

    def search(self, payload: Mapping[str, Any] | None = None, attempts: int = 1, request_id: str | None = None,
               base_delay: float = 0.1, max_delay: float = 1.0) -> Any:
        query = self._validate_search(payload or {})
        body = self._encode(query) if query else None
        headers = self._build_headers("POST", body, request_id, None)
        return self._send("POST", self._path("/search"), headers, body, attempts=attempts, base_delay=base_delay, max_delay=max_delay)

    def history(self, memory_id: str, limit: int | None = None, request_id: str | None = None) -> Any:
        query = {"limit": limit} if limit is not None else None
        headers = self._build_headers("GET", None, request_id, None)
        return self._send("GET", self._path(f"/memories/{memory_id}/history", query), headers, None)

    def context(self, payload: Mapping[str, Any] | None = None, attempts: int = 1, request_id: str | None = None,
                base_delay: float = 0.1, max_delay: float = 1.0) -> Any:
        body = self._encode(dict(payload or {})) if payload else None
        headers = self._build_headers("POST", body, request_id, None)
        return self._send("POST", self._path("/context"), headers, body, attempts=attempts, base_delay=base_delay, max_delay=max_delay)

    def list(self, options: Mapping[str, Any] | None = None, attempts: int = 1, request_id: str | None = None,
             base_delay: float = 0.1, max_delay: float = 1.0) -> Any:
        query = self._list_query(options or {})
        headers = self._build_headers("GET", None, request_id, None)
        return self._send("GET", self._path("/memories", query), headers, None, attempts=attempts, base_delay=base_delay, max_delay=max_delay)

    def iter_list(self, options: Mapping[str, Any] | None = None, request_id: str | None = None) -> Iterator[Any]:
        """Page through memories with the server's opaque cursor."""
        state = dict(options or {})
        while True:
            page = self.list(state, request_id=request_id)
            yield page
            cursor = (page.get("next_cursor") if isinstance(page, Mapping) else None) or (
                page.get("cursor") if isinstance(page, Mapping) else None
            )
            if not cursor:
                return
            state = {**state, "cursor": cursor}
            state.pop("offset", None)

    # -- snapshots ----------------------------------------------------------

    def create_snapshot(self, payload: Mapping[str, Any] | None = None, request_id: str | None = None) -> Any:
        body = self._encode(dict(payload)) if payload else None
        headers = self._build_headers("POST", body, request_id, None)
        return self._send("POST", self._path("/snapshot"), headers, body)

    def restore_snapshot(self, snapshot: Any, request_id: str | None = None) -> Any:
        body = self._encode(snapshot)
        headers = self._build_headers("POST", body, request_id, None)
        return self._send("POST", self._path("/import"), headers, body)

    # -- batch --------------------------------------------------------------

    def batch(self, payload: Mapping[str, Any], idempotency_key: str | None = None, request_id: str | None = None,
              attempts: int = 1) -> Any:
        self._check_retry("POST", attempts)
        request = self._validate_batch(payload, idempotency_key)
        body = self._encode(request)
        headers = self._build_headers("POST", body, request_id, idempotency_key)
        response = self._send("POST", self._path("/memories/batch"), headers, body)
        if idempotency_key is not None:
            failures = failed_outcomes(response) if isinstance(response, Mapping) else []
            if failures:
                raise ValidationError("a keyed batch response must not contain failed items")
        return response


class AsyncRemembra(_BaseRemembra):
    """Asynchronous client with the same surface and policy as :class:`Remembra`."""

    def __init__(self, endpoint: str, api_key: str | None = None, headers: Mapping[str, str] | None = None,
                 timeout: float | None = None, transport: Any | None = None) -> None:
        super().__init__(endpoint, api_key=api_key, headers=headers, timeout=timeout)
        if transport is None:
            self._transport: Any = AsyncTransport()
        elif inspect.iscoroutinefunction(getattr(transport, "request", None)):
            self._transport = transport
        else:
            # A synchronous injected transport is reused through a worker
            # thread so both clients share one code path and failure model.
            self._transport = AsyncTransport(transport)

    async def __aenter__(self) -> "AsyncRemembra":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def _send(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        attempts: int = 1,
        base_delay: float = 0.1,
        max_delay: float = 1.0,
    ) -> Any:
        self._check_retry(method, attempts)
        if not isinstance(base_delay, (int, float)) or base_delay < 0 or base_delay > 1.0:
            raise ValidationError("retry base delay must be between 0 and 1 second")
        if not isinstance(max_delay, (int, float)) or max_delay < base_delay or max_delay > 5.0:
            raise ValidationError("retry max delay must be between the base delay and 5 seconds")
        last: RemembraError | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = await self._transport.request(method, url, headers, body, self._timeout)
                return raise_for_status(response)
            except asyncio.CancelledError:
                raise
            except RemembraError as error:
                last = error
                if attempt >= attempts or not self._retryable(error):
                    raise
                await asyncio.sleep(min(max_delay, base_delay * (2 ** (attempt - 1))))
        raise last or NetworkError("the request failed")

    async def capabilities(self, request_id: str | None = None) -> Any:
        headers = self._build_headers("GET", None, request_id, None)
        return await self._send("GET", self._path("/capabilities"), headers, None)

    async def store(self, payload: Mapping[str, Any], request_id: str | None = None, attempts: int = 1) -> Any:
        self._check_retry("POST", attempts)
        body = self._encode(validate_store_request(dict(payload)))
        headers = self._build_headers("POST", body, request_id, None)
        return await self._send("POST", self._path("/memories"), headers, body)

    async def get(self, memory_id: str, request_id: str | None = None) -> Any:
        headers = self._build_headers("GET", None, request_id, None)
        return await self._send("GET", self._path(f"/memories/{memory_id}"), headers, None)

    async def update(self, memory_id: str, payload: Mapping[str, Any], request_id: str | None = None, attempts: int = 1) -> Any:
        self._check_retry("PUT", attempts)
        if not isinstance(payload, Mapping) or not payload:
            raise ValidationError("update requires at least one field")
        body = self._encode(dict(payload))
        headers = self._build_headers("PUT", body, request_id, None)
        return await self._send("PUT", self._path(f"/memories/{memory_id}"), headers, body)

    async def delete(self, memory_id: str, request_id: str | None = None, attempts: int = 1) -> Any:
        self._check_retry("DELETE", attempts)
        headers = self._build_headers("DELETE", None, request_id, None)
        return await self._send("DELETE", self._path(f"/memories/{memory_id}"), headers, None)

    async def search(self, payload: Mapping[str, Any] | None = None, attempts: int = 1, request_id: str | None = None,
                     base_delay: float = 0.1, max_delay: float = 1.0) -> Any:
        query = self._validate_search(payload or {})
        body = self._encode(query) if query else None
        headers = self._build_headers("POST", body, request_id, None)
        return await self._send("POST", self._path("/search"), headers, body, attempts=attempts, base_delay=base_delay, max_delay=max_delay)

    async def history(self, memory_id: str, limit: int | None = None, request_id: str | None = None) -> Any:
        query = {"limit": limit} if limit is not None else None
        headers = self._build_headers("GET", None, request_id, None)
        return await self._send("GET", self._path(f"/memories/{memory_id}/history", query), headers, None)

    async def context(self, payload: Mapping[str, Any] | None = None, attempts: int = 1, request_id: str | None = None,
                      base_delay: float = 0.1, max_delay: float = 1.0) -> Any:
        body = self._encode(dict(payload or {})) if payload else None
        headers = self._build_headers("POST", body, request_id, None)
        return await self._send("POST", self._path("/context"), headers, body, attempts=attempts, base_delay=base_delay, max_delay=max_delay)

    async def list(self, options: Mapping[str, Any] | None = None, attempts: int = 1, request_id: str | None = None,
                   base_delay: float = 0.1, max_delay: float = 1.0) -> Any:
        query = self._list_query(options or {})
        headers = self._build_headers("GET", None, request_id, None)
        return await self._send("GET", self._path("/memories", query), headers, None, attempts=attempts, base_delay=base_delay, max_delay=max_delay)

    async def create_snapshot(self, payload: Mapping[str, Any] | None = None, request_id: str | None = None) -> Any:
        body = self._encode(dict(payload)) if payload else None
        headers = self._build_headers("POST", body, request_id, None)
        return await self._send("POST", self._path("/snapshot"), headers, body)

    async def restore_snapshot(self, snapshot: Any, request_id: str | None = None) -> Any:
        body = self._encode(snapshot)
        headers = self._build_headers("POST", body, request_id, None)
        return await self._send("POST", self._path("/import"), headers, body)

    async def batch(self, payload: Mapping[str, Any], idempotency_key: str | None = None, request_id: str | None = None,
                    attempts: int = 1) -> Any:
        self._check_retry("POST", attempts)
        request = self._validate_batch(payload, idempotency_key)
        body = self._encode(request)
        headers = self._build_headers("POST", body, request_id, idempotency_key)
        response = await self._send("POST", self._path("/memories/batch"), headers, body)
        if idempotency_key is not None and isinstance(response, Mapping) and failed_outcomes(response):
            raise ValidationError("a keyed batch response must not contain failed items")
        return response


def batch_outcomes(response: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    results: Sequence[Any] = response.get("results") or []
    return [outcome for outcome in results if isinstance(outcome, Mapping)]
