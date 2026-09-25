"""Structured exceptions for the Remembra Python SDK.

The hierarchy mirrors the TypeScript SDK so a team using both languages sees
the same failure classes:

- :class:`RemembraError` is the base class for everything raised here.
- :class:`ApiError` carries the HTTP status, the machine-readable ``code``, and
  the decoded response ``body`` of a non-2xx response.
- :class:`NetworkError` is a transport failure that never reached the server.
- :class:`RequestTimeout` is a caller abort or a configured timeout.
- :class:`ValidationError` is a locally rejected request that the server would
  have rejected as well.

Messages never embed provider credentials or raw server diagnostics: the SDK
reports the status and code, and the decoded body exactly as received.
"""

from __future__ import annotations

from typing import Any, Mapping

__all__ = [
    "RemembraError",
    "ApiError",
    "NetworkError",
    "RequestTimeout",
    "ValidationError",
]


class RemembraError(Exception):
    """Base class for every error raised by this SDK."""


class ApiError(RemembraError):
    """A non-2xx response from the Remembra API."""

    def __init__(self, status: int, code: str, body: Any = None, message: str | None = None) -> None:
        self.status = status
        self.code = code
        self.body = body
        super().__init__(message or f"Remembra API error {code} (HTTP {status})")

    @classmethod
    def from_response(cls, status: int, body: Any) -> "ApiError":
        """Build an error from a decoded response body.

        A legacy response without a machine-readable code falls back to
        ``HTTP_<status>`` while the raw body is still preserved.
        """
        code = f"HTTP_{status}"
        message: str | None = None
        if isinstance(body, Mapping):
            raw = body.get("code")
            if isinstance(raw, str) and raw:
                code = raw
            detail = body.get("error")
            if isinstance(detail, Mapping):
                # Tolerate a nested `{error: {code, message}}` envelope.
                nested_code = detail.get("code")
                if isinstance(nested_code, str) and nested_code:
                    code = nested_code
                nested_message = detail.get("message")
                if isinstance(nested_message, str) and nested_message:
                    message = nested_message
            else:
                raw_message = body.get("message") or detail
                if isinstance(raw_message, str) and raw_message:
                    message = raw_message
        return cls(status=status, code=code, body=body, message=message)


class NetworkError(RemembraError):
    """The request never reached the server (DNS, connection, or TLS failure)."""


class RequestTimeout(RemembraError):
    """The caller aborted the request or the configured timeout elapsed."""


class ValidationError(RemembraError):
    """A request the SDK rejected locally because the server would reject it."""
