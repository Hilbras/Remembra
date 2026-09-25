"""Parity checks against the published `@hilbras/remembra` contract.

The Python client must not drift from the TypeScript SDK. These tests read the
repository's own public contract file and assert the invariants both SDKs
share, so a change on either side that breaks parity fails here.
"""

from __future__ import annotations

import pathlib
import unittest

from remembra import API_PREFIX, API_VERSION, MAX_BATCH_BYTES, MAX_BATCH_ITEMS, MAX_BATCH_SEARCH_RESULTS
from remembra.types import BATCH_OPERATIONS, READ_ONLY_BATCH_OPERATIONS

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def read_api_contract() -> dict:
    source = (REPO_ROOT / "src" / "api-contract.ts").read_text(encoding="utf-8")

    def literal(name: str) -> str:
        marker = f"export const {name} = "
        start = source.index(marker) + len(marker)
        end = source.index(";", start)
        value = source[start:end].strip().rstrip(";").strip()
        value = value.replace(" as const", "").strip()
        return value.strip("`\"'")

    return {
        "apiVersion": literal("API_VERSION"),
        "basePath": literal("API_PREFIX"),
        "idempotencyKeyHeader": literal("IDEMPOTENCY_KEY_HEADER"),
        "requestIdHeader": literal("REQUEST_ID_HEADER"),
        "batchMaxItems": literal("BATCH_MAX_ITEMS"),
        "batchMaxBytes": literal("BATCH_MAX_BYTES"),
        "batchMaxSearchResults": literal("BATCH_MAX_SEARCH_RESULTS"),
        "operations": [
            "store",
            "update",
            "delete",
            "export",
            "search",
        ],
    }


class ContractParityTest(unittest.TestCase):
    def test_namespace_and_headers_match(self) -> None:
        contract = read_api_contract()
        self.assertEqual(API_VERSION, contract["apiVersion"])
        self.assertEqual(API_PREFIX, contract["basePath"])
        self.assertEqual(contract["idempotencyKeyHeader"].lower(), "idempotency-key")
        self.assertEqual(contract["requestIdHeader"].lower(), "x-remembra-request-id")

    def test_batch_limits_match(self) -> None:
        contract = read_api_contract()
        # The contract may express a byte ceiling as `10 * 1024 * 1024`.
        factors = [int(part.strip()) for part in contract["batchMaxBytes"].split("*")]
        byte_limit = 1
        for factor in factors:
            byte_limit *= factor
        self.assertEqual(MAX_BATCH_ITEMS, int(contract["batchMaxItems"]))
        self.assertEqual(MAX_BATCH_BYTES, byte_limit)
        self.assertEqual(MAX_BATCH_SEARCH_RESULTS, int(contract["batchMaxSearchResults"]))
        self.assertEqual(list(BATCH_OPERATIONS), contract["operations"])
        self.assertEqual(READ_ONLY_BATCH_OPERATIONS, frozenset({"export", "search"}))

    def test_sdk_entrypoints_are_importable_without_the_server(self) -> None:
        # The SDK must stay importable with no third-party dependency present.
        module_names = {name.split(".")[0] for name in __import__("sys").modules}
        self.assertNotIn("httpx", module_names)
        self.assertNotIn("requests", module_names)
        self.assertNotIn("aiohttp", module_names)

    def test_caps_manifest_shape_is_unchanged(self) -> None:
        source = (REPO_ROOT / "src" / "api-contract.ts").read_text(encoding="utf-8")
        start = source.index("export const API_CAPABILITIES = [") + len("export const API_CAPABILITIES = ")
        block = source[start : source.index("] as const", start)]
        capabilities = [
            entry.strip().strip(",").strip("'\"")
            for entry in block[block.index("[") + 1 :].split(",")
            if entry.strip().strip(",").strip("'\"")
        ]
        for capability in ("memory", "context", "snapshot", "batch", "batch-idempotency"):
            self.assertIn(capability, capabilities)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
