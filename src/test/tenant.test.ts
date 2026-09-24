import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTenantContext,
  createTenantContext,
  isTenantContext,
  memoryBelongsToTenant,
  parseTenantFilter,
  parseTenantPrincipal,
  tenantDirectoryKey,
  tenantFilterFromContext,
} from "../tenant.js";
import { RemembraError } from "../errors.js";

test("tenant principals validate opaque identifiers and trusted dimensions", () => {
  const principal = parseTenantPrincipal({
    organizationId: "org_01",
    userId: "user-1",
    projectId: "project.alpha",
    agentId: "agent:writer",
    membershipVersion: "membership-7",
    scopes: ["project/project.alpha", "task/run-1"],
    capabilities: ["tenant:read", "tenant:write"],
  });
  assert.equal(principal.organizationId, "org_01");
  const context = createTenantContext({
    organizationId: "org_01",
    projectId: "project.alpha",
    membershipVersion: "membership-7",
    scopes: ["project/project.alpha"],
  });
  assert.equal(isTenantContext(context), true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.principal), true);
  assert.equal(isTenantContext({ organizationId: "org_01" }), false);
  assert.throws(() => assertTenantContext({ organizationId: "org_01" }), (error: unknown) => {
    assert.ok(error instanceof RemembraError);
    assert.equal(error.code, "TENANT_REQUIRED");
    return true;
  });
  assert.deepEqual(tenantFilterFromContext(context), {
    organizationId: "org_01",
    projectId: "project.alpha",
  });
  assert.equal(tenantDirectoryKey("org_01"), "tenant_b3JnXzAx");
});

test("tenant identifiers and scopes reject path and ambiguity", () => {
  for (const organizationId of ["../other", "a/b", "a\\b", "a\nb", ".", "..", ""]) {
    assert.throws(
      () => parseTenantPrincipal({ organizationId, membershipVersion: "v1" }),
      (error: unknown) => {
        assert.ok(error instanceof RemembraError);
        assert.equal(error.code, "INVALID_INPUT");
        return true;
      },
    );
  }
  assert.throws(
    () => parseTenantPrincipal({
      organizationId: "org",
      membershipVersion: "v1",
      scopes: ["project/../other"],
    }),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => parseTenantPrincipal({ organizationId: "org", unexpected: "client field", membershipVersion: "v1" }),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
});

test("tenant filters fail closed and memory matching requires exact organization/project", () => {
  assert.deepEqual(parseTenantFilter({ organizationId: "org", projectId: "p1" }), {
    organizationId: "org",
    projectId: "p1",
  });
  const filter = parseTenantFilter({ organizationId: "org", projectId: "p1" });
  assert.equal(memoryBelongsToTenant({ tenantId: "org", projectId: "p1" }, filter), true);
  assert.equal(memoryBelongsToTenant({ tenantId: "org", projectId: "p2" }, filter), false);
  assert.equal(memoryBelongsToTenant({ tenantId: "other", projectId: "p1" }, filter), false);
  assert.equal(memoryBelongsToTenant({}, filter), false);
});
