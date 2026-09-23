import { MemoryStore } from "./store.js";
import { search } from "./retrieval.js";
import { StoreInput, MemoryType } from "./types.js";

/**
 * Transport-agnostic handlers. Both the MCP tools and the HTTP API
 * call into this module, so behavior is guaranteed to match.
 */
export class MemoryService {
  constructor(readonly db: MemoryStore) {}

  async store(input: unknown) {
    const memory = await this.db.store(StoreInput.parse(input));
    return {
      id: memory.id,
      message: `Stored ${memory.type} memory ${memory.id} (scope: ${memory.scope})`,
      memory,
    };
  }

  async search(q: { query?: string; scope?: string; type?: MemoryType; limit?: number }) {
    const results = search(await this.db.all(), q);
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
}
