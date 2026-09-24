import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteBackend, SQLITE_SCHEMA_SQL } from "../sqlite-backend.js";
import { StoreInput } from "../types.js";
import type { TenantFilter } from "../tenant.js";

function input(content: string, scope = "project/p1"): StoreInput {
  return StoreInput.parse({ type: "fact", content, scope });
}

test("SQLite scopes point operations and keeps tenant rows out of legacy reads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-sqlite-"));
  const store = new SqliteBackend({ root });
  const tenantA: TenantFilter = { organizationId: "org-a", projectId: "p1" };
  const tenantB: TenantFilter = { organizationId: "org-b", projectId: "p1" };
  const a = await store.store(input("SQLite tenant A secret"), undefined, tenantA);
  const b = await store.store(input("SQLite tenant B secret"), undefined, tenantB);

  assert.equal((await store.get(a.id, tenantA))?.content, "SQLite tenant A secret");
  assert.equal(await store.get(a.id, tenantB), null);
  assert.deepEqual((await store.all(false, tenantA)).map((m) => m.id), [a.id]);
  assert.deepEqual((await store.all(false, tenantB)).map((m) => m.id), [b.id]);
  assert.equal((await store.all()).length, 0);

  const current = (await store.get(a.id, tenantA))!;
  const updated = await store.update({ ...current, content: "SQLite tenant A updated" }, undefined, tenantA);
  assert.equal(updated.content, "SQLite tenant A updated");
  assert.equal((await store.history(a.id, tenantA)).length, 1);
  assert.equal((await store.history(a.id, tenantB)).length, 0);
  assert.ok((await store.getAudit({ limit: 20 }, tenantA)).some((event) => event.memory_id === a.id));
  assert.equal((await store.getAudit({ limit: 20 }, tenantB)).some((event) => event.memory_id === a.id), false);
  assert.equal((await store.getAudit({ limit: 20 })).some((event) => event.memory_id === a.id), false);
  assert.ok(store.ftsSearch("updated", tenantA).includes(a.id));
  assert.equal(store.ftsSearch("secret", tenantB).includes(a.id), false);
  await assert.rejects(
    () => store.update({ ...current, content: "cross tenant" }, undefined, tenantB),
    (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
  );
  assert.equal(await store.forget(a.id, tenantB), false);
  assert.equal(await store.archive(a.id, tenantB), null);
  assert.equal(await store.importMemory({ ...a, id: "42345678-1234-4234-8234-123456789abc" }, tenantB), false);

  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("SQLite candidate SQL applies tenant and project predicates before limits/counts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-candidate-"));
  const store = new SqliteBackend({ root });
  const tenantA: TenantFilter = { organizationId: "org-a", projectId: "p1" };
  const tenantB: TenantFilter = { organizationId: "org-b", projectId: "p1" };
  await store.store(input("needle tenant A"), undefined, tenantA);
  for (let i = 0; i < 8; i++) {
    await store.store(input(`needle tenant B ${i}`), undefined, tenantB);
  }
  const page = await store.searchCandidates({
    terms: ["needle"],
    vector: null,
    now: Date.now(),
    resultLimit: 1,
    maxCandidates: 10,
    eligible: (memory) => memory.tenantId === "org-a" && memory.projectId === "p1",
    tenant: tenantA,
  });
  assert.equal(page.coverage, "complete");
  assert.equal(page.totalDocs, 1);
  assert.equal(page.memories.length, 1);
  assert.equal(page.memories[0].tenantId, "org-a");

  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("SQLite reopens a pre-tenant database before creating tenant indexes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-legacy-sqlite-"));
  const dbPath = path.join(root, "data.sqlite");
  const legacySql = SQLITE_SCHEMA_SQL
    .replace(/\n  tenant_id         TEXT,/g, "")
    .replace(/\n  project_id        TEXT,/g, "")
    .replace(/\n  user_id           TEXT,/g, "")
    .replace(/\n  agent_id          TEXT,/g, "")
    .replace(/\n  tenant_id  TEXT,/g, "")
    .replace(/\n  project_id TEXT,/g, "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_tenant[^;]*;/g, "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_versions_tenant[^;]*;/g, "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_audit_tenant[^;]*;/g, "");
  const legacy = new Database(dbPath);
  legacy.exec(legacySql);
  legacy.close();

  const store = new SqliteBackend({ root });
  const sqlite = store as unknown as { db: { pragma: (sql: string) => Array<{ name: string }> } };
  assert.ok(sqlite.db.pragma("table_info(memories)").some((column) => column.name === "tenant_id"));
  assert.ok(sqlite.db.pragma("table_info(memory_versions)").some((column) => column.name === "tenant_id"));
  assert.ok(sqlite.db.pragma("table_info(memory_audit)").some((column) => column.name === "tenant_id"));
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});
