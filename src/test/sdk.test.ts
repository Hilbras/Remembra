import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Remembra, RemembraApiError, type FetchLike } from "../sdk.js";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";

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
    const url = new URL(String(input));
    if (url.pathname.endsWith("/memories/search")) {
      return jsonResponse({ text: "found", results: [] });
    }
    if (url.pathname.endsWith("/memories")) return jsonResponse({ id: "m1", message: "stored", memory: {} });
    return jsonResponse({ text: "ok" });
  };
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    apiKey: "secret",
    fetch: fetchImpl,
  });

  await client.store({ type: "fact", content: "SDK memory" });
  const search = await client.search({ query: "hello world", limit: 5 });
  await client.list({ offset: 20, limit: 10 });

  assert.equal(search.text, "found");

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

test("SDK rejects server-managed identity fields before sending", async () => {
  let called = false;
  const client = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    () => client.store({
      type: "fact",
      content: "should not leave the SDK",
      provenance: { agentId: "forged" },
    } as never),
    /server-managed/,
  );
  assert.equal(called, false);
  await assert.rejects(
    () => client.store({ type: "fact", content: "tenant", tenantId: "org-a" } as never),
    /server-managed/,
  );
  await assert.rejects(
    () => client.search({ query: "x" }, { headers: { "x-remembra-tenant": "org-a" } }),
    /server-managed/,
  );
  assert.equal(called, false);
});

test("SDK forwards AbortSignal", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | null | undefined;
  const client = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async (_input, init) => {
      seenSignal = init?.signal;
      return jsonResponse({ text: "ok", results: [] });
    },
  });
  await client.search({ query: "x" }, { signal: controller.signal });
  assert.equal(seenSignal, controller.signal);
});

test("SDK completes an authenticated store/search/get/forget round trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-sdk-http-"));
  const service = new MemoryService(new MemoryStore(dir));
  const server = createHttpServer(service, { port: 0, apiKey: "sdk-key" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const client = new Remembra({
      endpoint: `http://127.0.0.1:${address.port}`,
      apiKey: "sdk-key",
    });
    const stored = await client.store({ type: "fact", content: "SDK HTTP round trip" });
    const found = await client.search({ query: "round trip" });
    assert.ok(found.results.some((memory) => memory.id === stored.id));
    const fetched = await client.get(stored.id);
    assert.equal(fetched.memory.id, stored.id);
    const context = await client.context({ query: "round trip", maxTokens: 200 });
    assert.ok(context.tokenCount <= 200);
    assert.match(context.context, /SDK HTTP round trip/);
    const deleted = await client.forget(stored.id);
    assert.equal(deleted.ok, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("published SDK and tenant subpaths resolve without starting the CLI", async () => {
  const packageSdk = await import("@hilbras/remembra/sdk");
  const packageTenant = await import("@hilbras/remembra/tenant");
  const packageDirectory = await import("@hilbras/remembra/tenant-directory");
  const packageMigration = await import("@hilbras/remembra/tenant-migration");
  assert.equal(typeof packageSdk.Remembra, "function");
  assert.equal(typeof packageTenant.createTenantContext, "function");
  assert.equal(typeof packageDirectory.InMemoryTenantDirectory, "function");
  assert.equal(typeof packageMigration.planTenantMigration, "function");
});

test("SDK rejects invalid endpoints and does not require an API key", async () => {
  assert.throws(() => new Remembra({ endpoint: "not-a-url" }), /http\(s\) URL/);
  const client = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async () => jsonResponse({ text: "ok", results: [] }),
  });
  assert.equal((await client.search({ query: "x" })).text, "ok");
});
