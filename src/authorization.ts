import { RemembraError } from "./errors.js";
import {
  isTenantContext,
  memoryBelongsToTenant,
  tenantFilterFromContext,
  type TenantCapability,
  type TenantContext,
} from "./tenant.js";

/** Closed V5.0.2 operation classes used by the central authorization layer. */
export type AuthorizationOperation =
  | "memory.read"
  | "memory.write"
  | "memory.update"
  | "memory.delete"
  | "memory.search"
  | "memory.history"
  | "snapshot.create"
  | "snapshot.restore"
  | "tenant.manage"
  | "project.manage";

export type AuthorizationDenialReason =
  | "missing_context"
  | "invalid_context"
  | "missing_capability"
  | "dimension_mismatch";

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: AuthorizationDenialReason };

/** Resource metadata only; content, provider data, and caller fields are ignored. */
export interface AuthorizationResource {
  tenantId?: string;
  projectId?: string;
  userId?: string;
  agentId?: string;
}

const REQUIRED_CAPABILITY: Readonly<Record<AuthorizationOperation, TenantCapability>> = Object.freeze({
  "memory.read": "tenant:read",
  "memory.write": "tenant:write",
  "memory.update": "tenant:write",
  "memory.delete": "tenant:write",
  "memory.search": "tenant:read",
  "memory.history": "tenant:read",
  "snapshot.create": "tenant:export",
  "snapshot.restore": "tenant:write",
  "tenant.manage": "tenant:admin",
  "project.manage": "tenant:admin",
});

export function requiredCapability(operation: AuthorizationOperation): TenantCapability {
  return REQUIRED_CAPABILITY[operation];
}

/**
 * Evaluate a trusted principal against an operation and optional resource.
 * This function is deliberately pure: membership freshness and I/O belong to
 * the caller before it reaches this decision point.
 */
export function evaluateAuthorization(
  context: unknown,
  operation: AuthorizationOperation,
  resource?: AuthorizationResource,
): AuthorizationDecision {
  if (context === undefined || context === null) return { allowed: false, reason: "missing_context" };
  if (!isTenantContext(context)) return { allowed: false, reason: "invalid_context" };

  const capabilities = context.principal.capabilities ?? [];
  const required = REQUIRED_CAPABILITY[operation];
  const hasCapability = capabilities.includes(required) ||
    (required !== "tenant:admin" && required !== "tenant:export" && capabilities.includes("tenant:admin"));
  if (!hasCapability) return { allowed: false, reason: "missing_capability" };

  if (resource && !memoryBelongsToTenant(resource, tenantFilterFromContext(context))) {
    return { allowed: false, reason: "dimension_mismatch" };
  }
  return { allowed: true };
}

/** Convert an authorization denial into the existing non-informative error contract. */
export function assertAuthorized(
  context: unknown,
  operation: AuthorizationOperation,
  resource?: AuthorizationResource,
): asserts context is TenantContext {
  const decision = evaluateAuthorization(context, operation, resource);
  if (decision.allowed) return;
  if (decision.reason === "dimension_mismatch") {
    throw new RemembraError("NOT_FOUND", "resource not found in the authorized scope");
  }
  throw new RemembraError("TENANT_REQUIRED", "trusted tenant authorization is required");
}
