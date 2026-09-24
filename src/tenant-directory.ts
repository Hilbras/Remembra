import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import { isValidTenantId } from "./types.js";
import {
  isTenantContext,
  type TenantContext,
  type TenantPrincipal,
} from "./tenant.js";

export type TenantMembershipRole = "member" | "manager" | "admin";

export interface TenantDirectoryUser {
  organizationId: string;
  userId: string;
  displayName?: string;
}

export interface TenantDirectoryProject {
  organizationId: string;
  projectId: string;
  displayName?: string;
}

export interface TenantDirectoryAgent {
  organizationId: string;
  agentId: string;
  userId?: string;
  projectId?: string;
  displayName?: string;
}

export interface TenantDirectorySnapshot {
  organizations: Array<{ organizationId: string; membershipVersion: number }>;
  users: TenantDirectoryUser[];
  projects: TenantDirectoryProject[];
  agents: TenantDirectoryAgent[];
  projectMembers: Array<{ organizationId: string; projectId: string; userId: string; role: TenantMembershipRole }>;
  projectAgents: Array<{ organizationId: string; projectId: string; agentId: string }>;
}

/** Host-side membership authority used to re-authorize tenant contexts. */
export interface TenantDirectory {
  getMembershipVersion(organizationId: string): string | undefined | Promise<string | undefined>;
  verifyContext(context: TenantContext): boolean | Promise<boolean>;
}

const directoryId = z.string().refine(isValidTenantId, "invalid tenant entity id");
const displayName = z.string().min(1).max(256).optional();
const directoryUserSchema = z.object({
  organizationId: directoryId,
  userId: directoryId,
  displayName,
}).strict();
const directoryProjectSchema = z.object({
  organizationId: directoryId,
  projectId: directoryId,
  displayName,
}).strict();
const directoryAgentSchema = z.object({
  organizationId: directoryId,
  agentId: directoryId,
  userId: directoryId.optional(),
  projectId: directoryId.optional(),
  displayName,
}).strict();
const directoryRole = z.enum(["member", "manager", "admin"]);
const directoryMemberSchema = z.object({
  organizationId: directoryId,
  projectId: directoryId,
  userId: directoryId,
  role: directoryRole,
}).strict();
const directoryProjectAgentSchema = z.object({
  organizationId: directoryId,
  projectId: directoryId,
  agentId: directoryId,
}).strict();
const directorySnapshotSchema = z.object({
  organizations: z.array(z.object({
    organizationId: directoryId,
    membershipVersion: z.number().int().positive(),
  }).strict()).max(100_000),
  users: z.array(directoryUserSchema).max(1_000_000),
  projects: z.array(directoryProjectSchema).max(1_000_000),
  agents: z.array(directoryAgentSchema).max(1_000_000),
  projectMembers: z.array(directoryMemberSchema).max(5_000_000),
  projectAgents: z.array(directoryProjectAgentSchema).max(5_000_000),
}).strict();
const directoryFileSchema = z.object({
  format: z.literal("remembra-tenant-directory"),
  version: z.literal(1),
  state: directorySnapshotSchema,
}).strict();

interface OrganizationRecord {
  organizationId: string;
  membershipVersion: number;
}

interface ProjectMemberRecord {
  organizationId: string;
  projectId: string;
  userId: string;
  role: TenantMembershipRole;
}

interface ProjectAgentRecord {
  organizationId: string;
  projectId: string;
  agentId: string;
}

function assertEntityId(value: string, label: string): void {
  if (!isValidTenantId(value)) throw new RemembraError("INVALID_INPUT", `invalid ${label}`);
}

function key(organizationId: string, id: string): string {
  return `${organizationId}\u0000${id}`;
}

function membershipKey(organizationId: string, projectId: string, userId: string): string {
  return `${organizationId}\u0000${projectId}\u0000${userId}`;
}

