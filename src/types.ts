import { z } from "zod";

/** The eleven memory types Remembra stores (plan §4.1 — explicit semantics in docs/memory-model.md). */
export const MemoryType = z.enum([
  "fact",
  "preference",
  "decision",
  "constraint",
  "instruction",
  "role",
  "entity",
  "relationship",
  "event",
  "history",
  "observation",
]);
export type MemoryType = z.infer<typeof MemoryType>;

/**
 * Frontmatter schema versions (plan §3.4). V4-compatible records remain at
 * version 3 so a V4.9 reader can still round-trip the legacy namespace during
 * migration. V5 tenant records use version 4 and are intentionally skipped by
 * V4 readers that cannot enforce organization isolation.
 */
export const SCHEMA_VERSION = 3;
export const TENANT_SCHEMA_VERSION = 4;
export const MAX_SCHEMA_VERSION = TENANT_SCHEMA_VERSION;

/** Opaque tenant identifier grammar shared by persistence and policy code. */
export const TENANT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidTenantId(value: string): boolean {
  return TENANT_ID_RE.test(value) && value !== "." && value !== "..";
}

/** Trust classification (plan §4.5). Gate rule: instruction-like types inject only at trust ≥ trusted. */
export const TrustLevel = z.enum(["unverified", "trusted", "verified", "system"]);
export type TrustLevel = z.infer<typeof TrustLevel>;

/** Where a memory came from (plan §4.3 provenance.sourceType). */
export const SourceType = z.enum(["manual", "conversation", "agent", "import", "system"]);
export type SourceType = z.infer<typeof SourceType>;

/** Decay/protection mode (plan §4.8). Absent = decaying (the default clocks). */
export const RetentionMode = z.enum([
  "pinned",
  "persistent",
  "ephemeral",
  "decaying",
  "neverExpire",
]);
export type RetentionMode = z.infer<typeof RetentionMode>;

/** Typed relation edge (plan §4.7) — replaces the untyped `related: [ids]` list. */
export const RelationKind = z.enum([
  "supports",
  "contradicts",
  "supersedes",
  "refines",
  "duplicates",
  "related",
]);
export type RelationKind = z.infer<typeof RelationKind>;

/** V4.7: memory ownership class. */
export const MemoryOwner = z.enum(["user", "agent", "project", "organization", "global"]);
export type MemoryOwner = z.infer<typeof MemoryOwner>;

/** V4.7: memory access level for multi-agent scoping. */
export const MemoryAccess = z.enum(["private", "shared", "global"]);
export type MemoryAccess = z.infer<typeof MemoryAccess>;

