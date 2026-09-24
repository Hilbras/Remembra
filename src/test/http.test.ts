import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import { API_CAPABILITY_MANIFEST, API_PREFIX, API_VERSION, REQUEST_ID_HEADER } from "../api-contract.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-http-"));
const service = new MemoryService(new MemoryStore(dir));
const server: http.Server = createHttpServer(service, { port: 0, apiKey: "test-key" });
await new Promise<void>((r) => server.once("listening", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => server.close());

test("health is open without auth", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test("requests without API key are rejected", async () => {
  const res = await fetch(`${base}/memories`);
  assert.equal(res.status, 401);
});

test("v1 API namespace preserves auth, headers, and legacy handler behavior", async () => {
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-remembra-api-version"), "v1");

  const unauthorized = await fetch(`${base}/api/v1/memories`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("x-remembra-api-version"), "v1");

  const created = await fetch(`${base}/api/v1/memories`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ type: "fact", content: "versioned HTTP memory" }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("x-remembra-api-version"), "v1");
  const { id } = await created.json();

  const found = await fetch(`${base}/api/v1/memories/search?query=versioned`, {
    headers: { authorization: "Bearer test-key" },
  });
  assert.equal(found.status, 200);
  assert.ok((await found.json()).results.some((m: { id: string }) => m.id === id));

  const context = await fetch(`${base}/api/v1/context`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ query: "versioned", maxTokens: 200 }),
  });
  assert.equal(context.status, 200);
  assert.equal(context.headers.get("x-remembra-api-version"), "v1");
  const contextBody = await context.json() as { tokenCount: number; context: string };
  assert.ok(contextBody.tokenCount <= 200);
  assert.match(contextBody.context, /versioned HTTP memory/);

  const invalidContext = await fetch(`${base}/api/v1/context`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ maxTokens: 0 }),
  });
  assert.equal(invalidContext.status, 400);
  assert.equal((await invalidContext.json() as { code?: string }).code, "INVALID_INPUT");

  const missing = await fetch(`${base}/api/v1/does-not-exist`, {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-remembra-api-version"), "v1");

  const invalid = await fetch(`${base}/api/v1/memories/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ operation: "delete", ids: [] }),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = {
    error: "ids: Array must contain at least 1 element(s)",
    code: "INVALID_INPUT",
  };
  assert.deepEqual(await invalid.json(), invalidBody);
  const badCursor = await fetch(`${base}/api/v1/memories?cursor=not-a-valid-cursor`, {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(badCursor.status, 400);
  assert.equal((await badCursor.json() as { code?: string }).code, "INVALID_INPUT");
  const legacyInvalid = await fetch(`${base}/memories/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ operation: "delete", ids: [] }),
  });
  assert.equal(legacyInvalid.status, 400);
  assert.equal(legacyInvalid.headers.get("x-remembra-api-version"), null);
  assert.deepEqual(await legacyInvalid.json(), invalidBody);
});