/**
 * Deterministic reference directory for host adapters and tests. It is
 * intentionally separate from MemoryBackend: production hosts may implement
 * the same contract in their existing identity database.
 */
export class InMemoryTenantDirectory implements TenantDirectory {
  private readonly organizations = new Map<string, OrganizationRecord>();
  private readonly users = new Map<string, TenantDirectoryUser>();
  private readonly projects = new Map<string, TenantDirectoryProject>();
  private readonly agents = new Map<string, TenantDirectoryAgent>();
  private readonly projectMembers = new Map<string, ProjectMemberRecord>();
  private readonly projectAgents = new Map<string, ProjectAgentRecord>();

  static fromSnapshot(snapshot: TenantDirectorySnapshot): InMemoryTenantDirectory {
    const parsed = directorySnapshotSchema.parse(snapshot);
    const directory = new InMemoryTenantDirectory();
    for (const organization of parsed.organizations) {
      if (directory.organizations.has(organization.organizationId)) {
        throw new RemembraError("INVALID_INPUT", `duplicate organization ${organization.organizationId}`);
      }
      directory.organizations.set(organization.organizationId, { ...organization });
    }
    for (const user of parsed.users) {
      directory.requireOrganization(user.organizationId);
      const userKey = key(user.organizationId, user.userId);
      if (directory.users.has(userKey)) throw new RemembraError("INVALID_INPUT", `duplicate user ${user.userId}`);
      directory.users.set(userKey, { ...user });
    }
    for (const project of parsed.projects) {
      directory.requireOrganization(project.organizationId);
      const projectKey = key(project.organizationId, project.projectId);
      if (directory.projects.has(projectKey)) throw new RemembraError("INVALID_INPUT", `duplicate project ${project.projectId}`);
      directory.projects.set(projectKey, { ...project });
    }
    for (const agent of parsed.agents) {
      directory.requireOrganization(agent.organizationId);
      const agentKey = key(agent.organizationId, agent.agentId);
      if (directory.agents.has(agentKey)) throw new RemembraError("INVALID_INPUT", `duplicate agent ${agent.agentId}`);
      if (agent.userId && !directory.users.has(key(agent.organizationId, agent.userId))) {
        throw new RemembraError("INVALID_INPUT", `agent ${agent.agentId} references an unknown user`);
      }
      if (agent.projectId && !directory.projects.has(key(agent.organizationId, agent.projectId))) {
        throw new RemembraError("INVALID_INPUT", `agent ${agent.agentId} references an unknown project`);
      }
      directory.agents.set(agentKey, { ...agent });
    }
    for (const member of parsed.projectMembers) {
      directory.requireOrganization(member.organizationId);
      if (!directory.projects.has(key(member.organizationId, member.projectId))) {
        throw new RemembraError("INVALID_INPUT", `membership references an unknown project`);
      }
      if (!directory.users.has(key(member.organizationId, member.userId))) {
        throw new RemembraError("INVALID_INPUT", `membership references an unknown user`);
      }
      const memberKey = membershipKey(member.organizationId, member.projectId, member.userId);
      if (directory.projectMembers.has(memberKey)) throw new RemembraError("INVALID_INPUT", "duplicate project membership");
      directory.projectMembers.set(memberKey, { ...member });
    }
    for (const projectAgent of parsed.projectAgents) {
      directory.requireOrganization(projectAgent.organizationId);
      if (!directory.projects.has(key(projectAgent.organizationId, projectAgent.projectId))) {
        throw new RemembraError("INVALID_INPUT", `project agent references an unknown project`);
      }
      const agent = directory.agents.get(key(projectAgent.organizationId, projectAgent.agentId));
      if (!agent || agent.projectId !== projectAgent.projectId) {
        throw new RemembraError("INVALID_INPUT", "project agent does not match its agent project");
      }
      const projectAgentKey = key(projectAgent.organizationId, projectAgent.agentId);
      if (directory.projectAgents.has(projectAgentKey)) throw new RemembraError("INVALID_INPUT", "duplicate project agent");
      directory.projectAgents.set(projectAgentKey, { ...projectAgent });
    }
    for (const agent of directory.agents.values()) {
      if (agent.projectId && !directory.projectAgents.has(key(agent.organizationId, agent.agentId))) {
        throw new RemembraError("INVALID_INPUT", "agent is missing its project association");
      }
    }
    return directory;
  }

