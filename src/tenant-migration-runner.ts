import { createHash } from "node:crypto";
import type { MemoryBackend } from "./backend.js";
import { RemembraError } from "./errors.js";
import {
  canonicalJson,
  createTenantMigrationManifest,
  verifyTenantMigrationManifest,
  type TenantMigrationManifest,
} from "./tenant-migration.js";
import type { Memory, MemoryAccess, MemoryOwner } from "./types.js";
import { memoryBelongsToTenant, type TenantFilter } from "./tenant.js";

export interface TenantMigrationEntityMappings {
  users?: Array<{ source: string; destination: string }>;
  projects?: Array<{ source: string; destination: string }>;
  agents?: Array<{ source: string; destination: string }>;
  scopes?: Array<{ source: string; destination: string }>;
}

export interface TenantMigrationAclMapping {
  sourceOwner: MemoryOwner;
  sourceAccess: MemoryAccess;
  destinationOwner: MemoryOwner;
  destinationAccess: MemoryAccess;
}

export interface TenantMigrationPlanInput {
  source: readonly Memory[];
  sourceSchemaVersion: number;
  organizationMappings: Array<{ sourceNamespace: string; destination: string }>;
  entityMappings?: TenantMigrationEntityMappings;
  aclMappings?: TenantMigrationAclMapping[];
  sourceNamespace?: (memory: Memory) => string;
  historyCount?: number;
  auditCount?: number;
  createdAt?: string;
}

export interface TenantMigrationDestinationRecord {
  source: Memory;
  destination: Memory;
}

