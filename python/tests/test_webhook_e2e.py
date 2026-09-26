"""End-to-end delivery: the real Remembra server to the real receiver example.

This is the one test that proves the whole chain works against the shipped
artifact rather than a double: the Remembra CLI queues an event, the Python
receiver example verifies the signature, the replay guard accepts it once, and
a second delivery of the same id is refused.

It starts a loopback receiver and the Remembra CLI, so it needs a built
`dist/`; it is skipped when that is absent.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO = pathlib.Path(__file__).resolve().parents[2]
RECEIVER = REPO / "examples" / "webhook-receiver" / "receiver.py"
CLI = REPO / "dist" / "index.js"
SECRET = bytes.fromhex("5c" * 32)


def load_example():
    spec = importlib.util.spec_from_file_location("webhook_receiver_e2e", RECEIVER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CaptureHandler(BaseHTTPRequestHandler):
    """Applies the example's real handler logic and records the verdict."""

    example = None
    guard = None
    seen: list[tuple[int, dict]] = []

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length)
        status, payload = type(self).example.handle_delivery(self.headers, body, SECRET, type(self).guard)
        type(self).seen.append((status, payload if status == 204 else payload))
        if status == 204:
            self.send_response(204)
            self.end_headers()
            return
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_: object) -> None:
        return


@unittest.skipUnless(CLI.is_file(), "requires a built dist/index.js")
class EndToEndDeliveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        import tempfile

        cls.example = load_example()
        cls.guard = cls.example.ReplayGuard()
        CaptureHandler.example = cls.example
        CaptureHandler.guard = cls.guard
        CaptureHandler.seen = []
        cls.server = HTTPServer(("127.0.0.1", 0), CaptureHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/hook"
        cls.temp = tempfile.TemporaryDirectory(prefix="remembra-webhook-e2e-")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def run_cli(self, args: list[str], extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        env = {
            **os.environ,
            "REMEMBRA_HOME": self.temp.name,
            "REMEMBRA_TENANT_MODE": "legacy",
            "REMEMBRA_EMBEDDINGS": "none",
            "REMEMBRA_LLM": "ollama",
            **(extra_env or {}),
        }
        node = shutil.which("node")
        assert node is not None, "node is required for the end-to-end delivery test"
        return subprocess.run([node, str(CLI), *args], capture_output=True, text=True, timeout=120, env=env)

    def test_a_real_export_delivers_a_verifiable_event_once(self) -> None:
        webhooks = json.dumps(
            [{"id": "sub-1", "url": self.url, "secret": SECRET.hex(), "events": ["snapshot.created"]}]
        )
        result = self.run_cli(["export", os.path.join(self.temp.name, "snapshot.json")], {"REMEMBRA_WEBHOOKS": webhooks})
        self.assertEqual(result.returncode, 0, result.stderr)
        # The receiver example accepted the delivery with its own signature check.
        self.assertEqual(len(CaptureHandler.seen), 1, f"expected one delivery, got {CaptureHandler.seen}")
        status, event = CaptureHandler.seen[0]
        self.assertEqual(status, 204)
        self.assertEqual(event["type"], "snapshot.created")
        # The payload carries counts only, never memory content.
        self.assertEqual(sorted(event["data"].keys()), ["count", "exportedAt", "organizationId"])

    def test_the_receiver_refuses_a_forged_body(self) -> None:
        body = json.dumps({"format": "remembra-webhook", "version": 1, "id": "forged", "type": "memory.created"}).encode()
        # Signed correctly but claimed as a different event type.
        seconds = int(time.time())
        digest = hmac.new(SECRET, f"{seconds}.".encode() + body, hashlib.sha256).hexdigest()
        status, payload = self.example.handle_delivery(
            {
                "x-remembra-signature": f"t={seconds},v1={digest}",
                "x-remembra-delivery": "forged-1",
                "x-remembra-event": "snapshot.created",
            },
            body,
            SECRET,
            self.example.ReplayGuard(),
        )
        self.assertEqual(status, 400)
        self.assertIn("does not match", payload["error"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
