import type { Memory, StoreInput } from "./types.js";
import type { TenantFilter } from "./tenant.js";

/** One superseded pre-image from `.history/<id>/` (audit Phase 8). */
export interface HistoryEntry {
  /** Snapshot file name (`${epochMs}-${seq}.md`). */
  file: string;
  /** The pre-image's own `updatedAt` — when this version was current. */
  at?: string;
  /** When the snapshot was taken (from the file name's epoch prefix). */
  snapshotAt?: string;
  /** Why this version superseded the pre-image (plan §4.6); from reasons.json. */
  reason?: string;
  /** When it was superseded (reason record), if a reason was given. */
  supersededAt?: string;
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
export interface CandidateSearchRequest {
  /** Normalized terms from retrieval.extractQuery(), never raw FTS syntax. */
  terms: readonly string[];
  /** Non-null vectors require an exact vector candidate provider. */
  vector?: number[] | null;
  scope?: string;
  type?: string;
  includeArchived?: boolean;
  includeExpired?: boolean;
  includeFuture?: boolean;
  includeQuarantined?: boolean;
  /** Shared clock used by the service lifecycle predicate. */
  now: number;
  /** Public result limit, used to size exact modifier anchors. */
  resultLimit: number;
  /** Hard backend output budget; never controlled by the public request. */
  maxCandidates: number;
  /** Service-owned policy/lifecycle predicate, checked before LIMIT. */
  eligible: (memory: Memory) => boolean;
  /** Trusted tenant filter; strict mode requires this before LIMIT. */
  tenant?: TenantFilter;
  /** True for latest/recent temporal queries, which double recency weight. */
  temporalBoost?: boolean;
}

export interface CandidateSearchPage {
  /** Rows that are safe to pass to the ranking pipeline. */
  memories: Memory[];
  /** `partial` means the service must use the existing full-scan path. */
  coverage: "complete" | "partial";
  source: "sqlite" | "file" | "none";
  /** Authoritative pre-scope denominator for keyword IDF. */
  totalDocs?: number;
}

export interface MemoryBackend {
  /** True only when every data-plane method enforces the supplied tenant filter. */
  readonly tenantCapable?: boolean;
  store(input: StoreInput, embedding?: number[], tenant?: TenantFilter): Promise<Memory>;
  /** Optional bounded candidate generation; absence preserves the legacy path. */
  searchCandidates?(request: CandidateSearchRequest): Promise<CandidateSearchPage>;
  /** Optional observability hook — the file backend exposes parse-cache stats. */
  cacheStats?(): { size: number; capacity: number };
  get(id: string, tenant?: TenantFilter): Promise<Memory | null>;
  all(includeArchived?: boolean, tenant?: TenantFilter): Promise<Memory[]>;
  /**
   * Persist an update. Implementations MUST apply optimistic concurrency
   * (plan §3.5): when `opts.expectedVersion` is set, compare it against the
   * stored version inside the write lock and throw CONFLICT on mismatch;
   * the written version is stored+1 either way.
   */
  update(
    memory: Memory,
    opts?: { expectedVersion?: number; reason?: string },
    tenant?: TenantFilter,
  ): Promise<Memory>;
  archive(id: string, tenant?: TenantFilter): Promise<Memory | null>;
  revive(id: string, tenant?: TenantFilter): Promise<Memory | null>;
  touch(id: string, tenant?: TenantFilter): Promise<void>;
  forget(id: string, tenant?: TenantFilter): Promise<boolean>;
  importMemory(m: Memory, tenant?: TenantFilter): Promise<boolean>;
  /** Optional (audit Phase 8): superseded pre-images, newest first. */
  history?(id: string, tenant?: TenantFilter): Promise<HistoryEntry[]>;
  /** V4.4: query audit events (optional; stub returns empty). */
  getAudit?(opts?: { limit?: number; since?: string }, tenant?: TenantFilter): Promise<Record<string, unknown>[]>;
}
