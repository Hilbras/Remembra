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
    if (agent.projectId) {
      this.projectAgents.set(key(agent.organizationId, agent.agentId), {
        organizationId: agent.organizationId,
        projectId: agent.projectId,
        agentId: agent.agentId,
      });
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
    this.projectMembers.set(key(organizationId, `${projectId}:${userId}`), {
      organizationId,
      projectId,
      userId,
      role,
    });
    this.bump(organizationId);
  }

  revokeProjectMembership(organizationId: string, projectId: string, userId: string): void {
    this.projectMembers.delete(key(organizationId, `${projectId}:${userId}`));
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
          ? this.projectMembers.has(key(principal.organizationId, `${principal.projectId}:${principal.userId}`))
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
