import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import {
  InMemoryTenantDirectory,
  type TenantDirectory,
  type TenantDirectoryAgent,
  type TenantDirectoryProject,
  type TenantDirectorySnapshot,
  type TenantDirectoryUser,
  type TenantMembershipRole,
} from "./tenant-directory.js";
import type { TenantContext } from "./tenant.js";

const DIRECTORY_FILE_FORMAT = "remembra-tenant-directory" as const;
const DIRECTORY_FILE_VERSION = 1 as const;
const directoryFileSchema = z.object({
  format: z.literal(DIRECTORY_FILE_FORMAT),
  version: z.literal(DIRECTORY_FILE_VERSION),
  state: z.unknown(),
}).strict();

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `tenant directory file: ${message}`);
}

/**
 * Durable, single-file tenant directory for local deployments and migration
 * tooling. Mutations are serialized and published through fsync + rename; the
 * authoritative production identity service may implement the same interface.
 */
export class FileTenantDirectory implements TenantDirectory {
  private state: InMemoryTenantDirectory | undefined;
  private loadPromise: Promise<void> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;

  constructor(private readonly filePath: string, maxBytes = 4 * 1024 * 1024) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) {
      throw new RemembraError("INVALID_INPUT", "tenant directory maxBytes is out of range");
    }
    this.maxBytes = maxBytes;
  }

  async load(): Promise<void> {
    await this.enqueue(() => this.ensureLoaded());
  }

  async getMembershipVersion(organizationId: string): Promise<string | undefined> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.state!.getMembershipVersion(organizationId);
    });
  }

  async verifyContext(context: TenantContext): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.state!.verifyContext(context);
    });
  }

  async snapshot(): Promise<TenantDirectorySnapshot> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.state!.snapshot();
    });
  }

  async createOrganization(organizationId: string): Promise<void> {
    await this.mutate((directory) => directory.createOrganization(organizationId));
  }

  async upsertUser(user: TenantDirectoryUser): Promise<void> {
    await this.mutate((directory) => directory.upsertUser(user));
  }

  async removeUser(organizationId: string, userId: string): Promise<void> {
    await this.mutate((directory) => directory.removeUser(organizationId, userId));
  }

  async upsertProject(project: TenantDirectoryProject): Promise<void> {
    await this.mutate((directory) => directory.upsertProject(project));
  }

  async removeProject(organizationId: string, projectId: string): Promise<void> {
    await this.mutate((directory) => directory.removeProject(organizationId, projectId));
  }

  async upsertAgent(agent: TenantDirectoryAgent): Promise<void> {
    await this.mutate((directory) => directory.upsertAgent(agent));
  }

  async removeAgent(organizationId: string, agentId: string): Promise<void> {
    await this.mutate((directory) => directory.removeAgent(organizationId, agentId));
  }

  async grantProjectMembership(
    organizationId: string,
    projectId: string,
    userId: string,
    role: TenantMembershipRole = "member",
  ): Promise<void> {
    await this.mutate((directory) => directory.grantProjectMembership(organizationId, projectId, userId, role));
  }

  async revokeProjectMembership(organizationId: string, projectId: string, userId: string): Promise<void> {
    await this.mutate((directory) => directory.revokeProjectMembership(organizationId, projectId, userId));
  }

  private async mutate(operation: (directory: InMemoryTenantDirectory) => void): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      const before = this.state!.snapshot();
      try {
        operation(this.state!);
        await this.persist(this.state!.snapshot());
      } catch (error) {
        this.state = InMemoryTenantDirectory.fromSnapshot(before);
        throw error;
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.readFromDisk();
    return this.loadPromise;
  }

  private async readFromDisk(): Promise<void> {
    const target = path.resolve(this.filePath);
    let raw: string;
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) invalid("refusing to read a symlink directory file");
      if (!stat.isFile()) invalid("directory path is not a regular file");
      if (stat.size > this.maxBytes) invalid(`directory file exceeds ${this.maxBytes} bytes`);
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = new InMemoryTenantDirectory();
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalid("directory file is not valid JSON");
    }
    const file = directoryFileSchema.safeParse(parsed);
    if (!file.success) invalid("directory file has an invalid envelope");
    try {
      this.state = InMemoryTenantDirectory.fromSnapshot(file.data.state as TenantDirectorySnapshot);
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      invalid("directory file contains invalid entity references");
    }
  }

  private async persist(state: TenantDirectorySnapshot): Promise<void> {
    const target = path.resolve(this.filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) invalid("refusing to overwrite a symlink directory file");
      if (!stat.isFile()) invalid("directory path is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const envelope = { format: DIRECTORY_FILE_FORMAT, version: DIRECTORY_FILE_VERSION, state };
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) invalid(`directory file exceeds ${this.maxBytes} bytes`);
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }
}