/** Provenance object (plan §4.3): where did this come from, who/which session/agent produced it. */
export const ProvenanceSchema = z.object({
  sourceType: SourceType,
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
  agentId: z.string().optional().describe("V4.7: agent that produced the memory"),
  agentType: z.string().optional().describe("V4.7: agent role (researcher, coder, critic, planner, reviewer)"),
  agentVersion: z.string().optional().describe("V4.7: semantic version of the agent"),
  conversationId: z.string().optional().describe("V4.7: grouped conversation identifier"),
  taskId: z.string().optional().describe("V4.7: task this memory belongs to"),
  runId: z.string().optional().describe("V4.7: single execution/run identifier"),
  provider: z.string().optional().describe("Provider/model (e.g. the digest LLM)"),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** One directed edge to another memory (plan §4.7). Backlinks derived at read time. */
export interface Relation {
  id: string;
  kind: RelationKind;
}

/**
 * Trust default from provenance (plan §4.5/§4.9): conversation extraction is
 * never trusted by itself — it must be approved before it can act as a
 * standing instruction; system writes are system; everything else trusted.
 */
export function defaultTrust(p: Pick<Provenance, "sourceType">): TrustLevel {
  if (p.sourceType === "conversation") return "unverified";
  if (p.sourceType === "system") return "system";
  return "trusted";
}

/**
 * Scope of a memory.
 * - "global": always relevant (user preferences, roles, general facts)
 * - any other string: project/workspace scope (e.g. a project path or project id)
 */
export type MemoryScope = string; // "global" | "/path/to/project" | "chatgpt"

export interface TenantMetadata {
  /** V5 organization boundary. Absent only on V4 legacy records. */
  tenantId?: string;
  projectId?: string;
  userId?: string;
  /** Authorization-bearing agent, distinct from provenance.agentId. */
  agentId?: string;
}

/**
 * Plan §4.2 metadata contract. `Memory` extends it — the HTTP/MCP JSON shape
 * stays flat (all fields top-level), while `MemoryMetadata` names the
 * metadata subset that every read validates (plan §3.4).
 */
export interface MemoryMetadata extends TenantMetadata {
  id: string;
  type: MemoryType;
  scope: string;
  importance: number; // 1..5
  confidence: number; // 0..1 — deliberately independent of importance (§4.4)
  trust: TrustLevel;
  source?: string;
  createdAt: string; // ISO date
  updatedAt: string; // ISO date
  lastSeen?: string; // last time it surfaced in search (decay signal)
  lastValidated?: string; // set when trust is (re)classified (§4.2)
  /** Optimistic-concurrency counter (§3.5). Starts at 1, +1 on every content/
   *  metadata update inside the store lock; exposed as `version` in JSON and
   *  compared against `expectedVersion`. Serialized as frontmatter `revision:`
   *  — frontmatter `version:` is the SCHEMA version. */
  version: number;
  /** V4.7 ownership and visibility policy (also present on Memory). */
  owner?: MemoryOwner;
  access?: MemoryAccess;
}

export interface Memory extends MemoryMetadata {
  content: string;
  tags: string[];
  /**
   * Origin of the write — required since 4.1.0 (plan §4.3/§4.10: every
   * memory answers where it came from). Legacy pre-4.1.0 files store a
   * `provenance: explicit|auto` string or nothing — normalized on read:
   * explicit → { sourceType: manual }, auto → { sourceType: conversation },
   * absent → { sourceType: manual }.
   */
  provenance: Provenance;
  /**
   * Typed outgoing edges (plan §4.7), directed (a→b does not imply b→a);
   * backlinks are derived at read time. Legacy `related: [ids]` lines
   * migrate to kind "related" on read. Managed by `memory_relate`.
   */
  relations?: Relation[];
  /** Decay protection (plan §4.8); absent = decaying (default clocks). */
  retention?: RetentionMode;
  /** Set when archived; archived memories are out of search until revived. */
  archivedAt?: string;
  /** Cached embedding vector (REMEMBRA_EMBEDDINGS≠none); serialized in frontmatter. */
  embedding?: number[];
  /** V4.7: who owns this memory. Absent means the store's default owner. */
  owner?: MemoryOwner;
  /** V4.7: agent-mode visibility policy. Absent means REMEMBRA_DEFAULT_ACCESS or global. */
  access?: MemoryAccess;
  /** V4.4/V4.5: optional meta flags set by security checks and lifecycle. */
  meta?: { injected?: boolean; quarantined?: boolean; contradicted?: boolean; compressedFrom?: string[]; compressionAt?: string };
  /** V4.5: temporal bounds. */
  validFrom?: string;
  validUntil?: string;
  observedAt?: string;
  supersededBy?: string;
}

/**
 * Scope safety: reject `..` path segments so scope can never escape the
 * storage root (P0 directory traversal fix). Absolute paths like
 * `/home/user/project` are fine — path.join keeps them contained.
 */
export function isSafeScope(scope: string): boolean {
  if (scope === "global") return true;
  const normalized = scope.replace(/[^a-zA-Z0-9._/-]/g, "_");
  return !normalized.split("/").some((seg) => seg === "..");
}

/** Memory ids: legacy 8–32 hex, or (since 4.1.0) UUIDv7 (plan §3.6). */
export const MEMORY_ID_RE =
  /^([a-f0-9]{8,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Safe single path component for file-backed history and other derived paths. */
export function isSafeMemoryId(value: string): boolean {
  return value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(value) &&
    !/[. ]$/.test(value);
}

// ---------------------------------------------------------------------------
// Shared input schemas (audit #13: one source of truth).
// The raw `*Shape` objects feed MCP tool inputSchemas (ZodRawShape);
// the parsed `*Input` objects validate on every transport.
// ---------------------------------------------------------------------------

export const trustInput = z
  .enum(["unverified", "trusted", "verified", "system"])
  .describe(
    "Trust classification: unverified (extracted, not yet approved) | trusted (default for direct stores) | verified (human-approved) | system",
  );

export const retentionInput = z
  .enum(["pinned", "persistent", "ephemeral", "decaying", "neverExpire"])
  .describe(
    "Decay protection: decaying (default) | pinned (never decays + rank boost) | persistent (archivable, never auto-deleted) | neverExpire (fully exempt) | ephemeral (accelerated clock lands with 4.5.0; today behaves as decaying)",
  );

export const provenanceInput = z
  .object({
    sourceType: SourceType.optional().describe("manual (default) | conversation | agent | import | system"),
    sessionId: z.string().optional().describe("Session that produced the memory"),
    messageId: z.string().optional().describe("Message within that session"),
    agentId: z.string().optional().describe("Agent that produced the memory"),
    agentType: z.string().optional().describe("Agent role, e.g. researcher or coder"),
    agentVersion: z.string().optional().describe("Version of the agent that produced the memory"),
    conversationId: z.string().optional().describe("Conversation this memory belongs to"),
    taskId: z.string().optional().describe("Task this memory belongs to"),
    runId: z.string().optional().describe("Execution run this memory belongs to"),
    provider: z.string().optional().describe("Provider/model (e.g. the digest LLM)"),
  })
  .optional()
  .describe("Provenance (plan §4.3); defaults to { sourceType: manual }");

export const storeInputShape = {
  type: MemoryType.describe(
    "fact | preference | decision | constraint | instruction | role | entity | relationship | event | history | observation",
  ),
  content: z.string().min(1).describe("The memory itself, written as a standalone statement"),
  scope: z
    .string()
    .default("global")
    .describe("'global' for always-relevant memories, or a project path/id for project-scoped ones"),
  tags: z.array(z.string()).default([]).describe("Keywords that boost retrieval"),
  importance: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("1=minor, 5=critical (default 3)"),
  source: z.string().optional().describe("Originating session or client"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Certainty of this claim 0..1, independent of importance (default 1.0 direct, 0.7 digests)"),
  trust: trustInput
    .optional()
    .describe(
      "Trust classification; default derived from provenance (direct store → trusted, conversation digest → unverified)",
    ),
  retention: retentionInput.optional(),
  provenance: provenanceInput,
  owner: MemoryOwner.optional().describe("V4.7: user | agent | project | organization | global"),
  access: MemoryAccess.optional().describe("V4.7: private | shared | global"),
  meta: z
    .object({
      injected: z.boolean().optional(),
      quarantined: z.boolean().optional(),
      contradicted: z.boolean().optional(),
      compressedFrom: z.array(z.string()).optional(),
      compressionAt: z.string().optional(),
    })
    .optional()
    .describe("V4.4/V4.5: security, lifecycle, and compression metadata"),
  /** V4.5: temporal bounds for time-sensitive memories. */
  validFrom: z.string().optional().describe("ISO timestamp when this claim becomes valid"),
  validUntil: z.string().optional().describe("ISO timestamp when this claim ceases to be valid"),
  observedAt: z.string().optional().describe("ISO timestamp of the original observation (for backfills)"),
  supersededBy: z.string().optional().describe("ID of the memory that supersedes this one"),
};
export const StoreInput = z
  .object(storeInputShape)
  .refine((v) => isSafeScope(v.scope), { message: "scope must not contain '..' path segments" });
export type StoreInput = z.infer<typeof StoreInput>;

export const digestInputShape = {
  transcript: z
    .string()
    .min(1)
    .describe("Conversation transcript or a detailed summary of the session"),
  scope: z.string().optional().describe("Scope for extracted memories (default: global)"),
  source: z.string().optional().describe("Originating session/client"),
};
export const DigestInput = z
  .object(digestInputShape)
  .refine((v) => v.scope === undefined || isSafeScope(v.scope), {
    message: "scope must not contain '..' path segments",
  });
export type DigestInput = z.infer<typeof DigestInput>;

export const searchInputShape = {
  query: z.string().optional().describe("Keywords to match (omit to get a scope/recency-ranked list)"),
  scope: z.string().optional().describe("Current project path or workspace id to filter by"),
  type: MemoryType.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  explain: z.boolean().optional().describe("Include per-memory score breakdown (V4.2.0+)"),
  /** V4.5: include memories whose validUntil has passed. */
  includeExpired: z.boolean().optional(),
  /** V4.5: include memories whose validFrom is in the future. */
  includeFuture: z.boolean().optional(),
  /** V4.5: include quarantined memories. */
  includeQuarantined: z.boolean().optional(),
  /** V4.5: include archived memories. */
  includeArchived: z.boolean().optional(),
};
export const SearchInput = z.object(searchInputShape);
export type SearchInput = z.infer<typeof SearchInput>;

export const listInputShape = {
  scope: z.string().optional(),
  type: MemoryType.optional(),
  includeArchived: z.boolean().optional().describe("Include archived memories (flagged)"),
  offset: z.number().int().min(0).optional().describe("Pagination: skip this many matching memories"),
  limit: z.number().int().min(1).max(500).optional().describe("Pagination: max memories to return"),
  includeQuarantined: z.boolean().optional(),
  includeExpired: z.boolean().optional(),
  includeFuture: z.boolean().optional(),
};
export const ListInput = z.object(listInputShape);
export type ListInput = z.infer<typeof ListInput>;

export const compressInputShape = {
  scope: z.string().optional().describe("Scope to filter memories for compression"),
  type: MemoryType.optional().describe("Memory type to filter for compression"),
  ids: z.array(z.string()).optional().describe("Explicit memory ids to compress"),
};
export const CompressInput = z.object(compressInputShape);
export type CompressInput = z.infer<typeof CompressInput>;

export const forgetInputShape = {
  id: z.string().describe("Memory id (from memory_store or memory_list)"),
};
export const ForgetInput = z.object(forgetInputShape);
export type ForgetInput = z.infer<typeof ForgetInput>;

/** All store fields optional — the patch shape for memory_update / PUT. */
const patchShape = {
  type: storeInputShape.type.optional(),
  content: storeInputShape.content.optional(),
  scope: storeInputShape.scope.optional(),
  tags: storeInputShape.tags.optional(),
  importance: storeInputShape.importance.optional(),
  source: storeInputShape.source.optional(),
  confidence: storeInputShape.confidence.optional(),
  trust: storeInputShape.trust,
  retention: storeInputShape.retention,
};

/** Concurrency guards — not content fields, never spread onto the Memory. */
const guardShape = {
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optimistic concurrency: update fails with CONFLICT (HTTP 409) unless the stored version matches"),
  reason: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Why this version supersedes the last — recorded in the history entry (plan §4.6)"),
};

export const updateInputShape = {
  id: z.string().describe("Memory id to update"),
  ...patchShape,
  ...guardShape,
};

const hasPatchField = (v: Record<string, unknown>): boolean =>
  Object.keys(v).some((k) => k !== "expectedVersion" && k !== "reason" && v[k] !== undefined);

export const UpdateInput = z
  .object({ ...patchShape, ...guardShape })
  .refine((v) => v.scope === undefined || isSafeScope(v.scope), {
    message: "scope must not contain '..' path segments",
  })
  .refine(hasPatchField, {
    message: "update must include at least one field",
  });
export type UpdateInput = z.infer<typeof UpdateInput>;

// V4.8 batch limits are deliberately shared by SDK, HTTP, and MCP callers.
export const MAX_BATCH_ITEMS = 100;
export const MAX_BATCH_BYTES = 10 * 1024 * 1024;

const batchIds = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_BATCH_ITEMS)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "batch ids must be unique",
  });

const hasBatchPatchField = (v: Record<string, unknown>): boolean =>
  Object.keys(v).some(
    (k) => !["id", "expectedVersion", "reason"].includes(k) && v[k] !== undefined,
  );

const batchUpdateItem = z
  .object({ ...updateInputShape, id: z.string().min(1) })
  .refine(hasBatchPatchField, { message: "update must include at least one field" });

const batchUpdateItems = z
  .array(batchUpdateItem)
  .min(1)
  .max(MAX_BATCH_ITEMS)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: "batch update ids must be unique",
  });

