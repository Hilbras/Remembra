/**
 * SQLite-backed MemoryBackend (V4.3.0).
 *
 * Runtime storage: a single SQLite database at `<root>/data.sqlite`.
 * Embeddings are stored as BLOB (Float32Array bytes), not frontmatter.
 * Full-text search is backed by an FTS5 virtual table (with graceful
 * fallback when the SQLite build lacks FTS5 support).
 *
 * Concurrency: SQLite WAL mode handles cross-process safety. An
 * in-process FIFO queue serialises same-process mutations (same contract
 * as MemoryStore).
 *
 * Migration: on first open, if no DB exists but legacy `.md` files are
 * present under `<root>`, they are auto-migrated into the DB and the old
 * tree is moved to `<root>/.legacy/`.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Memory, StoreInput } from "./types.js";
import type { MemoryBackend, HistoryEntry, CandidateSearchRequest, CandidateSearchPage } from "./backend.js";
import { RemembraError } from "./errors.js";
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import {
  MemoryType,
  TrustLevel,
  RetentionMode,
  ProvenanceSchema,
  defaultTrust,
  RelationKind,
  SCHEMA_VERSION,
  isValidTenantId,
  MemoryAccess,
  MemoryOwner,
} from "./types.js";
import { defaultAccess, defaultOwner } from "./agent.js";
import type { TenantFilter } from "./tenant.js";

// ---------------------------------------------------------------------------
//  Id generation (UUIDv7, plan §3.6)
// ---------------------------------------------------------------------------

export function genId(): string {
  const b = randomBytes(16);
  let ms = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function embedToBlob(v: number[] | undefined): Buffer | null {
  if (!v || v.length === 0) return null;
  const arr = new Float32Array(v);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function blobToEmbed(buf: Buffer | null): number[] | undefined {
  if (!buf || buf.length === 0) return undefined;
  // Safer: copy bytes into a fresh ArrayBuffer to avoid shared-buffer issues.
  const copy = Buffer.alloc(buf.length);
  copy.set(buf);
  const floatCount = copy.byteLength / 4;
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, floatCount));
}

function jsonStr(val: unknown): string {
  return JSON.stringify(val);
}

function parseJson<T = unknown>(s: string | undefined): T | null {
  if (s === undefined) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function asStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function assertScope(scope: string): void {
  if (!scope || /\.\./.test(scope) || scope.includes("\\")) {
    throw new RemembraError("INVALID_INPUT", `invalid scope "${scope}"`);
  }
}

function tenantWhere(alias: string, tenant?: TenantFilter): { sql: string; params: string[] } {
  const prefix = alias ? `${alias}.` : "";
  if (!tenant) return { sql: `${prefix}tenant_id IS NULL`, params: [] };
  const params = [tenant.organizationId];
  let sql = `${prefix}tenant_id = ?`;
  if (tenant.projectId) {
    sql += ` AND ${prefix}project_id = ?`;
    params.push(tenant.projectId);
  }
  return { sql, params };
}

// ---------------------------------------------------------------------------
//  Schema
// ---------------------------------------------------------------------------

export const SQLITE_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL CHECK (type IN (
                      'fact','preference','decision','constraint',
                      'instruction','role','entity','relationship',
                      'event','history','observation'
                    )),
  content           TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'global',
  tenant_id         TEXT,
  project_id        TEXT,
  user_id           TEXT,
  agent_id          TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  importance        INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  confidence        REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  trust             TEXT NOT NULL DEFAULT 'trusted' CHECK (trust IN (
                      'system','verified','trusted','unverified'
                    )),
  provenance        TEXT NOT NULL,
  owner             TEXT NOT NULL DEFAULT 'global' CHECK (owner IN (
                       'user','agent','project','organization','global'
                     )),
  access            TEXT NOT NULL DEFAULT 'global' CHECK (access IN (
                       'private','shared','global'
                     )),
  valid_from        TEXT,
  valid_until       TEXT,
  observed_at       TEXT,
  superseded_by     TEXT,
  meta              TEXT,
  retention         TEXT NOT NULL DEFAULT 'decaying' CHECK (retention IN (
                      'pinned','persistent','ephemeral','decaying','neverExpire'
                    )),
  relations         TEXT NOT NULL DEFAULT '[]',
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_seen         TEXT,
  archived_at       TEXT,
  embedding         BLOB
);

CREATE INDEX IF NOT EXISTS idx_scope       ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_tenant      ON memories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_scope ON memories(tenant_id, scope);
CREATE INDEX IF NOT EXISTS idx_type        ON memories(type);
CREATE INDEX IF NOT EXISTS idx_archived    ON memories(archived_at);
CREATE INDEX IF NOT EXISTS idx_updated     ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_last_seen   ON memories(last_seen);

CREATE TABLE IF NOT EXISTS memory_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tenant_id  TEXT,
  project_id TEXT,
  content    TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_tenant ON memory_versions(tenant_id, memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT REFERENCES memories(id),
  tenant_id  TEXT,
  project_id TEXT,
  action     TEXT NOT NULL CHECK (action IN (
                'store','update','archive','revive','forget','import'
              )),
  details    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_memory ON memory_audit(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON memory_audit(tenant_id, memory_id, created_at DESC);
`;

// ---------------------------------------------------------------------------
//  SqliteBackend
// ---------------------------------------------------------------------------

export interface SqliteOptions {
  /** Path to the SQLite database file. Default: `<root>/data.sqlite`. */
  dbPath?: string;
  /** Path to the legacy markdown-root (for migration detection). */
  root?: string;
  /** Test hook: memory-id factory (default: UUIDv7). */
  idGen?: () => string;
  /** Whether to force FTS5 on/off (auto-detected if omitted). */
  ftsEnabled?: boolean;
}

