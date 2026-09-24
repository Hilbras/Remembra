import { createTenantContext, type TenantContext, type TenantMode } from "./tenant.js";

export interface OperatorEnvironment {
  REMEMBRA_TENANT_MODE?: string;
  REMEMBRA_TENANT_ID?: string;
  REMEMBRA_TENANT_MEMBERSHIP_VERSION?: string;
  REMEMBRA_TENANT_PROJECT_ID?: string;
  REMEMBRA_TENANT_USER_ID?: string;
  REMEMBRA_TENANT_AGENT_ID?: string;
}

export function tenantModeFromEnv(env: OperatorEnvironment = process.env): TenantMode {
  const value = (env.REMEMBRA_TENANT_MODE ?? "legacy").trim().toLowerCase();
  if (value === "legacy" || value === "strict") return value;
  throw new Error(`Invalid REMEMBRA_TENANT_MODE "${value}" — expected legacy or strict`);
}

/**
 * Bind the local operator process to one trusted tenant. This is intentionally
 * environment-only: HTTP headers, CLI arguments, and SDK payloads cannot create
 * or select this context.
 */
export function createOperatorTenantContext(env: OperatorEnvironment = process.env): TenantContext {
  const organizationId = env.REMEMBRA_TENANT_ID?.trim();
  const membershipVersion = env.REMEMBRA_TENANT_MEMBERSHIP_VERSION?.trim();
  if (!organizationId) throw new Error("REMEMBRA_TENANT_ID is required when REMEMBRA_TENANT_MODE=strict");
  if (!membershipVersion) {
    throw new Error("REMEMBRA_TENANT_MEMBERSHIP_VERSION is required when REMEMBRA_TENANT_MODE=strict");
  }
  const projectId = env.REMEMBRA_TENANT_PROJECT_ID?.trim() || undefined;
  const userId = env.REMEMBRA_TENANT_USER_ID?.trim() || undefined;
  const agentId = env.REMEMBRA_TENANT_AGENT_ID?.trim() || undefined;
  return createTenantContext({
    organizationId,
    membershipVersion,
    ...(projectId ? { projectId } : {}),
    ...(userId ? { userId } : {}),
    ...(agentId ? { agentId } : {}),
    scopes: projectId ? ["global", `project/${projectId}`] : ["global"],
    capabilities: ["tenant:read", "tenant:write", "tenant:admin"],
  });
}
