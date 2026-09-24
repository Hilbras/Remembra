import { z } from "zod";
import { RemembraError, inputError } from "./errors.js";
import { isValidTenantId } from "./types.js";
import {
  type TenantDirectory,
  type TenantDirectoryAgent,
  type TenantDirectoryProject,
  type TenantDirectorySnapshot,
  type TenantDirectoryUser,
  type TenantMembershipRole,
} from "./tenant-directory.js";
import { isTenantContext, type TenantContext } from "./tenant.js";
import { assertAuthorized } from "./authorization.js";

const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;
const idSchema = z.string().refine(isValidTenantId, "invalid tenant entity id");
const displayNameSchema = z.string().min(1).max(256).optional();
const pageSchema = z.object({
  offset: z.number().int().min(0).max(MAX_OFFSET).default(0),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
}).strict();
const membershipRoleSchema = z.enum(["member", "manager", "admin"]);
const membershipInputSchema = z.object({
  projectId: idSchema,
  userId: idSchema,
  role: membershipRoleSchema.default("member"),
}).strict();

export type TenantEntityKind = "user" | "project" | "agent";

export type TenantEntity =
  | { kind: "user"; organizationId: string; userId: string; displayName?: string }
  | { kind: "project"; organizationId: string; projectId: string; displayName?: string }
  | { kind: "agent"; organizationId: string; agentId: string; userId?: string; projectId?: string; displayName?: string };

export interface TenantEntityPage {
  items: TenantEntity[];
  total: number;
  offset: number;
  limit: number;
}

export interface TenantMembership {
  organizationId: string;
  projectId: string;
  userId: string;
  role: TenantMembershipRole;
}

export interface TenantMembershipPage {
  items: TenantMembership[];
  total: number;
  offset: number;
  limit: number;
}

export interface TenantEntityAuditEvent {
  action: string;
  kind: "organization" | "user" | "project" | "agent" | "membership";
  organizationId: string;
  entityId?: string;
  outcome: "success";
  membershipVersion: string;
}

export interface TenantEntityDirectory extends TenantDirectory {
  snapshot(): TenantDirectorySnapshot | Promise<TenantDirectorySnapshot>;
  createOrganization(organizationId: string): void | Promise<void>;
  upsertUser(user: TenantDirectoryUser): void | Promise<void>;
  removeUser(organizationId: string, userId: string): void | Promise<void>;
  upsertProject(project: TenantDirectoryProject): void | Promise<void>;
  removeProject(organizationId: string, projectId: string): void | Promise<void>;
  upsertAgent(agent: TenantDirectoryAgent): void | Promise<void>;
  removeAgent(organizationId: string, agentId: string): void | Promise<void>;
  grantProjectMembership(
    organizationId: string,
    projectId: string,
    userId: string,
    role?: TenantMembershipRole,
  ): void | Promise<void>;
  revokeProjectMembership(organizationId: string, projectId: string, userId: string): void | Promise<void>;
}

export interface TenantEntityServiceOptions {
  audit?: (event: TenantEntityAuditEvent) => void | Promise<void>;
  /** Explicit host-only authorization for organization provisioning. */
  authorizeBootstrap?: (organizationId: string) => boolean | Promise<boolean>;
}

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `tenant entities: ${message}`);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw inputError(error, "INVALID_INPUT");
  }
}

function entityId(value: string): string {
  return parse(idSchema, value);
}

function sortEntities(entities: TenantEntity[]): TenantEntity[] {
  return entities.sort((left, right) => {
    const leftId = left.kind === "user" ? left.userId : left.kind === "project" ? left.projectId : left.agentId;
    const rightId = right.kind === "user" ? right.userId : right.kind === "project" ? right.projectId : right.agentId;
    return left.kind.localeCompare(right.kind) || leftId.localeCompare(rightId);
  });
}

function entityIdOf(entity: TenantEntity): string {
  return entity.kind === "user" ? entity.userId : entity.kind === "project" ? entity.projectId : entity.agentId;
}

/** Trusted host API for tenant-owned identity entities and memberships. */
export class TenantEntityService {
  constructor(
    private readonly directory: TenantEntityDirectory,
    private readonly options: TenantEntityServiceOptions = {},
  ) {}