export class SqliteBackend implements MemoryBackend {
  readonly tenantCapable = true;
  protected readonly db: Database.Database;
  private readonly idGen: () => string;
  private ftsEnabled: boolean;
  /**
   * Reuse hot read statements. Besides avoiding repeated SQL compilation,
   * retaining the statements avoids a better-sqlite3/Node 24 native cleanup
   * assertion when a large result set is read repeatedly.
   */
  private readonly allActiveStatement: Database.Statement;
  private readonly allIncludingArchivedStatement: Database.Statement;
  private readonly insertMemoryStatement: Database.Statement;
  private readonly lastInsertRowidStatement: Database.Statement;
  private readonly insertFtsStatement: Database.Statement | null;
  private readonly deleteFtsStatement: Database.Statement | null;
  private readonly auditStatement: Database.Statement;
  private readonly candidateMatchStatement: Database.Statement;
  private readonly candidateZeroStatement: Database.Statement;
  private readonly candidateCountStatement: Database.Statement;
  /** In-process FIFO so mutations are serialized within this instance. */
  private queue: Promise<void> = Promise.resolve();
  private migrationPromise: Promise<void> | null = null;

  constructor(opts: SqliteOptions = {}) {
    const dbPath = opts.dbPath ?? path.join(opts.root ?? ".remembra", "data.sqlite");
    this.db = new Database(dbPath, { readonly: false, fileMustExist: false });
    const dbSchemaVersion = Number(this.db.pragma("user_version", { simple: true }));
    if (dbSchemaVersion > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`SQLite schema ${dbSchemaVersion} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SQLITE_SCHEMA_SQL);
    this.ensureAgentColumns();
    this.ensureTenantAuxColumns();
    this.allActiveStatement = this.db.prepare(
      "SELECT * FROM memories WHERE archived_at IS NULL AND tenant_id IS NULL ORDER BY updated_at DESC",
    );
    this.allIncludingArchivedStatement = this.db.prepare(
      "SELECT * FROM memories WHERE tenant_id IS NULL ORDER BY updated_at DESC",
    );

    // Detect FTS5 support.
    this.ftsEnabled =
      opts.ftsEnabled ?? this.detectFts5();
    if (this.ftsEnabled) {
      this.createFts();
    } else {
      logEvent(
        "warn",
        "fts5_unavailable",
        {},
        "Remembra: FTS5 not available — falling back to keyword-only search",
      );
    }

    // Retain hot statements. Recreating these for every operation adds
    // avoidable compilation and has exposed a native cleanup assertion with
    // better-sqlite3 under Node 24 when the collection is large.
    this.insertMemoryStatement = this.db.prepare(`
      INSERT INTO memories (
        id, type, content, scope, tenant_id, project_id, user_id, agent_id, tags, importance, confidence, trust,
        provenance, owner, access, valid_from, valid_until, observed_at, superseded_by, meta,
        retention, relations, version, created_at, updated_at,
        last_seen, archived_at, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.lastInsertRowidStatement = this.db.prepare("SELECT last_insert_rowid() AS rowid");
    this.insertFtsStatement = this.ftsEnabled
      ? this.db.prepare("INSERT INTO memories_fts(rowid, content) VALUES (?, ?)")
      : null;
    this.deleteFtsStatement = this.ftsEnabled
      ? this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?")
      : null;
    this.auditStatement = this.db.prepare(
      "INSERT INTO memory_audit (memory_id, tenant_id, project_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const eligibleFilter = `
      (? = 1 OR m.archived_at IS NULL)
      AND (
        ? = 1
        OR m.valid_until IS NULL
        OR julianday(m.valid_until) IS NULL
        OR julianday(m.valid_until) >= julianday(?)
      )
      AND (
        ? = 1
        OR m.valid_from IS NULL
        OR julianday(m.valid_from) IS NULL
        OR julianday(m.valid_from) <= julianday(?)
      )
      AND (
        ? = 1
        OR COALESCE(
          CASE WHEN json_valid(m.meta) THEN json_extract(m.meta, '$.quarantined') ELSE 0 END,
          0
        ) = 0
      )
    `;
    const tenantFilter = `
      AND (
        (? = 0 AND m.tenant_id IS NULL)
        OR (? = 1 AND m.tenant_id = ?)
      )
      AND (? = '' OR m.project_id = ?)
    `;
    const candidateFilter = `${eligibleFilter}
      AND (? = '' OR m.scope = ? OR m.scope = 'global')
      ${tenantFilter}
    `;
    const keywordPredicate = `
      EXISTS (
        SELECT 1
        FROM json_each(?) AS terms
        WHERE instr(lower(m.content), lower(terms.value)) > 0
           OR instr(lower(m.tags), lower(terms.value)) > 0
      )
    `;
    this.candidateMatchStatement = this.db.prepare(`
      SELECT m.*
      FROM memories AS m
      WHERE ${candidateFilter}
        AND ${keywordPredicate}
      ORDER BY m.updated_at DESC
      LIMIT ?
    `);
    this.candidateZeroStatement = this.db.prepare(`
      SELECT m.*
      FROM memories AS m
      WHERE ${candidateFilter}
        AND NOT ${keywordPredicate}
      ORDER BY (
        CASE
          WHEN json_valid(m.provenance)
            AND json_extract(m.provenance, '$.sourceType') = 'manual' THEN 10
          ELSE 0
        END
        + CASE m.trust
            WHEN 'system' THEN 8
            WHEN 'verified' THEN 6
            WHEN 'trusted' THEN 2
            WHEN 'unverified' THEN -8
            ELSE 0
          END
        + CASE WHEN m.retention = 'pinned' THEN 50 ELSE 0 END
        + m.importance * 4
        + m.confidence * 20
        + (CASE WHEN ? = 1 THEN 2.0 ELSE 0.5 END)
          * (20.0 * pow(0.5, COALESCE(MAX(0.0, julianday(?) - julianday(m.updated_at)), 0.0) / 30.0))
        + CASE WHEN m.scope = ? THEN 150 ELSE 100 END
        + CASE
            WHEN m.type IN ('role', 'instruction') AND m.trust <> 'unverified' THEN 1000
            ELSE 0
          END
      )
      , m.updated_at DESC
      , m.id ASC
      LIMIT ?
    `);
    this.candidateCountStatement = this.db.prepare(`
      SELECT count(*) AS count
      FROM memories AS m
      WHERE ${eligibleFilter}${tenantFilter}
    `);

    this.idGen = opts.idGen ?? genId;

    // Auto-migrate from legacy flat files if needed.
    this.startMigration(opts.root).catch((err) => {
      logEvent(
        "error",
        "migration_failed",
        { error: String(err).slice(0, 200) },
        `Remembra: migration failed: ${String(err).slice(0, 200)}`,
      );
    });
  }

  /** Add V4.7 policy columns to databases created by earlier 4.x releases. */
  private ensureAgentColumns(): void {
    const columns = this.db.pragma("table_info(memories)") as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    if (!names.has("owner")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN owner TEXT NOT NULL DEFAULT 'global'");
    }
    if (!names.has("access")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN access TEXT NOT NULL DEFAULT 'global'");
    }
    for (const [name, definition] of [
      ["valid_from", "TEXT"],
      ["valid_until", "TEXT"],
      ["observed_at", "TEXT"],
      ["superseded_by", "TEXT"],
      ["meta", "TEXT"],
      ["tenant_id", "TEXT"],
      ["project_id", "TEXT"],
      ["user_id", "TEXT"],
      ["agent_id", "TEXT"],
    ] as const) {
      if (!names.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureTenantAuxColumns(): void {
    for (const table of ["memory_versions", "memory_audit"] as const) {
      const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      if (!names.has("tenant_id")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT`);
      if (!names.has("project_id")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
    }
  }

  // -------------------------------------------------------------------------
  //  Public API (MemoryBackend)
  // -------------------------------------------------------------------------

  async store(input: StoreInput, embedding?: number[], tenant?: TenantFilter): Promise<Memory> {
    return this.withLock(async () => {
      const now = new Date().toISOString();
      const id = this.idGen();
      const provSrc = input.provenance?.sourceType ?? "manual";
      const provenance: Memory["provenance"] = {
        sourceType: provSrc,
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
        confidence:
          input.confidence ?? (provSrc === "conversation" ? 0.7 : 1),
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
      this.insertRow(memory);
      this.audit("store", memory.id, { type: memory.type, scope: memory.scope }, provenance, tenant);
      return memory;
    });
  }

  async get(id: string, tenant?: TenantFilter): Promise<Memory | null> {
    const scoped = tenantWhere("m", tenant);
    const row = this.db
      .prepare(`SELECT m.* FROM memories AS m WHERE m.id = ? AND ${scoped.sql}`)
      .get(id, ...scoped.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      return rowToMemory(row);
    } catch (err) {
      logEvent("error", "row_to_memory_failed", { id, error: String(err).slice(0, 200) }, `rowToMemory failed for ${id}: ${String(err).slice(0, 200)}`);
      return null;
    }
  }

  async all(includeArchived = false, tenant?: TenantFilter): Promise<Memory[]> {
    let rows: Record<string, unknown>[];
    if (!tenant) {
      const statement = includeArchived
        ? this.allIncludingArchivedStatement
        : this.allActiveStatement;
      rows = statement.all() as Record<string, unknown>[];
    } else {
      const scoped = tenantWhere("m", tenant);
      const archived = includeArchived ? "" : " AND m.archived_at IS NULL";
      rows = this.db
        .prepare(`SELECT m.* FROM memories AS m WHERE ${scoped.sql}${archived} ORDER BY m.updated_at DESC`)
        .all(...scoped.params) as Record<string, unknown>[];
    }
    return rows.map(rowToMemory).filter((m): m is Memory => m !== null);
  }

  /**
   * Return an exact keyword candidate superset for the current ranking path.
   *
   * All lexical matches are retained (up to the hard budget). For rows with no
   * lexical signal, SQL orders by the same modifier, scope, and standing gate
   * expression used by retrieval.ts, so the top zero-signal rows are enough to
   * preserve the final top-k. If the lexical set exceeds the budget, coverage
   * is partial and the service deliberately falls back to all().
   */
  async searchCandidates(request: CandidateSearchRequest): Promise<CandidateSearchPage> {
    const partial = (): CandidateSearchPage => ({
      memories: [],
      coverage: "partial",
      source: "none",
    });
    if (request.vector && request.vector.length > 0) return partial();
    // `type` is historically accepted but ignored by searchQ; do not change
    // that behavior accidentally while optimizing the keyword path.
    if (request.type) return partial();

    const maxCandidates = Math.max(1, Math.min(1000, Math.floor(request.maxCandidates)));
    const nowIso = new Date(request.now).toISOString();
    const includeArchived = request.includeArchived ? 1 : 0;
    const includeExpired = request.includeExpired ? 1 : 0;
    const includeFuture = request.includeFuture ? 1 : 0;
    const includeQuarantined = request.includeQuarantined ? 1 : 0;
    const scope = request.scope ?? "";
    const eligibleParams = [
      includeArchived,
      includeExpired,
      nowIso,
      includeFuture,
      nowIso,
      includeQuarantined,
    ] as const;
    const tenantParams = request.tenant
      ? [1, 1, request.tenant.organizationId, request.tenant.projectId ?? "", request.tenant.projectId ?? ""]
      : [0, 0, "", "", ""];
    const candidateParams = [...eligibleParams, scope, scope, ...tenantParams] as const;
    const termsJson = JSON.stringify(request.terms);

    try {
      const matchRows = this.candidateMatchStatement.all(
        ...candidateParams,
        termsJson,
        maxCandidates + 1,
      ) as Record<string, unknown>[];
      const requiredZero = Math.min(request.resultLimit, maxCandidates);
      if (matchRows.length + requiredZero > maxCandidates) return partial();

      const zeroLimit = Math.max(0, maxCandidates - matchRows.length);
      const zeroRows = zeroLimit > 0
        ? this.candidateZeroStatement.all(
            ...candidateParams,
            termsJson,
            request.temporalBoost ? 1 : 0,
            nowIso,
            scope,
            zeroLimit,
          ) as Record<string, unknown>[]
        : [];

      const byId = new Map<string, Memory>();
      for (const row of [...matchRows, ...zeroRows]) {
        const memory = rowToMemory(row);
        if (!memory) return partial();
        // Defense in depth: a backend must not return a row the service's
        // policy/lifecycle predicate rejects. Treat disagreement as partial.
        if (!request.eligible(memory)) return partial();
        byId.set(memory.id, memory);
      }
      if (byId.size > maxCandidates) return partial();

      const countRow = this.candidateCountStatement.get(...eligibleParams, ...tenantParams) as { count: number };
      return {
        memories: [...byId.values()],
        coverage: "complete",
        source: "sqlite",
        totalDocs: Number(countRow.count),
      };
    } catch {
      // JSON1/math support or a transient SQLite error must never turn into
      // an empty result. The service will use its established full-scan path.
      return partial();
    }
  }

  async update(
    memory: Memory,
    opts?: { expectedVersion?: number; reason?: string },
    tenant?: TenantFilter,
  ): Promise<Memory> {
    return this.withLock(async () => {
      if (tenant && memory.tenantId !== tenant.organizationId) {
        throw new RemembraError("NOT_FOUND", `memory ${memory.id} not found`);
      }
      if (!tenant && memory.tenantId) {
        throw new RemembraError("NOT_FOUND", `memory ${memory.id} not found`);
      }
      const scoped = tenantWhere("m", tenant);
      const existingRow = this.db
        .prepare(`SELECT rowid, version, content, tenant_id, project_id FROM memories AS m WHERE m.id = ? AND ${scoped.sql}`)
        .get(memory.id, ...scoped.params) as {
          rowid: number;
          version: number;
          content: string;
          tenant_id: string | null;
          project_id: string | null;
        } | undefined;
      if (!existingRow) throw new RemembraError("NOT_FOUND", `memory ${memory.id} not found`);

      if (opts?.expectedVersion !== undefined) {
        if (existingRow.version !== opts.expectedVersion) {
          throw new RemembraError(
            "CONFLICT",
            `version mismatch for ${memory.id}: expected ${opts.expectedVersion}, stored ${existingRow.version}`,
          );
        }
      }

      const updated: Memory = {
        ...memory,
        ...(existingRow.tenant_id ? { tenantId: existingRow.tenant_id } : {}),
        ...(existingRow.project_id ? { projectId: existingRow.project_id } : {}),
        version: existingRow.version + 1,
        updatedAt: new Date().toISOString(),
      };

      // Snapshot history if content changed.
      if (memory.content !== existingRow.content) {
        await this.snapshotHistory(memory.id, existingRow.content, opts?.reason, tenant);
      }

      this.db
        .prepare(`
          UPDATE memories SET
            type = ?, content = ?, scope = ?, tenant_id = ?, project_id = ?, user_id = ?, agent_id = ?, tags = ?, importance = ?,
            confidence = ?, trust = ?, provenance = ?, owner = ?, access = ?,
            valid_from = ?, valid_until = ?, observed_at = ?, superseded_by = ?, meta = ?, retention = ?,
            relations = ?, version = ?, created_at = ?, updated_at = ?,
            last_seen = ?, archived_at = ?, embedding = ?
          WHERE id = ? AND ${tenantWhere("", tenant).sql}
        `)
        .run(
          updated.type,
          updated.content,
          updated.scope,
          updated.tenantId ?? null,
          updated.projectId ?? null,
          updated.userId ?? null,
          updated.agentId ?? null,
          jsonStr(updated.tags),
          updated.importance,
          updated.confidence,
          updated.trust,
          jsonStr(updated.provenance),
          updated.owner ?? "global",
          updated.access ?? "global",
          updated.validFrom ?? null,
          updated.validUntil ?? null,
          updated.observedAt ?? null,
          updated.supersededBy ?? null,
          jsonStr(updated.meta),
          updated.retention ?? "decaying",
          jsonStr(updated.relations ?? []),
          updated.version,
          updated.createdAt,
          updated.updatedAt,
          updated.lastSeen ?? null,
          updated.archivedAt ?? null,
          embedToBlob(updated.embedding),
          updated.id,
          ...scoped.params,
        );

      if (this.ftsEnabled && this.deleteFtsStatement && this.insertFtsStatement && updated.content !== existingRow.content) {
        this.deleteFtsStatement.run(existingRow.rowid);
        this.insertFtsStatement.run(existingRow.rowid, updated.content);
      }

      this.audit("update", updated.id, { reason: opts?.reason }, updated.provenance, tenant);
      return updated;
    });
  }

  async archive(id: string, tenant?: TenantFilter): Promise<Memory | null> {
    return this.withLock(async () => {
      const scoped = tenantWhere("m", tenant);
      const row = this.db
        .prepare(`SELECT rowid, m.* FROM memories AS m WHERE m.id = ? AND ${scoped.sql} AND m.archived_at IS NULL`)
        .get(id, ...scoped.params) as Record<string, unknown> | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE memories SET archived_at = ?, updated_at = ? WHERE id = ? AND ${tenantWhere("", tenant).sql}`,
        )
        .run(now, now, id, ...tenantWhere("", tenant).params);
      if (this.ftsEnabled && this.deleteFtsStatement) {
        this.deleteFtsStatement.run(Number(row.rowid));
      }
      const updated = rowToMemory({ ...row, archived_at: now, updated_at: now });
      this.audit("archive", id, undefined, updated?.provenance, tenant);
      return updated;
    });
  }

  async revive(id: string, tenant?: TenantFilter): Promise<Memory | null> {
    return this.withLock(async () => {
      const scoped = tenantWhere("m", tenant);
      const row = this.db
        .prepare(`SELECT rowid, m.* FROM memories AS m WHERE m.id = ? AND ${scoped.sql} AND m.archived_at IS NOT NULL`)
        .get(id, ...scoped.params) as Record<string, unknown> | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE memories SET archived_at = NULL, last_seen = ?, updated_at = ? WHERE id = ? AND ${tenantWhere("", tenant).sql}`,
        )
        .run(now, now, id, ...tenantWhere("", tenant).params);
      if (this.ftsEnabled && this.insertFtsStatement) {
        this.insertFtsStatement.run(Number(row.rowid), String(row.content));
      }
      const updated = rowToMemory({ ...row, archived_at: null, last_seen: now, updated_at: now });
      this.audit("revive", id, undefined, updated?.provenance, tenant);
      return updated;
    });
  }

  async touch(id: string, tenant?: TenantFilter): Promise<void> {
    return this.withLock(async () => {
      const scoped = tenantWhere("m", tenant);
      const row = this.db
        .prepare(`SELECT last_seen, updated_at FROM memories AS m WHERE m.id = ? AND ${scoped.sql}`)
        .get(id, ...scoped.params) as { last_seen: string; updated_at: string } | undefined;
      if (!row) return;
      const last = Date.parse(row.last_seen ?? row.updated_at);
      if (Number.isFinite(last) && Date.now() - last < 3_600_000) return;
      this.db
        .prepare(`UPDATE memories SET last_seen = ? WHERE id = ? AND ${tenantWhere("", tenant).sql}`)
        .run(new Date().toISOString(), id, ...tenantWhere("", tenant).params);
    });
  }

  async forget(id: string, tenant?: TenantFilter): Promise<boolean> {
    return this.withLock(async () => {
      // Look up the integer rowid for FTS sync.
      const scoped = tenantWhere("m", tenant);
      const memRow = this.db
        .prepare(`SELECT rowid, m.provenance FROM memories AS m WHERE m.id = ? AND ${scoped.sql}`)
        .get(id, ...scoped.params) as { rowid: number; provenance: string } | undefined;
      if (!memRow) return false;
      // Audit before deleting so the FK reference is valid.
      const provenance = parseJson<Memory["provenance"]>(memRow.provenance);
      this.audit("forget", id, undefined, provenance ?? undefined, tenant);
      // Manually sync FTS before deleting.
      if (this.ftsEnabled && this.deleteFtsStatement && memRow.rowid) {
        try {
          this.deleteFtsStatement.run(memRow.rowid);
        } catch {
          // ignore FTS sync errors
        }
      }
      // Delete child rows first (foreign key constraints).
      const childScope = tenantWhere("", tenant);
      this.db
        .prepare(`DELETE FROM memory_audit WHERE memory_id = ? AND ${childScope.sql}`)
        .run(id, ...childScope.params);
      this.db
        .prepare(`DELETE FROM memory_versions WHERE memory_id = ? AND ${childScope.sql}`)
        .run(id, ...childScope.params);
      const info = this.db
        .prepare(`DELETE FROM memories WHERE id = ? AND ${tenantWhere("", tenant).sql}`)
        .run(id, ...tenantWhere("", tenant).params);
      if (info.changes === 0) return false;
      return true;
    });
  }

  async importMemory(m: Memory, tenant?: TenantFilter): Promise<boolean> {
    return this.withLock(async () => {
      if (
        (!tenant && m.tenantId) ||
        (tenant && (m.tenantId !== tenant.organizationId || (tenant.projectId && m.projectId !== tenant.projectId)))
      ) return false;
      const scoped = tenantWhere("m", tenant);
      const existing = this.db
        .prepare(`SELECT 1 FROM memories AS m WHERE m.id = ? AND ${scoped.sql}`)
        .get(m.id, ...scoped.params) as { 1: number } | undefined;
      if (existing) return false;
      this.insertRow(m);
      this.audit("import", m.id, undefined, m.provenance, tenant);
      return true;
    });
  }

  async history(id: string, tenant?: TenantFilter): Promise<HistoryEntry[]> {
    const scoped = tenantWhere("", tenant);
    const rows = this.db
      .prepare(
        `SELECT content, reason, created_at FROM memory_versions WHERE memory_id = ? AND ${scoped.sql} ORDER BY created_at DESC`,
      )
      .all(id, ...scoped.params) as Array<{ content: string; reason: string | null; created_at: string }>;
    return rows.map((r, idx) => ({
      file: `snapshot-${idx}.md`,
      content: r.content,
      reason: r.reason ?? undefined,
      snapshotAt: r.created_at,
    }));
  }

  cacheStats(): { size: number; capacity: number } {
    const info = this.db
      .prepare(
        "SELECT count(*) AS cnt FROM memories WHERE archived_at IS NULL",
      )
      .get() as { cnt: number };
    return { size: info.cnt, capacity: 0 };
  }

  /** V4.4: query recent audit events. */
  async getAudit(
    opts?: { limit?: number; since?: string },
    tenant?: TenantFilter,
  ): Promise<Record<string, unknown>[]> {
    let sql = "SELECT memory_id, action, details, created_at FROM memory_audit WHERE 1 = 1";
    const params: unknown[] = [];
    const scoped = tenantWhere("", tenant);
    sql += ` AND ${scoped.sql}`;
    params.push(...scoped.params);
    if (opts?.since) {
      sql += " AND created_at >= ?";
      params.push(opts.since);
    }
    sql += " ORDER BY created_at DESC";
    const limit = opts?.limit ?? 50;
    sql += ` LIMIT ${Number(limit)}`;
    const rows = this.db.prepare(sql).all(...params) as Array<{
      memory_id: string;
      action: string;
      details: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      memory_id: r.memory_id,
      action: r.action,
      details: r.details ?? undefined,
      created_at: r.created_at,
    }));
  }

