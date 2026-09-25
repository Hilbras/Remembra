import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Remembra, RemembraApiError, RemembraNetworkError, RemembraTimeoutError, type FetchLike, type LegacyBatchRequest } from "../sdk.js";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import { API_CAPABILITY_MANIFEST, API_PREFIX, API_VERSION, BATCH_MAX_BYTES, BATCH_MAX_ITEMS, BATCH_MAX_SEARCH_RESULTS, REQUEST_ID_HEADER } from "../api-contract.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type SearchIsLegacyBatchOperation = "search" extends LegacyBatchRequest["operation"] ? true : false;
const searchIsLegacyBatchOperation: SearchIsLegacyBatchOperation = false;

test("the deprecated SDK batch type stays frozen at the pre-V5.4 operations", () => {
  assert.equal(searchIsLegacyBatchOperation, false);
});

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

test("SDK exposes typed snapshot create and restore methods", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const snapshot = {
    format: "remembra-export",
    version: 3,
    exportedAt: "2026-01-01T00:00:00.000Z",
    memories: [],
  };
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    apiKey: "secret",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (new URL(String(input)).pathname.endsWith("/import")) return jsonResponse({ imported: 1, skipped: 0 });
      return jsonResponse(snapshot);
    },
  });
  const exported = await client.createSnapshot();
  const restored = await client.restoreSnapshot(exported);
  assert.deepEqual(exported, snapshot);
  assert.deepEqual(restored, { imported: 1, skipped: 0 });
  assert.equal(calls[0].url, "https://memory.example.test/api/v1/snapshot");
  assert.equal(calls[1].url, "https://memory.example.test/api/v1/import");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), snapshot);
});

test("SDK exposes the shared v1 capabilities contract", async () => {
  const calls: string[] = [];
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    apiKey: "secret",
    fetch: async (input) => {
      calls.push(String(input));
      return jsonResponse(API_CAPABILITY_MANIFEST);
    },
  });
  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities, API_CAPABILITY_MANIFEST);
  assert.equal(client.apiVersion, API_VERSION);
  assert.equal(calls[0], `https://memory.example.test${API_PREFIX}/capabilities`);
});

test("SDK rejects a batch the server could never accept without a round trip", async () => {
  let called = 0;
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => {
      called++;
      return jsonResponse({});
    },
  });
  const tooManyItems = Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_value, index) => ({ type: "fact" as const, content: `m${index}` }));
  await assert.rejects(
    () => client.batch({ operation: "store", items: tooManyItems }),
    /at most 100 items/i,
  );
  await assert.rejects(
    () => client.batch({ operation: "delete", ids: Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_v, i) => `m${i}`) }),
    /at most 100 items/i,
  );
  // The aggregate search budget is enforced from per-item limits.
  await assert.rejects(
    () => client.batch({
      operation: "search",
      items: Array.from({ length: 10 }, () => ({ query: "bounded", limit: BATCH_MAX_SEARCH_RESULTS / 10 + 1 })),
    }),
    /must not exceed 1000/i,
  );
  // An oversized body is refused before it is serialized onto the wire.
  await assert.rejects(
    () => client.batch({ operation: "store", items: [{ type: "fact", content: "x".repeat(BATCH_MAX_BYTES + 1) }] }),
    /exceeds 10485760 bytes/i,
  );
  await assert.rejects(
    () => client.batch({ operation: "store", items: [{ type: "fact", content: BigInt(1) as unknown as string }] }),
    /JSON-serializable/i,
  );
  assert.equal(called, 0);
});

