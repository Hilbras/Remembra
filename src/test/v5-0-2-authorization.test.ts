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
import { defaultMemoryPolicy } from "../policy.js";
import { createSignedSnapshot } from "../snapshot-integrity.js";
import { planTenantMigration } from "../tenant-migration-runner.js";
import { SNAPSHOT_FORMAT } from "../types.js";
import { MemoryService } from "../service.js";
import { InMemoryTenantDirectory } from "../tenant-directory.js";
import { TenantEntityService } from "../tenant-entities.js";
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
  const directFilter = parseTenantFilter({ organizationId: "org-a", projectId: "project-a" });
  assert.equal(memoryBelongsToTenant({ tenantId: "org-a", projectId: "project-a", userId: "user-a" }, directFilter), false);
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
  const scopedAdmin = createTenantContext({
    organizationId: "org-a",
    projectId: "project-a",
    userId: "user-a",
    membershipVersion: "membership-1",
    scopes: ["project/project-a"],
    capabilities: ["tenant:read", "tenant:write", "tenant:admin"],
  });
  assert.equal(tenantFilterFromContext(scopedAdmin).organizationWide, false);
  assert.equal(
    evaluateAuthorization(scopedAdmin, "memory.read", { tenantId: "org-a", projectId: "project-a", userId: "user-b" }).allowed,
    false,
  );
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
  assert.deepEqual(evaluateAuthorization(admin, "snapshot.create"), {
    allowed: false,
    reason: "missing_capability",
  });
  const exporter = createTenantContext({
    organizationId: "org-a",
    membershipVersion: "membership-1",
    capabilities: ["tenant:read", "tenant:write", "tenant:admin", "tenant:export"],
  });
  assert.deepEqual(evaluateAuthorization(exporter, "snapshot.create"), { allowed: true });
  assert.deepEqual(evaluateAuthorization(writer, "memory.write"), { allowed: true });
  assert.deepEqual(evaluateAuthorization(writer, "tenant.manage"), {
    allowed: false,
    reason: "missing_capability",
  });
  assert.deepEqual(evaluateAuthorization(admin, "tenant.manage"), { allowed: true });
});

