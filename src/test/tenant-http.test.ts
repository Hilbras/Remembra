import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createTenantContext } from "../tenant.js";

function context(organizationId: string) {
  return createTenantContext({
    organizationId,
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write"],
  });
}

async function server(service: MemoryService, resolveTenantContext?: (req: unknown) => unknown) {
  const instance = createHttpServer(service, {
    port: 0,
    apiKey: "tenant-key",
    resolveTenantContext: resolveTenantContext as never,
  });
  await new Promise<void>((resolve) => instance.once("listening", () => resolve()));
  const address = instance.address() as { port: number };
  return { instance, base: `http://127.0.0.1:${address.port}` };
}

test("HTTP resolves tenant only through the trusted callback and ignores public tenant headers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-http-"));
  const service = new MemoryService(new MemoryStore(root), { tenantMode: "strict", embeddingProvider: "none" });
  const tenant = context("org-a");
  const { instance, base } = await server(service, () => tenant);
  try {
    const stored = await fetch(`${base}/api/v1/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "tenant-key", "x-remembra-tenant": "org-b" },
      body: JSON.stringify({ type: "fact", content: "HTTP tenant memory", scope: "global" }),
    });
    assert.equal(stored.status, 201);
    const storedBody = await stored.json() as { memory: { tenantId: string } };
    assert.equal(storedBody.memory.tenantId, "org-a");

    const found = await fetch(`${base}/api/v1/memories/search?query=tenant`, {
      headers: { "x-api-key": "tenant-key", "x-remembra-tenant": "org-b" },
    });
    assert.equal(found.status, 200);
    const foundBody = await found.json() as { results: Array<{ tenantId: string }> };
    assert.equal(foundBody.results[0].tenantId, "org-a");
  } finally {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP strict mode fails closed without a trusted tenant resolver", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-http-fail-"));
  const service = new MemoryService(new MemoryStore(root), { tenantMode: "strict", embeddingProvider: "none" });
  const { instance, base } = await server(service);
  try {
    const health = await fetch(`${base}/api/v1/health`);
    assert.equal(health.status, 200);
    const response = await fetch(`${base}/api/v1/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "tenant-key" },
      body: JSON.stringify({ type: "fact", content: "must fail closed" }),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: string }).code, "TENANT_REQUIRED");
  } finally {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
