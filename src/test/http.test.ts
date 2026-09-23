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
