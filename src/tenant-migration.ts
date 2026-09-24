import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import {
  MAX_SCHEMA_VERSION,
  TENANT_SCHEMA_VERSION,
  TENANT_ID_RE,
  MEMORY_ID_RE,
  MemoryOwner,
  MemoryAccess,
  RelationKind,
} from "./types.js";

export const TENANT_MIGRATION_FORMAT = "remembra-tenant-migration";
export const TENANT_MIGRATION_VERSION = 1 as const;

const identifier = z.string().regex(TENANT_ID_RE, "invalid tenant identifier");
const sourceLabel = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "source labels must not contain control characters");
const checksum = z.string().regex(/^[a-f0-9]{64}$/, "expected a SHA-256 hex digest");

const organizationMapping = z
  .object({ sourceNamespace: sourceLabel, destination: identifier })
  .strict();
const entityMapping = z.object({ source: sourceLabel, destination: identifier }).strict();

const entityMappingsSchema = z
  .object({
    users: z.array(entityMapping).max(100_000).default([]),
    projects: z.array(entityMapping).max(100_000).default([]),
    agents: z.array(entityMapping).max(100_000).default([]),
    scopes: z.array(entityMapping).max(100_000).default([]),
  })
  .strict();

const aclMappingSchema = z
  .object({
    sourceOwner: MemoryOwner,
    sourceAccess: MemoryAccess,
    destinationOwner: MemoryOwner,
    destinationAccess: MemoryAccess,
  })
  .strict();

const referenceSchema = z
  .object({
    organizationId: identifier,
    sourceId: z.string().regex(MEMORY_ID_RE, "invalid source memory id"),
    targetId: z.string().regex(MEMORY_ID_RE, "invalid target memory id"),
    kind: RelationKind,
    sha256: checksum,
  })
  .strict();

const recordSchema = z
  .object({
    organizationId: identifier,
    id: z.string().regex(MEMORY_ID_RE, "invalid memory id"),
    sha256: checksum,
  })
  .strict();

const countsSchema = z
  .object({
    memories: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
    history: z.number().int().nonnegative(),
    audit: z.number().int().nonnegative(),
  })
  .strict();

const signatureSchema = z
  .object({
    algorithm: z.literal("HMAC-SHA256"),
    value: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

const manifestBodyShape = {
  format: z.literal(TENANT_MIGRATION_FORMAT),
  manifestVersion: z.literal(TENANT_MIGRATION_VERSION),
  sourceSchemaVersion: z.number().int().min(1).max(MAX_SCHEMA_VERSION),
  destinationSchemaVersion: z.literal(TENANT_SCHEMA_VERSION),
  createdAt: z.string().min(1).max(64),
  organizationMappings: z.array(organizationMapping).min(1).max(100_000),
  entityMappings: entityMappingsSchema,
  aclMappings: z.array(aclMappingSchema).max(100_000).default([]),
  counts: countsSchema,
  records: z.array(recordSchema).max(1_000_000),
  references: z.array(referenceSchema).max(5_000_000).default([]),
};

const manifestBodySchema = z
  .object(manifestBodyShape)
  .strict()
  .superRefine((value, ctx) => {
    const destinations = new Set<string>();
    const sourceNamespaces = new Set<string>();
    for (const [index, mapping] of value.organizationMappings.entries()) {
      if (sourceNamespaces.has(mapping.sourceNamespace)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationMappings", index, "sourceNamespace"], message: "duplicate source namespace" });
      }
      if (destinations.has(mapping.destination)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationMappings", index, "destination"], message: "duplicate destination organization" });
      }
      sourceNamespaces.add(mapping.sourceNamespace);
      destinations.add(mapping.destination);
    }
    for (const [kind, mappings] of Object.entries(value.entityMappings)) {
      const sources = new Set<string>();
      const targets = new Set<string>();
      mappings.forEach((mapping, index) => {
        if (sources.has(mapping.source)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entityMappings", kind, index, "source"], message: "duplicate source entity" });
        }
        if (targets.has(mapping.destination)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entityMappings", kind, index, "destination"], message: "duplicate destination entity" });
        }
        sources.add(mapping.source);
        targets.add(mapping.destination);
      });
    }
    if (value.counts.memories !== value.records.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["counts", "memories"], message: "memory count must match records" });
    }
    if (value.counts.relations !== value.references.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["counts", "relations"], message: "relation count must match references" });
    }
    const ids = new Set<string>();
    for (const [index, record] of value.records.entries()) {
      const key = `${record.organizationId}:${record.id}`;
      if (ids.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["records", index], message: "duplicate organization/resource record" });
      }
      ids.add(key);
    }
  });

