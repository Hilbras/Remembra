import { MemoryStore } from "./store.js";
import { search } from "./retrieval.js";
import { StoreInput, MemoryType, Memory } from "./types.js";
import { resolveEmbeddingProvider, embedText, EmbeddingProvider, cosine } from "./embeddings.js";
import {
  resolveLlmProvider,
  extractMemories,
  resolveMerge,
  LlmProvider,
  ExtractedMemory,
} from "./llm.js";

export interface DigestResult {
  extracted: number;
  stored: Memory[];
  skippedDuplicates: number;
  merged: number;
  ids: string[];
}

export interface MaintainResult {
  archived: string[];
  deleted: string[];
  embedded: number;
  revived?: number;
}

interface ServiceDeps {
  embeddingProvider?: EmbeddingProvider;
  llmProvider?: LlmProvider;
  /** Injection points for tests. */
  embedFn?: (text: string) => Promise<number[]>;
  extractFn?: (transcript: string) => Promise<ExtractedMemory[]>;
  mergeFn?: (newContent: string, existing: { type: string; content: string }) => Promise<
    { action: "store" } | { action: "skip" } | { action: "merge"; content: string }
  >;
  /** How often the opportunistic decay pass may run on search (ms). Default 1h. */
  decayIntervalMs?: number;
  /** Active memory unused for this many days gets archived. Default 90. */
  archiveAfterDays?: number;
  /** Archived memory older than this gets auto-deleted. Default 365. */
  archiveTtlDays?: number;
}

/**
 * Transport-agnostic handlers. Both the MCP tools and the HTTP API
 * call into this module, so behavior is guaranteed to match.
 */
export class MemoryService {
  private readonly embedFn?: (text: string) => Promise<number[]>;
  private readonly extractFn: (transcript: string) => Promise<ExtractedMemory[]>;
  private readonly mergeFn: (
    newContent: string,
    existing: { type: string; content: string },
  ) => Promise<{ action: "store" } | { action: "skip" } | { action: "merge"; content: string }>;
  private readonly decayIntervalMs: number;
  private readonly archiveAfterDays: number;
  private readonly archiveTtlDays: number;
  private lastDecayRun = 0;
  private decayRunning = false;

  constructor(readonly db: MemoryStore, deps: ServiceDeps = {}) {
    const emb = deps.embeddingProvider ?? resolveEmbeddingProvider();
    const llm = deps.llmProvider ?? resolveLlmProvider();

    this.embedFn =
      deps.embedFn ??
      (emb === "none" ? undefined : async (text: string) => embedText(text, emb));

    this.extractFn = deps.extractFn ?? (async (t: string) => extractMemories(t, llm));
    this.mergeFn = deps.mergeFn ?? ((n, e) => resolveMerge(n, e, llm));

    this.decayIntervalMs = deps.decayIntervalMs ?? 3_600_000; // 1h
    this.archiveAfterDays = deps.archiveAfterDays ?? Number(process.env.REMEMBRA_ARCHIVE_AFTER_DAYS ?? 90);
    this.archiveTtlDays = deps.archiveTtlDays ?? Number(process.env.REMEMBRA_ARCHIVE_TTL_DAYS ?? 365);
  }

  get embeddingsEnabled(): boolean {
    return this.embedFn !== undefined;
  }