  /** Provision a new organization through an explicit host authorization hook. */
  async provisionOrganization(organizationId: string): Promise<{ organizationId: string; membershipVersion: string }> {
    const id = entityId(organizationId);
    const authorized = await this.options.authorizeBootstrap?.(id);
    if (!authorized) throw new RemembraError("TENANT_REQUIRED", "organization provisioning is not authorized");
    await this.directory.createOrganization(id);
    const membershipVersion = await this.directory.getMembershipVersion(id);
    if (!membershipVersion) throw new RemembraError("NOT_FOUND", "organization not found after provisioning");
    await this.options.audit?.({
      action: "provision",
      kind: "organization",
      organizationId: id,
      entityId: id,
      outcome: "success",
      membershipVersion,
    });
    return { organizationId: id, membershipVersion };
  }

  async getOrganization(context: TenantContext): Promise<{ organizationId: string; membershipVersion: string }> {
    const principal = await this.authorize(context, "read");
    const version = await this.directory.getMembershipVersion(principal.organizationId);
    if (!version) throw new RemembraError("NOT_FOUND", "organization not found");
    return { organizationId: principal.organizationId, membershipVersion: version };
  }

  async list(
    context: TenantContext,
    kind: TenantEntityKind,
    pageInput: { offset?: number; limit?: number } = {},
  ): Promise<TenantEntityPage> {
    const principal = await this.authorize(context, "read");
    if (kind !== "user" && kind !== "project" && kind !== "agent") invalid("unsupported entity kind");
    const page = parse(pageSchema, pageInput);
    const snapshot = await this.directory.snapshot();
    const entities = this.entitiesFor(snapshot, principal.organizationId, kind)
      .filter((entity) => this.visible(entity, principal, snapshot));
    sortEntities(entities);
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 50;
    return {
      items: entities.slice(offset, offset + limit),
      total: entities.length,
      offset,
      limit,
    };
  }

  async listProjectMembers(
    context: TenantContext,
    projectId: string,
    pageInput: { offset?: number; limit?: number } = {},
  ): Promise<TenantMembershipPage> {
    const principal = await this.authorize(context, "read");
    const normalizedProjectId = entityId(projectId);
    if (principal.projectId && principal.projectId !== normalizedProjectId) {
      throw new RemembraError("NOT_FOUND", "project not found");
    }
    const page = parse(pageSchema, pageInput);
    const snapshot = await this.directory.snapshot();
    if (!snapshot.projects.some((project) => project.organizationId === principal.organizationId && project.projectId === normalizedProjectId)) {
      throw new RemembraError("NOT_FOUND", "project not found");
    }
    const memberships = snapshot.projectMembers
      .filter((member) => member.organizationId === principal.organizationId && member.projectId === normalizedProjectId)
      .filter((member) => !principal.userId || member.userId === principal.userId)
      .map((member) => ({ ...member }))
      .sort((left, right) => left.userId.localeCompare(right.userId));
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 50;
    return {
      items: memberships.slice(offset, offset + limit),
      total: memberships.length,
      offset,
      limit,
    };
  }

  async get(
    context: TenantContext,
    kind: TenantEntityKind,
    id: string,
  ): Promise<TenantEntity> {
    if (kind !== "user" && kind !== "project" && kind !== "agent") invalid("unsupported entity kind");
    const principal = await this.authorize(context, "read");
    const normalizedId = entityId(id);
    const snapshot = await this.directory.snapshot();
    const entity = this.entitiesFor(snapshot, principal.organizationId, kind)
      .find((candidate) => entityIdOf(candidate) === normalizedId);
    if (!entity || !this.visible(entity, principal, snapshot)) throw new RemembraError("NOT_FOUND", "tenant entity not found");
    return entity;
  }

  async createUser(context: TenantContext, input: { userId: string; displayName?: string }): Promise<TenantEntity> {
    const principal = await this.authorizeAdmin(context);
    const user = parse(z.object({ userId: idSchema, displayName: displayNameSchema }).strict(), input);
    const snapshot = await this.directory.snapshot();
    if (snapshot.users.some((candidate) => candidate.organizationId === principal.organizationId && candidate.userId === user.userId)) {
      throw new RemembraError("CONFLICT", "user already exists");
    }
    await this.directory.upsertUser({ organizationId: principal.organizationId, ...user });
    return this.auditAndReturn("create", "user", principal.organizationId, user.userId);
  }

