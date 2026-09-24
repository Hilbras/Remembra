import { z } from "zod";
import { RemembraError } from "./errors.js";
import { isValidTenantId } from "./types.js";

/** V5 tenant enforcement mode. Legacy mode is the only V4-compatible mode. */
export type TenantMode = "legacy" | "strict";

/**
 * Capability labels are descriptive claims resolved by the host. They are not
 * bearer tokens and must not be accepted from a public request.
 */
export type TenantCapability = "tenant:read" | "tenant:write" | "tenant:export" | "tenant:admin";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidTenantId, "must be a valid opaque tenant identifier");

const tenantScope = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(global|(?:project|agent|task|council)\/[A-Za-z0-9._:-]+)$/,
    "must be global or a canonical project/agent/task/council scope",
  );

const capability = z.enum(["tenant:read", "tenant:write", "tenant:export", "tenant:admin"]);

export const TenantPrincipalSchema = z
  .object({
    organizationId: identifier,
    userId: identifier.optional(),
    projectId: identifier.optional(),
    agentId: identifier.optional(),
    membershipVersion: z.string().min(1).max(128),
    scopes: z.array(tenantScope).max(256).optional(),
    capabilities: z.array(capability).max(16).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const dimensions = [value.userId, value.projectId, value.agentId].filter(Boolean).length;
    if (dimensions > 0 && !value.scopes?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopes"], message: "scoped principals require explicit scopes" });
    }
    if (dimensions === 0 && !value.capabilities?.some((item) => item === "tenant:read" || item === "tenant:admin")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "organization-wide principals require an explicit read capability" });
    }
    if (value.capabilities?.includes("tenant:admin") && !value.capabilities.includes("tenant:read")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "admin capability requires read capability" });
    }
  });

type ParsedTenantPrincipal = z.infer<typeof TenantPrincipalSchema>;
export type TenantPrincipal = Readonly<
  Omit<ParsedTenantPrincipal, "scopes" | "capabilities"> & {
    readonly scopes?: readonly string[];
    readonly capabilities?: readonly TenantCapability[];
  }
>;

const TENANT_CONTEXT = Symbol("remembra.tenant-context");

/** Opaque context minted only by a trusted host integration. */
export interface TenantContext {
  readonly [TENANT_CONTEXT]: true;
  readonly principal: TenantPrincipal;
}

export interface TenantFilter {
  readonly organizationId: string;
  readonly projectId?: string;
  readonly userId?: string;
  readonly agentId?: string;
}

export const TenantFilterSchema = z
  .object({
    organizationId: identifier,
    projectId: identifier.optional(),
    userId: identifier.optional(),
    agentId: identifier.optional(),
  })
  .strict();

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `invalid tenant principal: ${message}`);
}

function freezePrincipal(value: z.infer<typeof TenantPrincipalSchema>): TenantPrincipal {
  return Object.freeze({
    ...value,
    ...(value.scopes ? { scopes: Object.freeze([...value.scopes]) } : {}),
    ...(value.capabilities ? { capabilities: Object.freeze([...value.capabilities]) } : {}),
  });
}

export function parseTenantPrincipal(input: unknown): TenantPrincipal {
  const parsed = TenantPrincipalSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    invalid(`${issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : "invalid claims"}`);
  }
  return freezePrincipal(parsed.data);
}

export function createTenantContext(input: unknown): TenantContext {
  const principal = parseTenantPrincipal(input);
  return Object.freeze({
    [TENANT_CONTEXT]: true as const,
    principal,
  });
}

export function isTenantContext(value: unknown): value is TenantContext {
  return typeof value === "object" && value !== null && (value as Partial<TenantContext>)[TENANT_CONTEXT] === true;
}

export function assertTenantContext(value: unknown): asserts value is TenantContext {
  if (!isTenantContext(value)) {
    throw new RemembraError("TENANT_REQUIRED", "a trusted tenant context is required");
  }
}

export function parseTenantFilter(input: unknown): TenantFilter {
  const parsed = TenantFilterSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RemembraError(
      "INVALID_INPUT",
      `invalid tenant filter${issue ? ` at ${issue.path.join(".") || "root"}: ${issue.message}` : ""}`,
    );
  }
  return Object.freeze(parsed.data);
}

export function tenantFilterFromContext(context: TenantContext): TenantFilter {
  assertTenantContext(context);
  const principal = context.principal;
  return Object.freeze({
    organizationId: principal.organizationId,
    ...(principal.projectId ? { projectId: principal.projectId } : {}),
    ...(principal.userId ? { userId: principal.userId } : {}),
    ...(principal.agentId ? { agentId: principal.agentId } : {}),
  });
}

/** Opaque, collision-free directory key for a validated organization ID. */
export function tenantDirectoryKey(organizationId: string): string {
  const parsed = parseTenantFilter({ organizationId });
  return `tenant_${Buffer.from(parsed.organizationId, "utf8").toString("base64url")}`;
}

export function memoryBelongsToTenant(
  memory: { tenantId?: string; projectId?: string },
  filter: TenantFilter,
): boolean {
  if (memory.tenantId !== filter.organizationId) return false;
  if (filter.projectId && memory.projectId !== filter.projectId) return false;
  return true;
}