export const BatchRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("store"), items: z.array(StoreInput).min(1).max(MAX_BATCH_ITEMS) }),
  z.object({ operation: z.literal("update"), items: batchUpdateItems }),
  z.object({ operation: z.literal("delete"), ids: batchIds }),
  z.object({ operation: z.literal("export"), ids: batchIds }),
]);
export type BatchRequest = z.infer<typeof BatchRequest>;

/** MCP-facing shape; the service performs the discriminated structural parse. */
export const batchInputShape = {
  operation: z.enum(["store", "update", "delete", "export"]).describe("Batch operation"),
  items: z.array(z.unknown()).optional().describe("Store or update items"),
  ids: z.array(z.string()).optional().describe("Delete/export ids"),
};

export interface BatchSummary {
  requested: number;
  succeeded: number;
  failed: number;
}

export interface BatchSuccess<T> {
  index: number;
  id?: string;
  ok: true;
  result: T;
}

export interface BatchFailure {
  index: number;
  id?: string;
  ok: false;
  error: { code: string; message: string };
}

export type BatchOutcome<T = unknown> = BatchSuccess<T> | BatchFailure;

export interface BatchExecutionMetadata {
  transactionPolicy: "per-item" | "read-only";
  idempotency: "unsupported" | "read-only" | "stored" | "replayed";
}