export interface TenantMigrationPlan {
  readonly manifest: TenantMigrationManifest;
  readonly records: readonly TenantMigrationDestinationRecord[];
}

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `tenant migration: ${message}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function mappingValue(
  mappings: Array<{ source: string; destination: string }> | undefined,
  source: string | undefined,
  label: string,
): string | undefined {
  if (source === undefined) return undefined;
  const found = mappings?.find((mapping) => mapping.source === source);
  if (!found) invalid(`unmapped ${label} ${source}`);
  return found.destination;
}

function filterFor(memory: Memory): TenantFilter {
  return {
    organizationId: memory.tenantId!,
    ...(memory.projectId ? { projectId: memory.projectId } : {}),
    ...(memory.userId ? { userId: memory.userId } : {}),
    ...(memory.agentId ? { agentId: memory.agentId } : {}),
  };
}

/** Build and sign a fully checked migration plan without writing the destination. */
export function planTenantMigration(input: TenantMigrationPlanInput, key: Buffer | Uint8Array): TenantMigrationPlan {
  if (input.source.length === 0) invalid("source is empty");
  const sourceIds = new Set<string>();
  for (const memory of input.source) {
    if (sourceIds.has(memory.id)) invalid(`duplicate source memory id ${memory.id}`);
    if (memory.tenantId) invalid(`source memory ${memory.id} already has tenant metadata`);
    sourceIds.add(memory.id);
  }

  const sourceNamespace = input.sourceNamespace ?? (() => "legacy-root");
  const organizationFor = new Map<string, string>();
  for (const mapping of input.organizationMappings) {
    if (organizationFor.has(mapping.sourceNamespace)) invalid(`duplicate source namespace ${mapping.sourceNamespace}`);
    organizationFor.set(mapping.sourceNamespace, mapping.destination);
  }

  const entityMappings = input.entityMappings ?? {};
  const aclPairs = new Map<string, TenantMigrationAclMapping>();
  for (const mapping of input.aclMappings ?? []) {
    aclPairs.set(`${mapping.sourceOwner}:${mapping.sourceAccess}`, mapping);
  }

  const references: Array<{
    organizationId: string;
    sourceId: string;
    targetId: string;
    kind: string;
    sha256: string;
  }> = [];
  const records: TenantMigrationDestinationRecord[] = [];
  for (const source of input.source) {
    const namespace = sourceNamespace(source);
    const organizationId = organizationFor.get(namespace);
    if (!organizationId) invalid(`unmapped source namespace ${namespace}`);
    const projectId = mappingValue(entityMappings.projects, source.projectId, "project");
    const userId = mappingValue(entityMappings.users, source.userId, "user");
    const agentId = mappingValue(entityMappings.agents, source.agentId, "agent");
    const acl = aclPairs.get(`${source.owner ?? "global"}:${source.access ?? "global"}`);
    const destination: Memory = {
      ...source,
      tenantId: organizationId,
      ...(projectId ? { projectId } : {}),
      ...(userId ? { userId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(acl
        ? { owner: acl.destinationOwner, access: acl.destinationAccess }
        : { owner: source.owner ?? "global", access: source.access ?? "global" }),
    };
    const addReference = (targetId: string, kind: string): void => {
      if (!sourceIds.has(targetId)) invalid(`reference ${source.id} -> ${targetId} is outside the source set`);
      references.push({
        organizationId,
        sourceId: source.id,
        targetId,
        kind,
        sha256: sha256({ sourceId: source.id, targetId, kind }),
      });
    };
    for (const relation of source.relations ?? []) addReference(relation.id, relation.kind);
    if (source.supersededBy) addReference(source.supersededBy, "supersedes");
    for (const id of source.meta?.compressedFrom ?? []) addReference(id, "compressedFrom");
    records.push({ source, destination });
  }

  const manifest = createTenantMigrationManifest({
    sourceSchemaVersion: input.sourceSchemaVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
    organizationMappings: input.organizationMappings,
    entityMappings: {
      users: entityMappings.users ?? [],
      projects: entityMappings.projects ?? [],
      agents: entityMappings.agents ?? [],
      scopes: entityMappings.scopes ?? [],
    },
    aclMappings: input.aclMappings ?? [],
    counts: {
      memories: records.length,
      relations: references.length,
      history: input.historyCount ?? 0,
      audit: input.auditCount ?? 0,
    },
    records: records.map(({ source, destination }) => ({
      organizationId: destination.tenantId!,
      id: source.id,
      sha256: sha256(source),
    })),
    references,
  }, key);

  return Object.freeze({ manifest, records: Object.freeze(records) });
}

export interface TenantMigrationApplyResult {
  imported: number;
  skipped: number;
}

export interface TenantMigrationProgress {
  completed: number;
  total: number;
  imported: number;
  skipped: number;
  id: string;
}

export interface TenantMigrationApplyOptions {
  onProgress?: (progress: TenantMigrationProgress) => void | Promise<void>;
  /** Number of already-verified records to skip (used by durable retries). */
  startAt?: number;
  /** Trusted destination filter; every mapped record must fit it. */
  destinationFilter?: TenantFilter;
}

/** Verify the signature, source checksums, mappings, and destination capability. */
export function preflightTenantMigration(
  plan: TenantMigrationPlan,
  destination: MemoryBackend,
  key: Buffer | Uint8Array,
  destinationFilter?: TenantFilter,
): TenantMigrationManifest {
  const manifest = verifyTenantMigrationManifest(plan.manifest, key);
  if (destination.tenantCapable !== true) {
    throw new RemembraError("SERVICE_UNAVAILABLE", "tenant migration requires a tenant-capable destination backend");
  }
  if (manifest.records.length !== plan.records.length) invalid("plan record count does not match manifest");
  const manifestRecords = new Map(manifest.records.map((record) => [record.id, record]));
  const seen = new Set<string>();
  for (const record of plan.records) {
    const manifestRecord = manifestRecords.get(record.source.id);
    if (!manifestRecord || sha256(record.source) !== manifestRecord.sha256) {
      invalid(`source checksum mismatch for ${record.source.id}`);
    }
    const identity = `${record.destination.tenantId}:${record.destination.id}`;
    if (seen.has(identity)) invalid(`duplicate destination identity ${identity}`);
    seen.add(identity);
    if (record.destination.tenantId !== manifestRecord.organizationId) {
      invalid(`destination organization mismatch for ${record.source.id}`);
    }
    if (destinationFilter && !memoryBelongsToTenant(record.destination, destinationFilter)) {
      invalid(`destination dimensions are outside the trusted tenant scope for ${record.source.id}`);
    }
  }
  return manifest;
}

/** Verify and apply a plan; duplicate destination IDs are safely skipped on retry. */
export async function applyTenantMigration(
  plan: TenantMigrationPlan,
  destination: MemoryBackend,
  key: Buffer | Uint8Array,
  options: TenantMigrationApplyOptions = {},
): Promise<TenantMigrationApplyResult> {
  const manifest = preflightTenantMigration(plan, destination, key, options.destinationFilter);
  const requestedStart = Number(options.startAt ?? 0);
  if (!Number.isInteger(requestedStart) || requestedStart < 0) {
    invalid("startAt must be a non-negative integer");
  }
  const startAt = Math.min(requestedStart, plan.records.length);
  let imported = 0;
  let skipped = 0;
  for (const [index, record] of plan.records.entries()) {
    if (index < startAt) continue;
    const destinationFilter = options.destinationFilter ?? filterFor(record.destination);
    if (await destination.importMemory(record.destination, destinationFilter)) imported++;
    else skipped++;
    await options.onProgress?.({
      completed: index + 1,
      total: manifest.records.length,
      imported,
      skipped,
      id: record.destination.id,
    });
  }
  return { imported, skipped };
}
