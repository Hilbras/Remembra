import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createTenantContext } from "../tenant.js";
import { createSignedSnapshot } from "../snapshot-integrity.js";
import { SNAPSHOT_FORMAT } from "../types.js";
import { RemembraError } from "../errors.js";

const key = Buffer.from("v501 snapshot key");
const tenant = createTenantContext({
  organizationId: "org-a",
  membershipVersion: "membership-1",
  scopes: ["global"],
  capabilities: ["tenant:read", "tenant:write"],
});

function tenantlessSnapshot() {
  return createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 4,
    exportedAt: new Date().toISOString(),
    memories: [{
      id: "42345678-1234-4234-8234-123456789abc",
      type: "fact",
      content: "tenantless secret",
      scope: "global",
      tags: [],
      importance: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, key);
}

test("SEC-SNAPSHOT-001: strict restore rejects a signed tenantless snapshot before writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-snapshot-"));
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: key,
  });
  const snapshot = tenantlessSnapshot();
  try {
    await assert.rejects(
      () => service.previewSnapshot(snapshot, { tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
    );
    await assert.rejects(
      () => service.importSnapshot(snapshot, { tenant }),
      (error: unknown) => error instanceof RemembraError && error.code === "SNAPSHOT_INVALID",
    );
    assert.equal((await service.search({ query: "tenantless", tenant })).results.length, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
