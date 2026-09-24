import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../store.js";
import { StoreInput } from "../types.js";
import type { TenantFilter } from "../tenant.js";

function input(content: string, scope = "project/p1"): StoreInput {
  return StoreInput.parse({ type: "fact", content, scope });
}

test("file backend isolates tenant reads, writes, lifecycle, and history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-file-"));
  const store = new MemoryStore(root);
  const tenantA: TenantFilter = { organizationId: "org-a", projectId: "p1" };
  const tenantB: TenantFilter = { organizationId: "org-b", projectId: "p1" };

  const a = await store.store(input("Tenant A secret"), undefined, tenantA);
  const b = await store.store(input("Tenant B secret"), undefined, tenantB);
  assert.equal((await store.get(a.id, tenantA))?.content, "Tenant A secret");
  assert.equal(await store.get(a.id, tenantB), null);
  assert.deepEqual((await store.all(false, tenantA)).map((m) => m.id), [a.id]);
  assert.deepEqual((await store.all(false, tenantB)).map((m) => m.id), [b.id]);
  assert.equal((await store.all()).length, 0, "legacy reads never enumerate tenant namespaces");

  const tenantFile = path.join(root, "tenants", "tenant_b3JnLWE", "scopes", "project", "p1", `${a.id}.md`);
  await fs.access(tenantFile);

  const current = (await store.get(a.id, tenantA))!;
  const updated = await store.update({ ...current, content: "Tenant A updated" }, undefined, tenantA);
  assert.equal(updated.content, "Tenant A updated");
  await assert.rejects(
    () => store.update({ ...current, content: "cross tenant" }, undefined, tenantB),
    (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
  );
  assert.equal(await store.forget(a.id, tenantB), false);
  assert.equal(await store.archive(a.id, tenantB), null);
  assert.equal((await store.history(a.id, tenantA)).length, 1);
  assert.equal((await store.history(a.id, tenantB)).length, 0);
  assert.ok(await store.archive(a.id, tenantA));
  assert.equal(await store.revive(a.id, tenantB), null);
  assert.ok(await store.revive(a.id, tenantA));

  assert.equal(await store.importMemory({ ...a, id: "22345678-1234-4234-8234-123456789abc" }, tenantB), false);
  assert.equal(await store.importMemory({ ...a, id: "32345678-1234-4234-8234-123456789abc" }), false);
  await fs.rm(root, { recursive: true, force: true });
});
