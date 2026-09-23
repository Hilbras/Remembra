import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Memory, StoreInput, SCHEMA_VERSION } from "./types.js";
import type { MemoryBackend } from "./backend.js";
import { RemembraError } from "./errors.js";

export interface StoreLockOptions {
  /** Max wait for the cross-process lock (ms). Env: REMEMBRA_LOCK_TIMEOUT_MS. Default 5000. */
  lockTimeoutMs?: number;
  /** Lock files older than this with a dead/unknown pid are stolen (ms). Env: REMEMBRA_LOCK_STALE_MS. Default 10000. */
  lockStaleMs?: number;
  /** LRU parse-cache capacity in entries. Env: REMEMBRA_CACHE_SIZE. Default 10000; 0 disables. */
  cacheSize?: number;
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
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  /** In-process FIFO so the file lock is only ever contended cross-process. */
  private queue: Promise<void> = Promise.resolve();
  private recovery: Promise<void> | null = null;
  private recovered = false;
  private holdsLock = false;
  private readonly cache: ParseCache;

  constructor(
    private readonly root: string,
    opts: StoreLockOptions = {},
  ) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? Number(process.env.REMEMBRA_LOCK_TIMEOUT_MS ?? 5000);
    this.lockStaleMs = opts.lockStaleMs ?? Number(process.env.REMEMBRA_LOCK_STALE_MS ?? 10000);
    this.cache = new ParseCache(opts.cacheSize ?? Number(process.env.REMEMBRA_CACHE_SIZE ?? 10_000));
  }

  static defaultRoot(): string {
    return process.env.REMEMBRA_HOME ?? path.join(os.homedir(), ".remembra");
  }

  // -------------------------------------------------------------------------
  // Public API — each entry awaits recovery, then runs under the lock.
  // Internal helpers must NOT call back into locked public methods
  // (the queue/lock are not reentrant); reads (get/all) never lock.
  // -------------------------------------------------------------------------

  async store(
    input: StoreInput,
    embedding?: number[],
    opts?: { provenance?: Memory["provenance"] },
  ): Promise<Memory> {
    await this.ensureRecovered();
    return this.withLock(() => this.storeLocked(input, embedding, opts));
  }

  async forget(id: string): Promise<boolean> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      const file = await this.findFile(id);
      if (!file) return false;
      await fs.unlink(file);
      this.cache.forget(file);
      return true;
    });
  }

  /** Load active memories (excludes archived). Pass includeArchived for everything. */
  async all(includeArchived = false): Promise<Memory[]> {
    await this.ensureRecovered();
    const dirs = [path.join(this.root, "global"), path.join(this.root, "scopes")];
    if (includeArchived) {
      dirs.push(path.join(this.root, "archived", "global"), path.join(this.root, "archived", "scopes"));
    }
    const files = await walk(...dirs);
    const memories = await Promise.all(files.map((f) => this.parseCached(f)));
    return memories.filter((m): m is Memory => m !== null);
  }

  async get(id: string): Promise<Memory | null> {
    await this.ensureRecovered();
    const file = await this.findFile(id);
    if (!file) return null;
    return this.parseCached(file);
  }

  /** Parse-cache observability (tests + future /metrics). */
  cacheStats(): { size: number; capacity: number } {
    return { size: this.cache.size, capacity: this.cache.capacity };
  }

  /** Move a memory to the archived tree (sets archivedAt). */
  async archive(id: string): Promise<Memory | null> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      const m = await this.get(id);
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
  async revive(id: string): Promise<Memory | null> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      const m = await this.get(id);
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
  async update(memory: Memory): Promise<Memory> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      const updated: Memory = { ...memory, updatedAt: new Date().toISOString() };
      const file = this.fileFor(updated);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await this.writeCached(file, render(updated), updated);
      return updated;
    });
  }

  /** Record that a memory surfaced in search (decay refresh). Cheap: no-op if seen <1h ago. */
  async touch(id: string): Promise<void> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      // Read + write inside the lock: racing an archive/revive move here is
      // what used to be able to resurrect a file in both trees.
      const m = await this.get(id);
      if (!m) return;
      const last = Date.parse(m.lastSeen ?? m.updatedAt);
      if (Number.isFinite(last) && Date.now() - last < 3_600_000) return;
      m.lastSeen = new Date().toISOString();
      await this.writeCached(this.fileFor(m), render(m), m);
    });
  }

  /** Import a snapshot memory verbatim (id preserved). Returns false if the id exists. */
  async importMemory(m: Memory): Promise<boolean> {
    await this.ensureRecovered();
    return this.withLock(async () => {
      if (await this.findFile(m.id)) return false;
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
    await writeFileAtomic(file, data, fs);
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
    if (probe.hit) return probe.memory ?? null;
    const memory = await parse(file);
    this.cache.remember(file, st, memory);
    return memory;
  }

  private async storeLocked(
    input: StoreInput,
    embedding?: number[],
    opts?: { provenance?: Memory["provenance"] },
  ): Promise<Memory> {
    const now = new Date().toISOString();
    // 12 hex chars (2^48): collision-safe; existence check guards the rest (P2 audit #9).
    let id = genId();
    for (let i = 0; i < 10 && (await this.findFile(id)); i++) id = genId();
    if (await this.findFile(id)) {
      throw new RemembraError("CONFLICT", `could not allocate a unique memory id after retries`);
    }
    const memory: Memory = {
      id,
      type: input.type,
      content: input.content,
      scope: input.scope,
      tags: input.tags,
      importance: input.importance,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      provenance: opts?.provenance ?? "explicit",
      embedding,
    };
    const file = this.fileFor(memory);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this.writeCached(file, render(memory), memory);
    return memory;
  }

  private fileFor(m: Memory): string {
    const safeScope = m.scope === "global" ? "global" : m.scope.replace(/[^a-zA-Z0-9._/-]/g, "_");
    const base = m.scope === "global" ? path.join(this.root, "global") : path.join(this.root, "scopes", safeScope);
    const archivedBase =
      m.scope === "global"
        ? path.join(this.root, "archived", "global")
        : path.join(this.root, "archived", "scopes", safeScope);
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

  private async findFile(id: string): Promise<string | null> {
    const files = await walk(
      path.join(this.root, "global"),
      path.join(this.root, "scopes"),
      path.join(this.root, "archived"),
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
    const tmps = everything.filter((f) => f.endsWith(".tmp"));
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
      console.error(
        `Remembra: crash recovery — removed ${tmps.length} orphaned temp file(s), reconciled ${reconciled} interrupted move(s)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
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
async function writeFileAtomic(file: string, data: string, fsmod: typeof fs): Promise<void> {
  const tmp = `${file}.${genId().slice(0, 6)}.tmp`;
  try {
    await fsmod.writeFile(tmp, data, "utf8");
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

function render(m: Memory): string {
  const lines = [
    "---",
    `id: ${m.id}`,
    `version: ${SCHEMA_VERSION}`,
    `type: ${m.type}`,
    `scope: ${m.scope}`,
    `tags: [${m.tags.join(", ")}]`,
    `importance: ${m.importance}`,
    `created: ${m.createdAt}`,
    `updated: ${m.updatedAt}`,
    m.lastSeen ? `lastSeen: ${m.lastSeen}` : undefined,
    m.archivedAt ? `archivedAt: ${m.archivedAt}` : undefined,
    m.source ? `source: ${m.source}` : undefined,
    m.provenance ? `provenance: ${m.provenance}` : undefined,
    m.embedding && m.embedding.length > 0 ? `embedding: [${m.embedding.join(",")}]` : undefined,
    "---",
    "",
    m.content,
    "",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

/** Files we've already warned about (avoid log spam on every search). */
const parseWarnings = new Set<string>();

async function parse(file: string): Promise<Memory | null> {
  const warnOnce = (why: string) => {
    const key = `${file}:${why}`;
    if (parseWarnings.has(key)) return;
    parseWarnings.add(key);
    console.error(`Remembra: skipping unparseable memory file ${path.basename(file)} (${why})`);
  };
  try {
    const raw = await fs.readFile(file, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) {
      warnOnce("missing/invalid frontmatter");
      return null;
    }
    const meta: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    const tagsRaw = (meta.tags ?? "[]").replace(/^\[|\]$/g, "");
    let embedding: number[] | undefined;
    if (meta.embedding) {
      const nums = meta.embedding.replace(/^\[|\]$/g, "").split(",").map(Number);
      if (nums.length > 0 && nums.every((n) => Number.isFinite(n))) embedding = nums;
    }
    return {
      id: meta.id ?? path.basename(file, ".md"),
      type: (meta.type ?? "fact") as Memory["type"],
      content: match[2].trim(),
      scope: meta.scope ?? "global",
      tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : [],
      importance: Number(meta.importance ?? 3),
      createdAt: meta.created ?? new Date(0).toISOString(),
      updatedAt: meta.updated ?? meta.created ?? new Date(0).toISOString(),
      lastSeen: meta.lastSeen,
      archivedAt: meta.archivedAt,
      source: meta.source,
      provenance:
        meta.provenance === "explicit" || meta.provenance === "auto" ? meta.provenance : undefined,
      embedding,
    };
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err));
    return null;
  }
}
