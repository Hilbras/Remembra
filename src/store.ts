import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  Memory,
  StoreInput,
  SCHEMA_VERSION,
  TENANT_SCHEMA_VERSION,
  isValidTenantId,
  MemoryType,
  Provenance,
  ProvenanceSchema,
  Relation,
  RelationKind,
  RetentionMode,
  MemoryOwner,
  MemoryAccess,
  TrustLevel,
  defaultTrust,
  isSafeMemoryId,
} from "./types.js";
import type { MemoryBackend, HistoryEntry } from "./backend.js";
import { RemembraError } from "./errors.js";
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import { encryptionEnabled, isEncrypted, encryptBuffer, decryptBuffer } from "./crypto.js";
import { defaultAccess, defaultOwner } from "./agent.js";
import { tenantDirectoryKey, type TenantFilter } from "./tenant.js";

export interface StoreLockOptions {
  /** Max wait for the cross-process lock (ms). Env: REMEMBRA_LOCK_TIMEOUT_MS. Default 5000. */
  lockTimeoutMs?: number;
  /** Lock files older than this with a dead/unknown pid are stolen (ms). Env: REMEMBRA_LOCK_STALE_MS. Default 10000. */
  lockStaleMs?: number;
  /** LRU parse-cache capacity in entries. Env: REMEMBRA_CACHE_SIZE. Default 10000; 0 disables. */
  cacheSize?: number;
  /** Test hook: memory-id factory (default: UUIDv7 — plan §3.6). */
  idGen?: () => string;
}

function assertSafeHistoryId(id: string): void {
  if (!isSafeMemoryId(id)) {
    throw new RemembraError("INVALID_INPUT", "memory id is not safe for a history path");
  }
}

function assertContained(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RemembraError("INVALID_INPUT", "history path escapes storage root");
  }
}

async function ensureSafeDirectory(dir: string, label: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) throw new RemembraError("INVALID_INPUT", `${label} must not be a symlink`);
    if (!stat.isDirectory()) throw new RemembraError("INVALID_INPUT", `${label} must be a directory`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(dir, { recursive: true });
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RemembraError("INVALID_INPUT", `${label} is not a safe directory`);
    }
    return false;
  }
}

async function isExistingSafeDirectory(dir: string, label: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) throw new RemembraError("INVALID_INPUT", `${label} must not be a symlink`);
    if (!stat.isDirectory()) throw new RemembraError("INVALID_INPUT", `${label} must be a directory`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularFile(file: string, label: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RemembraError("INVALID_INPUT", `${label} must be a regular non-symlink file`);
  }
}

/**
 * File-based memory store (source of truth — no database).
 *
 * Layout (default root: ~/.remembra):
 *   global/<id>.md            — active memories, valid everywhere
 *   scopes/<scope>/<id>.md    — active memories scoped to a project/workspace
 *   archived/global/<id>.md   — archived memories (out of search, listed with flag)
 *   archived/scopes/<scope>/  — archived scoped memories
 *
 * Concurrency (audit: advisory file locking):
 *   - in-process: all mutating ops of one instance go through a FIFO queue;
 *   - cross-process: `<root>/.remembra.lock` via O_EXCL create, stolen only
 *     when stale (dead pid or older than lockStaleMs).
 *
 * Crash recovery (audit: journal for crash recovery — recovery-pass flavor):
 *   atomic rename() already prevents torn files, so instead of a WAL this
 *   store runs a one-time recovery on first access per instance:
 *     1. delete orphaned `*.tmp` files (crash between write and rename);
 *     2. reconcile ids present in BOTH active and archived trees (crash
 *        between archive/revive's write and unlink) — newest updatedAt wins,
 *        ties go to the archived copy.
 *
 * Parse cache (audit Phase 5: LRU / lazy loading):
 *   an LRU of parsed memories keyed by file path and validated by
 *   (mtimeMs, size) on every read. A hit costs one stat() instead of
 *   read+parse; writes update the entry they produced, deletes evict, and
 *   cross-process writers are caught by the stat check — so correctness
 *   never depends on cache coherence, only speed does.
 */
export class MemoryStore implements MemoryBackend {
  readonly tenantCapable = true;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  /** In-process FIFO so the file lock is only ever contended cross-process. */
  private queue: Promise<void> = Promise.resolve();
  private recovery: Promise<void> | null = null;
  private recovered = false;
  private holdsLock = false;
  private readonly cache: ParseCache;
  private readonly idGen: () => string;

