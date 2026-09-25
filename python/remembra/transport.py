"""HTTP transports for the Remembra Python SDK.

The SDK has no runtime dependencies. The synchronous transport uses
:mod:`urllib.request` from the standard library, and the asynchronous client
reuses it through a worker thread so both clients share one code path, one
timeout policy, and one set of failure classes. Hosts and tests can inject any
callable with the same signature.
"""

from __future__ import annotations

import json
import socket
import ssl
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping, Protocol

from .errors import ApiError, NetworkError, RequestTimeout

__all__ = ["Response", "SyncTransport", "AsyncTransport", "Transport"]

DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_TIMEOUT_SECONDS = 120.0
MAX_RESPONSE_BYTES = 32 * 1024 * 1024


class Response(Protocol):
    """The minimal response contract a transport must return."""

    status: int
    body: bytes
    headers: Mapping[str, str]


class SyncResponse:
    __slots__ = ("status", "body", "headers")

    def __init__(self, status: int, body: bytes, headers: Mapping[str, str] | None = None) -> None:
        self.status = status
        self.body = body
        self.headers = dict(headers or {})


class Transport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> SyncResponse: ...


class SyncTransport:
    """Standard-library HTTP transport with bounded reads and timeouts."""

    def __init__(self, opener: Any | None = None) -> None:
        # An opener is injectable for hosts that need a proxy or a custom CA.
        self._opener = opener or urllib.request.build_opener()

    def request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> SyncResponse:
        request = urllib.request.Request(url=url, data=body, headers=dict(headers), method=method)
        try:
            with self._opener.open(request, timeout=timeout) as response:
                return SyncResponse(response.status, _bounded_read(response), dict(response.headers.items()))
        except urllib.error.HTTPError as error:  # a 4xx/5xx still carries a body
            return SyncResponse(error.code, _bounded_read(error), dict(error.headers.items() if error.headers else {}))
        except socket.timeout as error:
            raise RequestTimeout("the request timed out") from error
        except urllib.error.URLError as error:
            reason = error.reason
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise RequestTimeout("the request timed out") from error
            raise NetworkError(f"the request could not reach the server: {reason}") from error
        except (TimeoutError, ConnectionError, ssl.SSLError, OSError) as error:
            raise NetworkError(f"the request could not reach the server: {error}") from error


def _bounded_read(response: Any) -> bytes:
    """Read at most the response cap so a hostile server cannot exhaust memory."""
    body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise NetworkError("the response exceeded the supported size")
    return body


class AsyncTransport:
    """Asynchronous facade over :class:`SyncTransport`.

    The blocking call runs in a worker thread, so the event loop is never
    blocked and cancellation stops the awaited result. Timeouts and failures
    keep the same classification as the synchronous client.
    """

    def __init__(self, transport: Transport | None = None) -> None:
        self._transport = transport or SyncTransport()

    async def request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> SyncResponse:
        import asyncio

        call = self._transport.request
        return await asyncio.to_thread(call, method, url, dict(headers), body, timeout)


def decode_body(response: SyncResponse) -> Any:
    if not response.body:
        return None
    try:
        return json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        # A non-JSON error body is preserved as text rather than raising.
        return response.body.decode("utf-8", errors="replace")


def raise_for_status(response: SyncResponse) -> Any:
    """Return the decoded body for 2xx, otherwise raise :class:`ApiError`."""
    body = decode_body(response)
    if 200 <= response.status < 300:
        return body
    raise ApiError.from_response(response.status, body)


TransportCallable = Callable[..., SyncResponse]