export interface BatchMutationResult {
  operation: "store" | "update" | "delete";
  summary: BatchSummary;
  results: BatchOutcome[];
  execution: BatchExecutionMetadata;
}

export interface BatchExportResult {
  operation: "export";
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  exportedAt: string;
  memories: Memory[];
  summary: BatchSummary;
  results: BatchOutcome<{ id: string }>[];
  execution: BatchExecutionMetadata;
}

export type BatchResult = BatchMutationResult | BatchExportResult;


export const getInputShape = {
  id: z.string().describe("Memory id — returns the memory with related links and backlinks"),
};
export const GetInput = z.object(getInputShape);
export type GetInput = z.infer<typeof GetInput>;

export const relateInputShape = {
  id: z.string().describe("Source memory id"),
  related: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe("Target memory ids to link to / unlink from"),
  action: z
    .enum(["add", "remove"])
    .default("add")
    .describe("add (default) creates links, remove deletes them"),
  kind: RelationKind.default("related").describe(
    "Edge kind (plan §4.7): supports | contradicts | supersedes | refines | duplicates | related",
  ),
};
export const RelateInput = z.object(relateInputShape);
export type RelateInput = z.infer<typeof RelateInput>;

export const historyInputShape = {
  id: z.string().refine(isSafeMemoryId, "invalid memory id").describe("Memory id to show version history for"),
  limit: z.number().int().min(1).max(100).optional().describe("Max past versions to return (newest first)"),
};
export const HistoryInput = z.object(historyInputShape);
export type HistoryInput = z.infer<typeof HistoryInput>;

