import { z } from "zod";

/** The four memory types Remembra stores. */
export const MemoryType = z.enum(["fact", "decision", "role", "history"]);
export type MemoryType = z.infer<typeof MemoryType>;

/**
 * Frontmatter schema version. Bump when the Memory format changes and
 * add a migration step in store.ts (missing field in old files = v1).
 */
export const SCHEMA_VERSION = 1;

/**
 * Scope of a memory.
 * - "global": always relevant (user preferences, roles, general facts)
 * - any other string: project/workspace scope (e.g. a project path or project id)
 */
export type MemoryScope = string; // "global" | "/path/to/project" | "chatgpt"

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  scope: MemoryScope;
  tags: string[];
  importance: number; // 1..5
  createdAt: string; // ISO date
  updatedAt: string; // ISO date
  source?: string; // originating session/client
  /**
   * How the memory entered the store: `explicit` = deliberately stored via
   * the tool/API, `auto` = extracted by a digest. Missing on pre-3.4.0 files
   * (neutral — scores as neither). Ranked: explicit +10.
   */
  provenance?: "explicit" | "auto";
  /** Last time the memory surfaced in search results (decay signal). */
  lastSeen?: string;
  /** Set when archived; archived memories are out of search until revived. */
  archivedAt?: string;
  /** Cached embedding vector (REMEMBRA_EMBEDDINGS≠none); serialized in frontmatter. */
  embedding?: number[];
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

// ---------------------------------------------------------------------------
// Shared input schemas (audit #13: one source of truth).
// The raw `*Shape` objects feed MCP tool inputSchemas (ZodRawShape);
// the parsed `*Input` objects validate on every transport.
// ---------------------------------------------------------------------------

export const storeInputShape = {
  type: MemoryType.describe("fact | decision | role | history"),
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
};
export const SearchInput = z.object(searchInputShape);
export type SearchInput = z.infer<typeof SearchInput>;

export const listInputShape = {
  scope: z.string().optional(),
  type: MemoryType.optional(),
  includeArchived: z.boolean().optional().describe("Include archived memories (flagged)"),
};
export const ListInput = z.object(listInputShape);
export type ListInput = z.infer<typeof ListInput>;

export const forgetInputShape = {
  id: z.string().describe("Memory id (from memory_store or memory_list)"),
};
export const ForgetInput = z.object(forgetInputShape);
export type ForgetInput = z.infer<typeof ForgetInput>;

/** Query accepted by the retrieval layer (retrieval.ts). */
export interface SearchQuery {
  query?: string;
  scope?: string;
  type?: MemoryType;
  limit?: number;
}

/** Backup file envelope (remembra export / import). */
export const SNAPSHOT_FORMAT = "remembra-export";
export const SnapshotInput = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.string(),
  memories: z
    .array(
      z.object({
        id: z.string().regex(/^[a-f0-9]{8,32}$/, "invalid id"),
        type: MemoryType,
        content: z.string().min(1),
        scope: z.string().refine(isSafeScope, { message: "scope must not contain '..'" }),
        tags: z.array(z.string()),
        importance: z.number().int().min(1).max(5),
        createdAt: z.string(),
        updatedAt: z.string(),
        source: z.string().optional(),
        lastSeen: z.string().optional(),
        archivedAt: z.string().optional(),
        provenance: z.enum(["explicit", "auto"]).optional(),
        embedding: z.array(z.number()).optional(),
      }),
    )
    .max(100_000),
});
export type SnapshotInput = z.infer<typeof SnapshotInput>;