  createOrganization(organizationId: string): void {
    assertEntityId(organizationId, "organization id");
    if (this.organizations.has(organizationId)) {
      throw new RemembraError("CONFLICT", `organization ${organizationId} already exists`);
    }
    this.organizations.set(organizationId, { organizationId, membershipVersion: 1 });
  }

  upsertUser(user: TenantDirectoryUser): void {
    assertEntityId(user.organizationId, "organization id");
    assertEntityId(user.userId, "user id");
    this.requireOrganization(user.organizationId);
    this.users.set(key(user.organizationId, user.userId), { ...user });
    this.bump(user.organizationId);
  }

  removeUser(organizationId: string, userId: string): void {
    this.requireOrganization(organizationId);
    this.users.delete(key(organizationId, userId));
    for (const [k, member] of this.projectMembers) {
      if (member.organizationId === organizationId && member.userId === userId) this.projectMembers.delete(k);
    }
    for (const [k, agent] of this.agents) {
      if (agent.organizationId === organizationId && agent.userId === userId) {
        this.agents.delete(k);
        this.projectAgents.delete(k);
      }
    }
    this.bump(organizationId);
  }

  upsertProject(project: TenantDirectoryProject): void {
    assertEntityId(project.organizationId, "organization id");
    assertEntityId(project.projectId, "project id");
    this.requireOrganization(project.organizationId);
    this.projects.set(key(project.organizationId, project.projectId), { ...project });
    this.bump(project.organizationId);
  }

  removeProject(organizationId: string, projectId: string): void {
    this.requireOrganization(organizationId);
    this.projects.delete(key(organizationId, projectId));
    for (const [k, member] of this.projectMembers) {
      if (member.organizationId === organizationId && member.projectId === projectId) this.projectMembers.delete(k);
    }
    for (const [k, agent] of this.projectAgents) {
      if (agent.organizationId === organizationId && agent.projectId === projectId) this.projectAgents.delete(k);
    }
    for (const [k, agent] of this.agents) {
      if (agent.organizationId === organizationId && agent.projectId === projectId) {
        const unassigned = { ...agent };
        delete unassigned.projectId;
        this.agents.set(k, unassigned);
      }
    }
    this.bump(organizationId);
  }

  upsertAgent(agent: TenantDirectoryAgent): void {
    assertEntityId(agent.organizationId, "organization id");
    assertEntityId(agent.agentId, "agent id");
    if (agent.userId) assertEntityId(agent.userId, "user id");
    if (agent.projectId) assertEntityId(agent.projectId, "project id");
    this.requireOrganization(agent.organizationId);
    if (agent.userId && !this.users.has(key(agent.organizationId, agent.userId))) {
      throw new RemembraError("NOT_FOUND", `user ${agent.userId} not found in organization`);
    }
    if (agent.projectId && !this.projects.has(key(agent.organizationId, agent.projectId))) {
      throw new RemembraError("NOT_FOUND", `project ${agent.projectId} not found in organization`);
    }
    this.agents.set(key(agent.organizationId, agent.agentId), { ...agent });
    const projectAgentKey = key(agent.organizationId, agent.agentId);
    if (agent.projectId) {
      this.projectAgents.set(projectAgentKey, {
        organizationId: agent.organizationId,
        projectId: agent.projectId,
        agentId: agent.agentId,
      });
    } else {
      this.projectAgents.delete(projectAgentKey);
    }
    this.bump(agent.organizationId);
  }