  /** Close the database connection. Called on shutdown. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** Path to the SQLite database file on disk. */
  getDbPath(): string {
    return this.db.name;
  }

  /** Test hook: execute arbitrary SQL (for test setup only). */
  _testExec(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  // -------------------------------------------------------------------------
  //  Internal helpers
  // -------------------------------------------------------------------------

  private insertRow(m: Memory): void {
    this.insertMemoryStatement.run(
      m.id,
      m.type,
      m.content,
      m.scope,
      m.tenantId ?? null,
      m.projectId ?? null,
      m.userId ?? null,
      m.agentId ?? null,
      jsonStr(m.tags),
      m.importance,
      m.confidence,
      m.trust,
      jsonStr(m.provenance),
      m.owner ?? "global",
      m.access ?? "global",
      m.validFrom ?? null,
      m.validUntil ?? null,
      m.observedAt ?? null,
      m.supersededBy ?? null,
      jsonStr(m.meta),
      m.retention ?? "decaying",
      jsonStr(m.relations ?? []),
      m.version,
      m.createdAt,
      m.updatedAt,
      m.lastSeen ?? null,
      m.archivedAt ?? null,
      embedToBlob(m.embedding),
    );
    if (this.insertFtsStatement) {
      const rowId = this.lastInsertRowidStatement.get() as { rowid: number };
      this.insertFtsStatement.run(rowId.rowid, m.content);
    }
  }

  private async snapshotHistory(id: string, oldContent: string, reason?: string, tenant?: TenantFilter): Promise<void> {
    const limit = Number(process.env.REMEMBRA_HISTORY_LIMIT ?? 20);
    if (limit <= 0) return;
    const scoped = tenantWhere("", tenant);
    this.db
      .prepare(
        "INSERT INTO memory_versions (memory_id, tenant_id, project_id, content, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        tenant?.organizationId ?? null,
        tenant?.projectId ?? null,
        oldContent,
        reason ?? null,
        new Date().toISOString(),
      );
    metrics.inc("remembra_history_snapshots_total");
    if (limit > 0) {
      this.db
        .prepare(
          "DELETE FROM memory_versions WHERE " + scoped.sql + " AND id NOT IN (" +
          "SELECT id FROM memory_versions WHERE memory_id = ? AND " + scoped.sql + " ORDER BY created_at DESC LIMIT ?" +
          ")",
        )
        .run(...scoped.params, id, ...scoped.params, limit);
    }
  }

  private audit(
    action: string,
    memoryId: string | null,
    details?: Record<string, unknown>,
    provenance?: Memory["provenance"],
    tenant?: TenantFilter,
  ): void {
    const actor = provenance?.agentId
      ? {
          actor: {
            agentId: provenance.agentId,
            agentType: provenance.agentType,
            agentVersion: provenance.agentVersion,
            conversationId: provenance.conversationId,
            taskId: provenance.taskId,
            runId: provenance.runId,
          },
        }
      : {};
    this.auditStatement.run(
      memoryId,
      tenant?.organizationId ?? null,
      tenant?.projectId ?? null,
      action,
      (details || Object.keys(actor).length > 0) ? jsonStr({ ...details, ...actor }) : null,
      new Date().toISOString(),
    );
  }

  /** In-process FIFO queue — serialises same-process mutations. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  // -------------------------------------------------------------------------
  //  FTS5
  // -------------------------------------------------------------------------

  private detectFts5(): boolean {
    try {
      this.db.pragma("enable_fts5 = 1");
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_test USING fts5(x)");
      this.db.exec("DROP TABLE IF EXISTS _fts_test");
      return true;
    } catch {
      return false;
    }
  }

  private createFts(): void {
    try {
      this.db.exec(/* sql */ `
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content
        );
      `);
      // Rebuild idempotently from the main table. A single INSERT…SELECT keeps
      // startup bounded and avoids per-row native statement churn.
      this.db.exec("DELETE FROM memories_fts");
      this.db.exec(
        "INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories",
      );
      logEvent("info", "fts5_ready", {}, "Remembra: FTS5 full-text search enabled");
    } catch (err) {
      logEvent(
        "warn",
        "fts5_create_failed",
        { error: String(err).slice(0, 200) },
        `Remembra: FTS5 creation failed, falling back: ${String(err).slice(0, 200)}`,
      );
      this.ftsEnabled = false;
    }
  }

  /**
   * FTS5-compatible search: returns IDs of matching memories.
   * Falls back to empty when FTS5 is unavailable (caller should use keyword scoring).
   */
  ftsSearch(query: string, tenant?: TenantFilter): string[] {
    if (!this.ftsEnabled) return [];
    try {
      const scoped = tenantWhere("m", tenant);
      const rows = this.db
        .prepare(
          `SELECT m.id FROM memories_fts JOIN memories AS m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? AND ${scoped.sql}`,
        )
        .all(query, ...scoped.params) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  //  Migration from legacy flat files
  // -------------------------------------------------------------------------

  private startMigration(root?: string): Promise<void> {
    if (!this.migrationPromise) {
      this.migrationPromise = this.maybeMigrate(root).finally(() => {
        this.migrationPromise = null;
      });
    }
    return this.migrationPromise;
  }

  private async maybeMigrate(root?: string): Promise<void> {
    const dbPath = this.db.name;
    const legacyRoot = root ?? path.dirname(dbPath);
    const globalDir = path.join(legacyRoot, "global");
    const scopesDir = path.join(legacyRoot, "scopes");
    const archivedDir = path.join(legacyRoot, "archived");

    // Check if any legacy files exist.
    const hasFiles = await Promise.all([
      fs.access(globalDir).then(() => true, () => false),
      fs.access(scopesDir).then(() => true, () => false),
      fs.access(archivedDir).then(() => true, () => false),
    ]).then(([a, b, c]) => a || b || c);

    if (!hasFiles) return; // no legacy data — fresh install

    logEvent("info", "migration_start", { root: legacyRoot }, "Remembra: migrating from flat files to SQLite");

    const mdFiles = await this.walkMdFiles(globalDir, scopesDir, archivedDir);
    let imported = 0;
    let skipped = 0;

    for (const file of mdFiles) {
      try {
        const mem = await parseLegacyFile(file);
        if (!mem) { skipped++; continue; }
        // Scope is semantic data, not a filesystem path. Keep council/task
        // scopes intact so agent policy can compare them exactly.
        this.insertRow(mem);
        imported++;
      } catch {
        skipped++;
      }
    }

    // Move only legacy data directories; data.sqlite must stay in place.
    const legacyMove = path.join(legacyRoot, ".legacy");
    await fs.mkdir(legacyMove, { recursive: true });
    for (const name of ["global", "scopes", "archived"]) {
      const from = path.join(legacyRoot, name);
      if (await fs.access(from).then(() => true, () => false)) {
        await fs.rename(from, path.join(legacyMove, name)).catch(() => {});
      }
    }

    logEvent(
      "info",
      "migration_done",
      { imported, skipped, legacy: legacyMove },
      `Remembra: migration complete — ${imported} memories imported, ${skipped} skipped`,
    );
    metrics.inc("remembra_migrations_total", { step: "file_to_sqlite" }, imported);
  }

  private async walkMdFiles(...dirs: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const dir of dirs) {
      try {
        await this._walkDir(dir, result);
      } catch {
        // directory doesn't exist — skip
      }
    }
    return result;
  }

  private async _walkDir(dir: string, acc: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this._walkDir(full, acc);
      } else if (entry.name.endsWith(".md")) {
        acc.push(full);
      }
    }
  }

  /** Public entry point for manual migration: `remembra migrate`. */
  async migrate(): Promise<{ imported: number; skipped: number }> {
    const root = path.dirname(this.db.name);
    // Run migration even if DB exists (idempotent: skips if no legacy files).
    await this.startMigration(root);
    const count = this.db.prepare("SELECT count(*) AS cnt FROM memories").get() as { cnt: number };
    return { imported: count.cnt, skipped: 0 };
  }
}