  async updateUser(context: TenantContext, input: { userId: string; displayName?: string }): Promise<TenantEntity> {
    const principal = await this.authorizeAdmin(context);
    const user = parse(z.object({ userId: idSchema, displayName: displayNameSchema }).strict(), input);
    const snapshot = await this.directory.snapshot();
    const current = snapshot.users.find((candidate) => candidate.organizationId === principal.organizationId && candidate.userId === user.userId);
    if (!current) throw new RemembraError("NOT_FOUND", "user not found");
    await this.directory.upsertUser({ ...current, ...user });
    return this.auditAndReturn("update", "user", principal.organizationId, user.userId);
  }

  async deleteUser(context: TenantContext, userId: string): Promise<void> {
    const principal = await this.authorizeAdmin(context);
    const id = entityId(userId);
    const snapshot = await this.directory.snapshot();
    if (!snapshot.users.some((candidate) => candidate.organizationId === principal.organizationId && candidate.userId === id)) {
      throw new RemembraError("NOT_FOUND", "user not found");
    }
    await this.directory.removeUser(principal.organizationId, id);
    await this.audit("delete", "user", principal.organizationId, id);
  }

  async createProject(context: TenantContext, input: { projectId: string; displayName?: string }): Promise<TenantEntity> {
    const principal = await this.authorizeAdmin(context);
    const project = parse(z.object({ projectId: idSchema, displayName: displayNameSchema }).strict(), input);
    const snapshot = await this.directory.snapshot();
    if (snapshot.projects.some((candidate) => candidate.organizationId === principal.organizationId && candidate.projectId === project.projectId)) {
      throw new RemembraError("CONFLICT", "project already exists");
    }
    await this.directory.upsertProject({ organizationId: principal.organizationId, ...project });
    return this.auditAndReturn("create", "project", principal.organizationId, project.projectId);
  }

  async updateProject(context: TenantContext, input: { projectId: string; displayName?: string }): Promise<TenantEntity> {
    const principal = await this.authorizeAdmin(context);
    const project = parse(z.object({ projectId: idSchema, displayName: displayNameSchema }).strict(), input);
    const snapshot = await this.directory.snapshot();
    const current = snapshot.projects.find((candidate) => candidate.organizationId === principal.organizationId && candidate.projectId === project.projectId);
    if (!current) throw new RemembraError("NOT_FOUND", "project not found");
    await this.directory.upsertProject({ ...current, ...project });
    return this.auditAndReturn("update", "project", principal.organizationId, project.projectId);
  }

  async deleteProject(context: TenantContext, projectId: string): Promise<void> {
    const principal = await this.authorizeAdmin(context);
    const id = entityId(projectId);
    const snapshot = await this.directory.snapshot();
    if (!snapshot.projects.some((candidate) => candidate.organizationId === principal.organizationId && candidate.projectId === id)) {
      throw new RemembraError("NOT_FOUND", "project not found");
    }
    await this.directory.removeProject(principal.organizationId, id);
    await this.audit("delete", "project", principal.organizationId, id);
  }

  async createAgent(context: TenantContext, input: { agentId: string; userId?: string; projectId?: string; displayName?: string }): Promise<TenantEntity> {
    const principal = await this.authorizeAdmin(context);
    const agent = parse(z.object({ agentId: idSchema, userId: idSchema.optional(), projectId: idSchema.optional(), displayName: displayNameSchema }).strict(), input);
    const snapshot = await this.directory.snapshot();
    if (snapshot.agents.some((candidate) => candidate.organizationId === principal.organizationId && candidate.agentId === agent.agentId)) {
      throw new RemembraError("CONFLICT", "agent already exists");
    }
    await this.directory.upsertAgent({ organizationId: principal.organizationId, ...agent });
    return this.auditAndReturn("create", "agent", principal.organizationId, agent.agentId);
  }

  async updateAgent(context: TenantContext, input: { agentId: string; userId?: string; projectId?: string; displayName?: string }): Promise<TenantEntity> {
    const principal = await this.authorizeAdmin(context);
    const agent = parse(z.object({ agentId: idSchema, userId: idSchema.optional(), projectId: idSchema.optional(), displayName: displayNameSchema }).strict(), input);
    const snapshot = await this.directory.snapshot();
    const current = snapshot.agents.find((candidate) => candidate.organizationId === principal.organizationId && candidate.agentId === agent.agentId);
    if (!current) throw new RemembraError("NOT_FOUND", "agent not found");
    await this.directory.upsertAgent({ ...current, ...agent });
    return this.auditAndReturn("update", "agent", principal.organizationId, agent.agentId);
  }

