"""Webhook receiver example: verify the signature, reject a replay, then act.

The other half of the delivery contract. A receiver must do three things
before trusting a body:

  1. read the raw bytes exactly as sent,
  2. verify ``x-remembra-signature`` with the shared secret, and
  3. reject a delivery id it has already handled.

Skipping step 1 is the classic mistake: re-serializing the JSON changes the
bytes and the signature never matches.

Run:      REMEMBRA_WEBHOOK_SECRET=<hex> python3 examples/webhook-receiver/receiver.py
Then:     REMEMBRA_WEBHOOKS='[{"id":"sub-1","url":"http://127.0.0.1:9099/hook",
            "secret":"<hex>","events":["memory.created"]}]' npx remembra --http
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Mapping

TOLERANCE_SECONDS = 5 * 60
DEFAULT_TTL_SECONDS = 5 * 60
DEFAULT_CAPACITY = 10_000


def verify_signature(secret: bytes, header: str, body: bytes, tolerance: int = TOLERANCE_SECONDS, now: float | None = None) -> str | None:
    """Return ``None`` when the signature is valid, else the failure reason.

    Mirrors the sender: ``t=<unix seconds>,v1=<hex hmac>`` over
    ``<timestamp>.<body>``, compared in constant time.
    """
    parts = {}
    for segment in header.split(","):
        name, _, value = segment.partition("=")
        if not name or not value:
            return "malformed"
        parts[name.strip()] = value.strip()
    timestamp, provided = parts.get("t"), parts.get("v1")
    if not timestamp or not provided or not timestamp.isdigit():
        return "malformed"
    if len(provided) != 64 or any(c not in "0123456789abcdef" for c in provided.lower()):
        return "malformed"
    if abs(int(time.time() if now is None else now) - int(timestamp)) > tolerance:
        return "timestamp"
    expected = hmac.new(secret, f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, provided.lower()):
        return "signature"
    return None


class ReplayGuard:
    """Bounded, TTL-based dedupe. A full guard can accept a replay — alert."""

    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS, capacity: int = DEFAULT_CAPACITY) -> None:
        self.ttl = ttl_seconds
        self.capacity = capacity
        self.seen: dict[str, float] = {}
        self.evictions = 0

    def accept(self, delivery_id: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        for key, expires_at in list(self.seen.items()):
            if expires_at <= now:
                del self.seen[key]
        if delivery_id in self.seen:
            return False
        if len(self.seen) >= self.capacity:
            del self.seen[next(iter(self.seen))]
            self.evictions += 1
        self.seen[delivery_id] = now + self.ttl
        return True


def handle_delivery(headers: Mapping[str, str], raw_body: bytes, secret: bytes, guard: ReplayGuard) -> tuple[int, Any]:
    """Return ``(status, body)``; 204 means the delivery was accepted."""
    signature = headers.get("x-remembra-signature")
    delivery_id = headers.get("x-remembra-delivery")
    event_type = headers.get("x-rembrella-event") or headers.get("x-remembra-event")
    if not signature or not delivery_id:
        return 400, {"error": "missing signature or delivery id"}
    reason = verify_signature(secret, signature, raw_body)
    if reason is not None:
        # "timestamp" is outside the window; "signature" means the body was
        # altered or the secret is wrong. Neither is trustworthy.
        return 401, {"error": f"signature {reason}"}
    if not guard.accept(delivery_id):
        return 409, {"error": "replayed delivery"}
    event = json.loads(raw_body)
    if event_type and event.get("type") != event_type:
        return 400, {"error": "event type header does not match the body"}
    return 204, event


def build_handler(secret: bytes, guard: ReplayGuard):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            length = int(self.headers.get("content-length") or 0)
            raw_body = self.rfile.read(length)
            status, body = handle_delivery(self.headers, raw_body, secret, guard)
            if status == 204:
                self.send_response(204)
                self.end_headers()
                print(f"delivered {body['type']} {body['id']}")
                return
            # A 4xx tells the sender the delivery is permanent: it stops retrying.
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_: Any) -> None:  # keep the console readable
            return

    return Handler


if __name__ == "__main__":  # pragma: no cover - manual run
    secret_hex = os.environ.get("REMEMBRA_WEBHOOK_SECRET", "")
    if len(secret_hex) < 64:
        raise SystemExit("set REMEMBRA_WEBHOOK_SECRET to at least 32 bytes of hex")
    port = int(os.environ.get("WEBHOOK_PORT", "9099"))
    guard = ReplayGuard()
    server = HTTPServer(("127.0.0.1", port), build_handler(bytes.fromhex(secret_hex), guard))
    print(f"webhook receiver listening on http://127.0.0.1:{port}/hook")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if guard.evictions:
            print(f"replay guard evicted {guard.evictions} entries")
