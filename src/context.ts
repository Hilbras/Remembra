import { z } from "zod";
import { RemembraError } from "./errors.js";
import { isSafeScope, type Memory, type RetrievalExplanation } from "./types.js";

/** Maximum context budget accepted by the V5 context API. */
export const MAX_CONTEXT_TOKENS = 100_000;
export const MAX_CONTEXT_CANDIDATES = 100;
export const DEFAULT_CONTEXT_TOKENS = 4_000;

export const contextInputShape = {
  query: z.string().max(10_000).optional(),
  scope: z.string().optional(),
  maxTokens: z.number().int().min(1).max(MAX_CONTEXT_TOKENS).default(DEFAULT_CONTEXT_TOKENS),
  limit: z.number().int().min(1).max(MAX_CONTEXT_CANDIDATES).default(MAX_CONTEXT_CANDIDATES),
  explain: z.boolean().optional().default(false),
  includeArchived: z.boolean().optional().default(false),
  includeExpired: z.boolean().optional().default(false),
  includeFuture: z.boolean().optional().default(false),
  includeQuarantined: z.boolean().optional().default(false),
};

export const ContextInput = z
  .object(contextInputShape)
  .refine((value) => value.scope === undefined || isSafeScope(value.scope), {
    message: "scope must not contain '..' path segments",
  });
export type ContextInput = z.infer<typeof ContextInput>;

export interface TokenCounter {
  readonly id: string;
  count(text: string): number;
}

/**
 * Conservative deterministic fallback for environments without a tokenizer.
 * CJK/code-point-heavy text is counted more aggressively than Latin text so
 * the default cannot silently underfill a model context window.
 */
export const defaultTokenCounter: TokenCounter = {
  id: "conservative-estimate-v1",
  count(text: string): number {
    if (text.length === 0) return 0;
    let cjk = 0;
    let codePoints = 0;
    for (const char of text) {
      codePoints++;
      const code = char.codePointAt(0) ?? 0;
      if (
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x20000 && code <= 0x2ffff)
      ) {
        cjk++;
      }
    }
    return Math.max(1, Math.ceil(cjk + (codePoints - cjk) / 4));
  },
};

export interface ContextRetrievalMetadata {
  query: string;
  scope?: string;
  maxTokens: number;
  tokenCounter: string;
  candidateCount: number;
  selectedCount: number;
  omittedCount: number;
  explanations?: RetrievalExplanation[];
}

export type ContextMemory = Omit<Memory, "embedding">;

export interface ContextResult {
  /** Selected memories without internal embedding vectors. */
  memories: ContextMemory[];
  context: string;
  tokenCount: number;
  retrievalMetadata: ContextRetrievalMetadata;
}

/** Stable, human-readable serialization used for budget accounting. */
export function renderContextMemory(memory: Memory): string {
  return `[${memory.id}] ${memory.type.toUpperCase()} (scope: ${memory.scope}, trust: ${memory.trust})\n${memory.content}`;
}

/** Select ranked memories without ever exceeding the active token budget. */
export function selectContextMemories(
  ranked: readonly Memory[],
  maxTokens: number,
  counter: TokenCounter = defaultTokenCounter,
): { memories: Memory[]; context: string; tokenCount: number; omittedCount: number } {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RemembraError("INVALID_INPUT", "maxTokens must be a positive integer");
  }
  const selected: Memory[] = [];
  let context = "";
  let omittedCount = 0;
  const count = (text: string): number => {
    const value = counter.count(text);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`token counter ${counter.id} returned an invalid count`);
    }
    return value;
  };

  for (const memory of ranked) {
    const rendered = renderContextMemory(memory);
    const next = context ? `${context}\n\n${rendered}` : rendered;
    const nextCount = count(next);
    if (nextCount > maxTokens) {
      omittedCount++;
      continue;
    }
    selected.push(memory);
    context = next;
  }

  return {
    memories: selected,
    context,
    tokenCount: context ? count(context) : 0,
    omittedCount,
  };
}
