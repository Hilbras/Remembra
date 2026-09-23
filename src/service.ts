import { MemoryStore } from "./store.js";
import { search } from "./retrieval.js";
import { StoreInput, MemoryType, Memory } from "./types.js";
import { resolveEmbeddingProvider, embedText, EmbeddingProvider } from "./embeddings.js";
import { resolveLlmProvider, extractMemories, LlmProvider, ExtractedMemory } from "./llm.js";

export interface DigestResult {
  extracted: number;
  stored: Memory[];
  skippedDuplicates: number;
  ids: string[];
}

interface ServiceDeps {
  embeddingProvider?: EmbeddingProvider;
  llmProvider?: LlmProvider;
  /** Injection points for tests. */
  embedFn?: (text: string) => Promise<number[]>;
  extractFn?: (transcript: string) => Promise<ExtractedMemory[]>;
}

/**
 * Transport-agnostic handlers. Both the MCP tools and the HTTP API
 * call into this module, so behavior is guaranteed to match.
 */
export class MemoryService {
  private readonly embedFn?: (text: string) => Promise<number[]>;
  private readonly extractFn?: (transcript: string) => Promise<ExtractedMemory[]>;

  constructor(readonly db: MemoryStore, deps: ServiceDeps = {}) {
    const emb = deps.embeddingProvider ?? resolveEmbeddingProvider();
    const llm = deps.llmProvider ?? resolveLlmProvider();

    this.embedFn =
      deps.embedFn ??
      (emb === "none"
        ? undefined
        : async (text: string) => embedText(text, emb));

    // Extraction is resolved lazily inside the call so search/store work
    // even when no LLM key is configured.
    this.extractFn =
      deps.extractFn ??
      (async (transcript: string) => extractMemories(transcript, llm));
  }

  get embeddingsEnabled(): boolean {
    return this.embedFn !== undefined;
  }

  private async maybeEmbed(text: string): Promise<number[] | undefined> {
    if (!this.embedFn) return undefined;
    try {
      return await this.embedFn(text);
    } catch (err) {
      // Degrade to keyword mode rather than failing the write.
      console.error(`Remembra: embedding failed (${err instanceof Error ? err.message : err}); continuing without`);
      return undefined;
    }
  }

  async store(input: unknown) {
    const parsed = StoreInput.parse(input);
    const embedding = await this.maybeEmbed(parsed.content);
    const memory = await this.db.store(parsed, embedding);
    return {
      id: memory.id,
      message: `Stored ${memory.type} memory ${memory.id} (scope: ${memory.scope})`,
      memory,
    };
  }

  async search(q: { query?: string; scope?: string; type?: MemoryType; limit?: number }) {
    let queryVec: number[] | null = null;
    if (q.query && this.embedFn) queryVec = (await this.maybeEmbed(q.query)) ?? null;

    const results = search(await this.db.all(), q, queryVec);
    const text =
      results.length === 0
        ? "No matching memories."
        : results
            .map(
              (m) =>
                `[${m.id}] ${m.type.toUpperCase()} (scope: ${m.scope}, importance: ${m.importance}, ${m.updatedAt.slice(0, 10)})\n${m.content}`,
            )
            .join("\n\n");
    return { text, results };
  }

  async list(q: { scope?: string; type?: MemoryType }) {
    let memories = await this.db.all();
    if (q.scope) memories = memories.filter((m) => m.scope === q.scope || m.scope === "global");
    if (q.type) memories = memories.filter((m) => m.type === q.type);
    memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const text =
      memories.length === 0
        ? "No memories stored yet."
        : memories.map((m) => `[${m.id}] ${m.type} (${m.scope}): ${m.content.split("\n")[0]}`).join("\n");
    return { text, memories };
  }

  async forget(id: string) {
    const ok = await this.db.forget(id);
    return { ok, text: ok ? `Deleted memory ${id}.` : `No memory with id ${id}.` };
  }

  /**
   * Session digest (v2): extract worth-keeping memories from a transcript
   * and store them, skipping exact duplicates already present.
   */
  async digest(opts: { transcript: string; scope?: string; source?: string }): Promise<DigestResult> {
    const extracted = await this.extractFn!(opts.transcript);
    const existing = await this.db.all();
    const seen = new Set(existing.map((m) => dedupKey(m.type, m.content, m.scope)));

    const stored: Memory[] = [];
    let skippedDuplicates = 0;

    for (const item of extracted) {
      const scope = item.scope ?? opts.scope ?? "global";
      const key = dedupKey(item.type, item.content, scope);
      if (seen.has(key)) {
        skippedDuplicates++;
        continue;
      }
      seen.add(key);
      const { memory } = await this.store({
        type: item.type,
        content: item.content,
        scope,
        tags: item.tags,
        importance: item.importance,
        source: opts.source,
      });
      stored.push(memory);
    }

    return {
      extracted: extracted.length,
      stored,
      skippedDuplicates,
      ids: stored.map((m) => m.id),
    };
  }
}

/** Normalized identity for exact-match dedup (v2; LLM merge comes in v3). */
function dedupKey(type: string, content: string, scope: string): string {
  return `${type}|${scope}|${content.toLowerCase().replace(/\s+/g, " ").trim()}`;
}