// ---------------------------------------------------------------------------
//  Row ↔ Memory conversion
// ---------------------------------------------------------------------------

function rowToMemory(row: Record<string, unknown>): Memory | null {
  const id = asStr(row.id);
  if (!id) return null;

  const type = asStr(row.type);
  if (!type || !MemoryType.options.includes(type as MemoryType)) return null;

  const scope = asStr(row.scope) ?? "global";
  try { assertScope(scope); } catch { return null; }

  const tenantId = asStr(row.tenant_id);
  const projectId = asStr(row.project_id);
  const userId = asStr(row.user_id);
  const agentId = asStr(row.agent_id);
  if (
    (tenantId !== undefined && !isValidTenantId(tenantId)) ||
    (projectId !== undefined && !isValidTenantId(projectId)) ||
    (userId !== undefined && !isValidTenantId(userId)) ||
    (agentId !== undefined && !isValidTenantId(agentId))
  ) return null;

  const content = asStr(row.content);
  if (!content) return null;

  const tags = parseJson<string[]>(asStr(row.tags)) ?? [];
  const importance = Math.min(5, Math.max(1, Number(row.importance) ?? 3));
  const confidence = Math.min(1, Math.max(0, Number(row.confidence) ?? 1));
  const trustRaw = asStr(row.trust);
  const trust = TrustLevel.options.includes(trustRaw as TrustLevel)
    ? (trustRaw as TrustLevel)
    : "trusted";

  const provenanceRaw = parseJson<Record<string, unknown>>(asStr(row.provenance));
  let provenance: Memory["provenance"] = { sourceType: "manual" };
  if (provenanceRaw) {
    const parsed = ProvenanceSchema.safeParse(provenanceRaw);
    if (parsed.success) provenance = parsed.data;
  }

  const retentionRaw = asStr(row.retention);
  const retention = RetentionMode.options.includes(retentionRaw as RetentionMode)
    ? (retentionRaw as RetentionMode)
    : undefined;

  const ownerRaw = asStr(row.owner);
  const owner = MemoryOwner.options.includes(ownerRaw as MemoryOwner)
    ? (ownerRaw as MemoryOwner)
    : "global";
  const accessRaw = asStr(row.access);
  const access = MemoryAccess.options.includes(accessRaw as MemoryAccess)
    ? (accessRaw as MemoryAccess)
    : "global";
  const validFrom = asStr(row.valid_from);
  const validUntil = asStr(row.valid_until);
  const observedAt = asStr(row.observed_at);
  const supersededBy = asStr(row.superseded_by);
  const memoryMeta = parseJson<Memory["meta"]>(asStr(row.meta));

  const relationsRaw = parseJson<Array<{ id: string; kind: string }>>(asStr(row.relations));
  const relations: Memory["relations"] =
    relationsRaw && relationsRaw.length > 0 ? (relationsRaw as Memory["relations"]) : undefined;

  const version = Number(row.version) ?? 1;
  const createdAt = asStr(row.created_at) ?? new Date().toISOString();
  const updatedAt = asStr(row.updated_at) ?? createdAt;
  const lastSeen = asStr(row.last_seen);
  const archivedAt = asStr(row.archived_at);
  const embedding = blobToEmbed(
    row.embedding instanceof Buffer ? row.embedding : null,
  );

  return {
    id,
    type: type as MemoryType,
    content,
    scope,
    ...(tenantId ? { tenantId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(userId ? { userId } : {}),
    ...(agentId ? { agentId } : {}),
    tags,
    importance,
    confidence,
    trust,
    provenance,
    owner,
    access,
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    ...(memoryMeta ? { meta: memoryMeta } : {}),
    retention,
    relations,
    version,
    createdAt,
    updatedAt,
    ...(lastSeen ? { lastSeen } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(embedding ? { embedding } : {}),
  };
}

// ---------------------------------------------------------------------------
//  Legacy file parser (for migration from flat-file store)
// ---------------------------------------------------------------------------

async function parseLegacyFile(file: string): Promise<Memory | null> {
  const raw = (await fs.readFile(file)).toString("utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return null;

  let meta: Record<string, unknown>;
  try {
    const doc = parseYaml(match[1]);
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
      meta = doc as Record<string, unknown>;
    } else if (match[1].trim() === "") {
      meta = {};
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const baseId = path.basename(file, ".md");
  const id = (meta.id ? String(meta.id) : baseId) as string;
  const type = (meta.type ? String(meta.type) : "fact") as MemoryType;
  if (!MemoryType.options.includes(type)) return null;

  const scope = (meta.scope ? String(meta.scope) : "global") as string;
  if (!scope || /\.\./.test(scope) || scope.includes("\\")) return null;
  const tenantId = meta.tenantId ? String(meta.tenantId) : undefined;
  const projectId = meta.projectId ? String(meta.projectId) : undefined;
  const userId = meta.userId ? String(meta.userId) : undefined;
  const agentId = meta.agentId ? String(meta.agentId) : undefined;
  if (
    (tenantId !== undefined && !isValidTenantId(tenantId)) ||
    (projectId !== undefined && !isValidTenantId(projectId)) ||
    (userId !== undefined && !isValidTenantId(userId)) ||
    (agentId !== undefined && !isValidTenantId(agentId))
  ) return null;

  const content = match[2].trim();
  if (!content) return null;

  const tags: string[] = Array.isArray(meta.tags)
    ? (meta.tags as unknown[]).map((t) => String(t)).filter(Boolean)
    : typeof meta.tags === "string"
      ? (meta.tags as string).replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean)
      : [];

  const impNum = Number(meta.importance ?? 3);
  const importance = Number.isFinite(impNum) ? Math.min(5, Math.max(1, Math.round(impNum))) : 3;

  const confFallback = (() => {
    const p = meta.provenance;
    if (typeof p === "object" && p !== null && "sourceType" in p) {
      return (p as { sourceType: string }).sourceType === "conversation" ? 0.7 : 1;
    }
    return 1;
  })();
  const confNum = Number(meta.confidence);
  const confidence = Number.isFinite(confNum) ? Math.min(1, Math.max(0, confNum)) : confFallback;

  const trustRaw = meta.trust ? String(meta.trust) : undefined;
  const trust = TrustLevel.options.includes(trustRaw as TrustLevel)
    ? (trustRaw as TrustLevel)
    : "trusted";

  let provenance: Memory["provenance"] = { sourceType: "manual" };
  if (meta.provenance) {
    if (typeof meta.provenance === "object" && !Array.isArray(meta.provenance)) {
      const parsed = ProvenanceSchema.safeParse(meta.provenance);
      if (parsed.success) provenance = parsed.data;
    }
  }

  const retentionRaw = meta.retention ? String(meta.retention) : undefined;
  const retention = RetentionMode.options.includes(retentionRaw as RetentionMode)
    ? (retentionRaw as RetentionMode)
    : undefined;

  const ownerRaw = meta.owner ? String(meta.owner) : undefined;
  const owner = MemoryOwner.options.includes(ownerRaw as MemoryOwner)
    ? (ownerRaw as MemoryOwner)
    : "global";
  const accessRaw = meta.access ? String(meta.access) : undefined;
  const access = MemoryAccess.options.includes(accessRaw as MemoryAccess)
    ? (accessRaw as MemoryAccess)
    : "global";

  const relationsRaw = meta.relations;
  let relations: Memory["relations"] = undefined;
  if (Array.isArray(relationsRaw)) {
    relations = (relationsRaw as Array<unknown>)
      .map((e: unknown) => {
        if (typeof e === "object" && e !== null) {
          const o = e as Record<string, unknown>;
          return { id: String(o.id ?? o[0] ?? ""), kind: String(o.kind ?? o[1] ?? "related") as RelationKind };
        }
        return null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.id.length > 0);
    if (relations.length === 0) relations = undefined;
  }

  const createdAt = meta.created ? String(meta.created) : new Date().toISOString();
  const updatedAt = meta.updated ? String(meta.updated) : createdAt;
  const validFrom = meta.validFrom ? String(meta.validFrom) : undefined;
  const validUntil = meta.validUntil ? String(meta.validUntil) : undefined;
  const observedAt = meta.observedAt ? String(meta.observedAt) : undefined;
  const supersededBy = meta.supersededBy ? String(meta.supersededBy) : undefined;
  const lastSeen = meta.lastSeen ? String(meta.lastSeen) : undefined;
  const archivedAt = meta.archivedAt ? String(meta.archivedAt) : undefined;
  const memoryMeta =
    meta.meta && typeof meta.meta === "object" && !Array.isArray(meta.meta)
      ? (meta.meta as Memory["meta"])
      : undefined;
  const embeddingRaw = meta.embedding;
  const embedding: number[] | undefined =
    typeof embeddingRaw === "string" && embeddingRaw.length > 0
      ? embeddingRaw.split(",").map((s) => parseFloat(s)).filter((n) => Number.isFinite(n))
      : undefined;

  const revision = meta.revision !== undefined ? Math.max(1, Math.round(Number(meta.revision))) : 1;

  return {
    id,
    type,
    content,
    scope,
    ...(tenantId ? { tenantId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(userId ? { userId } : {}),
    ...(agentId ? { agentId } : {}),
    tags,
    importance,
    confidence,
    trust,
    provenance,
    owner,
    access,
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    ...(memoryMeta ? { meta: memoryMeta } : {}),
    retention,
    relations,
    version: revision,
    createdAt,
    updatedAt,
    ...(lastSeen ? { lastSeen } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(embedding ? { embedding } : {}),
  };
}
