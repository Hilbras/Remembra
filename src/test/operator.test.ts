import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperatorTenantContext, snapshotKeyFromEnv, tenantModeFromEnv } from "../operator.js";

test("operator tenant configuration is explicit and validated", () => {
  assert.equal(tenantModeFromEnv({}), "legacy");
  assert.equal(tenantModeFromEnv({ REMEMBRA_TENANT_MODE: "strict" }), "strict");
  assert.throws(() => tenantModeFromEnv({ REMEMBRA_TENANT_MODE: "global" }), /REMEMBRA_TENANT_MODE/);
  assert.throws(() => createOperatorTenantContext({ REMEMBRA_TENANT_MODE: "strict" }), /REMEMBRA_TENANT_ID/);
  assert.throws(
    () => createOperatorTenantContext({ REMEMBRA_TENANT_MODE: "strict", REMEMBRA_TENANT_ID: "org-a" }),
    /MEMBERSHIP_VERSION/,
  );
  const context = createOperatorTenantContext({
    REMEMBRA_TENANT_MODE: "strict",
    REMEMBRA_TENANT_ID: "org-a",
    REMEMBRA_TENANT_MEMBERSHIP_VERSION: "membership-1",
    REMEMBRA_TENANT_PROJECT_ID: "project-a",
  });
  assert.equal(context.principal.organizationId, "org-a");
  assert.equal(context.principal.projectId, "project-a");
  assert.ok(context.principal.capabilities?.includes("tenant:admin"));
  assert.throws(() => snapshotKeyFromEnv({ REMEMBRA_SNAPSHOT_KEY: "short" }), /SNAPSHOT_KEY/);
  assert.equal(snapshotKeyFromEnv({ REMEMBRA_SNAPSHOT_KEY: "a".repeat(64) })?.length, 32);
});