/** Query accepted by the retrieval layer (retrieval.ts). */
export interface SearchQuery {
  query?: string;
  scope?: string;
  type?: MemoryType;
  limit?: number;
  /** Include per-memory score breakdown (plan §5.8 / V4.2.0). Off by default. */
  explain?: boolean;
  /** Pre-seeded candidate ids for future relationship-expansion calls. */
  candidates?: string[];
  /** Internal corpus size used to keep keyword IDF stable for candidate searches. */
  totalDocs?: number;
}

/** Each scoring component exposed so callers can inspect why a memory ranked
    where it did (plan §5.8). */
export interface RetrievalExplanation {
  /** Unique id of the scored memory. */
  id: string;
  /** Full score breakdown (sums to totalScore). */
  components: Record<string, number>;
  /** The final float score assigned before MMR truncation. */
  totalScore: number;
  /** Which gates fired: "scope_match", "role_gate", "similarity_cut", ... */
  reasons: string[];
}

/** Output envelope from the retrieval pipeline — wraps both the ranked memories
    and optional per-memory explanations. */
export interface SearchResults {
  results: Memory[];
  explanations?: RetrievalExplanation[];
}

/** Backup file envelope (remembra export / import). */
export const SNAPSHOT_FORMAT = "remembra-export";
export const SnapshotInput = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.string(),
  integrity: z
    .object({
      algorithm: z.literal("HMAC-SHA256"),
      value: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .optional(),
  memories: z
    .array(
      z.object({
        id: z.string().regex(MEMORY_ID_RE, "invalid id"),
        type: MemoryType,
        content: z.string().min(1),
        scope: z.string().refine(isSafeScope, { message: "scope must not contain '..'" }),
        tags: z.array(z.string()),
        importance: z.number().int().min(1).max(5),
        createdAt: z.string(),
        updatedAt: z.string(),
        source: z.string().optional(),
        lastSeen: z.string().optional(),
        lastValidated: z.string().optional(),
        archivedAt: z.string().optional(),
        /** Object form (4.1.0+) or legacy string (pre-4.1 exports) — normalized on import. */
        provenance: z.union([ProvenanceSchema, z.enum(["explicit", "auto"])]).optional(),
        confidence: z.number().min(0).max(1).optional(),
        trust: TrustLevel.optional(),
        retention: RetentionMode.optional(),
        owner: MemoryOwner.optional(),
        access: MemoryAccess.optional(),
        tenantId: z.string().regex(TENANT_ID_RE, "invalid tenant id").optional(),
        projectId: z.string().regex(TENANT_ID_RE, "invalid project id").optional(),
        userId: z.string().regex(TENANT_ID_RE, "invalid user id").optional(),
        agentId: z.string().regex(TENANT_ID_RE, "invalid agent id").optional(),
        meta: z
          .object({
            injected: z.boolean().optional(),
            quarantined: z.boolean().optional(),
            contradicted: z.boolean().optional(),
            compressedFrom: z.array(z.string()).optional(),
            compressionAt: z.string().optional(),
          })
          .optional(),
        validFrom: z.string().optional(),
        validUntil: z.string().optional(),
        observedAt: z.string().optional(),
        supersededBy: z.string().optional(),
        version: z.number().int().min(1).optional(),
        /** Typed edges (4.1.0+). */
        relations: z
          .array(z.object({ id: z.string().regex(MEMORY_ID_RE, "invalid id"), kind: RelationKind }))
          .optional(),
        /** Legacy untyped links (pre-4.1 exports) — migrated to kind "related" on import. */
        related: z.array(z.string()).optional(),
        embedding: z.array(z.number()).optional(),
      }),
    )
    .max(100_000),
}).refine((snapshot) => snapshot.version <= MAX_SCHEMA_VERSION, {
  message: `snapshot schema version must be <= ${MAX_SCHEMA_VERSION}`,
});
export type SnapshotInput = z.infer<typeof SnapshotInput>;
