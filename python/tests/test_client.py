"""Unit tests for the Remembra Python SDK.

These run with the standard library only::

    python3 -m unittest discover -s python/tests -t python
"""

from __future__ import annotations

import asyncio
import json
import unittest

from remembra import (
    ApiError,
    AsyncRemembra,
    NetworkError,
    Remembra,
    RemembraError,
    RequestTimeout,
    ValidationError,
)
from remembra.transport import SyncResponse

ENDPOINT = "http://memory.example.test"


class FakeTransport:
    """Records requests and replays a scripted list of outcomes."""

    def __init__(self, outcomes=None) -> None:
        self.outcomes = list(outcomes or [])
        self.calls: list[dict] = []

    def request(self, method, url, headers, body, timeout):
        self.calls.append(
            {"method": method, "url": url, "headers": dict(headers), "body": body, "timeout": timeout}
        )
        outcome = self.outcomes.pop(0) if self.outcomes else (200, {"ok": True})
        if isinstance(outcome, Exception):
            raise outcome
        status, payload = outcome
        if isinstance(payload, (dict, list)):
            return SyncResponse(status, json.dumps(payload).encode("utf-8"), {"content-type": "application/json"})
        return SyncResponse(status, payload if isinstance(payload, bytes) else str(payload).encode("utf-8"))

    @property
    def last(self) -> dict:
        return self.calls[-1]