test("SDK sends bounded idempotency keys for batch mutations", async () => {
  const calls: Headers[] = [];
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async (_input, init) => {
      calls.push(new Headers(init?.headers));
      return jsonResponse({
        operation: "store",
        summary: { requested: 1, succeeded: 1, failed: 0 },
        results: [{ index: 0, id: "m1", ok: true, result: { id: "m1", message: "stored" } }],
        execution: { transactionPolicy: "per-item", idempotency: "stored" },
      });
    },
  });
  await client.batch(
    { operation: "store", items: [{ type: "fact", content: "once" }] },
    { idempotencyKey: "sdk-batch-001" },
  );
  assert.equal(calls[0].get("idempotency-key"), "sdk-batch-001");

  let called = false;
  const invalidClient = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    () => invalidClient.batch(
      { operation: "store", items: [{ type: "fact", content: "once" }] },
      { idempotencyKey: "bad key" },
    ),
    /idempotency/i,
  );
  assert.equal(called, false);
  await assert.rejects(
    () => client.batch({ operation: "export", ids: ["m1"] }, { idempotencyKey: "export-key" }),
    /only supported for batch mutations/i,
  );

  const headerKeyClient = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => jsonResponse({
      operation: "store",
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [{ index: 0, id: "m1", ok: true, result: { id: "m1", message: "stored" } }],
      execution: { transactionPolicy: "per-item", idempotency: "stored" },
    }),
  });
  await headerKeyClient.batch(
    { operation: "store", items: [{ type: "fact", content: "header key" }] },
    { headers: { "Idempotency-Key": "sdk-header-batch-001" } },
  );

  const partialKeyed = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => jsonResponse({
      operation: "delete",
      summary: { requested: 2, succeeded: 1, failed: 1 },
      results: [
        { index: 0, id: "m1", ok: true, result: { text: "Deleted memory m1." } },
        { index: 1, id: "m2", ok: false, error: { code: "NOT_FOUND", message: "No memory with id m2." } },
      ],
      execution: { transactionPolicy: "per-item", idempotency: "stored" },
    }),
  });
  await assert.rejects(
    () => partialKeyed.batch(
      { operation: "delete", ids: ["m1", "m2"] },
      { idempotencyKey: "partial-keyed-batch" },
    ),
    /invalid batch response/i,
  );

  const malformed = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => jsonResponse({
      operation: "store",
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [{}],
      execution: { transactionPolicy: "per-item", idempotency: "stored" },
    }),
  });
  await assert.rejects(
    () => malformed.batch({ operation: "store", items: [{ type: "fact", content: "once" }] }),
    /invalid batch response/i,
  );
});

test("SDK exposes validated read-only batch search", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        operation: "search",
        summary: { requested: 2, succeeded: 2, failed: 0 },
        results: [
          { index: 0, ok: true, result: { text: "first", results: [] } },
          { index: 1, ok: true, result: { text: "second", results: [] } },
        ],
        execution: { transactionPolicy: "read-only", idempotency: "read-only" },
      });
    },
  });

  const response = await client.batch({
    operation: "search",
    items: [{ query: "first", limit: 5 }, { query: "second", limit: 5 }],
  });
  assert.equal(response.operation, "search");
  if (response.operation !== "search" || !response.results[0]?.ok || !response.results[1]?.ok) {
    assert.fail("expected two valid search outcomes");
  }
  assert.equal(response.results[0].result.text, "first");
  assert.equal(response.results[1].result.text, "second");
  assert.equal(calls[0].url, "https://memory.example.test/api/v1/memories/batch");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    operation: "search",
    items: [{ query: "first", limit: 5 }, { query: "second", limit: 5 }],
  });

  await assert.rejects(
    () => client.batch(
      { operation: "search", items: [{ query: "first" }] },
      { idempotencyKey: "search-key" },
    ),
    /only supported for batch mutations/i,
  );
  assert.equal(calls.length, 1);

  const malformed = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => jsonResponse({
      operation: "search",
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [{ index: 0, ok: true, result: { text: "invalid", results: {} } }],
      execution: { transactionPolicy: "read-only", idempotency: "read-only" },
    }),
  });
  await assert.rejects(
    () => malformed.batch({ operation: "search", items: [{ query: "invalid" }] }),
    /invalid batch response/i,
  );

  const extraKey = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => jsonResponse({
      operation: "search",
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [{ index: 0, ok: true, result: { text: "invalid", results: [], extra: true } }],
      execution: { transactionPolicy: "read-only", idempotency: "read-only" },
    }),
  });
  await assert.rejects(
    () => extraKey.batch({ operation: "search", items: [{ query: "invalid" }] }),
    /invalid batch response/i,
  );

  const partial = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => jsonResponse({
      operation: "search",
      summary: { requested: 1, succeeded: 0, failed: 1 },
      results: [{
        index: 0,
        ok: false,
        error: { code: "TENANT_REQUIRED", message: "a trusted tenant context is required" },
      }],
      execution: { transactionPolicy: "read-only", idempotency: "read-only" },
    }),
  });
  const partialResponse = await partial.batch({ operation: "search", items: [{ query: "denied" }] });
  assert.equal(partialResponse.operation === "search" && partialResponse.results[0]?.ok, false);
});

