"""Tests for the webhook receiver example.

The example is the receiver half of the delivery contract, so these tests
assert the three things a receiver must do before trusting a body: verify the
signature over the exact bytes, reject a replay, and refuse a header that
disagrees with the signed body.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import os
import pathlib
import sys
import time
import unittest

# The example lives in the repository-level examples/ directory, not inside python/.
EXAMPLE = pathlib.Path(__file__).resolve().parents[2] / "examples" / "webhook-receiver" / "receiver.py"
SECRET = bytes.fromhex("7a" * 32)


def load_example():
    spec = importlib.util.spec_from_file_location("webhook_receiver_example", EXAMPLE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sign(secret: bytes, body: bytes, at: float | None = None) -> str:
    seconds = int(time.time() if at is None else at)
    digest = hmac.new(secret, f"{seconds}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={seconds},v1={digest}"


class ReceiverExampleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.example = load_example()
        self.guard = self.example.ReplayGuard()
        self.body = b'{"format":"remembra-webhook","version":1,"id":"e1","type":"memory.created","createdAt":"2026-01-01T00:00:00.000Z","data":{}}'

    def headers(self, signature: str, delivery_id: str = "d1", event_type: str = "memory.created") -> dict[str, str]:
        return {
            "x-remembra-signature": signature,
            "x-remembra-delivery": delivery_id,
            "x-remembra-event": event_type,
        }

    def test_a_valid_delivery_is_accepted_then_refused_as_a_replay(self) -> None:
        status, event = self.example.handle_delivery(self.headers(sign(SECRET, self.body)), self.body, SECRET, self.guard)
        self.assertEqual(status, 204)
        self.assertEqual(event["type"], "memory.created")

        status, body = self.example.handle_delivery(self.headers(sign(SECRET, self.body)), self.body, SECRET, self.guard)
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "replayed delivery")

    def test_tampering_expiry_and_mismatched_headers_are_refused(self) -> None:
        # A body altered after signing does not verify.
        status, body = self.example.handle_delivery(self.headers(sign(SECRET, self.body)), self.body + b" ", SECRET, self.guard)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "signature signature")

        # Correctly signed but outside the window.
        status, body = self.example.handle_delivery(
            self.headers(sign(SECRET, self.body, time.time() - 3600), "d-stale"), self.body, SECRET, self.guard
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "signature timestamp")

        # A header that disagrees with the signed body.
        status, body = self.example.handle_delivery(
            self.headers(sign(SECRET, self.body), "d-mismatch", "memory.deleted"), self.body, SECRET, self.guard
        )
        self.assertEqual(status, 400)
        self.assertIn("does not match", body["error"])

        # Missing headers are refused before any parsing.
        self.assertEqual(self.example.handle_delivery({}, self.body, SECRET, self.guard)[0], 400)
        self.assertEqual(self.example.handle_delivery({"x-remembra-delivery": "d"}, self.body, SECRET, self.guard)[0], 400)

    def test_a_body_signed_with_another_secret_is_refused(self) -> None:
        status, _body = self.example.handle_delivery(self.headers(sign(os.urandom(32), self.body), "d-foreign"), self.body, SECRET, self.guard)
        self.assertEqual(status, 401)

    def test_the_guard_is_bounded_and_reports_evictions(self) -> None:
        guard = self.example.ReplayGuard(ttl_seconds=1, capacity=2)
        now = time.time()
        self.assertTrue(guard.accept("a", now))
        self.assertTrue(guard.accept("b", now))
        self.assertTrue(guard.accept("c", now))
        self.assertEqual(guard.evictions, 1, "a full guard must report rather than hide the risk")
        self.assertFalse(guard.accept("c", now), "the newest entry is still remembered")
        self.assertTrue(guard.accept("c", now + 2), "outside the ttl it is no longer a replay")

    def test_malformed_signature_headers_are_refused(self) -> None:
        for header in ["", "garbage", "t=abc,v1=zz", "v1=deadbeef", "t=1,v1=short"]:
            self.assertIsNotNone(self.example.verify_signature(SECRET, header, self.body), header)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
