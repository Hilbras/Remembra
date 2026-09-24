import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import { verifySignedSnapshot, type SignedSnapshot } from "./snapshot-integrity.js";
import {
  canonicalJson,
  verifyTenantMigrationManifest,
  type TenantMigrationManifest,
} from "./tenant-migration.js";
import {
  planTenantMigration,
  type TenantMigrationPlan,
} from "./tenant-migration-runner.js";
import {
  defaultTrust,
  isValidTenantId,
  ProvenanceSchema,
  SNAPSHOT_FORMAT,
  SnapshotInput,
  type Memory,
  type Provenance,
} from "./types.js";

const PLAN_FORMAT = "remembra-tenant-migration-plan" as const;
const PLAN_VERSION = 1 as const;
const PLAN_INTEGRITY_ALGORITHM = "HMAC-SHA256" as const;

const planFileSchema = z.object({
  format: z.literal(PLAN_FORMAT),
  version: z.literal(PLAN_VERSION),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceNamespace: z.string().min(1).max(512),
  targetOrganizationId: z.string().refine(isValidTenantId, "invalid target organization"),
  manifest: z.unknown(),
  records: z.array(z.object({ source: z.unknown(), destination: z.unknown() })),
  integrity: z.object({
    algorithm: z.literal(PLAN_INTEGRITY_ALGORITHM),
    value: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
}).strict();

export type TenantSnapshotPlanFile = z.infer<typeof planFileSchema>;

export interface TenantSnapshotAnalysis {
  format: "remembra-tenant-snapshot-analysis";
  version: 1;
  sourceFormat: string;
  sourceSchemaVersion: number;
  total: number;
  tenantless: number;
  tenantBound: number;
  mixed: boolean;
  organizations: string[];
  requiresExplicitMigration: boolean;
  estimatedBytes: number;
}

function invalid(message: string): never {
  throw new RemembraError("SNAPSHOT_INVALID", `tenant snapshot migration: ${message}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalizedJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function planSignature(body: Omit<TenantSnapshotPlanFile, "integrity">, key: Buffer | Uint8Array): TenantSnapshotPlanFile["integrity"] {
  return {
    algorithm: PLAN_INTEGRITY_ALGORITHM,
    value: createHmac("sha256", Buffer.from(key)).update(canonicalJson(body), "utf8").digest("base64url"),
  };
}

function normalizeProvenance(value: unknown): Provenance {
  if (typeof value === "string") return { sourceType: value === "auto" ? "conversation" : "manual" };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const parsed = ProvenanceSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return { sourceType: "manual" };
}

function parseSnapshotRecord(value: unknown): SnapshotInput["memories"][number] {
  const parsed = SnapshotInput.safeParse({
    format: SNAPSHOT_FORMAT,
    version: 4,
    exportedAt: new Date().toISOString(),
    memories: [value],
  });
  if (!parsed.success) invalid("plan contains an invalid memory record");
  return parsed.data.memories[0];
}

function recordToMemory(value: unknown, allowTenant: boolean): Memory {
  const raw = parseSnapshotRecord(value);
  if (!allowTenant && raw.tenantId) invalid("migration source unexpectedly contains tenant metadata");
  const provenance = normalizeProvenance(raw.provenance);
  const memory: Memory = {
    id: raw.id,
    type: raw.type,
    content: raw.content,
    scope: raw.scope,
    tags: [...raw.tags],
    importance: raw.importance,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    provenance,
    confidence: raw.confidence ?? (provenance.sourceType === "conversation" ? 0.7 : 1),
    trust: raw.trust ?? defaultTrust(provenance),
    version: raw.version ?? 1,
    owner: raw.owner ?? "global",
    access: raw.access ?? "global",
    relations: raw.relations ?? raw.related?.map((id) => ({ id, kind: "related" as const })),
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.lastSeen ? { lastSeen: raw.lastSeen } : {}),
    ...(raw.lastValidated ? { lastValidated: raw.lastValidated } : {}),
    ...(raw.archivedAt ? { archivedAt: raw.archivedAt } : {}),
    ...(raw.retention ? { retention: raw.retention } : {}),
    ...(raw.meta ? { meta: raw.meta } : {}),
    ...(raw.validFrom ? { validFrom: raw.validFrom } : {}),
    ...(raw.validUntil ? { validUntil: raw.validUntil } : {}),
    ...(raw.observedAt ? { observedAt: raw.observedAt } : {}),
    ...(raw.supersededBy ? { supersededBy: raw.supersededBy } : {}),
    ...(raw.embedding ? { embedding: raw.embedding } : {}),
    ...(raw.tenantId ? { tenantId: raw.tenantId } : {}),
    ...(raw.projectId ? { projectId: raw.projectId } : {}),
    ...(raw.userId ? { userId: raw.userId } : {}),
    ...(raw.agentId ? { agentId: raw.agentId } : {}),
  };
  return normalizedJson(memory) as Memory;
}

/** Analyze a signed V5 snapshot without reading or mutating a destination store. */
export function analyzeTenantSnapshot(data: unknown, key: Buffer | Uint8Array): TenantSnapshotAnalysis {
  const snapshot = verifySignedSnapshot(data, key);
  const organizations = new Set<string>();
  let tenantless = 0;
  let tenantBound = 0;
  for (const memory of snapshot.memories) {
    if (memory.tenantId) {
      tenantBound++;
      organizations.add(memory.tenantId);
    } else {
      tenantless++;
    }
  }
  return {
    format: "remembra-tenant-snapshot-analysis",
    version: 1,
    sourceFormat: snapshot.format,
    sourceSchemaVersion: snapshot.version,
    total: snapshot.memories.length,
    tenantless,
    tenantBound,
    mixed: tenantless > 0 && tenantBound > 0,
    organizations: [...organizations].sort(),
    requiresExplicitMigration: tenantless > 0,
    estimatedBytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  };
}

/** Build a signed, target-bound migration plan from a signed tenantless snapshot. */
export function createTenantSnapshotPlan(
  data: unknown,
  key: Buffer | Uint8Array,
  options: { targetOrganizationId: string; sourceNamespace?: string },
): TenantSnapshotPlanFile {
  const snapshot = verifySignedSnapshot(data, key);
  if (!isValidTenantId(options.targetOrganizationId)) invalid("target organization is invalid");
  if (snapshot.memories.some((memory) => memory.tenantId)) invalid("ordinary tenant migration source must be tenantless");
  const source = snapshot.memories.map((memory) => recordToMemory(memory, false));
  const sourceNamespace = options.sourceNamespace ?? "legacy-root";
  const plan = planTenantMigration({
    source,
    sourceSchemaVersion: snapshot.version,
    organizationMappings: [{ sourceNamespace, destination: options.targetOrganizationId }],
  }, key);
  const body = normalizedJson({
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    snapshotDigest: sha256(normalizedJson(snapshot)),
    sourceNamespace,
    targetOrganizationId: options.targetOrganizationId,
    manifest: plan.manifest,
    records: plan.records,
  }) as Omit<TenantSnapshotPlanFile, "integrity">;
  return { ...body, integrity: planSignature(body, key) };
}

/** Verify a serialized plan and reconstruct its typed migration records. */
export function verifyTenantSnapshotPlan(
  value: unknown,
  snapshotData: unknown,
  key: Buffer | Uint8Array,
): TenantMigrationPlan {
  const parsed = planFileSchema.safeParse(value);
  if (!parsed.success) invalid("migration plan shape is invalid");
  const { integrity, ...body } = parsed.data;
  const expected = planSignature(body, key);
  const actualBytes = Buffer.from(integrity.value, "base64url");
  const expectedBytes = Buffer.from(expected.value, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    invalid("migration plan signature verification failed");
  }
  const snapshot = verifySignedSnapshot(snapshotData, key);
  if (body.snapshotDigest !== sha256(normalizedJson(snapshot))) invalid("migration plan snapshot digest mismatch");
  const manifest = verifyTenantMigrationManifest(body.manifest, key);
  const records = body.records.map(({ source, destination }) => ({
    source: recordToMemory(source, false),
    destination: recordToMemory(destination, true),
  }));
  return { manifest, records };
}

export function tenantSnapshotPlanJson(plan: TenantSnapshotPlanFile): string {
  return JSON.stringify(plan, null, 2);
}
