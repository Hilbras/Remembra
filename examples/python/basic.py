"""Python example: store, search, and page through memories.

Run a local server first:  npx remembra --http
Then:                      python3 examples/python/basic.py
"""

from __future__ import annotations

import os

from remembra import Remembra

client = Remembra(
    os.environ.get("REMEMBRA_ENDPOINT", "http://127.0.0.1:8787"),
    api_key=os.environ.get("REMEMBRA_API_KEY"),
)

stored = client.store(
    {
        "type": "decision",
        "content": "The payments cluster is upgraded during the tuesday 02:00 UTC window.",
        "scope": "global",
        "tags": ["deploy", "payments"],
        "importance": 8,
    }
)
print("stored", stored["id"])

found = client.search({"query": "payments cluster upgrade window", "limit": 5})
for hit in found["results"]:
    print(hit["memory"]["id"], hit["memory"]["content"])

# Cursor pagination: follow the server's opaque cursor until it stops.
for page in client.iter_list({"limit": 20}):
    print("page:", len(page["memories"]), "active memories")
