import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";

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

  const missing = await fetch(`${base}/api/v1/does-not-exist`, {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-remembra-api-version"), "v1");
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
