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
  /** Cached embedding vector (REMEMBRA_EMBEDDINGS≠none); serialized in frontmatter. */
  embedding?: number[];
}

export const StoreInput = z.object({
  type: MemoryType,
  content: z.string().min(1),
  scope: z.string().default("global"),
  tags: z.array(z.string()).default([]),
  importance: z.number().int().min(1).max(5).default(3),
  source: z.string().optional(),
});
export type StoreInput = z.infer<typeof StoreInput>;

export interface SearchQuery {
  query?: string;
  scope?: string;
  type?: MemoryType;
  limit?: number;
}