  async deleteAgent(context: TenantContext, agentId: string): Promise<void> {
    const principal = await this.authorizeAdmin(context);
    const id = entityId(agentId);
    const snapshot = await this.directory.snapshot();
    if (!snapshot.agents.some((candidate) => candidate.organizationId === principal.organizationId && candidate.agentId === id)) {
      throw new RemembraError("NOT_FOUND", "agent not found");
    }
    await this.directory.removeAgent(principal.organizationId, id);
    await this.audit("delete", "agent", principal.organizationId, id);
  }

  async grantProjectMembership(
    context: TenantContext,
    input: { projectId: string; userId: string; role?: TenantMembershipRole },
  ): Promise<void> {
    const principal = await this.authorizeAdmin(context);
    const membership = parse(membershipInputSchema, input);
    await this.directory.grantProjectMembership(principal.organizationId, membership.projectId, membership.userId, membership.role);
    await this.audit("grant", "membership", principal.organizationId, `${membership.projectId}:${membership.userId}`);
  }

  async revokeProjectMembership(context: TenantContext, input: { projectId: string; userId: string }): Promise<void> {
    const principal = await this.authorizeAdmin(context);
    const membership = parse(z.object({ projectId: idSchema, userId: idSchema }).strict(), input);
    await this.directory.revokeProjectMembership(principal.organizationId, membership.projectId, membership.userId);
    await this.audit("revoke", "membership", principal.organizationId, `${membership.projectId}:${membership.userId}`);
  }

  private async authorize(context: TenantContext, capability: "read" | "write") {
    if (!isTenantContext(context)) throw new RemembraError("TENANT_REQUIRED", "trusted tenant context required");
    if (!(await this.directory.verifyContext(context))) throw new RemembraError("TENANT_REQUIRED", "tenant membership is not current");
    assertAuthorized(context, capability === "write" ? "tenant.manage" : "memory.read");
    return context.principal;
  }

  private async authorizeAdmin(context: TenantContext) {
    const principal = await this.authorize(context, "write");
    if (principal.projectId || principal.userId || principal.agentId) {
      throw new RemembraError("TENANT_REQUIRED", "organization administrator context required");
    }
    return principal;
  }

  private entitiesFor(snapshot: TenantDirectorySnapshot, organizationId: string, kind: TenantEntityKind): TenantEntity[] {
    if (kind === "user") return snapshot.users.filter((user) => user.organizationId === organizationId).map((user) => ({ kind, ...user }));
    if (kind === "project") return snapshot.projects.filter((project) => project.organizationId === organizationId).map((project) => ({ kind, ...project }));
    return snapshot.agents.filter((agent) => agent.organizationId === organizationId).map((agent) => ({ kind, ...agent }));
  }

  private visible(entity: TenantEntity, principal: TenantContext["principal"], snapshot: TenantDirectorySnapshot): boolean {
    if (entity.organizationId !== principal.organizationId) return false;
    if (principal.projectId) {
      if (entity.kind === "project") return entity.projectId === principal.projectId;
      if (entity.kind === "agent") return entity.projectId === principal.projectId;
      return snapshot.projectMembers.some((member) => member.organizationId === principal.organizationId && member.projectId === principal.projectId && member.userId === entity.userId);
    }
    if (principal.userId && entity.kind === "user") return entity.userId === principal.userId;
    if (principal.agentId && entity.kind === "agent") return entity.agentId === principal.agentId;
    return true;
  }

  private async auditAndReturn(
    action: string,
    kind: TenantEntityKind,
    organizationId: string,
    entityId: string,
  ): Promise<TenantEntity> {
    const snapshot = await this.directory.snapshot();
    const result = this.entitiesFor(snapshot, organizationId, kind)
      .find((candidate) => entityIdOf(candidate) === entityId);
    if (!result) throw new RemembraError("NOT_FOUND", "tenant entity not found after mutation");
    await this.audit(action, kind, organizationId, entityId);
    return result;
  }

  private async audit(action: string, kind: TenantEntityAuditEvent["kind"], organizationId: string, entityId?: string): Promise<void> {
    const membershipVersion = await this.directory.getMembershipVersion(organizationId);
    if (!membershipVersion) throw new RemembraError("NOT_FOUND", "organization not found");
    await this.options.audit?.({ action, kind, organizationId, entityId, outcome: "success", membershipVersion });
  }
}