  private async maybeEmbed(text: string): Promise<number[] | undefined> {
    if (!this.embedFn) return undefined;
    try {
      return await this.embedFn(text);
    } catch (err) {
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

    // Refresh decay clocks for memories that surfaced (fire-and-forget).
    for (const m of results) this.db.touch(m.id).catch(() => {});
    // Opportunistic decay pass, debounced (decision v3-Q1: piggyback on search).
    this.maybeRunDecay();

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

  async list(q: { scope?: string; type?: MemoryType; includeArchived?: boolean }) {
    let memories = await this.db.all(q.includeArchived ?? false);
    if (q.scope) memories = memories.filter((m) => m.scope === q.scope || m.scope === "global");
    if (q.type) memories = memories.filter((m) => m.type === q.type);
    memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const text =
      memories.length === 0
        ? "No memories stored yet."
        : memories
            .map(
              (m) =>
                `[${m.id}]${m.archivedAt ? " [archived]" : ""} ${m.type} (${m.scope}): ${m.content.split("\n")[0]}`,
            )
            .join("\n");
    return { text, memories };
  }

  async forget(id: string) {
    const ok = await this.db.forget(id);
    return { ok, text: ok ? `Deleted memory ${id}.` : `No memory with id ${id}.` };
  }

  /**
   * Session digest (v2) with contradiction-merge (v3):
   * extract worth-keeping memories, skip exact duplicates, and let the LLM
   * merge items that evolved from a stored memory (superseded text preserved).
   */
  async digest(opts: { transcript: string; scope?: string; source?: string }): Promise<DigestResult> {
    const extracted = await this.extractFn(opts.transcript);
    const active = await this.db.all();
    const archived = await this.db.all(true).then((all) => all.filter((m) => m.archivedAt));
    const seen = new Set(active.map((m) => dedupKey(m.type, m.content, m.scope)));

    const stored: Memory[] = [];
    let skippedDuplicates = 0;
    let merged = 0;

    for (const item of extracted) {
      const scope = item.scope ?? opts.scope ?? "global";
      const key = dedupKey(item.type, item.content, scope);

      // Exact duplicate → skip (or revive if it had decayed).
      if (seen.has(key)) {
        skippedDuplicates++;
        continue;
      }
      const archivedDup = archived.find((m) => dedupKey(m.type, m.content, scope) === key);
      if (archivedDup) {
        const revived = await this.db.revive(archivedDup.id);
        if (revived) {
          seen.add(key);
          merged++; // counted as a revival/refresh
          continue;
        }
      }

      // Evolved fact → LLM decides: store fresh, skip, or merge.
      const itemVec = (await this.maybeEmbed(item.content)) ?? null;
      const candidate = this.findCandidate(item, scope, [...active, ...archived], itemVec);
      if (candidate) {
        const decision = await this.mergeFn(item.content, {
          type: candidate.type,
          content: candidate.content,
        });
        if (decision.action === "skip") {
          skippedDuplicates++;
          continue;
        }
        if (decision.action === "merge") {
          const now = new Date().toISOString().slice(0, 10);
          const old = candidate.content.split("\n")[0];
          const content = `${decision.content}\n\n> superseded (${now}): ${old}`;
          const embedding = await this.maybeEmbed(decision.content);
          await this.db.update({ ...candidate, content, embedding, source: opts.source ?? candidate.source });
          merged++;
          // Re-index dedup set against the new content.
          seen.delete(dedupKey(candidate.type, candidate.content, candidate.scope));
          seen.add(dedupKey(candidate.type, decision.content, candidate.scope));
          continue;
        }
        // action: "store" → fall through and store fresh
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
      merged,
      ids: stored.map((m) => m.id),
    };
  }

  /**
   * Explicit maintenance (decision v3-Q1): decay sweep + vector backfill.
   * Exposed as the `memory_maintain` tool, POST /maintain, and the CLI.
   */
  async maintain(): Promise<MaintainResult> {
    const result = await this.decayPass();
    // Vector backfill: embed active memories stored while embeddings were off.
    if (this.embedFn) {
      const active = await this.db.all();
      for (const m of active) {
        if (m.embedding && m.embedding.length > 0) continue;
        const vec = await this.maybeEmbed(m.content);
        if (vec) {
          await this.db.update({ ...m, embedding: vec });
          result.embedded++;
        }
      }
    }
    return result;
  }

  /** Decay lifecycle: unused actives → archived → auto-deleted past TTL. */
  private async decayPass(): Promise<MaintainResult> {
    const now = Date.now();
    const archiveCutoff = now - this.archiveAfterDays * 86_400_000;
    const ttlCutoff = now - this.archiveTtlDays * 86_400_000;
    const result: MaintainResult = { archived: [], deleted: [], embedded: 0 };

    const active = await this.db.all();
    for (const m of active) {
      if (m.type === "role") continue; // standing instructions never decay
      const lastActive = Date.parse(m.lastSeen ?? m.updatedAt);
      if (Number.isFinite(lastActive) && lastActive < archiveCutoff) {
        await this.db.archive(m.id);
        result.archived.push(m.id);
      }
    }

    const archived = (await this.db.all(true)).filter((m) => m.archivedAt);
    for (const m of archived) {
      const archivedAt = Date.parse(m.archivedAt!);
      if (Number.isFinite(archivedAt) && archivedAt < ttlCutoff) {
        await this.db.forget(m.id);
        result.deleted.push(m.id);
      }
    }
    return result;
  }

  private maybeRunDecay(): void {
    if (this.decayRunning) return;
    if (Date.now() - this.lastDecayRun < this.decayIntervalMs) return;
    this.lastDecayRun = Date.now();
    this.decayRunning = true;
    this.decayPass()
      .catch((err) => console.error("Remembra: decay pass failed:", err))
      .finally(() => {
        this.decayRunning = false;
      });
  }

  /** Pick the most similar stored memory of the same type+scope for merge comparison. */
  private findCandidate(
    item: ExtractedMemory,
    scope: string,
    pool: Memory[],
    itemVec: number[] | null,
  ): Memory | null {
    let best: Memory | null = null;
    let bestScore = 0;
    for (const m of pool) {
      if (m.type !== item.type || m.scope !== scope) continue;
      const score = candidateSimilarity(item.content, m, itemVec);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    // Threshold: must be clearly about the same thing before spending an LLM call.
    return bestScore >= 0.4 ? best : null;
  }
}

/** Normalized identity for exact-match dedup. */
function dedupKey(type: string, content: string, scope: string): string {
  return `${type}|${scope}|${content.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** Similarity: embeddings (cosine) when both sides have vectors, else keyword overlap. */
function candidateSimilarity(newContent: string, m: Memory, itemVec: number[] | null): number {
  if (itemVec && m.embedding && m.embedding.length === itemVec.length) {
    // Cosine is typically 0..1 for normalized-ish text vectors; scale to our 0..1 threshold.
    return Math.max(0, cosine(itemVec, m.embedding));
  }
  const terms = new Set(
    newContent
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
  if (terms.size === 0) return 0;
  const hay = m.content.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.size;
}