test("v1 capabilities discovery is authenticated, versioned, and bounded", async () => {
  const unauthorized = await fetch(`${base}/api/v1/capabilities`);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get(REQUEST_ID_HEADER.toLowerCase()) ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

  const response = await fetch(`${base}${API_PREFIX}/capabilities`, {
    headers: { "x-api-key": "test-key", "x-remembra-request-id": "http-request-001" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-remembra-api-version"), API_VERSION);
  assert.equal(response.headers.get(REQUEST_ID_HEADER.toLowerCase()), "http-request-001");
  const body = await response.json() as {
    apiVersion: string;
    basePath: string;
    capabilities: string[];
    compatibility: { legacyRoutes: boolean; versionHeader: string };
  };
  assert.deepEqual(body, API_CAPABILITY_MANIFEST);
  assert.equal(body.apiVersion, API_VERSION);
  assert.equal(body.basePath, API_PREFIX);
  assert.ok(body.capabilities.length <= 32);
  assert.ok(body.capabilities.every((capability) => typeof capability === "string"));

  const unsupported = await fetch(`${base}/api/v2/capabilities`, {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.headers.get("x-remembra-api-version"), null);
});

test("v1 version header is present on concurrency-limit responses", async () => {
  const previous = process.env.REMEMBRA_MAX_CONCURRENT;
  process.env.REMEMBRA_MAX_CONCURRENT = "0";
  const overloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-overload-"));
  const overloadServer = createHttpServer(new MemoryService(new MemoryStore(overloadDir)), {
    port: 0,
    apiKey: "test-key",
  });
  try {
    await new Promise<void>((resolve) => overloadServer.once("listening", () => resolve()));
    const overloadBase = `http://127.0.0.1:${(overloadServer.address() as { port: number }).port}`;
    const response = await fetch(`${overloadBase}/api/v1/memories`, {
      headers: { "x-api-key": "test-key" },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-remembra-api-version"), "v1");
  } finally {
    await new Promise<void>((resolve, reject) =>
      overloadServer.close((error) => (error ? reject(error) : resolve())),
    );
    if (previous === undefined) delete process.env.REMEMBRA_MAX_CONCURRENT;
    else process.env.REMEMBRA_MAX_CONCURRENT = previous;
  }
});

test("v1 CORS preflight exposes the version header", async () => {
  const previous = process.env.REMEMBRA_CORS_ORIGIN;
  process.env.REMEMBRA_CORS_ORIGIN = "https://client.example";
  const corsDir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-cors-"));
  const corsServer = createHttpServer(new MemoryService(new MemoryStore(corsDir)), {
    port: 0,
    apiKey: "test-key",
  });
  try {
    await new Promise<void>((resolve) => corsServer.once("listening", () => resolve()));
    const corsBase = `http://127.0.0.1:${(corsServer.address() as { port: number }).port}`;
    const response = await fetch(`${corsBase}/api/v1/memories`, {
      method: "OPTIONS",
      headers: { origin: "https://client.example" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://client.example");
    assert.match(response.headers.get("access-control-expose-headers") ?? "", /X-Remembra-API-Version/);
    assert.match(response.headers.get("access-control-expose-headers") ?? "", /X-Remembra-Request-Id/);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /X-Remembra-Request-Id/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      corsServer.close((error) => (error ? reject(error) : resolve())),
    );
    if (previous === undefined) delete process.env.REMEMBRA_CORS_ORIGIN;
    else process.env.REMEMBRA_CORS_ORIGIN = previous;
  }
});

test("store → search → delete round-trip", async () => {
  const created = await fetch(`${base}/memories`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ type: "fact", content: "HTTP test memory", tags: ["http"] }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const found = await fetch(`${base}/memories/search?query=http`, {
    headers: { authorization: "Bearer test-key" },
  });
  assert.equal(found.status, 200);
  const body = await found.json();
  assert.ok(body.results.some((m: { id: string }) => m.id === id));

  const del = await fetch(`${base}/memories/${id}`, {
    method: "DELETE",
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(del.status, 200);

  const gone = await fetch(`${base}/memories/${id}`, {
    method: "DELETE",
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(gone.status, 404);
});

test("POST /memories/batch returns ordered outcomes and validates structure", async () => {
  const res = await fetch(`${base}/memories/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({
      operation: "store",
      items: [
        { type: "fact", content: "batch HTTP one" },
        { type: "decision", content: "batch HTTP two", importance: 4 },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.operation, "store");
  assert.deepEqual(body.summary, { requested: 2, succeeded: 2, failed: 0 });
  assert.deepEqual(body.execution, { transactionPolicy: "per-item", idempotency: "unsupported" });
  assert.deepEqual(body.results.map((item: { index: number }) => item.index), [0, 1]);

  const invalid = await fetch(`${base}/memories/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ operation: "delete", ids: [] }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_INPUT");
});

test("invalid JSON body returns 400", async () => {
  const res = await fetch(`${base}/memories`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: "not json",
  });
  assert.equal(res.status, 400);
});

test("unknown route returns 404", async () => {
  const res = await fetch(`${base}/nope`, { headers: { "x-api-key": "test-key" } });
  assert.equal(res.status, 404);
});

test("agent HTTP context is supplied by the host resolver", async (t) => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-http-agent-"));
  const agentService = new MemoryService(new MemoryStore(agentDir), { agentMode: true });
  const agentServer = createHttpServer(agentService, {
    port: 0,
    apiKey: "agent-key",
    resolveAgentContext: () => ({ agentId: "agent-a", agentType: "researcher" }),
  });
  t.after(() => agentServer.close());
  await new Promise<void>((resolve) => agentServer.once("listening", () => resolve()));
  const agentBase = `http://127.0.0.1:${(agentServer.address() as { port: number }).port}`;

  const created = await fetch(`${agentBase}/memories`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "agent-key" },
    body: JSON.stringify({
      type: "fact",
      content: "Agent private note",
      access: "private",
      provenance: { sourceType: "agent", agentId: "agent-a", agentType: "researcher" },
    }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const list = await fetch(`${agentBase}/memories`, { headers: { "x-api-key": "agent-key" } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).memories.length, 1);

  const direct = await fetch(`${agentBase}/memories/${id}`, { headers: { "x-api-key": "agent-key" } });
  assert.equal(direct.status, 200);

  const summary = await fetch(`${agentBase}/agents/agent-a`, { headers: { "x-api-key": "agent-key" } });
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).memories.private, 1);

  const search = await fetch(`${agentBase}/memories/search?query=private`, {
    headers: { "x-api-key": "agent-key" },
  });
  assert.equal(search.status, 200);
  assert.equal((await search.json()).results.length, 1);
});

test("digest without transcript returns 400", async () => {
  const res = await fetch(`${base}/memories/digest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify({ scope: "global" }),
  });
  assert.equal(res.status, 400);
});