export type TenantMigrationManifestInput = {
  sourceSchemaVersion: number;
  createdAt: string;
  organizationMappings: z.input<typeof organizationMapping>[];
  entityMappings?: z.input<typeof entityMappingsSchema>;
  aclMappings?: z.input<typeof aclMappingSchema>[];
  counts: z.input<typeof countsSchema>;
  records: z.input<typeof recordSchema>[];
  references?: z.input<typeof referenceSchema>[];
};
export type TenantMigrationManifest = z.infer<typeof manifestBodySchema> & {
  signature: z.infer<typeof signatureSchema>;
};

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `tenant migration manifest: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function bodyWithDefaults(input: TenantMigrationManifestInput): z.infer<typeof manifestBodySchema> {
  const candidate = {
    format: TENANT_MIGRATION_FORMAT,
    manifestVersion: TENANT_MIGRATION_VERSION,
    sourceSchemaVersion: input.sourceSchemaVersion,
    destinationSchemaVersion: TENANT_SCHEMA_VERSION,
    createdAt: input.createdAt,
    organizationMappings: input.organizationMappings,
    entityMappings: input.entityMappings,
    aclMappings: input.aclMappings,
    counts: input.counts,
    records: input.records,
    references: input.references,
  };
  const parsed = manifestBodySchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    invalid(`${issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : "invalid manifest"}`);
  }
  return parsed.data;
}

function sign(body: z.infer<typeof manifestBodySchema>, key: Buffer): z.infer<typeof signatureSchema> {
  if (key.length === 0) invalid("HMAC key must not be empty");
  return {
    algorithm: "HMAC-SHA256",
    value: createHmac("sha256", key).update(canonicalJson(body), "utf8").digest("base64url"),
  };
}

export function createTenantMigrationManifest(
  input: TenantMigrationManifestInput,
  key: Buffer | Uint8Array,
): TenantMigrationManifest {
  const body = bodyWithDefaults(input);
  return deepFreeze({ ...body, signature: sign(body, Buffer.from(key)) });
}

export function verifyTenantMigrationManifest(value: unknown, key: Buffer | Uint8Array): TenantMigrationManifest {
  // The manifest is flat. Parse the signature envelope first, then run the
  // body schema (including cross-field duplicate/count checks) on exactly the
  // bytes that will be authenticated.
  const envelope = z.object({
    ...manifestBodyShape,
    signature: signatureSchema,
  }).strict().safeParse(value);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    throw new RemembraError("SNAPSHOT_INVALID", `tenant migration manifest: ${issue?.message || "invalid shape"}`);
  }
  const { signature, ...candidateBody } = envelope.data;
  const bodyResult = manifestBodySchema.safeParse(candidateBody);
  if (!bodyResult.success) {
    const issue = bodyResult.error.issues[0];
    throw new RemembraError("SNAPSHOT_INVALID", `tenant migration manifest: ${issue?.message || "invalid body"}`);
  }
  const body = bodyResult.data;
  if (key.length === 0) throw new RemembraError("SNAPSHOT_INVALID", "tenant migration manifest: HMAC key is empty");
  const expected = sign(body, Buffer.from(key));
  const actualBuffer = Buffer.from(signature.value, "base64url");
  const expectedBuffer = Buffer.from(expected.value, "base64url");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new RemembraError("SNAPSHOT_INVALID", "tenant migration manifest: signature verification failed");
  }
  return deepFreeze({ ...body, signature });
}