class ClientTest(unittest.TestCase):
    def test_paths_auth_and_namespace(self) -> None:
        transport = FakeTransport([(200, {"memories": [], "next_cursor": None})])
        client = Remembra(ENDPOINT, api_key="secret", transport=transport)
        client.list({"scope": "global", "limit": 5})
        call = transport.last
        self.assertEqual(call["method"], "GET")
        self.assertTrue(call["url"].startswith(f"{ENDPOINT}/api/v1/memories?"))
        self.assertEqual(call["headers"]["x-api-key"], "secret")
        self.assertEqual(call["headers"]["accept"], "application/json")
        self.assertIn("x-remembra-request-id", call["headers"])
        self.assertEqual(client.api_version, "v1")

    def test_request_id_is_generated_and_propagated(self) -> None:
        transport = FakeTransport([(200, {}), (200, {})])
        client = Remembra(ENDPOINT, transport=transport)
        client.capabilities()
        self.assertTrue(transport.last["headers"]["x-remembra-request-id"])
        client.capabilities(request_id="req-42")
        self.assertEqual(transport.last["headers"]["x-remembra-request-id"], "req-42")
        with self.assertRaises(ValidationError):
            client.capabilities(request_id="not valid!")

    def test_store_rejects_server_managed_identity(self) -> None:
        transport = FakeTransport()
        client = Remembra(ENDPOINT, transport=transport)
        for field in ("id", "tenantId", "organizationId", "userId", "agentId", "embedding"):
            with self.assertRaises(ValidationError):
                client.store({"type": "fact", "content": "x", field: "nope"})
        with self.assertRaises(ValidationError):
            client.store({"content": "missing type"})
        self.assertEqual(transport.calls, [])

    def test_api_errors_are_typed_and_keep_the_body(self) -> None:
        transport = FakeTransport([(404, {"error": {"code": "NOT_FOUND", "message": "No memory with id m9."}})])
        client = Remembra(ENDPOINT, transport=transport)
        with self.assertRaises(ApiError) as raised:
            client.get("m9")
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual(raised.exception.code, "NOT_FOUND")
        self.assertEqual(raised.exception.body["error"]["code"], "NOT_FOUND")
        self.assertIsInstance(raised.exception, RemembraError)

    def test_legacy_error_without_code_falls_back(self) -> None:
        transport = FakeTransport([(500, {"error": "boom"})])
        client = Remembra(ENDPOINT, transport=transport)
        with self.assertRaises(ApiError) as raised:
            client.capabilities()
        self.assertEqual(raised.exception.code, "HTTP_500")
        self.assertEqual(raised.exception.body, {"error": "boom"})

    def test_network_and_timeout_errors_are_distinct(self) -> None:
        client = Remembra(ENDPOINT, transport=FakeTransport([NetworkError("dns")]))
        with self.assertRaises(NetworkError):
            client.capabilities()
        client = Remembra(ENDPOINT, transport=FakeTransport([RequestTimeout("slow")]))
        with self.assertRaises(RequestTimeout):
            client.capabilities()

    def test_retries_apply_to_reads_only(self) -> None:
        transport = FakeTransport([(503, {"error": "busy"}), (200, {"memories": []})])
        client = Rememba = Remembra(ENDPOINT, transport=transport)
        page = client.list({"limit": 5}, attempts=3, base_delay=0.0, max_delay=0.0)
        self.assertEqual(page["memories"], [])
        self.assertEqual(len(transport.calls), 2)

        # A write is never retried, so one call cannot duplicate a mutation.
        write_transport = FakeTransport([(503, {"error": "busy"}), (200, {"ok": True})])
        writer = Remembra(ENDPOINT, transport=write_transport)
        with self.assertRaises(ValidationError):
            writer.store({"type": "fact", "content": "once"}, attempts=2)  # type: ignore[call-arg]

    def test_non_retryable_status_is_not_retried(self) -> None:
        transport = FakeTransport([(400, {"error": {"code": "INVALID_INPUT"}}), (200, {"memories": []})])
        client = Remembra(ENDPOINT, transport=transport)
        with self.assertRaises(ApiError):
            client.list({"limit": 5}, attempts=3, base_delay=0.0, max_delay=0.0)
        self.assertEqual(len(transport.calls), 1)

    def test_bounded_inputs_are_rejected_locally(self) -> None:
        transport = FakeTransport()
        client = Remembra(ENDPOINT, timeout=5, transport=transport)
        with self.assertRaises(ValidationError):
            Remembra(ENDPOINT, timeout=0)
        with self.assertRaises(ValidationError):
            Remembra(ENDPOINT, timeout=1000)
        with self.assertRaises(ValidationError):
            Remembra("memory.example.test")
        with self.assertRaises(ValidationError):
            client.list({"limit": 5000})
        with self.assertRaises(ValidationError):
            client.search({"query": "x", "limit": 500})
        with self.assertRaises(ValidationError):
            client.list({"cursor": "c", "offset": 10})
        with self.assertRaises(ValidationError):
            client.update("m1", {})
        self.assertEqual(transport.calls, [])

    def test_timeout_is_passed_to_the_transport(self) -> None:
        transport = FakeTransport([(200, {})])
        client = Remembra(ENDPOINT, timeout=2.5, transport=transport)
        client.capabilities()
        self.assertEqual(transport.last["timeout"], 2.5)

    def test_cursor_pagination_walks_every_page_once(self) -> None:
        transport = FakeTransport(
            [
                (200, {"memories": [{"id": "m1"}], "next_cursor": "c1"}),
                (200, {"memories": [{"id": "m2"}], "next_cursor": None}),
            ]
        )
        client = Remembra(ENDPOINT, transport=transport)
        ids = [memory["id"] for page in client.iter_list({"limit": 1}) for memory in page["memories"]]
        self.assertEqual(ids, ["m1", "m2"])
        self.assertIn("cursor=c1", transport.calls[1]["url"])

    def test_batch_budget_is_enforced_before_a_request(self) -> None:
        transport = FakeTransport()
        client = Remembra(ENDPOINT, transport=transport)
        too_many = {"operation": "store", "items": [{"type": "fact", "content": f"m{i}"} for i in range(101)]}
        with self.assertRaises(ValidationError):
            client.batch(too_many)
        wide_search = {"operation": "search", "items": [{"query": "x", "limit": 200} for _ in range(6)]}
        with self.assertRaises(ValidationError):
            client.batch(wide_search)
        with self.assertRaises(ValidationError):
            client.batch({"operation": "store", "items": []})
        with self.assertRaises(ValidationError):
            client.batch({"operation": "teleport", "items": [{"a": 1}]})
        self.assertEqual(transport.calls, [])

    def test_idempotency_key_is_mutation_only(self) -> None:
        transport = FakeTransport(
            [
                (200, {"operation": "store", "summary": {"requested": 1, "succeeded": 1, "failed": 0},
                       "results": [{"index": 0, "ok": True, "result": {"id": "m1", "message": "Stored"}}],
                       "execution": {"transactionPolicy": "per-item", "idempotency": "stored"}}),
                (200, {"operation": "store", "summary": {"requested": 1, "succeeded": 0, "failed": 1},
                       "results": [{"index": 0, "ok": False, "error": {"code": "NOT_FOUND", "message": "missing"}}],
                       "execution": {"transactionPolicy": "per-item", "idempotency": "stored"}}),
            ]
        )
        client = Remembra(ENDPOINT, transport=transport)
        result = client.batch(
            {"operation": "store", "items": [{"type": "fact", "content": "once"}]},
            idempotency_key="batch-001",
        )
        self.assertEqual(result["summary"]["succeeded"], 1)
        self.assertEqual(transport.last["headers"]["idempotency-key"], "batch-001")

        # A keyed response with a failed item is never accepted as replay-safe.
        with self.assertRaises(ValidationError):
            client.batch(
                {"operation": "delete", "ids": ["missing"]},
                idempotency_key="batch-002",
            )
        with self.assertRaises(ValidationError):
            client.batch({"operation": "search", "items": [{"query": "x"}]}, idempotency_key="batch-003")
        with self.assertRaises(ValidationError):
            client.batch({"operation": "store", "items": [{"type": "fact", "content": "x"}]}, idempotency_key="bad key")

    def test_snapshot_round_trip_uses_the_server_envelope(self) -> None:
        snapshot = {"format": "remembra-snapshot", "version": 3, "exportedAt": "2026-01-01T00:00:00.000Z", "memories": []}
        transport = FakeTransport([(200, snapshot), (200, {"imported": 0, "skipped": 0})])
        client = Remembra(ENDPOINT, transport=transport)
        exported = client.create_snapshot()
        self.assertEqual(exported, snapshot)
        restored = client.restore_snapshot(exported)
        self.assertEqual(restored, {"imported": 0, "skipped": 0})
        self.assertEqual(json.loads(transport.last["body"]), snapshot)
        self.assertTrue(transport.last["url"].endswith("/api/v1/import"))