  removeAgent(organizationId: string, agentId: string): void {
    this.requireOrganization(organizationId);
    this.agents.delete(key(organizationId, agentId));
    this.projectAgents.delete(key(organizationId, agentId));
    this.bump(organizationId);
  }

  grantProjectMembership(
    organizationId: string,
    projectId: string,
    userId: string,
    role: TenantMembershipRole = "member",
  ): void {
    this.requireOrganization(organizationId);
    if (!this.projects.has(key(organizationId, projectId))) throw new RemembraError("NOT_FOUND", `project ${projectId} not found`);
    if (!this.users.has(key(organizationId, userId))) throw new RemembraError("NOT_FOUND", `user ${userId} not found`);
    this.projectMembers.set(membershipKey(organizationId, projectId, userId), {
      organizationId,
      projectId,
      userId,
      role,
    });
    this.bump(organizationId);
  }

  revokeProjectMembership(organizationId: string, projectId: string, userId: string): void {
    this.projectMembers.delete(membershipKey(organizationId, projectId, userId));
    this.bump(organizationId);
  }

  getMembershipVersion(organizationId: string): string | undefined {
    return this.organizations.get(organizationId)?.membershipVersion.toString();
  }

  verifyContext(context: TenantContext): boolean {
    if (!isTenantContext(context)) return false;
    const principal: TenantPrincipal = context.principal;
    const organization = this.organizations.get(principal.organizationId);
    if (!organization || organization.membershipVersion.toString() !== principal.membershipVersion) return false;
    const capabilities = principal.capabilities ?? [];
    const isAdmin = capabilities.includes("tenant:admin");
    if (principal.userId && !this.users.has(key(principal.organizationId, principal.userId))) return false;
    if (principal.agentId) {
      const agent = this.agents.get(key(principal.organizationId, principal.agentId));
      if (!agent) return false;
      if (principal.userId && agent.userId && agent.userId !== principal.userId) return false;
      if (principal.projectId && agent.projectId && agent.projectId !== principal.projectId) return false;
    }
    if (principal.projectId) {
      if (!this.projects.has(key(principal.organizationId, principal.projectId))) return false;
      if (!isAdmin) {
        const userAllowed = principal.userId
          ? this.projectMembers.has(membershipKey(principal.organizationId, principal.projectId, principal.userId))
          : false;
        const agentAllowed = principal.agentId
          ? this.projectAgents.has(key(principal.organizationId, principal.agentId)) &&
            this.projectAgents.get(key(principal.organizationId, principal.agentId))?.projectId === principal.projectId
          : false;
        if (!userAllowed && !agentAllowed) return false;
      }
      if (!isAdmin && !principal.scopes?.includes(`project/${principal.projectId}`)) return false;
    }
    if (!principal.projectId && !principal.userId && !principal.agentId && !isAdmin && capabilities.length === 0) {
      return false;
    }
    return true;
  }

  snapshot(): TenantDirectorySnapshot {
    return {
      organizations: [...this.organizations.values()].map((org) => ({ ...org })),
      users: [...this.users.values()].map((value) => ({ ...value })),
      projects: [...this.projects.values()].map((value) => ({ ...value })),
      agents: [...this.agents.values()].map((value) => ({ ...value })),
      projectMembers: [...this.projectMembers.values()].map((value) => ({ ...value })),
      projectAgents: [...this.projectAgents.values()].map((value) => ({ ...value })),
    };
  }

  private requireOrganization(organizationId: string): OrganizationRecord {
    assertEntityId(organizationId, "organization id");
    const organization = this.organizations.get(organizationId);
    if (!organization) throw new RemembraError("NOT_FOUND", `organization ${organizationId} not found`);
    return organization;
  }

  private bump(organizationId: string): void {
    const organization = this.requireOrganization(organizationId);
    organization.membershipVersion += 1;
  }
}