test("SDK retries only opted-in read requests and never retries writes", async () => {
  let calls = 0;
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => {
      calls++;
      if (calls === 1) throw new Error("temporary socket failure");
      return jsonResponse({ text: "recovered", results: [] });
    },
  });
  const result = await client.search({}, { retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 } });
  assert.equal(result.text, "recovered");
  assert.equal(calls, 2);

  let writeCalled = false;
  const writeClient = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => {
      writeCalled = true;
      return jsonResponse({ id: "m1", message: "stored", memory: {} });
    },
  });
  await assert.rejects(
    () => writeClient.store({ type: "fact", content: "unsafe retry" }, { retry: { attempts: 2 } }),
    /read-only|retry/i,
  );
  assert.equal(writeCalled, false);
});

test("SDK propagates bounded request IDs and generates one when omitted", async () => {
  const seen: Headers[] = [];
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return jsonResponse({ text: "ok", results: [] });
    },
  });
  await client.search({}, { requestId: "sdk-request-001" });
  await client.search({});
  assert.equal(seen[0].get(REQUEST_ID_HEADER), "sdk-request-001");
  assert.match(seen[1].get(REQUEST_ID_HEADER) ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

  let called = false;
  const invalidClient = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => {
      called = true;
      return jsonResponse({ text: "ok", results: [] });
    },
  });
  await assert.rejects(() => invalidClient.search({}, { requestId: "bad request id" }), /requestId/);
  assert.equal(called, false);
});

test("SDK exposes typed tenant entity methods without tenant identity fields", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ ok: true, kind: "agent", agentId: "agent-a" });
    },
  });
  await client.tenantOrganization();
  await client.listTenantEntities("user", { offset: 2, limit: 10 });
  await client.getTenantEntity("agent", "agent-a");
  await client.createTenantEntity("agent", "agent-a", { userRef: "user-a", projectRef: "project-a" });
  await client.updateTenantEntity("agent", "agent-a", { displayName: "Agent" });
  await client.deleteTenantEntity("agent", "agent-a");
  await client.grantTenantMembership("project-a", "user-a", "member");
  await client.revokeTenantMembership("project-a", "user-a");
  await client.listTenantMemberships("project-a", { limit: 10 });

  assert.match(calls[0].url, /\/api\/v1\/tenant\/organization$/);
  assert.match(calls[1].url, /tenant\/entities\/user\?offset=2&limit=10$/);
  assert.match(calls[3].url, /tenant\/entities\/agent\/agent-a$/);
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { userRef: "user-a", projectRef: "project-a" });
  assert.match(calls[6].url, /tenant\/memberships\/project-a\/user-a$/);
  assert.match(calls[8].url, /tenant\/memberships\/project-a\?limit=10$/);
  assert.equal(new Headers(calls[6].init?.headers).get("x-api-key"), null);
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

