import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertAuthorized,
  evaluateAuthorization,
} from "../authorization.js";
import { formatToolError, RemembraError } from "../errors.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { StoreInput } from "../types.js";
import {
  createTenantContext,
  memoryBelongsToTenant,
  parseTenantFilter,
  tenantFilterFromContext,
  type TenantFilter,
} from "../tenant.js";

test("SEC-AUTH-001: scoped tenant filters enforce user and agent dimensions", () => {
  const filter = parseTenantFilter({
    organizationId: "org-a",
    projectId: "project-a",
    userId: "user-a",
    agentId: "agent-a",
    organizationWide: false,
  });
  assert.equal(
    memoryBelongsToTenant(
      { tenantId: "org-a", projectId: "project-a", userId: "user-a", agentId: "agent-a" },
      filter,
    ),
    true,
  );
  assert.equal(
    memoryBelongsToTenant(
      { tenantId: "org-a", projectId: "project-a", userId: "user-b", agentId: "agent-a" },
      filter,
    ),
    false,
  );
  assert.equal(
    memoryBelongsToTenant(
      { tenantId: "org-a", projectId: "project-a", userId: "user-a", agentId: "agent-b" },
      filter,
    ),
    false,
  );
});

test("SEC-AUTH-001: a missing selector does not widen a scoped principal", () => {
  const filter = parseTenantFilter({
    organizationId: "org-a",
    projectId: "project-a",
    organizationWide: false,
  });
  assert.equal(memoryBelongsToTenant({ tenantId: "org-a", projectId: "project-a" }, filter), true);
  assert.equal(memoryBelongsToTenant({ tenantId: "org-a", projectId: "project-a", userId: "user-a" }, filter), false);
  assert.equal(memoryBelongsToTenant({ tenantId: "org-a", projectId: "project-a", agentId: "agent-a" }, filter), false);
});

test("SEC-AUTH-002: explicit organization-wide access is distinct from scoped access", () => {
  const context = createTenantContext({
    organizationId: "org-a",
    membershipVersion: "membership-1",
    capabilities: ["tenant:read", "tenant:write"],
  });
  const filter = tenantFilterFromContext(context);
  assert.equal(filter.organizationWide, true);
  assert.equal(memoryBelongsToTenant({ tenantId: "org-a", userId: "user-a" }, filter), true);
  assert.equal(memoryBelongsToTenant({ tenantId: "org-b", userId: "user-a" }, filter), false);

  const scoped = createTenantContext({
    organizationId: "org-a",
    projectId: "project-a",
    membershipVersion: "membership-1",
    scopes: ["project/project-a"],
    capabilities: ["tenant:read"],
  });
  assert.equal(tenantFilterFromContext(scoped).organizationWide, false);
});

test("SEC-AUTH-002: the central evaluator default-denies and maps capabilities to operations", () => {
  const readOnly = createTenantContext({
    organizationId: "org-a",
    membershipVersion: "membership-1",
    capabilities: ["tenant:read"],
  });
  const writer = createTenantContext({
    organizationId: "org-a",
    membershipVersion: "membership-1",
    capabilities: ["tenant:read", "tenant:write"],
  });
  const admin = createTenantContext({
    organizationId: "org-a",
    membershipVersion: "membership-1",
    capabilities: ["tenant:read", "tenant:write", "tenant:admin"],
  });

  assert.deepEqual(evaluateAuthorization(undefined, "memory.read"), {
    allowed: false,
    reason: "missing_context",
  });
  assert.deepEqual(evaluateAuthorization(readOnly, "memory.read"), { allowed: true });
  assert.deepEqual(evaluateAuthorization(readOnly, "memory.write"), {
    allowed: false,
    reason: "missing_capability",
  });
  assert.deepEqual(evaluateAuthorization(readOnly, "snapshot.create"), {
    allowed: false,
    reason: "missing_capability",
  });
  assert.deepEqual(evaluateAuthorization(writer, "snapshot.create"), {
    allowed: false,
    reason: "missing_capability",
  });
  assert.deepEqual(evaluateAuthorization(admin, "snapshot.create"), { allowed: true });
  assert.deepEqual(evaluateAuthorization(writer, "memory.write"), { allowed: true });
  assert.deepEqual(evaluateAuthorization(writer, "tenant.manage"), {
    allowed: false,
    reason: "missing_capability",
  });
  assert.deepEqual(evaluateAuthorization(admin, "tenant.manage"), { allowed: true });
});