test("SEC-SENS-001: default sensitive-data redaction is applied by service store and update paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-redaction-"));
  const policy = defaultMemoryPolicy();
  policy.sensitiveData.action = "redact";
  const service = new MemoryService(new MemoryStore(root), { embeddingProvider: "none", policy });
  try {
    const stored = (await service.store(input("key sk-abc123def456ghi789jkl012mno345pqr"))).memory;
    assert.equal(stored.content.includes("sk-abc123def456ghi789jkl012mno345pqr"), false);
    const updated = await service.update(stored.id, { content: "password: super-secret-value" });
    assert.equal(updated.memory.content.includes("super-secret-value"), false);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-DOC-001: encryption documentation distinguishes file, SQLite, snapshot, and transport planes", async () => {
  const security = await fs.readFile("docs/security.md", "utf8");
  const storage = await fs.readFile("docs/storage.md", "utf8");
  assert.match(security, /does not encrypt SQLite/);
  assert.match(security, /Snapshot HMAC/);
  assert.match(storage, /not\s+application-level encrypted/);
  assert.doesNotMatch(storage, /Immutable audit log/);
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

test("SEC-AUTH-002: batch export requires the explicit export capability and signs strict output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-batch-export-"));
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: Buffer.from("v502 batch export snapshot key"),
  });
  const writer = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  });
  const reader = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read"],
  });
  try {
    const stored = (await service.store(input("batch export secret"), { tenant: writer })).memory;
    await assert.rejects(
      () => service.batch({ operation: "export", ids: [stored.id] }, { tenant: reader }),
      (error: unknown) => (error as { code?: string }).code === "TENANT_REQUIRED",
    );
    const exported = await service.batch({ operation: "export", ids: [stored.id] }, { tenant: writer });
    assert.equal(exported.operation, "export");
    assert.equal("integrity" in exported, true);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-AUTH-003: central authorization denies before provider work or mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-provider-gate-"));
  let embedCalls = 0;
  let extractCalls = 0;
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embedFn: async () => {
      embedCalls++;
      return [0.1, 0.2];
    },
    extractFn: async () => {
      extractCalls++;
      return [];
    },
  });
  const reader = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read"],
  });
  try {
    await assert.rejects(
      () => service.store(input("denied before embedding"), { tenant: reader }),
      (error: unknown) => (error as { code?: string }).code === "TENANT_REQUIRED",
    );
    await assert.rejects(
      () => service.digest({ transcript: "denied before extraction", tenant: reader }),
      (error: unknown) => (error as { code?: string }).code === "TENANT_REQUIRED",
    );
    assert.equal(embedCalls, 0);
    assert.equal(extractCalls, 0);
    assert.equal((await service.search({ query: "denied", tenant: reader })).results.length, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-AUTH-004: unauthorized and missing resources are externally indistinguishable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-noninformative-"));
  const service = new MemoryService(new MemoryStore(root), { tenantMode: "strict", embeddingProvider: "none" });
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
  try {
    const stored = (await service.store(input("user A non-informative secret"), { tenant: userA })).memory;
    const capture = async (id: string): Promise<{ code?: string; message?: string }> => {
      try {
        await service.get(id, { tenant: userB });
        return {};
      } catch (error) {
        const typed = error as { code?: string; message?: string };
        return { code: typed.code, message: typed.message?.replace(id, "<requested-id>") };
      }
    };
    assert.deepEqual(await capture(stored.id), await capture("82345678-1234-4234-8234-123456789abc"));
    assert.equal((await service.search({ query: "non-informative", tenant: userB })).results.length, 0);
    assert.equal((await service.list({ tenant: userB })).total, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-AUTH-001: scoped migration rejects destination records outside the trusted dimensions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-migration-scope-"));
  const key = Buffer.from("34".repeat(32), "hex");
  const source: import("../types.js").Memory = {
    id: "72345678-1234-4234-8234-123456789abc",
    type: "fact",
    content: "scoped migration secret",
    scope: "global",
    projectId: "project-old",
    userId: "user-old",
    agentId: "agent-old",
    tags: [],
    importance: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: { sourceType: "manual" },
    confidence: 1,
    trust: "trusted",
    owner: "global",
    access: "global",
    version: 1,
  };
  const snapshot = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: [source],
  }, key);
  const plan = planTenantMigration({
    source: [source],
    sourceSchemaVersion: 3,
    organizationMappings: [{ sourceNamespace: "legacy-root", destination: "org-a" }],
    entityMappings: {
      projects: [{ source: "project-old", destination: "project-b" }],
      users: [{ source: "user-old", destination: "user-b" }],
      agents: [{ source: "agent-old", destination: "agent-b" }],
    },
  }, key);
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embeddingProvider: "none",
    snapshotKey: key,
  });
  const scoped = createTenantContext({
    organizationId: "org-a",
    projectId: "project-a",
    userId: "user-a",
    agentId: "agent-a",
    membershipVersion: "membership-1",
    scopes: ["global", "project/project-a", "agent/agent-a"],
    capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  });
  try {
    await assert.rejects(
      () => service.migrateSnapshot(snapshot, plan, key, { tenant: scoped }),
      (error: unknown) => error instanceof RemembraError,
    );
    await assert.rejects(
      () => service.get(source.id, { tenant: scoped }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-AUTH-002: ordinary service requests recheck current membership before side effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v502-membership-"));
  let providerCalls = 0;
  const service = new MemoryService(new MemoryStore(root), {
    tenantMode: "strict",
    embeddingProvider: "none",
    embedFn: async () => {
      providerCalls++;
      return [0.1, 0.2];
    },
    verifyTenantContext: async () => false,
  });
  const tenant = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "stale",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write", "tenant:export"],
  });
  try {
    await assert.rejects(
      () => service.search({ query: "anything", tenant }),
      (error: unknown) => (error as { code?: string }).code === "TENANT_REQUIRED",
    );
    await assert.rejects(
      () => service.store(input("must not be stored"), { tenant }),
      (error: unknown) => (error as { code?: string }).code === "TENANT_REQUIRED",
    );
    assert.equal(providerCalls, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-AUTH-001: user and agent selectors constrain tenant entity visibility", async () => {
  const directory = InMemoryTenantDirectory.fromSnapshot({
    organizations: [{ organizationId: "org-a", membershipVersion: 1 }],
    users: [
      { organizationId: "org-a", userId: "user-a" },
      { organizationId: "org-a", userId: "user-b" },
    ],
    projects: [
      { organizationId: "org-a", projectId: "project-a" },
      { organizationId: "org-a", projectId: "project-b" },
    ],
    agents: [
      { organizationId: "org-a", agentId: "agent-a", userId: "user-a", projectId: "project-a" },
      { organizationId: "org-a", agentId: "agent-b", userId: "user-b", projectId: "project-b" },
    ],
    projectMembers: [
      { organizationId: "org-a", projectId: "project-a", userId: "user-a", role: "member" },
      { organizationId: "org-a", projectId: "project-b", userId: "user-b", role: "member" },
    ],
    projectAgents: [
      { organizationId: "org-a", projectId: "project-a", agentId: "agent-a" },
      { organizationId: "org-a", projectId: "project-b", agentId: "agent-b" },
    ],
  });
  const entities = new TenantEntityService(directory);
  const user = createTenantContext({
    organizationId: "org-a",
    userId: "user-a",
    membershipVersion: "1",
    scopes: ["global"],
    capabilities: ["tenant:read"],
  });
  const agent = createTenantContext({
    organizationId: "org-a",
    agentId: "agent-a",
    membershipVersion: "1",
    scopes: ["agent/agent-a"],
    capabilities: ["tenant:read"],
  });
  assert.deepEqual((await entities.list(user, "project")).items.map((entity) => (entity as { projectId: string }).projectId), ["project-a"]);
  assert.deepEqual((await entities.list(user, "agent")).items.map((entity) => (entity as { agentId: string }).agentId), ["agent-a"]);
  assert.deepEqual((await entities.list(agent, "user")).items.map((entity) => (entity as { userId: string }).userId), ["user-a"]);
  assert.deepEqual((await entities.list(agent, "project")).items.map((entity) => (entity as { projectId: string }).projectId), ["project-a"]);
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
    const updatedUserMemory = await store.update({ ...userMemory, content: "user A updated" }, undefined, userA);
    assert.equal(updatedUserMemory.content, "user A updated");
    assert.equal((await store.history(userMemory.id, userA)).length, 1);
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
