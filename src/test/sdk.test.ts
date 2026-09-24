import { test } from "node:test";
import assert from "node:assert/strict";
import { Remembra, RemembraApiError, type FetchLike } from "../sdk.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("SDK uses the v1 namespace, API key, typed paths, and query encoding", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/memories/search")) {
      return jsonResponse({ text: "found", results: [] });
    }
    if (String(input).endsWith("/memories")) return jsonResponse({ id: "m1", message: "stored", memory: {} });
    return jsonResponse({ text: "ok" });
  };
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    apiKey: "secret",
    fetch: fetchImpl,
  });

  await client.store({ type: "fact", content: "SDK memory" });
  await client.search({ query: "hello world", limit: 5 });
  await client.list({ offset: 20, limit: 10 });

  assert.equal(calls[0].url, "https://memory.example.test/api/v1/memories");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new Headers(calls[0].init?.headers).get("x-api-key"), "secret");
  assert.equal(calls[1].url, "https://memory.example.test/api/v1/memories/search?query=hello+world&limit=5");
  assert.equal(calls[2].url, "https://memory.example.test/api/v1/memories?offset=20&limit=10");
});

test("SDK preserves structured API errors", async () => {
  const client = new Remembra({
    endpoint: "http://localhost:8787/api/v1",
    fetch: async () => jsonResponse({ error: "No memory with id missing", code: "NOT_FOUND" }, 404),
  });

  await assert.rejects(
    () => client.get("missing"),
    (error: unknown) => {
      assert.ok(error instanceof RemembraApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, "No memory with id missing");
      return true;
    },
  );
});

test("SDK rejects invalid endpoints and does not require an API key", async () => {
  assert.throws(() => new Remembra({ endpoint: "not-a-url" }), /http\(s\) URL/);
  const client = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async () => jsonResponse({ text: "ok", results: [] }),
  });
  assert.equal((await client.search({ query: "x" })).text, "ok");
});
