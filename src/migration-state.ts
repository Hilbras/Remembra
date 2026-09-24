import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import type { MemoryBackend } from "./backend.js";
import {
  applyTenantMigration,
  preflightTenantMigration,
  type TenantMigrationPlan,
  type TenantMigrationProgress,
} from "./tenant-migration-runner.js";
import { canonicalJson, type TenantMigrationManifest } from "./tenant-migration.js";
import type { Memory } from "./types.js";
import type { TenantFilter } from "./tenant.js";

export const MIGRATION_STATE_FORMAT = "remembra-migration-state" as const;
export const MIGRATION_STATE_VERSION = 1 as const;
export type MigrationStatus = "applying" | "applied" | "failed" | "published";

const stateSchema = z.object({
  format: z.literal(MIGRATION_STATE_FORMAT),
  stateVersion: z.literal(MIGRATION_STATE_VERSION),
  planId: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["applying", "applied", "failed", "published"]),
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  updatedAt: z.string().min(1).max(64),
  error: z.string().max(512).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.processed > value.total) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["processed"], message: "processed cannot exceed total" });
  }
  if (value.imported + value.skipped !== value.processed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["imported"], message: "counts must match processed" });
  }
});

export type MigrationState = z.infer<typeof stateSchema>;

export interface MigrationStateStore {
  load(planId: string): Promise<MigrationState | undefined>;
  save(state: MigrationState): Promise<void>;
}

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `migration state: ${message}`);
}

export function migrationPlanId(manifest: TenantMigrationManifest): string {
  return createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
}

function memoryChecksum(memory: Memory): string {
  // Backends may materialize default fields during import; normalize those
  // representations before comparing the verified destination row.
  const normalized: Record<string, unknown> = {
    ...memory,
    retention: memory.retention ?? "decaying",
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) delete normalized[key];
  }
  return createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
}

function destinationFilter(memory: Memory): TenantFilter {
  return {
    organizationId: memory.tenantId!,
    ...(memory.projectId ? { projectId: memory.projectId } : {}),
    ...(memory.userId ? { userId: memory.userId } : {}),
    ...(memory.agentId ? { agentId: memory.agentId } : {}),
  };
}

async function firstUnverifiedRecord(
  plan: TenantMigrationPlan,
  destination: MemoryBackend,
  end: number,
): Promise<number> {
  for (let index = 0; index < end; index++) {
    const record = plan.records[index];
    const found = await destination.get(record.destination.id, destinationFilter(record.destination));
    if (!found || memoryChecksum(found) !== memoryChecksum(record.destination)) return index;
  }
  return end;
}

/** Durable JSON state file using the same no-symlink + fsync/rename discipline as snapshots. */
export class FileMigrationStateStore implements MigrationStateStore {
  constructor(private readonly filePath: string) {}

