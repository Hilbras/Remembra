import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { InMemoryTenantDirectory } from "../tenant-directory.js";
import { TenantEntityService } from "../tenant-entities.js";
import { createTenantContext } from "../tenant.js";

function adminContext(version: string) {
  return createTenantContext({
    organizationId: "org-a",
    membershipVersion: version,
    capabilities: ["tenant:read", "tenant:admin"],
  });
}

function projectContext(version: string) {
  return createTenantContext({
    organizationId: "org-a",
    membershipVersion: version,
    userId: "user-a",
    projectId: "project-a",
    scopes: ["project/project-a"],
    capabilities: ["tenant:read"],
  });
}

test("HTTP tenant entity routes use trusted context, bounded pagination, and reserved-field rejection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-entities-http-"));
  const directory = new InMemoryTenantDirectory();
  directory.createOrganization("org-a");
  const entities = new TenantEntityService(directory);
  const memoryService = new MemoryService(new MemoryStore(path.join(root, "memory")), {
    tenantMode: "strict",
    embeddingProvider: "none",
  });
  let version = "1";
  let currentContext = adminContext(version);
  const instance = createHttpServer(memoryService, {
    port: 0,
    apiKey: "entity-key",
    tenantEntities: entities,
    resolveTenantContext: () => currentContext,
  });
  await new Promise<void>((resolve) => instance.once("listening", () => resolve()));
  const address = instance.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, init: RequestInit = {}) => fetch(`${base}${route}`, {
    ...init,
    headers: { "x-api-key": "entity-key", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const syncVersion = async () => {
    version = (await directory.getMembershipVersion("org-a"))!;
    currentContext = adminContext(version);
  };

  try {
    const organization = await request("/api/v1/tenant/organization");
    assert.equal(organization.status, 200);
    assert.deepEqual(await organization.json(), { organizationId: "org-a", membershipVersion: "1" });

    const user = await request("/api/v1/tenant/entities/user/user-a", {
      method: "POST",
      body: JSON.stringify({ displayName: "User A" }),
    });
    assert.equal(user.status, 201);
    assert.equal(((await user.json()) as { userId: string }).userId, "user-a");
    await syncVersion();

    const project = await request("/api/v1/tenant/entities/project/project-a", {
      method: "POST",
      body: JSON.stringify({ displayName: "Project A" }),
    });
    assert.equal(project.status, 201);
    await syncVersion();

    const grant = await request("/api/v1/tenant/memberships/project-a/user-a", {
      method: "POST",
      body: JSON.stringify({ role: "member" }),
    });
    assert.equal(grant.status, 200);
    await syncVersion();

    const agent = await request("/api/v1/tenant/entities/agent/agent-a", {
      method: "POST",
      body: JSON.stringify({ userRef: "user-a", projectRef: "project-a" }),
    });
    assert.equal(agent.status, 201);
    await syncVersion();

    const users = await request("/api/v1/tenant/entities/user?limit=1&offset=0");
    assert.equal(users.status, 200);
    const usersBody = await users.json() as { items: Array<{ userId: string }>; total: number; limit: number };
    assert.equal(usersBody.total, 1);
    assert.equal(usersBody.items[0].userId, "user-a");

    const tooLargePage = await request("/api/v1/tenant/entities/user?limit=101");
    assert.equal(tooLargePage.status, 400);

    const forgedQuery = await request("/api/v1/tenant/entities/user?organizationId=org-b");
    assert.equal(forgedQuery.status, 400);
    const forgedBody = await request("/api/v1/tenant/entities/user/user-b", {
      method: "POST",
      body: JSON.stringify({ displayName: "forged", organizationId: "org-b" }),
    });
    assert.equal(forgedBody.status, 400);

    currentContext = projectContext(version);
    const scopedUsers = await request("/api/v1/tenant/entities/user");
    assert.equal(scopedUsers.status, 200);
    assert.deepEqual((await scopedUsers.json() as { items: Array<{ userId: string }> }).items.map((item) => item.userId), ["user-a"]);
    const forbidden = await request("/api/v1/tenant/entities/user/user-c", {
      method: "POST",
      body: JSON.stringify({ displayName: "forbidden" }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(((await forbidden.json()) as { code?: string }).code, "TENANT_REQUIRED");
  } finally {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP entity routes fail closed without a trusted tenant resolver", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-entities-http-fail-"));
  const directory = new InMemoryTenantDirectory();
  directory.createOrganization("org-a");
  const instance = createHttpServer(
    new MemoryService(new MemoryStore(path.join(root, "memory")), { tenantMode: "strict", embeddingProvider: "none" }),
    { port: 0, apiKey: "entity-key", tenantEntities: new TenantEntityService(directory) },
  );
  await new Promise<void>((resolve) => instance.once("listening", () => resolve()));
  const address = instance.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tenant/entities/user`, {
      headers: { "x-api-key": "entity-key" },
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: string }).code, "TENANT_REQUIRED");
  } finally {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
