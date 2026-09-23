import type { Memory, StoreInput } from "./types.js";

/** One superseded pre-image from `.history/<id>/` (audit Phase 8). */
export interface HistoryEntry {
  /** Snapshot file name (`${epochMs}-${seq}.md`). */
  file: string;
  /** The pre-image's own `updatedAt` — when this version was current. */
  at?: string;
  /** When the snapshot was taken (from the file name's epoch prefix). */
  snapshotAt?: string;
  content: string;
}

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
  /** Optional (audit Phase 8): superseded pre-images, newest first. */
  history?(id: string): Promise<HistoryEntry[]>;
}