  constructor(
    private readonly root: string,
    opts: StoreLockOptions = {},
  ) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? Number(process.env.REMEMBRA_LOCK_TIMEOUT_MS ?? 5000);
    this.lockStaleMs = opts.lockStaleMs ?? Number(process.env.REMEMBRA_LOCK_STALE_MS ?? 10000);
    this.cache = new ParseCache(opts.cacheSize ?? Number(process.env.REMEMBRA_CACHE_SIZE ?? 10_000));
    this.idGen = opts.idGen ?? genId;
  }

  static defaultRoot(): string {
    return process.env.REMEMBRA_HOME ?? path.join(os.homedir(), ".remembra");
  }

  // -------------------------------------------------------------------------
  // Public API — each entry awaits recovery, then runs under the lock.
  // Internal helpers must NOT call back into locked public methods
  // (the queue/lock are not reentrant); reads (get/all) never lock.
  // -------------------------------------------------------------------------

  async store(input: StoreInput, embedding?: number[], tenant?: TenantFilter): Promise<Memory> {
    await this.ensureRecovered();
    return this.withLock(() => this.storeLocked(input, embedding, tenant));
  }

  async forget(id: string, tenant?: TenantFilter): Promise<boolean> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      const file = await this.findFile(id, tenant);
      if (!file) return false;
      await fs.unlink(file);
      this.cache.forget(file);
      return true;
    });
  }

  /** Load active memories (excludes archived). Pass includeArchived for everything. */
  async all(includeArchived = false, tenant?: TenantFilter): Promise<Memory[]> {
    await this.ensureRecovered();
    const base = tenant ? this.tenantRoot(tenant) : this.root;
    const dirs = [path.join(base, "global"), path.join(base, "scopes")];
    if (includeArchived) {
      dirs.push(path.join(base, "archived", "global"), path.join(base, "archived", "scopes"));
    }
    const files = await walk(...dirs);
    const memories = await Promise.all(files.map((f) => this.parseCached(f)));
    return memories.filter((m): m is Memory => m !== null && (!tenant || this.matchesTenant(m, tenant)));
  }

  async get(id: string, tenant?: TenantFilter): Promise<Memory | null> {
    await this.ensureRecovered();
    const file = await this.findFile(id, tenant);
    if (!file) return null;
    const memory = await this.parseCached(file);
    return memory && (!tenant || this.matchesTenant(memory, tenant)) ? memory : null;
  }

  /** Parse-cache observability (tests + future /metrics). */
  cacheStats(): { size: number; capacity: number } {
    return { size: this.cache.size, capacity: this.cache.capacity };
  }

  /** Move a memory to the archived tree (sets archivedAt). */
  async archive(id: string, tenant?: TenantFilter): Promise<Memory | null> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      const m = await this.get(id, tenant);
      if (!m || m.archivedAt) return null;
      const oldFile = this.fileFor(m);
      const now = new Date().toISOString();
      const updated: Memory = { ...m, archivedAt: now, updatedAt: now };
      const newFile = this.fileFor(updated);
      if (oldFile === newFile) return null;
      await fs.mkdir(path.dirname(newFile), { recursive: true });
      await this.writeCached(newFile, render(updated), updated);
      await fs.unlink(oldFile);
      this.cache.forget(oldFile);
      return updated;
    });
  }

  /** Bring an archived memory back into active search. */
  async revive(id: string, tenant?: TenantFilter): Promise<Memory | null> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      const m = await this.get(id, tenant);
      if (!m || !m.archivedAt) return null;
      const oldFile = this.fileFor(m);
      const now = new Date().toISOString();
      const updated: Memory = { ...m, archivedAt: undefined, lastSeen: now, updatedAt: now };
      const newFile = this.fileFor(updated);
      await fs.mkdir(path.dirname(newFile), { recursive: true });
      await this.writeCached(newFile, render(updated), updated);
      await fs.unlink(oldFile);
      this.cache.forget(oldFile);
      return updated;
    });
  }

  /** Persist changes to an existing memory (merge/update path). */
  async update(
    memory: Memory,
    opts?: { expectedVersion?: number; reason?: string },
    tenant?: TenantFilter,
  ): Promise<Memory> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      if (tenant && !this.matchesTenant(memory, tenant)) {
        throw new RemembraError("NOT_FOUND", `No memory with id ${memory.id}`);
      }
      const target = this.fileFor(memory);
      // Locate the current file. Same path (scope unchanged — the common
      // case: merge, embedding backfill) = one stat; a scope move via
      // memory_update lives elsewhere → findFile (manual edits, rare).
      const samePath = await fs
        .stat(target)
        .then(() => true, () => false);
      const existingFile = samePath ? target : await this.findFile(memory.id, tenant);
      const current = existingFile ? await this.parseCached(existingFile) : null;
      if (!current || (memory.tenantId && !tenant) || (tenant && !this.matchesTenant(current, tenant))) {
        throw new RemembraError("NOT_FOUND", `No memory with id ${memory.id}`);
      }

      // Optimistic concurrency (plan §3.5): compare against the FRESH
      // on-disk version inside the lock, then write disk+1 — a stale writer
      // loses with CONFLICT instead of silently clobbering.
      if (opts?.expectedVersion !== undefined) {
        const disk = current?.version;
        if (disk !== opts.expectedVersion) {
          throw new RemembraError(
            "CONFLICT",
            `version mismatch for ${memory.id}: expected ${opts.expectedVersion}, stored ${disk ?? "none"}`,
          );
        }
      }
      const updated: Memory = {
        ...memory,
        version: (current?.version ?? memory.version ?? 1) + 1,
        updatedAt: new Date().toISOString(),
      };
      // History (audit Phase 8 / plan §4.6): content-changing updates snapshot
      // the on-disk pre-image first (embedding backfills and `memory_relate`
      // change no content → no snapshot). The optional reason lands beside the
      // snapshot in reasons.json — never inline in current content.
      if (current && current.content !== memory.content) {
        const historyTenant = tenant ?? (memory.tenantId ? { organizationId: memory.tenantId } : undefined);
        await this.snapshotHistory(existingFile!, opts?.reason, historyTenant);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.writeCached(target, render(updated), updated);
      if (existingFile && existingFile !== target) {
        // Scope move: unlink the old tree entry (crash between write and
        // unlink leaves a dual-homed id → the recovery pass reconciles it,
        // same as archive/revive).
        await fs.unlink(existingFile).catch(() => {});
        this.cache.forget(existingFile);
      }
      return updated;
    });
  }

  /**
   * Version history for one memory — `.history/<id>/*.md`, newest first.
   * Entries are raw pre-image copies (byte-for-byte, ciphertext preserved).
   */
  async history(id: string, tenant?: TenantFilter): Promise<HistoryEntry[]> {
    await this.ensureRecovered();
    assertSafeHistoryId(id);
    const base = tenant ? this.tenantRoot(tenant) : this.root;
    if (!(await isExistingSafeDirectory(base, "storage root"))) return [];
    const historyRoot = path.join(base, ".history");
    assertContained(base, historyRoot);
    if (!(await isExistingSafeDirectory(historyRoot, "history root"))) return [];
    const dir = path.join(historyRoot, id);
    assertContained(base, dir);
    if (!(await isExistingSafeDirectory(dir, "memory history directory"))) return [];
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md")).sort().reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: HistoryEntry[] = [];
    const reasonsFile = path.join(dir, "reasons.json");
    const hasReasons = await isExistingSafeDirectory(dir, "memory history directory");
    if (hasReasons) {
      try {
        await assertRegularFile(reasonsFile, "history reasons file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const reasons = await readReasons(reasonsFile);
    for (const name of names) {
      const file = path.join(dir, name);
      assertContained(dir, file);
      await assertRegularFile(file, "history snapshot");
      const m = await parse(file); // decrypts transparently; throws ENCRYPTED_NO_KEY loudly
      if (!m) continue;
      const epoch = Number(name.split("-")[0]);
      const why = reasons[name];
      out.push({
        file: name,
        at: m.updatedAt,
        ...(Number.isFinite(epoch) && epoch > 0 ? { snapshotAt: new Date(epoch).toISOString() } : {}),
        ...(why?.reason ? { reason: why.reason, supersededAt: why.supersededAt } : {}),
        content: m.content,
      });
    }
    return out;
  }

  /** V4.4: audit events — file backend has none, returns empty. */
  async getAudit(): Promise<Record<string, unknown>[]> {
    return [];
  }

  /**
   * Convert the whole tree (memories + history) between plain and encrypted
   * at rest. Requires REMEMBRA_ENCRYPT_KEY either way (decryption needs it).
   * Idempotent: files already in the target state are skipped.
   */
  async migrateEncryption(mode: "encrypt" | "decrypt"): Promise<{ converted: number; skipped: number }> {
    await this.ensureRecovered();
    if (!encryptionEnabled()) {
      throw new RemembraError(
        "INVALID_INPUT",
        `remembra ${mode} requires REMEMBRA_ENCRYPT_KEY (64 hex chars) to be set`,
      );
    }
    return this.withLock(async () => {
      const files = [
        ...(await walk(path.join(this.root, "global"), path.join(this.root, "scopes"), path.join(this.root, "archived"))),
        // History snapshots + their supersession reasons (§4.6 sidecar).
        ...await walkGeneric([path.join(this.root, ".history")], (n) => n.endsWith(".md") || n === "reasons.json"),
      ];
      let converted = 0;
      let skipped = 0;
      for (const f of files) {
        const buf = await fs.readFile(f);
        const enc = isEncrypted(buf);
        if ((mode === "encrypt" && enc) || (mode === "decrypt" && !enc)) {
          skipped++;
          continue;
        }
        await writeFileAtomic(f, mode === "encrypt" ? encryptBuffer(buf) : decryptBuffer(buf), fs);
        this.cache.forget(f);
        converted++;
      }
      metrics.inc("remembra_encryption_migrations_total", { mode }, converted);
      return { converted, skipped };
    });
  }

  /** Copy the current file into `.history/<id>/` and prune beyond the cap. */
  private async snapshotHistory(file: string, reason?: string, tenant?: TenantFilter): Promise<void> {
    const limit = Number(process.env.REMEMBRA_HISTORY_LIMIT ?? 20);
    if (limit <= 0) return; // history disabled
    const id = path.basename(file, ".md");
    assertSafeHistoryId(id);
    const base = tenant ? this.tenantRoot(tenant) : this.root;
    await ensureSafeDirectory(base, "storage root");
    const historyRoot = path.join(base, ".history");
    assertContained(base, historyRoot);
    await ensureSafeDirectory(historyRoot, "history root");
    const dir = path.join(historyRoot, id);
    assertContained(base, dir);
    await ensureSafeDirectory(dir, "memory history directory");
    const existing = (await fs.readdir(dir)).filter((n) => n.endsWith(".md"));
    for (const name of existing) {
      await assertRegularFile(path.join(dir, name), "history snapshot");
    }
    let maxSeq = -1;
    for (const n of existing) {
      const m = n.match(/-(\d+)\.md$/);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    // `${epochMs}-${seq}.md` sorts lexicographically = chronologically
    // (seq breaks same-millisecond ties; the lock serializes writers).
    const target = path.join(dir, `${Date.now()}-${String(maxSeq + 1).padStart(4, "0")}.md`);
    await writeFileAtomic(target, await fs.readFile(file), fs);
    metrics.inc("remembra_history_snapshots_total");
    // Supersession reason (plan §4.6 `history[].reason`): recorded beside the
    // snapshot in reasons.json (encrypted with the rest of the store) — the
    // snapshot itself stays a byte-for-byte pre-image.
    if (reason) {
      const reasonsFile = path.join(dir, "reasons.json");
      try {
        await assertRegularFile(reasonsFile, "history reasons file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const reasons = await readReasons(reasonsFile);
      reasons[path.basename(target)] = { reason, supersededAt: new Date().toISOString() };
      const json = JSON.stringify(reasons);
      await writeFileAtomic(
        reasonsFile,
        encryptionEnabled() ? encryptBuffer(Buffer.from(json, "utf8")) : json,
        fs,
      );
    }
    const sorted = existing.concat(path.basename(target)).sort();
    const excess = sorted.length - limit;
    if (excess > 0) {
      for (const name of sorted.slice(0, excess)) {
        await fs.unlink(path.join(dir, name)).catch(() => {});
      }
    }
  }

  /** Record that a memory surfaced in search (decay refresh). Cheap: no-op if seen <1h ago. */
  async touch(id: string, tenant?: TenantFilter): Promise<void> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      // Read + write inside the lock: racing an archive/revive move here is
      // what used to be able to resurrect a file in both trees.
      const m = await this.get(id, tenant);
      if (!m) return;
      const last = Date.parse(m.lastSeen ?? m.updatedAt);
      if (Number.isFinite(last) && Date.now() - last < 3_600_000) return;
      m.lastSeen = new Date().toISOString();
      await this.writeCached(this.fileFor(m), render(m), m);
    });
  }

  /** Import a snapshot memory verbatim (id preserved). Returns false if the id exists. */
  async importMemory(m: Memory, tenant?: TenantFilter): Promise<boolean> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      if ((!tenant && m.tenantId) || (tenant && !this.matchesTenant(m, tenant))) return false;
      if (await this.findFile(m.id, tenant)) return false;
      const file = this.fileFor(m); // containment check applies (P0)
      await fs.mkdir(path.dirname(file), { recursive: true });
      await this.writeCached(file, render(m), m);
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Locked body helpers (no reentrant locking inside these).
  // -------------------------------------------------------------------------

  /**
   * Atomic write + cache refresh: the entry we just produced is remembered
   * with the on-disk stat, so the next read is a validated hit.
   */
  private async writeCached(file: string, data: string, memory: Memory): Promise<void> {
    // Encrypted mode (Phase 8): ciphertext at rest, plaintext in cache/RAM.
    const payload = encryptionEnabled() ? encryptBuffer(Buffer.from(data, "utf8")) : data;
    await writeFileAtomic(file, payload, fs);
    try {
      const st = await fs.stat(file);
      this.cache.remember(file, { mtimeMs: st.mtimeMs, size: st.size }, memory);
    } catch {
      this.cache.forget(file); // vanished between rename and stat → next read re-walks
    }
  }

  /**
   * stat() the file, then either serve the cached parse (validated by
   * mtime+size — catches writers from other processes too) or read+parse.
   */
  private async parseCached(file: string): Promise<Memory | null> {
    let st: { mtimeMs: number; size: number };
    try {
      st = await fs.stat(file);
    } catch {
      this.cache.forget(file);
      return null;
    }
    const probe = this.cache.probe(file, st);
    if (probe.hit) {
      metrics.inc("remembra_cache_events_total", { result: "hit" });
      return probe.memory ?? null;
    }
    metrics.inc("remembra_cache_events_total", { result: "miss" });
    const memory = await parse(file);
    this.cache.remember(file, st, memory);
    return memory;
  }

  private async storeLocked(input: StoreInput, embedding?: number[], tenant?: TenantFilter): Promise<Memory> {
    const now = new Date().toISOString();
    // UUIDv7 (plan §3.6): unique from entropy + time alone — the old
    // 12-hex existence-scan retry loop is gone by design.
    const id = this.idGen();
    // Provenance (plan §4.3): every memory records where it came from;
    // trust (§4.5/§4.9) defaults from it — conversation extraction is never
    // trusted by itself, system writes are system, everything else trusted.
    const provenance: Provenance = {
      sourceType: input.provenance?.sourceType ?? "manual",
      ...(input.provenance?.sessionId ? { sessionId: input.provenance.sessionId } : {}),
      ...(input.provenance?.messageId ? { messageId: input.provenance.messageId } : {}),
      ...(input.provenance?.agentId ? { agentId: input.provenance.agentId } : {}),
      ...(input.provenance?.agentType ? { agentType: input.provenance.agentType } : {}),
      ...(input.provenance?.agentVersion ? { agentVersion: input.provenance.agentVersion } : {}),
      ...(input.provenance?.conversationId ? { conversationId: input.provenance.conversationId } : {}),
      ...(input.provenance?.taskId ? { taskId: input.provenance.taskId } : {}),
      ...(input.provenance?.runId ? { runId: input.provenance.runId } : {}),
      ...(input.provenance?.provider ? { provider: input.provenance.provider } : {}),
    };
    const memory: Memory = {
      id,
      type: input.type,
      content: input.content,
      scope: input.scope,
      ...(tenant ? { tenantId: tenant.organizationId } : {}),
      ...(tenant?.projectId ? { projectId: tenant.projectId } : {}),
      ...(tenant?.userId ? { userId: tenant.userId } : {}),
      ...(tenant?.agentId ? { agentId: tenant.agentId } : {}),
      tags: input.tags,
      importance: input.importance,
      createdAt: now,
      updatedAt: now,
      version: 1,
      source: input.source,
      confidence: input.confidence ?? (provenance.sourceType === "conversation" ? 0.7 : 1),
      trust: input.trust ?? defaultTrust(provenance),
      provenance,
      owner: input.owner ?? defaultOwner(provenance),
      access: input.access ?? defaultAccess(),
      retention: input.retention,
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      embedding,
    };
    const file = this.fileFor(memory);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this.writeCached(file, render(memory), memory);
    return memory;
  }

  private tenantRoot(tenant: TenantFilter): string {
    return path.join(this.root, "tenants", tenantDirectoryKey(tenant.organizationId));
  }

  private matchesTenant(memory: Memory, tenant: TenantFilter): boolean {
    if (memory.tenantId !== tenant.organizationId) return false;
    if (tenant.projectId && memory.projectId !== tenant.projectId) return false;
    return true;
  }

  private fileFor(m: Memory): string {
    const safeScope = m.scope === "global" ? "global" : m.scope.replace(/[^a-zA-Z0-9._/-]/g, "_");
    const baseRoot = m.tenantId
      ? path.join(this.root, "tenants", tenantDirectoryKey(m.tenantId))
      : this.root;
    const base = m.scope === "global" ? path.join(baseRoot, "global") : path.join(baseRoot, "scopes", safeScope);
    const archivedBase =
      m.scope === "global"
        ? path.join(baseRoot, "archived", "global")
        : path.join(baseRoot, "archived", "scopes", safeScope);
    const dir = m.archivedAt ? archivedBase : base;
    const file = path.resolve(path.join(dir, `${m.id}.md`));
    // Defense in depth (P0): never touch anything outside the storage root.
    const root = path.resolve(this.root);
    if (!file.startsWith(root + path.sep)) {
      throw new RemembraError(
        "SCOPE_ESCAPES_ROOT",
        `Invalid scope "${m.scope}": resolves outside the storage root`,
      );
    }
    return file;
  }

  private async findFile(id: string, tenant?: TenantFilter): Promise<string | null> {
    const base = tenant ? this.tenantRoot(tenant) : this.root;
    const files = await walk(
      path.join(base, "global"),
      path.join(base, "scopes"),
      path.join(base, "archived"),
    );
    return files.find((f) => path.basename(f, ".md") === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Advisory file lock + in-process queue.
  // -------------------------------------------------------------------------

  private lockFile(): string {
    return path.join(this.root, ".remembra.lock");
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    await prev;
    try {
      await this.acquireFileLock();
      try {
        return await fn();
      } catch (err) {
        throw classifyFsError(err);
      } finally {
        await this.releaseFileLock();
      }
    } finally {
      release();
    }
  }

  private async acquireFileLock(): Promise<void> {
    const file = this.lockFile();
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fh = await fs.open(file, "wx");
        try {
          await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
        } finally {
          await fh.close();
        }
        this.holdsLock = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new RemembraError(
            "IO_ERROR",
            `cannot create lock file: ${err instanceof Error ? err.message : err}`,
            { cause: err },
          );
        }
      }
      if (await this.lockIsStale(file)) {
        await fs.unlink(file).catch(() => {});
        continue; // steal: O_EXCL create decides the winner
      }
      if (Date.now() >= deadline) {
        const holder = await lockHolderPid(file);
        throw new RemembraError(
          "LOCK_TIMEOUT",
          `storage is locked by ${holder !== null ? `pid ${holder}` : "another process"} (waited ${this.lockTimeoutMs}ms)`,
        );
      }
      await sleep(15 + Math.floor(Math.random() * 20));
    }
  }

  private async releaseFileLock(): Promise<void> {
    if (!this.holdsLock) return;
    this.holdsLock = false;
    try {
      const info = JSON.parse(await fs.readFile(this.lockFile(), "utf8"));
      if (info.pid === process.pid) await fs.unlink(this.lockFile()).catch(() => {});
    } catch {
      // already gone (or unreadable) — nothing to release
    }
  }

  private async lockIsStale(file: string): Promise<boolean> {
    try {
      const st = await fs.stat(file);
      if (Date.now() - st.mtimeMs >= this.lockStaleMs) return true;
      let pid: unknown;
      try {
        pid = (JSON.parse(await fs.readFile(file, "utf8")) as { pid?: unknown }).pid;
      } catch {
        pid = undefined;
      }
      if (typeof pid !== "number") return false; // fresh but unwritten: writer in progress
      // Our own pid + fresh = a SIBLING store instance in this process holds it
      // live (the in-process FIFO only serializes within one instance). The age
      // check above still rescues abandoned own-pid files after lockStaleMs.
      if (pid === process.pid) return false;
      try {
        process.kill(pid, 0);
        return false; // alive
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "EPERM"; // ESRCH dead → stale; EPERM alive → wait
      }
    } catch {
      return true; // vanished between EEXIST and stat → retry the create
    }
  }

  // -------------------------------------------------------------------------
  // Crash recovery (the "journal" phase — see class doc for why not a WAL).
  // -------------------------------------------------------------------------

  private async ensureRecovered(): Promise<void> {
    if (this.recovered) return;
    if (!this.recovery) {
      const run = this.withLock(() => this.recover());
      this.recovery = run.then(
        () => {
          this.recovered = true;
        },
        (err) => {
          this.recovery = null; // a failed recovery (e.g. LOCK_TIMEOUT) must be retryable
          throw err;
        },
      );
    }
    await this.recovery;
  }

  private async recover(): Promise<void> {
    const everything = await walkRaw(this.root);
    // Age-gated sweep: a tmp younger than the stale-lock window belongs to an
    // in-flight atomic write (its rename is milliseconds away — touching it
    // would race into a spurious ENOENT), so only tmps old enough to be
    // provably abandoned — a crash between write and rename — are removed.
    // Crash orphans are collected by any later startup once they age out.
    const tmps: string[] = [];
    for (const t of everything) {
      if (!t.endsWith(".tmp")) continue;
      const st = await fs.stat(t).catch(() => null);
      if (st && Date.now() - st.mtimeMs < this.lockStaleMs) continue;
      tmps.push(t);
    }
    for (const t of tmps) await fs.unlink(t).catch(() => {});

    // Ids present in both active and archived trees → interrupted archive/revive.
    const active = await walk(path.join(this.root, "global"), path.join(this.root, "scopes"));
    const archived = await walk(path.join(this.root, "archived"));
    const archivedById = new Map(archived.map((f) => [path.basename(f, ".md"), f]));
    let reconciled = 0;
    for (const activeFile of active) {
      const twin = archivedById.get(path.basename(activeFile, ".md"));
      if (!twin) continue;
      const [am, zm] = await Promise.all([parse(activeFile), parse(twin)]);
      if (!am && !zm) {
        await fs.unlink(activeFile).catch(() => {});
        await fs.unlink(twin).catch(() => {});
        reconciled++;
        continue;
      }
      // Newest updatedAt wins; ties go to the archived copy (archive writes
      // archivedAt last in the common crash window).
      const keepArchived = !am || (zm !== null && Date.parse(zm.updatedAt) >= Date.parse(am.updatedAt));
      await fs.unlink(keepArchived ? activeFile : twin).catch(() => {});
      reconciled++;
    }

    if (tmps.length > 0 || reconciled > 0) {
      logEvent(
        "warn",
        "crash_recovery",
        { orphaned_tmp: tmps.length, reconciled },
        `Remembra: crash recovery — removed ${tmps.length} orphaned temp file(s), reconciled ${reconciled} interrupted move(s)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * UUIDv7 (plan §3.6): 48-bit millisecond timestamp + version/variant bits +
 * randomness — lexicographically sortable by creation time and unique from
 * entropy alone, so id allocation needs no filesystem collision scan.
 */
function genId(): string {
  const b = randomBytes(16);
  let ms = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * LRU of parsed memories, keyed by file path, validated by (mtimeMs, size).
 * Map preserves insertion order → first key is the least-recently-used.
 * capacity 0 disables caching entirely (every read re-parses).
 */
class ParseCache {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; memory: Memory | null }>();

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  probe(file: string, st: { mtimeMs: number; size: number }): { hit: boolean; memory?: Memory | null } {
    const e = this.entries.get(file);
    if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) return { hit: false };
    this.entries.delete(file); // touch: move to the MRU end
    this.entries.set(file, e);
    return { hit: true, memory: e.memory };
  }

  remember(file: string, st: { mtimeMs: number; size: number }, memory: Memory | null): void {
    if (this.capacity <= 0) return;
    this.entries.delete(file);
    this.entries.set(file, { mtimeMs: st.mtimeMs, size: st.size, memory });
    while (this.entries.size > this.capacity) {
      const lru = this.entries.keys().next().value;
      if (lru === undefined) break;
      this.entries.delete(lru);
    }
  }

  forget(file: string): void {
    this.entries.delete(file);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function lockHolderPid(file: string): Promise<number | null> {
  try {
    const pid = (JSON.parse(await fs.readFile(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/** Wrap raw filesystem failures so callers see a stable IO_ERROR code. */
function classifyFsError(err: unknown): unknown {
  if (err instanceof RemembraError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    return new RemembraError("IO_ERROR", `filesystem error (${code}): ${(err as Error).message}`, {
      cause: err,
    });
  }
  return err;
}

/**
 * Atomic write (P1 audit): write to a temp file in the same directory,
 * then rename() over the target — POSIX-atomic, so a crash mid-write can
 * never leave a half-written memory file.
 */
async function writeFileAtomic(file: string, data: string | Buffer, fsmod: typeof fs): Promise<void> {
  const tmp = `${file}.${genId().slice(0, 6)}.tmp`;
  try {
    await fsmod.writeFile(tmp, data);
    await fsmod.rename(tmp, file);
  } catch (err) {
    await fsmod.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function walkGeneric(dirs: string[], pred: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walkGeneric([full], pred)));
      else if (pred(e.name)) out.push(full);
    }
  }
  return out;
}

/** All files (used by crash recovery to find *.tmp orphans). */
async function walkRaw(...dirs: string[]): Promise<string[]> {
  return walkGeneric(dirs, () => true);
}

async function walk(...dirs: string[]): Promise<string[]> {
  return walkGeneric(dirs, (name) => name.endsWith(".md"));
}

export function render(m: Memory): string {
  // Spec-parsed YAML frontmatter (plan §3.4): the serializer quotes/escapes
  // values, so scopes/tags/sources with YAML-ambiguous characters round-trip.
  // `version` = schema version (§3.4 guard), `revision` = the memory's own
  // optimistic-concurrency counter (§3.5), exposed as `version` in JSON.
  const meta: Record<string, unknown> = {
    id: m.id,
    // Keep tenantless V4 records at schema 3 for V4.9 readers. A record with
    // a tenant boundary is V5 schema 4 and older readers must skip it.
    version: m.tenantId ? TENANT_SCHEMA_VERSION : SCHEMA_VERSION,
    revision: m.version,
    type: m.type,
    scope: m.scope,
    tags: m.tags,
    importance: m.importance,
    confidence: m.confidence,
    trust: m.trust,
    created: m.createdAt,
    updated: m.updatedAt,
  };
  if (m.tenantId) meta.tenantId = m.tenantId;
  if (m.projectId) meta.projectId = m.projectId;
  if (m.userId) meta.userId = m.userId;
  if (m.agentId) meta.agentId = m.agentId;
  if (m.lastSeen) meta.lastSeen = m.lastSeen;
  if (m.lastValidated) meta.lastValidated = m.lastValidated;
  if (m.archivedAt) meta.archivedAt = m.archivedAt;
  if (m.source) meta.source = m.source;
  meta.provenance = m.provenance; // required since 4.1.0 (plan §4.3)
  if (m.owner) meta.owner = m.owner;
  if (m.access) meta.access = m.access;
  if (m.meta) meta.meta = m.meta;
  if (m.validFrom) meta.validFrom = m.validFrom;
  if (m.validUntil) meta.validUntil = m.validUntil;
  if (m.observedAt) meta.observedAt = m.observedAt;
  if (m.supersededBy) meta.supersededBy = m.supersededBy;
  if (m.retention) meta.retention = m.retention;
  if (m.relations && m.relations.length > 0) meta.relations = m.relations;
  if (m.embedding && m.embedding.length > 0) meta.embedding = m.embedding.join(",");
  return `---\n${stringifyYaml(meta).trimEnd()}\n---\n\n${m.content}\n`;
}

/** Files we've already warned about (avoid log spam on every search). */
const parseWarnings = new Set<string>();

/** Warn once per file+reason. `skip` = file excluded from reads; `fix` = served after normalization. */
function warnOnce(file: string, why: string, kind: "skip" | "fix"): void {
  const key = `${file}:${kind}:${why}`;
  if (parseWarnings.has(key)) return;
  parseWarnings.add(key);
  const base = path.basename(file);
  if (kind === "skip") {
    logEvent(
      "warn",
      "memory_parse_skipped",
      { file: base, reason: why },
      `Remembra: skipping unparseable memory file ${base} (${why})`,
    );
  } else {
    logEvent(
      "warn",
      "memory_normalized",
      { file: base, reason: why },
      `Remembra: memory file ${base} had invalid metadata (${why}); normalized on read`,
    );
  }
}

const EPOCH = new Date(0).toISOString();

/** ISO timestamp if parseable, else undefined (invalid → caller decides). */
function validDate(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Read-side validation (plan §3.4 / §3.8 "invalid metadata").
 *
 * Two outcomes:
 *  - **skip**: the file's structure or semantics are unusable (unknown schema
 *    version, bad id/type/scope, empty content). It is excluded from reads and
 *    logged once as `memory_parse_skipped` — never deleted, never written.
 *  - **normalize**: the value is out of range but recoverable (importance 9,
 *    confidence -0.2, malformed date). It is clamped/fallbacked, the memory is
 *    served, and `memory_normalized` is logged once — so ranking math can
 *    never see NaN and hand-edited files don't silently vanish.
 */
async function parse(file: string): Promise<Memory | null> {
  const skip = (why: string): null => {
    warnOnce(file, why, "skip");
    return null;
  };
  const fix = (why: string): void => warnOnce(file, why, "fix");
  try {
    const buf = await fs.readFile(file);
    // decryptBuffer passes plain bytes through untouched; encrypted files
    // without/with a wrong key throw ENCRYPTED_NO_KEY — deliberately NOT
    // warn-skipped: unreadable storage must fail loudly (health → 503).
    const raw = decryptBuffer(buf).toString("utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) return skip("missing/invalid frontmatter");
    // Spec-parsed YAML (plan §3.4). The legacy line reader below is the v1
    // fallback, only for frontmatters YAML refuses (unquoted `a: b` values
    // written before the serializer quoted them) — fields still validate.
    let meta: Record<string, unknown>;
    try {
      const doc = parseYaml(match[1]);
      if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
        meta = doc as Record<string, unknown>;
      } else if (match[1].trim() === "") {
        meta = {};
      } else {
        return skip("broken frontmatter");
      }
    } catch {
      meta = legacyFrontmatter(match[1]);
      if (Object.keys(meta).length === 0) return skip("broken frontmatter");
    }

    // Schema version: missing = current (legacy files); a version from the
    // future means data we don't understand — refuse to serve it (the file
    // stays untouched on disk). Frontmatter `version` = SCHEMA version; the
    // memory's own optimistic-concurrency counter (§3.5) is `revision` and
    // surfaces as `version` in JSON.
    const version = meta.version === undefined ? SCHEMA_VERSION : Number(asStr(meta.version));
    if (!Number.isInteger(version)) {
      return skip(`invalid schema version "${truncate(String(meta.version))}"`);
    }
    if (version > TENANT_SCHEMA_VERSION) return skip(`unsupported schema version ${version}`);

    const tenantId = meta.tenantId === undefined ? undefined : asStr(meta.tenantId);
    const projectId = meta.projectId === undefined ? undefined : asStr(meta.projectId);
    const userId = meta.userId === undefined ? undefined : asStr(meta.userId);
    const agentId = meta.agentId === undefined ? undefined : asStr(meta.agentId);
    const tenantValue = tenantId ?? (version >= TENANT_SCHEMA_VERSION ? "" : undefined);
    if (
      (meta.tenantId !== undefined && (!tenantId || !isValidTenantId(tenantId))) ||
      (meta.projectId !== undefined && (!projectId || !isValidTenantId(projectId))) ||
      (meta.userId !== undefined && (!userId || !isValidTenantId(userId))) ||
      (meta.agentId !== undefined && (!agentId || !isValidTenantId(agentId))) ||
      (version >= TENANT_SCHEMA_VERSION && !isValidTenantId(tenantValue ?? ""))
    ) {
      return skip("invalid or missing tenant metadata");
    }

    let revision = 1;
    if (meta.revision !== undefined) {
      const r = Number(meta.revision);
      if (Number.isInteger(r) && r >= 1) revision = r;
      else fix(`invalid revision "${truncate(String(meta.revision))}"`);
    }

    // Id: the filename is the source of truth (findFile matches on it).
    const baseId = path.basename(file, ".md");
    let id = baseId;
    const idRaw = asStr(meta.id);
    if (meta.id !== undefined) {
      if (idRaw === undefined || !/^[A-Za-z0-9._-]+$/.test(idRaw)) {
        return skip(`invalid id "${truncate(idRaw ?? String(meta.id))}"`);
      }
      if (idRaw !== baseId) {
        fix("id/filename mismatch — using filename");
        id = baseId;
      }
    }

    const type = meta.type === undefined ? "fact" : asStr(meta.type) ?? "";
    if (!MemoryType.options.includes(type as MemoryType)) {
      return skip(`invalid type "${truncate(type)}"`);
    }

    const scope = meta.scope === undefined ? "global" : asStr(meta.scope) ?? "";
    if (!scope || /(^|\/)\.\.(\/|$)|\\/.test(scope)) return skip("invalid scope");

    const content = match[2].trim();
    if (!content) return skip("empty content");

    // Tags: YAML array (4.1.0+) or legacy `[a, b]` scalar.
    let tags: string[] = [];
    if (Array.isArray(meta.tags)) {
      tags = meta.tags.map((t) => asStr(t) ?? "").filter((t) => t.length > 0);
    } else if (typeof meta.tags === "string") {
      const inner = meta.tags.replace(/^\[|\]$/g, "").trim();
      tags = inner ? inner.split(",").map((t) => t.trim()).filter(Boolean) : [];
    } else if (meta.tags !== undefined) {
      fix("invalid tags");
    }

    // Ranges: clamp instead of rejecting — never let NaN into ranking math.
    const impNum = Number(meta.importance ?? 3);
    let importance = 3;
    if (Number.isFinite(impNum)) {
      importance = Math.min(5, Math.max(1, Math.round(impNum)));
      if (importance !== impNum) fix(`importance ${impNum} clamped to ${importance}`);
    } else {
      fix(`invalid importance "${truncate(String(meta.importance ?? ""))}"`);
    }

    // Provenance (plan §4.3): object form since 4.1.0; legacy `explicit|auto`
    // strings migrate on read (explicit → manual, auto → conversation).
    // Absent (pre-3.4 files) defaults to manual — deliberate stores.
    let provenance: Provenance = { sourceType: "manual" };
    if (meta.provenance !== undefined && meta.provenance !== null) {
      if (typeof meta.provenance === "object" && !Array.isArray(meta.provenance)) {
        const parsed = ProvenanceSchema.safeParse(meta.provenance);
        if (parsed.success) provenance = parsed.data;
        else fix("invalid provenance object");
      } else {
        const s = asStr(meta.provenance);
        if (s === "auto" || s === "conversation") provenance = { sourceType: "conversation" };
        else if (s === "explicit" || s === "manual") provenance = { sourceType: "manual" };
        else if (s === "agent" || s === "import" || s === "system") provenance = { sourceType: s };
        else fix(`invalid provenance "${truncate(s ?? String(meta.provenance))}"`);
      }
    }

    // Confidence (plan §4.4): required, independent of importance — missing
    // (pre-confidence files) uses the store's own default: 0.7 for
    // conversation extraction, 1.0 otherwise.
    let confidence: number;
    const confFallback = provenance.sourceType === "conversation" ? 0.7 : 1;
    if (meta.confidence === undefined) {
      confidence = confFallback;
    } else {
      const c = Number(meta.confidence);
      if (!Number.isFinite(c)) {
        fix(`invalid confidence "${truncate(String(meta.confidence))}"`);
        confidence = confFallback;
      } else {
        confidence = Math.min(1, Math.max(0, c));
        if (confidence !== c) fix(`confidence ${c} clamped to ${confidence}`);
      }
    }

    // Trust (plan §4.5): required; when absent it derives from provenance so
    // legacy digest-extracted role/instruction files land `unverified` and
    // lose the standing-instruction gate until approved (§4.9).
    let trust: TrustLevel;
    const trustRaw = asStr(meta.trust);
    if (meta.trust === undefined) trust = defaultTrust(provenance);
    else if (trustRaw !== undefined && TrustLevel.options.includes(trustRaw as TrustLevel)) {
      trust = trustRaw as TrustLevel;
    } else {
      fix(`invalid trust "${truncate(trustRaw ?? String(meta.trust))}"`);
      trust = defaultTrust(provenance);
    }

    // Retention mode (plan §4.8); absent = decaying (default clocks).
    let retention: RetentionMode | undefined;
    if (meta.retention !== undefined) {
      const r = asStr(meta.retention);
      if (r !== undefined && RetentionMode.options.includes(r as RetentionMode)) {
        retention = r as RetentionMode;
      } else fix(`invalid retention "${truncate(r ?? String(meta.retention))}"`);
    }

    const ownerRaw = asStr(meta.owner);
    const owner = MemoryOwner.options.includes(ownerRaw as MemoryOwner)
      ? (ownerRaw as MemoryOwner)
      : "global";
    if (ownerRaw !== undefined && !owner) fix(`invalid owner "${truncate(ownerRaw)}"`);
    const accessRaw = asStr(meta.access);
    const access = MemoryAccess.options.includes(accessRaw as MemoryAccess)
      ? (accessRaw as MemoryAccess)
      : "global";
    if (accessRaw !== undefined && !access) fix(`invalid access "${truncate(accessRaw)}"`);

    const memoryMeta =
      meta.meta && typeof meta.meta === "object" && !Array.isArray(meta.meta)
        ? (meta.meta as Record<string, unknown>)
        : undefined;
    if (meta.meta !== undefined && !memoryMeta) fix("invalid meta object");

    const validFrom = validDate(asStr(meta.validFrom));
    if (meta.validFrom !== undefined && !validFrom) fix("invalid validFrom date");
    const validUntil = validDate(asStr(meta.validUntil));
    if (meta.validUntil !== undefined && !validUntil) fix("invalid validUntil date");
    const observedAt = validDate(asStr(meta.observedAt));
    if (meta.observedAt !== undefined && !observedAt) fix("invalid observedAt date");
    const supersededBy = asStr(meta.supersededBy);
    if (meta.supersededBy !== undefined && !supersededBy) fix("invalid supersededBy");

    const createdOk = validDate(asStr(meta.created));
    if (meta.created !== undefined && !createdOk) fix("invalid created date");
    const updatedOk = validDate(asStr(meta.updated));
    if (meta.updated !== undefined && !updatedOk) fix("invalid updated date");
    const createdAt = createdOk ?? EPOCH;
    const updatedAt = updatedOk ?? createdOk ?? createdAt;

    const lastSeen = validDate(asStr(meta.lastSeen));
    if (meta.lastSeen !== undefined && !lastSeen) fix("invalid lastSeen date");
    const lastValidated = validDate(asStr(meta.lastValidated));
    if (meta.lastValidated !== undefined && !lastValidated) fix("invalid lastValidated date");
    const archivedAt = validDate(asStr(meta.archivedAt));
    if (meta.archivedAt !== undefined && !archivedAt) fix("invalid archivedAt date");

    const source = asStr(meta.source);
    if (meta.source !== undefined && source === undefined) fix("invalid source");

    // Relations (plan §4.7): typed edges since 4.1.0; legacy untyped
    // `related: [ids]` migrates to kind "related" on read.
    let relations: Relation[] | undefined;
    const validRelId = (v: unknown): v is string =>
      typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v);
    if (Array.isArray(meta.relations)) {
      const ok: Relation[] = [];
      let bad = 0;
      for (const e of meta.relations) {
        const rec = e as { id?: unknown; kind?: unknown } | null;
        const kind = rec && typeof rec === "object" ? asStr(rec.kind) : undefined;
        if (
          rec &&
          typeof rec === "object" &&
          validRelId(rec.id) &&
          kind !== undefined &&
          RelationKind.options.includes(kind as RelationKind)
        ) {
          ok.push({ id: rec.id, kind: kind as RelationKind });
        } else bad++;
      }
      if (bad > 0) fix("invalid relation edge");
      relations = ok.length > 0 ? ok : undefined;
    } else if (meta.relations !== undefined) fix("invalid relations");
    if (!relations && meta.related !== undefined) {
      const legacy =
        typeof meta.related === "string"
          ? parseList(meta.related)
          : Array.isArray(meta.related)
            ? meta.related.map((r) => asStr(r) ?? "")
            : undefined;
      const ids = legacy ?? [];
      const ok = ids.filter((r) => /^[A-Za-z0-9._-]+$/.test(r));
      if (ok.length !== ids.length) fix("invalid related id");
      relations = ok.length > 0 ? ok.map((rid) => ({ id: rid, kind: "related" as const })) : undefined;
    }

    // Embedding: comma scalar (4.1.0 writer), number array, or legacy
    // `[0.1,0.2]` bracket scalar.
    let embedding: number[] | undefined;
    if (Array.isArray(meta.embedding)) {
      const nums = meta.embedding.map((n) => Number(n));
      if (nums.length > 0 && nums.every((n) => Number.isFinite(n))) embedding = nums;
      else fix("invalid embedding");
    } else if (typeof meta.embedding === "string") {
      const inner = meta.embedding.replace(/^\[|\]$/g, "");
      const nums = inner.split(",").map((n) => Number(n.trim()));
      if (nums.length > 0 && nums.every((n) => Number.isFinite(n))) embedding = nums;
      else fix("invalid embedding");
    } else if (meta.embedding !== undefined) fix("invalid embedding");

    return {
      id,
      type: type as MemoryType,
      content,
      scope,
      tags,
      importance,
      confidence,
      trust,
      provenance,
      owner,
      access,
      ...(tenantId ? { tenantId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(userId ? { userId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(memoryMeta ? { meta: memoryMeta as Memory["meta"] } : {}),
      ...(validFrom ? { validFrom } : {}),
      ...(validUntil ? { validUntil } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(supersededBy ? { supersededBy } : {}),
      createdAt,
      updatedAt,
      lastSeen,
      lastValidated,
      archivedAt,
      version: revision,
      source,
      retention,
      relations,
      embedding,
    };
  } catch (err) {
    if (err instanceof RemembraError) throw err; // ENCRYPTED_NO_KEY etc — loud, never skipped
    warnOnce(file, err instanceof Error ? err.message : String(err), "skip");
    return null;
  }
}

/** Scalars written by older renderers may come back as numbers — coerce. */
function asStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Legacy ≤4.0.x line reader — only used when YAML refuses a v1 frontmatter. */
function legacyFrontmatter(text: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

interface HistoryReason {
  reason: string;
  supersededAt?: string;
}

/** `.history/<id>/reasons.json` (plan §4.6) — missing/corrupt = no reasons. */
async function readReasons(file: string): Promise<Record<string, HistoryReason>> {
  try {
    const text = decryptBuffer(await fs.readFile(file)).toString("utf8");
    const obj = JSON.parse(text) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, HistoryReason>;
    }
    return {};
  } catch (err) {
    if (err instanceof RemembraError) throw err; // encrypted store without key → loud
    return {}; // missing/corrupt sidecar: history simply lacks reasons
  }
}

/** `[a, b]` frontmatter list → string[] | undefined. */
function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const inner = raw.replace(/^\[|\]$/g, "").trim();
  if (!inner) return undefined;
  const items = inner.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
