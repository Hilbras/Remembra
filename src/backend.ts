import type { Memory, StoreInput } from "./types.js";

/**
 * Storage abstraction (audit: Phase 3 — separate MemoryStore abstraction to
 * enable a future DB swap).
 *
 * `MemoryService` only ever talks to this contract. `MemoryStore` is the
 * file-backed implementation shipped today; a SQLite/vector-DB backend would
 * only need to satisfy this interface (see docs/architecture.md).
 *
 * Concurrency contract for implementations:
 *  - mutating calls must be safe under same-process concurrency (queueing) and
 *    cross-process concurrency (advisory lock) — a caller may issue `touch()`
 *    while another process runs `archive()`;
 *  - a memory id must exist in exactly one tree at rest;
 *  - `importMemory` must refuse ids that already exist (return false).
 */
export interface MemoryBackend {
  store(
    input: StoreInput,
    embedding?: number[],
    opts?: { provenance?: Memory["provenance"] },
  ): Promise<Memory>;
  /** Optional observability hook — the file backend exposes parse-cache stats. */
  cacheStats?(): { size: number; capacity: number };
  get(id: string): Promise<Memory | null>;
  all(includeArchived?: boolean): Promise<Memory[]>;
  update(memory: Memory): Promise<Memory>;
  archive(id: string): Promise<Memory | null>;
  revive(id: string): Promise<Memory | null>;
  touch(id: string): Promise<void>;
  forget(id: string): Promise<boolean>;
  importMemory(m: Memory): Promise<boolean>;
}