class AsyncClientTest(unittest.TestCase):
    def test_async_client_matches_the_sync_surface(self) -> None:
        async def scenario() -> None:
            transport = FakeTransport(
                [
                    (503, {"error": "busy"}),
                    (200, {"memories": [{"id": "m1", "content": "release"}], "next_cursor": None}),
                    (200, {"results": [], "summary": {"requested": 1, "succeeded": 1, "failed": 0}}),
                ]
            )
            async with AsyncRemembra(ENDPOINT, api_key="secret", transport=transport) as client:
                # A read retries and succeeds; the API key still rides along.
                page = await client.list({"limit": 5}, attempts=2, base_delay=0.0, max_delay=0.0)
                self.assertEqual(page["memories"][0]["id"], "m1")
                self.assertEqual(transport.last["headers"]["x-api-key"], "secret")
                stored = await client.batch({"operation": "store", "items": [{"type": "fact", "content": "x"}]})
                self.assertEqual(stored["summary"]["succeeded"], 1)
                # A non-retryable failure surfaces with the same typed error.
                with self.assertRaises(ValidationError):
                    await client.store({"type": "fact", "content": "x"}, attempts=2)

        asyncio.run(scenario())

    def test_async_validation_is_identical(self) -> None:
        async def scenario() -> None:
            transport = FakeTransport()
            async with AsyncRemembra(ENDPOINT, transport=transport) as client:
                with self.assertRaises(ValidationError):
                    await client.store({"type": "fact", "content": "x", "id": "forced"})
                with self.assertRaises(ValidationError):
                    await client.batch({"operation": "store", "items": [{"type": "fact", "content": "x"}] * 101})
            self.assertEqual(transport.calls, [])

        asyncio.run(scenario())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
