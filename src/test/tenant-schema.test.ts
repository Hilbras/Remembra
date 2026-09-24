import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { render, MemoryStore } from "../store.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { SCHEMA_VERSION, TENANT_SCHEMA_VERSION, SnapshotInput, type Memory } from "../types.js";

function memory(overrides: Partial<Memory> = {}): Memory {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "12345678-1234-4234-8234-123456789abc",
    type: "fact",
    content: "Tenant schema round trip",
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("tenant records use V5 frontmatter while legacy records remain V4.9-compatible", async () => {
  const legacy = render(memory());
  assert.match(legacy, new RegExp(`version: ${SCHEMA_VERSION}\\b`));
  assert.doesNotMatch(legacy, /tenantId:/);

  const tenant = render(memory({ tenantId: "org_01", projectId: "project.alpha", userId: "user-1", agentId: "agent-1" }));
  assert.match(tenant, new RegExp(`version: ${TENANT_SCHEMA_VERSION}\\b`));
  assert.match(tenant, /tenantId: org_01/);
  assert.match(tenant, /projectId: project\.alpha/);
  assert.match(tenant, /userId: user-1/);
  assert.match(tenant, /agentId: agent-1/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-schema-"));
  const store = new MemoryStore(dir);
  await store.importMemory(
    memory({ tenantId: "org_01", projectId: "project.alpha" }),
    { organizationId: "org_01", projectId: "project.alpha" },
  );
  const loaded = await store.get("12345678-1234-4234-8234-123456789abc", {
    organizationId: "org_01",
    projectId: "project.alpha",
  });
  assert.equal(loaded?.tenantId, "org_01");
  assert.equal(loaded?.projectId, "project.alpha");
  await fs.rm(dir, { recursive: true, force: true });
});

test("SQLite preserves optional V5 tenant metadata and V4 rows remain readable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-sqlite-"));
  const store = new SqliteBackend({ root: dir });
  const tenant = memory({ tenantId: "org_01", projectId: "project.alpha", userId: "user-1", agentId: "agent-1" });
  assert.equal(await store.importMemory(tenant), true);
  const loaded = await store.get(tenant.id);
  assert.equal(loaded?.tenantId, "org_01");
  assert.equal(loaded?.projectId, "project.alpha");
  assert.equal(loaded?.userId, "user-1");
  assert.equal(loaded?.agentId, "agent-1");
  if (!loaded) throw new Error("expected tenant memory");
  const updated = await store.update({ ...loaded, content: "Updated tenant metadata" });
  assert.equal(updated.tenantId, "org_01");
  assert.equal(updated.projectId, "project.alpha");
  assert.equal(updated.agentId, "agent-1");

  const legacy = memory({ id: "legacy1234", tenantId: undefined, projectId: undefined, userId: undefined, agentId: undefined });
  assert.equal(await store.importMemory(legacy), true);
  assert.equal((await store.get(legacy.id))?.tenantId, undefined);
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("snapshot schema accepts tenant metadata but rejects malformed identifiers", () => {
  const base = memory({ tenantId: "org_01" });
  const parsed = SnapshotInput.parse({
    format: "remembra-export",
    version: TENANT_SCHEMA_VERSION,
    exportedAt: base.updatedAt,
    memories: [base],
  });
  assert.equal(parsed.memories[0].tenantId, "org_01");
  assert.throws(() => SnapshotInput.parse({
    format: "remembra-export",
    version: TENANT_SCHEMA_VERSION,
    exportedAt: base.updatedAt,
    memories: [{ ...base, tenantId: "../escape" }],
  }));
});
