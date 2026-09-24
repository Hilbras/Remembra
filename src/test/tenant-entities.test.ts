import { test } from "node:test";
import assert from "node:assert/strict";
import { TenantEntityService, type TenantEntityAuditEvent } from "../tenant-entities.js";
import { InMemoryTenantDirectory } from "../tenant-directory.js";
import { createTenantContext } from "../tenant.js";
import { RemembraError } from "../errors.js";

function context(
  organizationId: string,
  membershipVersion: string,
  extra: Record<string, unknown> = {},
  capabilities = ["tenant:read", "tenant:admin"],
) {
  const hasDimension = Boolean(extra.userId || extra.projectId || extra.agentId);
  return createTenantContext({
    organizationId,
    membershipVersion,
    capabilities,
    ...(hasDimension ? { scopes: extra.projectId ? [`project/${String(extra.projectId)}`] : ["global"] } : {}),
    ...extra,
  });
}

test("tenant organization provisioning is default-deny and host-authorized", async () => {
  const directory = new InMemoryTenantDirectory();
  const events: TenantEntityAuditEvent[] = [];
  const denied = new TenantEntityService(directory, { audit: (event) => { events.push(event); } });
  await assert.rejects(
    () => denied.provisionOrganization("org-a"),
    (error: unknown) => error instanceof RemembraError && error.code === "TENANT_REQUIRED",
  );
  const eventsBefore = events.length;
  const authorized = new TenantEntityService(directory, {
    authorizeBootstrap: (organizationId) => organizationId === "org-a",
    audit: (event) => { events.push(event); },
  });
  assert.deepEqual(await authorized.provisionOrganization("org-a"), { organizationId: "org-a", membershipVersion: "1" });
  assert.equal(events.length, eventsBefore + 1);
  assert.equal(events.at(-1)?.kind, "organization");
  await assert.rejects(
    () => authorized.provisionOrganization("org-a"),
    (error: unknown) => error instanceof RemembraError && error.code === "CONFLICT",
  );
  await assert.rejects(
    () => authorized.provisionOrganization("../bad"),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
});

test("tenant entity service derives organization, paginates, and audits membership CRUD", async () => {
  const directory = new InMemoryTenantDirectory();
  directory.createOrganization("org-a");
  directory.createOrganization("org-b");
  const events: TenantEntityAuditEvent[] = [];
  const service = new TenantEntityService(directory, { audit: (event) => { events.push(event); } });
  let version = await directory.getMembershipVersion("org-a")!;
  const admin = () => context("org-a", version);

  await service.createUser(admin(), { userId: "user-a", displayName: "A" });
  version = await directory.getMembershipVersion("org-a")!;
  await service.createUser(context("org-a", version), { userId: "user-b" });
  version = await directory.getMembershipVersion("org-a")!;
  await service.createUser(context("org-a", version), { userId: "user-c" });
  version = await directory.getMembershipVersion("org-a")!;
  await service.createProject(context("org-a", version), { projectId: "project-a" });
  version = await directory.getMembershipVersion("org-a")!;
  await service.createAgent(context("org-a", version), { agentId: "agent-a", userId: "user-a", projectId: "project-a" });
  version = await directory.getMembershipVersion("org-a")!;
  await service.grantProjectMembership(context("org-a", version), {
    projectId: "project-a",
    userId: "user-a",
    role: "member",
  });
  version = await directory.getMembershipVersion("org-a")!;
  const membershipPage = await service.listProjectMembers(context("org-a", version), "project-a");
  assert.deepEqual(membershipPage.items.map((membership) => [membership.userId, membership.role]), [["user-a", "member"]]);

  const page = await service.list(context("org-a", version), "user", { offset: 1, limit: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.offset, 1);
  assert.equal(page.limit, 2);
  assert.deepEqual(page.items.map((entity) => entity.kind === "user" ? entity.userId : ""), ["user-b", "user-c"]);

  const scoped = context("org-a", version, { userId: "user-a", projectId: "project-a" }, ["tenant:read"]);
  assert.deepEqual((await service.list(scoped, "user")).items.map((entity) => entity.kind === "user" ? entity.userId : ""), ["user-a"]);
  assert.deepEqual((await service.list(scoped, "project")).items.map((entity) => entity.kind === "project" ? entity.projectId : ""), ["project-a"]);
  await assert.rejects(
    () => service.createUser(scoped, { userId: "user-d" }),
    (error: unknown) => error instanceof RemembraError && error.code === "TENANT_REQUIRED",
  );
  await assert.rejects(
    () => service.list(context("org-a", version), "user", { limit: 101 }),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => service.get(context("org-a", version), "user", "missing"),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );
  assert.ok(events.some((event) => event.action === "grant" && event.kind === "membership"));
  assert.ok(events.every((event) => event.organizationId === "org-a" && event.membershipVersion));
});

test("tenant entity service rejects stale, cross-tenant, and dangling references", async () => {
  const directory = new InMemoryTenantDirectory();
  directory.createOrganization("org-a");
  directory.createOrganization("org-b");
  const service = new TenantEntityService(directory);
  const initial = context("org-a", "1");
  await service.createUser(initial, { userId: "user-a" });
  const stale = initial;
  const currentVersion = await directory.getMembershipVersion("org-a")!;
  await assert.rejects(
    () => service.list(stale, "user"),
    (error: unknown) => error instanceof RemembraError && error.code === "TENANT_REQUIRED",
  );
  const current = context("org-a", currentVersion);
  assert.equal((await service.get(current, "user", "user-a")).kind, "user");
  const orgBVersion = await directory.getMembershipVersion("org-b")!;
  const orgB = context("org-b", orgBVersion);
  await service.createUser(orgB, { userId: "user-b" });
  const orgAVersion = await directory.getMembershipVersion("org-a")!;
  await assert.rejects(
    () => service.get(context("org-a", orgAVersion), "user", "user-b"),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => service.createAgent(current, { agentId: "agent-a", userId: "missing" }),
    (error: unknown) => error instanceof RemembraError && error.code === "NOT_FOUND",
  );
});