test("SDK normalizes unexpected network failures", async () => {
  const client = new Remembra({
    endpoint: "https://memory.example.test",
    fetch: async () => {
      throw new Error("socket closed");
    },
  });
  await assert.rejects(
    () => client.search({}),
    (error: unknown) => {
      assert.ok(error instanceof RemembraNetworkError);
      assert.equal(error.code, "NETWORK_ERROR");
      assert.match(error.message, /network request failed/);
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
  for (const identity of [
    { tenant_id: "org-a" },
    { organization: "org-a" },
    { user: "user-a" },
    { project: "project-a" },
    { AgentId: "agent-a" },
    { membership_version: "membership-1" },
  ]) {
    await assert.rejects(
      () => client.store({ type: "fact", content: "alias", ...identity } as never),
      /server-managed/,
    );
  }
  assert.equal(called, false);
});

test("SDK enforces bounded request timeouts and preserves caller aborts", async () => {
  const timeoutClient = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  await assert.rejects(
    () => timeoutClient.search({ query: "slow" }, { timeoutMs: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof RemembraTimeoutError);
      assert.equal(error.timeoutMs, 10);
      return true;
    },
  );

  const controller = new AbortController();
  const abortClient = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const pending = abortClient.search({ query: "abort" }, { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as { name?: string }).name === "AbortError");

  let called = false;
  const invalidClient = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async () => {
      called = true;
      return jsonResponse({ text: "ok", results: [] });
    },
  });
  await assert.rejects(() => invalidClient.search({}, { timeoutMs: 0 }), /timeout/i);
  await assert.rejects(() => invalidClient.search({}, { timeoutMs: 120_001 }), /timeout/i);
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

test("SDK list follows an opaque cursor without duplicate pages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-sdk-cursor-"));
  const service = new MemoryService(new MemoryStore(dir));
  const server = createHttpServer(service, { port: 0, apiKey: "cursor-key" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const client = new Remembra({ endpoint: `http://127.0.0.1:${address.port}`, apiKey: "cursor-key" });
    await client.store({ type: "fact", content: "cursor one" });
    await client.store({ type: "fact", content: "cursor two" });
    await client.store({ type: "fact", content: "cursor three" });

    const first = await client.list({ limit: 1 });
    assert.equal(first.memories.length, 1);
    assert.ok(first.nextCursor);
    const second = await client.list({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.memories.length, 1);
    assert.notEqual(second.memories[0].id, first.memories[0].id);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
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
    const snapshot = await client.createSnapshot();
    assert.ok(snapshot.memories.some((memory) => memory.id === stored.id));
    const restored = await client.restoreSnapshot(snapshot);
    assert.equal(restored.imported, 0);
    assert.equal(restored.skipped, snapshot.memories.length);
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
  const packageContract = await import("@hilbras/remembra/api-contract");
  const packageIdempotency = await import("@hilbras/remembra/batch-idempotency");
  const packageTenant = await import("@hilbras/remembra/tenant");
  const packageDirectory = await import("@hilbras/remembra/tenant-directory");
  const packageDirectoryFile = await import("@hilbras/remembra/tenant-directory-file");
  const packageEntities = await import("@hilbras/remembra/tenant-entities");
  const packageMigration = await import("@hilbras/remembra/tenant-migration");
  const packageMigrationState = await import("@hilbras/remembra/migration-state");
  const packageRecovery = await import("@hilbras/remembra/recovery");
  const packageSqliteRecovery = await import("@hilbras/remembra/sqlite-recovery");
  assert.equal(typeof packageSdk.Remembra, "function");
  assert.equal(packageContract.API_VERSION, API_VERSION);
  assert.equal(typeof packageIdempotency.FileBatchIdempotencyStore, "function");
  assert.equal(typeof packageIdempotency.SqliteBatchIdempotencyStore, "function");
  assert.equal(typeof packageTenant.createTenantContext, "function");
  assert.equal(typeof packageDirectory.InMemoryTenantDirectory, "function");
  assert.equal(typeof packageDirectoryFile.FileTenantDirectory, "function");
  assert.equal(typeof packageEntities.TenantEntityService, "function");
  assert.equal(typeof packageMigration.planTenantMigration, "function");
  assert.equal(typeof packageMigrationState.runDurableTenantMigration, "function");
  assert.equal(typeof packageRecovery.writeSignedSnapshotFile, "function");
  assert.equal(typeof packageSqliteRecovery.backupSqlite, "function");
});

test("SDK rejects invalid endpoints and does not require an API key", async () => {
  assert.throws(() => new Remembra({ endpoint: "not-a-url" }), /http\(s\) URL/);
  const client = new Remembra({
    endpoint: "http://localhost:8787",
    fetch: async () => jsonResponse({ text: "ok", results: [] }),
  });
  assert.equal((await client.search({ query: "x" })).text, "ok");
});
