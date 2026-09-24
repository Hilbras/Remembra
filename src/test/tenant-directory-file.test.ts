import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTenantDirectory } from "../tenant-directory-file.js";
import { createTenantContext } from "../tenant.js";

function context(version: string, extra: Record<string, unknown> = {}) {
  const hasDimension = Boolean(extra.userId || extra.projectId || extra.agentId);
  return createTenantContext({
    organizationId: "org-a",
    membershipVersion: version,
    capabilities: ["tenant:read", "tenant:write"],
    ...(hasDimension ? { scopes: extra.projectId ? [`project/${String(extra.projectId)}`] : ["global"] } : {}),
    ...extra,
  });
}

async function populatedDirectory(root: string): Promise<{ directory: FileTenantDirectory; file: string }> {
  const file = path.join(root, "directory.json");
  const directory = new FileTenantDirectory(file);
  await directory.createOrganization("org-a");
  await directory.upsertUser({ organizationId: "org-a", userId: "user-a" });
  await directory.upsertProject({ organizationId: "org-a", projectId: "project-a" });
  await directory.grantProjectMembership("org-a", "project-a", "user-a");
  await directory.upsertAgent({ organizationId: "org-a", agentId: "agent-a", userId: "user-a", projectId: "project-a" });
  return { directory, file };
}

test("file tenant directory persists versioned hierarchy and resumes authorization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-directory-"));
  const { directory, file } = await populatedDirectory(root);
  assert.equal(await directory.getMembershipVersion("org-a"), "5");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await directory.verifyContext(context("5", {
    userId: "user-a",
    projectId: "project-a",
    agentId: "agent-a",
    scopes: ["project/project-a"],
  })), true);

  const reopened = new FileTenantDirectory(file);
  assert.equal(await reopened.verifyContext(context("5", { userId: "user-a" })), true);
  await reopened.revokeProjectMembership("org-a", "project-a", "user-a");
  assert.equal(await reopened.getMembershipVersion("org-a"), "6");
  assert.equal(await reopened.verifyContext(context("6", {
    userId: "user-a",
    projectId: "project-a",
    scopes: ["project/project-a"],
  })), false);

  await reopened.removeProject("org-a", "project-a");
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.agents[0].projectId, undefined);
  assert.equal((await new FileTenantDirectory(file).getMembershipVersion("org-a")), "7");
  await fs.rm(root, { recursive: true, force: true });
});

test("file tenant directory rejects malformed, oversized, and symlinked state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-directory-invalid-"));
  const file = path.join(root, "directory.json");
  const { directory } = await populatedDirectory(root);
  await directory.removeAgent("org-a", "agent-a");
  await fs.writeFile(file, "{broken", "utf8");
  await assert.rejects(() => new FileTenantDirectory(file).load(), /not valid JSON/);

  const validFile = path.join(root, "valid.json");
  const validDirectory = new FileTenantDirectory(validFile, 1024);
  await validDirectory.createOrganization("org-a");
  await fs.writeFile(validFile, `${"x".repeat(2048)}`, "utf8");
  await assert.rejects(() => new FileTenantDirectory(validFile, 1024).load(), /exceeds/);

  const symlink = path.join(root, "link.json");
  await fs.symlink(validFile, symlink);
  await assert.rejects(() => new FileTenantDirectory(symlink).load(), /symlink/);
  await fs.rm(root, { recursive: true, force: true });
});

test("membership keys remain distinct when entity ids contain separators", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-tenant-directory-keys-"));
  const directory = new FileTenantDirectory(path.join(root, "directory.json"));
  await directory.createOrganization("org-a");
  await directory.upsertUser({ organizationId: "org-a", userId: "b" });
  await directory.upsertUser({ organizationId: "org-a", userId: "a:b" });
  await directory.upsertProject({ organizationId: "org-a", projectId: "p:a" });
  await directory.upsertProject({ organizationId: "org-a", projectId: "p" });
  await directory.grantProjectMembership("org-a", "p:a", "b");
  await directory.grantProjectMembership("org-a", "p", "a:b");
  const version = await directory.getMembershipVersion("org-a");
  assert.equal(await directory.verifyContext(context(version!, {
    userId: "b",
    projectId: "p:a",
    scopes: ["project/p:a"],
  })), true);
  assert.equal(await directory.verifyContext(context(version!, {
    userId: "a:b",
    projectId: "p",
    scopes: ["project/p"],
  })), true);
  await fs.rm(root, { recursive: true, force: true });
});
