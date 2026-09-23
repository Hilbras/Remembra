import { z } from "zod";

/** The four memory types Remembra stores. */
export const MemoryType = z.enum(["fact", "decision", "role", "history"]);
export type MemoryType = z.infer<typeof MemoryType>;

/**
 * Scope of a memory.
 * - "global": always relevant (user preferences, roles, general facts)
 * - any other string: project/workspace scope (e.g. a repo path or project id)
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

export const StoreInput = z.object({
  type: MemoryType,
  content: z.string().min(1),
  scope: z
    .string()
    .default("global")
    .refine(isSafeScope, { message: "scope must not contain '..' path segments" }),
  tags: z.array(z.string()).default([]),
  importance: z.number().int().min(1).max(5).default(3),
  source: z.string().optional(),
});
export type StoreInput = z.infer<typeof StoreInput>;

export const DigestInput = z.object({
  transcript: z.string().min(1),
  scope: z
    .string()
    .refine(isSafeScope, { message: "scope must not contain '..' path segments" })
    .optional(),
  source: z.string().max(500).optional(),
});
export type DigestInput = z.infer<typeof DigestInput>;

export interface SearchQuery {
  query?: string;
  scope?: string;
  type?: MemoryType;
  limit?: number;
}
