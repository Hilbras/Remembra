import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTenantDirectory } from "../tenant-directory.js";
import { createTenantContext } from "../tenant.js";

function context(directory: InMemoryTenantDirectory, organizationId: string, version: string, extra: Record<string, unknown> = {}) {
  const hasDimension = Boolean(extra.userId || extra.projectId || extra.agentId);
  return createTenantContext({
    organizationId,
    membershipVersion: version,
    capabilities: ["tenant:read", "tenant:write"],
    ...(hasDimension ? { scopes: extra.projectId ? [`project/${String(extra.projectId)}`] : ["global"] } : {}),
    ...extra,
  });
}

test("tenant directory verifies organization/project/user/agent membership and versions", () => {
  const directory = new InMemoryTenantDirectory();
  directory.createOrganization("org-a");
  directory.upsertUser({ organizationId: "org-a", userId: "user-a" });
  directory.upsertProject({ organizationId: "org-a", projectId: "project-a" });
  directory.grantProjectMembership("org-a", "project-a", "user-a");
  directory.upsertAgent({ organizationId: "org-a", agentId: "agent-a", userId: "user-a", projectId: "project-a" });

  assert.equal(directory.getMembershipVersion("org-a"), "5");
  assert.equal(directory.verifyContext(context(directory, "org-a", "5", { userId: "user-a" })), true);
  assert.equal(directory.verifyContext(context(directory, "org-a", "5", {
    userId: "user-a",
    projectId: "project-a",
    agentId: "agent-a",
    scopes: ["project/project-a"],
  })), true);
  assert.equal(directory.verifyContext(context(directory, "org-a", "3", { userId: "user-a" })), false);
  assert.equal(directory.verifyContext(context(directory, "org-b", "1")), false);

  directory.revokeProjectMembership("org-a", "project-a", "user-a");
  assert.equal(directory.verifyContext(context(directory, "org-a", "6", {
    userId: "user-a",
    projectId: "project-a",
    scopes: ["project/project-a"],
  })), false);
});

test("tenant directory rejects mismatched agent/user/project relationships", () => {
  const directory = new InMemoryTenantDirectory();
  directory.createOrganization("org-a");
  directory.upsertUser({ organizationId: "org-a", userId: "user-a" });
  directory.upsertUser({ organizationId: "org-a", userId: "user-b" });
  directory.upsertProject({ organizationId: "org-a", projectId: "project-a" });
  directory.grantProjectMembership("org-a", "project-a", "user-a");
  directory.upsertAgent({ organizationId: "org-a", agentId: "agent-a", userId: "user-b", projectId: "project-a" });
  const version = directory.getMembershipVersion("org-a")!;
  assert.equal(directory.verifyContext(context(directory, "org-a", version, {
    userId: "user-a",
    projectId: "project-a",
    agentId: "agent-a",
    scopes: ["project/project-a"],
  })), false);
  assert.throws(() => directory.upsertAgent({ organizationId: "org-a", agentId: "agent-b", projectId: "missing" }), /not found/);
});