test("SEC-AUTH-005: public tool errors sanitize provider diagnostics", () => {
  const secret = "https://provider.internal/v1?token=secret response-body stack";
  assert.equal(
    formatToolError(new RemembraError("LLM_ERROR", secret)),
    "[LLM_ERROR] The provider request failed.",
  );
  assert.equal(
    formatToolError(new RemembraError("PROVIDER_TIMEOUT", secret)),
    "[PROVIDER_TIMEOUT] The provider request timed out.",
  );
  assert.equal(
    formatToolError(new RemembraError("IO_ERROR", secret)),
    "[IO_ERROR] The server could not complete the request.",
  );
});

test("SEC-AUTH-001: the central evaluator applies the same dimension predicate as storage", () => {
  const scoped = createTenantContext({
    organizationId: "org-a",
    projectId: "project-a",
    userId: "user-a",
    agentId: "agent-a",
    membershipVersion: "membership-1",
    scopes: ["project/project-a", "agent/agent-a"],
    capabilities: ["tenant:read", "tenant:write"],
  });
  assert.deepEqual(
    evaluateAuthorization(scoped, "memory.read", {
      tenantId: "org-a",
      projectId: "project-a",
      userId: "user-a",
      agentId: "agent-a",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateAuthorization(scoped, "memory.read", {
      tenantId: "org-a",
      projectId: "project-a",
      userId: "user-b",
      agentId: "agent-a",
    }),
    { allowed: false, reason: "dimension_mismatch" },
  );
  assert.throws(
    () => assertAuthorized(scoped, "memory.read", { tenantId: "org-a", userId: "user-b" }),
    (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
  );
});

function input(content: string): StoreInput {
  return StoreInput.parse({ type: "fact", content, scope: "global" });
}

test("SEC-AUTH-001: MemoryService applies the centralized user and agent policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-auth-service-"));
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: Buffer.from("v502 authorization snapshot key"),
  });
  const userA = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  });
  const userB = createTenantContext({
    organizationId: "org-a",
    userId: "user-b",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  });
  const agentA = createTenantContext({
    organizationId: "org-a",
    agentId: "agent-a",
    membershipVersion: "membership-1",
    scopes: ["agent/agent-a"],
    capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  });
  try {
    const userMemory = (await service.store(input("service user A"), { tenant: userA })).memory;
    await service.store(input("service user B"), { tenant: userB });
    const agentMemory = (await service.store(input("service agent A"), { tenant: agentA })).memory;

    assert.equal((await service.get(userMemory.id, { tenant: userA })).memory.content, "service user A");
    await assert.rejects(
      () => service.get(userMemory.id, { tenant: userB }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
    assert.equal((await service.search({ query: "service", tenant: userA })).results.length, 1);
    assert.equal((await service.search({ query: "service", tenant: userB })).results.length, 1);
    assert.equal((await service.exportSnapshot({ tenant: userA })).memories.length, 1);
    assert.equal((await service.exportSnapshot({ tenant: agentA })).memories.length, 1);
    assert.equal((await service.get(agentMemory.id, { tenant: agentA })).memory.content, "service agent A");
    await assert.rejects(
      () => service.update(userMemory.id, { content: "cross-user service write" }, { tenant: userB }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-AUTH-001: file backend applies user and agent filters to every data-plane path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-auth-file-"));
  const store = new MemoryStore(root);
  const userA: TenantFilter = { organizationId: "org-a", userId: "user-a", organizationWide: false };
  const userB: TenantFilter = { organizationId: "org-a", userId: "user-b", organizationWide: false };
  const agentA: TenantFilter = { organizationId: "org-a", agentId: "agent-a", organizationWide: false };
  const agentB: TenantFilter = { organizationId: "org-a", agentId: "agent-b", organizationWide: false };
  try {
    const userMemory = await store.store(input("user A private memory"), undefined, userA);
    const otherUserMemory = await store.store(input("user B private memory"), undefined, userB);
    const agentMemory = await store.store(input("agent A private memory"), undefined, agentA);
    const otherAgentMemory = await store.store(input("agent B private memory"), undefined, agentB);

    assert.equal((await store.get(userMemory.id, userA))?.content, "user A private memory");
    assert.equal(await store.get(userMemory.id, userB), null);
    assert.equal(await store.get(agentMemory.id, agentB), null);
    assert.deepEqual((await store.all(false, userA)).map((memory) => memory.id), [userMemory.id]);
    assert.deepEqual((await store.all(false, userB)).map((memory) => memory.id), [otherUserMemory.id]);
    assert.deepEqual((await store.all(false, agentA)).map((memory) => memory.id), [agentMemory.id]);
    assert.deepEqual((await store.all(false, agentB)).map((memory) => memory.id), [otherAgentMemory.id]);

    const current = (await store.get(userMemory.id, userA))!;
    await assert.rejects(
      () => store.update({ ...current, content: "cross-user write" }, undefined, userB),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
    assert.equal((await store.history(userMemory.id, userA)).length, 0);
    assert.equal((await store.history(userMemory.id, userB)).length, 0);
    assert.equal(await store.forget(userMemory.id, userB), false);
    assert.equal(await store.archive(userMemory.id, userB), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-AUTH-001: SQLite applies user and agent filters before candidates, counts, history, and audit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-auth-sqlite-"));
  const store = new SqliteBackend({ root });
  const userA: TenantFilter = { organizationId: "org-a", userId: "user-a", organizationWide: false };
  const userB: TenantFilter = { organizationId: "org-a", userId: "user-b", organizationWide: false };
  const agentA: TenantFilter = { organizationId: "org-a", agentId: "agent-a", organizationWide: false };
  const agentB: TenantFilter = { organizationId: "org-a", agentId: "agent-b", organizationWide: false };
  try {
    const userMemory = await store.store(input("user A sqlite memory"), undefined, userA);
    const otherUserMemory = await store.store(input("user B sqlite memory"), undefined, userB);
    const agentMemory = await store.store(input("agent A sqlite memory"), undefined, agentA);
    await store.store(input("agent B sqlite memory"), undefined, agentB);

    assert.equal((await store.get(userMemory.id, userA))?.content, "user A sqlite memory");
    assert.equal(await store.get(userMemory.id, userB), null);
    assert.equal(await store.get(agentMemory.id, agentB), null);
    assert.deepEqual((await store.all(false, userA)).map((memory) => memory.id), [userMemory.id]);
    assert.deepEqual((await store.all(false, userB)).map((memory) => memory.id), [otherUserMemory.id]);

    const candidates = await store.searchCandidates({
      terms: ["sqlite"],
      vector: null,
      now: Date.now(),
      resultLimit: 10,
      maxCandidates: 20,
      eligible: () => true,
      tenant: userA,
    });
    assert.equal(candidates.totalDocs, 1);
    assert.deepEqual(candidates.memories.map((memory) => memory.id), [userMemory.id]);

    const current = (await store.get(userMemory.id, userA))!;
    await assert.rejects(
      () => store.update({ ...current, content: "cross-user sqlite write" }, undefined, userB),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
    assert.equal((await store.history(userMemory.id, userA)).length, 0);
    assert.equal((await store.history(userMemory.id, userB)).length, 0);
    assert.equal((await store.getAudit({ limit: 20 }, userA)).some((event) => event.memory_id === userMemory.id), true);
    assert.equal((await store.getAudit({ limit: 20 }, userB)).some((event) => event.memory_id === userMemory.id), false);
    assert.equal(await store.forget(userMemory.id, userB), false);
    assert.equal(await store.archive(userMemory.id, userB), null);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
