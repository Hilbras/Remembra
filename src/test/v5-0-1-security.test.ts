import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createTenantContext } from "../tenant.js";

async function makeService(): Promise<MemoryService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-"));
  return new MemoryService(new MemoryStore(root), { embeddingProvider: "none" });
}

function withEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function listen(service: MemoryService, apiKey: string): Promise<{ server: ReturnType<typeof createHttpServer>; base: string }> {
  const server = createHttpServer(service, { port: 0, host: "127.0.0.1", apiKey });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

test("SEC-RL-001: an unauthenticated request cannot consume the valid protected rate bucket", async (t) => {
  const restore = withEnv({ REMEMBRA_RATE_LIMIT: "1", REMEMBRA_RATE_WINDOW_MS: "60000" });
  const service = await makeService();
  const { server, base } = await listen(service, "v501-secret");
  t.after(async () => {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const unauthorized = await fetch(`${base}/memories`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${base}/memories`, {
    headers: { "x-api-key": "v501-secret" },
  });
  assert.equal(authorized.status, 200);
});

test("SEC-RL-002: rate identities are opaque and tenant-scoped", async (t) => {
  const restore = withEnv({
    REMEMBRA_RATE_LIMIT: "1",
    REMEMBRA_RATE_WINDOW_MS: "60000",
    REMEMBRA_LOG: "json",
  });
  const service = await makeService();
  const server = createHttpServer(service, {
    port: 0,
    host: "127.0.0.1",
    apiKey: "v501-secret",
    resolveTenantContext: (req) => {
      const tenant = req.headers["x-test-tenant"];
      return typeof tenant === "string" && tenant.length > 0
        ? createTenantContext({
            organizationId: tenant,
            membershipVersion: "membership-1",
            scopes: ["global"],
            capabilities: ["tenant:read"],
          })
        : undefined;
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const logs = await captureStderr(async () => {
    const tenantAFirst = await fetch(`${base}/memories`, {
      headers: { "x-api-key": "v501-secret", "x-test-tenant": "org-a" },
    });
    const tenantASecond = await fetch(`${base}/memories`, {
      headers: { "x-api-key": "v501-secret", "x-test-tenant": "org-a" },
    });
    const tenantB = await fetch(`${base}/memories`, {
      headers: { "x-api-key": "v501-secret", "x-test-tenant": "org-b" },
    });
    assert.equal(tenantAFirst.status, 200);
    assert.equal(tenantASecond.status, 429);
    assert.equal(tenantB.status, 200);
  });

  assert.ok(!logs.includes("v501-secret"), "raw API key must not be logged");
  assert.ok(logs.includes("rate_limit"));
});