  async load(planId: string): Promise<MigrationState | undefined> {
    const target = path.resolve(this.filePath);
    let raw: string;
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) invalid("refusing to read a symlink state file");
      if (!stat.isFile()) invalid("state path is not a regular file");
      if (stat.size > 1024 * 1024) invalid("state file exceeds 1 MiB");
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalid("state file is not valid JSON");
    }
    const result = stateSchema.safeParse(parsed);
    if (!result.success) invalid("state file has an invalid shape");
    if (result.data.planId !== planId) invalid("state file belongs to another migration plan");
    return result.data;
  }

  async save(state: MigrationState): Promise<void> {
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) invalid("cannot write an invalid state");
    const target = path.resolve(this.filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) invalid("refusing to overwrite a symlink state file");
      if (!stat.isFile()) invalid("state path is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(parsed.data), "utf8");
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

export interface DurableMigrationOptions {
  stateStore: MigrationStateStore;
  /** Persist every N successfully processed records (default 100). */
  checkpointEvery?: number;
}

export interface DurableMigrationResult {
  imported: number;
  skipped: number;
  state: MigrationState;
}

function stateFor(
  planId: string,
  status: MigrationStatus,
  progress: TenantMigrationProgress | undefined,
  total: number,
  error?: string,
): MigrationState {
  return {
    format: MIGRATION_STATE_FORMAT,
    stateVersion: MIGRATION_STATE_VERSION,
    planId,
    status,
    total,
    processed: progress?.completed ?? 0,
    imported: progress?.imported ?? 0,
    skipped: progress?.skipped ?? 0,
    updatedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

/** Apply a plan with a durable, retryable state checkpoint. */
export async function runDurableTenantMigration(
  plan: TenantMigrationPlan,
  destination: MemoryBackend,
  key: Buffer | Uint8Array,
  options: DurableMigrationOptions,
): Promise<DurableMigrationResult> {
  const manifest = preflightTenantMigration(plan, destination, key);
  const planId = migrationPlanId(manifest);
  const requestedCheckpoint = Number(options.checkpointEvery ?? 100);
  if (!Number.isInteger(requestedCheckpoint) || requestedCheckpoint < 1) {
    invalid("checkpointEvery must be a positive integer");
  }
  const checkpointEvery = requestedCheckpoint;
  const existing = await options.stateStore.load(planId);
  const total = plan.records.length;

  if (existing?.status === "published" || existing?.status === "applied") {
    const verified = await firstUnverifiedRecord(plan, destination, total);
    if (verified !== total) {
      throw new RemembraError("INVALID_INPUT", `migration destination is incomplete at record ${verified}`);
    }
    return { imported: existing.imported, skipped: existing.skipped, state: existing };
  }

  let resumeAt = 0;
  let priorImported = 0;
  let priorSkipped = 0;
  if (existing) {
    const requestedResume = Math.min(existing.processed, total);
    const verified = await firstUnverifiedRecord(plan, destination, requestedResume);
    resumeAt = verified;
    if (verified === requestedResume) {
      priorImported = existing.imported;
      priorSkipped = existing.skipped;
    }
  }

  const retryable = { ...(existing ?? stateFor(planId, "applying", undefined, total)) };
  delete retryable.error;
  let latest: MigrationState = {
    ...retryable,
    status: "applying",
    processed: resumeAt,
    imported: priorImported,
    skipped: priorSkipped,
    updatedAt: new Date().toISOString(),
  };
  await options.stateStore.save(latest);
  try {
    const result = await applyTenantMigration(plan, destination, key, {
      startAt: resumeAt,
      onProgress: async (progress) => {
        if (progress.completed % checkpointEvery !== 0 && progress.completed !== progress.total) return;
        latest = stateFor(planId, "applying", {
          ...progress,
          imported: priorImported + progress.imported,
          skipped: priorSkipped + progress.skipped,
        }, total);
        await options.stateStore.save(latest);
      },
    });
    const verified = await firstUnverifiedRecord(plan, destination, total);
    if (verified !== total) {
      throw new RemembraError("INVALID_INPUT", `migration verification missing record ${verified}`);
    }
    latest = stateFor(planId, "applied", {
      completed: total,
      total,
      imported: priorImported + result.imported,
      skipped: priorSkipped + result.skipped,
      id: plan.records.at(-1)?.destination.id ?? "",
    }, total);
    await options.stateStore.save(latest);
    return {
      imported: priorImported + result.imported,
      skipped: priorSkipped + result.skipped,
      state: latest,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    latest = { ...latest, status: "failed", error: message.slice(0, 512), updatedAt: new Date().toISOString() };
    await options.stateStore.save(latest);
    throw error;
  }
}

/** Operator-confirmed publication marker; callers must perform any backend swap before this. */
export async function publishTenantMigration(
  planId: string,
  stateStore: MigrationStateStore,
): Promise<MigrationState> {
  const state = await stateStore.load(planId);
  if (!state) invalid("migration state not found");
  if (state.status !== "applied") invalid(`migration cannot be published from ${state.status}`);
  const published: MigrationState = { ...state, status: "published", updatedAt: new Date().toISOString() };
  await stateStore.save(published);
  return published;
}
