import Database from "better-sqlite3";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RemembraError } from "./errors.js";
import { canonicalJson } from "./tenant-migration.js";

export const BATCH_IDEMPOTENCY_FORMAT = "remembra-batch-idempotency" as const;
export const BATCH_IDEMPOTENCY_VERSION = 1 as const;
export const MAX_BATCH_IDEMPOTENCY_REQUEST_BYTES = 256 * 1024;
export const MAX_BATCH_IDEMPOTENCY_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface BatchIdempotencyInput {
  /** Opaque host-derived principal/credential scope; never an authorization payload. */
  scope: string;
  /** Validated client key. The raw value is never written to the database. */
  key: string;
  /** Stable hash of the canonical request. */
  fingerprint: string;
  /**
   * Batch operation this claim belongs to. A released claim keeps binding the
   * key to its operation, so a released key can never be reused for a
   * different operation.
   */
  operation?: string;
}

export type BatchIdempotencyClaim =
  | { status: "fresh" }
  | { status: "replay"; response: unknown };

/**
 * Why a durable gate is held. `restore` gates are cleared by a verified
 * data restore; `migration` gates belong to a resumable tenant migration and
 * must never be cleared as if the data had simply been rolled back.
 */
export type BatchRestoreReason = "restore" | "migration";

export interface BatchIdempotencyStore {
  readonly restorePending?: boolean;
  /**
   * Verified owner of the durable gate. `undefined` means no gate is held or
   * the held gate cannot be attributed, which is never auto-clearable.
   */
  readonly restoreReason?: BatchRestoreReason;
  claim(input: BatchIdempotencyInput): Promise<BatchIdempotencyClaim>;
  complete(input: BatchIdempotencyInput & { response: unknown }): Promise<void>;
  /** Release an in-progress claim only when the caller knows no write took effect. */
  abandon?(input: BatchIdempotencyInput): Promise<void>;
  /** Create a durable gate before a data restore or tenant migration begins. */
  beginRestore?(reason?: BatchRestoreReason): Promise<void>;
  /** Invalidate claims and clear the restore gate after publication succeeds. */
  completeRestore?(): Promise<void>;
  /** Invalidate all claims after a data rollback/restore or operator reset. */
  invalidate(): Promise<void>;
  close?(): void;
}

export interface FileBatchIdempotencyStoreOptions {
  /** Maximum serialized response accepted for one claim. */
  maxBytes?: number;
  /** @deprecated Completed claims no longer expire; accepted for source compatibility. */
  maxAgeMs?: number;
  /** Maximum total claims retained; capacity exhaustion fails closed. */
  maxEntries?: number;
  /** Maximum claims retained for one scope. */
  maxEntriesPerScope?: number;
  /** Maximum aggregate reserved/response bytes. */
  maxTotalBytes?: number;
  /** Optional externally managed HMAC key; otherwise a 0600 local key is generated. */
  integrityKey?: Buffer;
  /** Test clock hook. */
  now?: () => number;
}

type ClaimState = "in_progress" | "completed" | "released";

interface ClaimRow {
  scopeHash: string;
  keyHash: string;
  fingerprint: string;
  state: ClaimState;
  createdAt: number;
  completedAt: number | null;
  response: string | null;
  responseBytes: number;
  reservedBytes: number;
  operation: string;
  mac: string;
  generation: number;
}

/** Claim columns without the released-state operation binding. */
const CLAIM_COLUMNS_V1 = [
  "scope_hash",
  "key_hash",
  "fingerprint",
  "state",
  "created_at",
  "completed_at",
  "response",
  "response_bytes",
  "reserved_bytes",
  "mac",
  "generation",
] as const;

const CLAIM_COLUMNS_V2 = [...CLAIM_COLUMNS_V1, "operation"] as const;

function invalid(message: string): never {
  throw new RemembraError("SERVICE_UNAVAILABLE", `batch idempotency: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verified owner of a durable gate marker. An unreadable, replaced, or
 * unrecognized marker yields `undefined` so callers never auto-clear it.
 */
export function readRestoreMarkerReason(markerPath: string): BatchRestoreReason | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.format !== "remembra-batch-restore" || !Number.isSafeInteger(parsed.version)) return undefined;
  if (parsed.version === 1) return "restore";
  return parsed.reason === "restore" || parsed.reason === "migration" ? parsed.reason : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function batchIdempotencyFingerprint(value: unknown): string {
  return digest(canonicalJson(value));
}

/** Convert a trusted host scope into an opaque digest before it reaches the ledger. */
export function batchIdempotencyScope(value: string): string {
  return digest(value);
}

function validateInput(input: BatchIdempotencyInput): void {
  if (typeof input.scope !== "string" || !/^[a-f0-9]{64}$/.test(input.scope)) {
    throw new RemembraError("INVALID_INPUT", "idempotency scope must be a 64-character digest");
  }
  if (typeof input.key !== "string" || input.key.length < 1 || input.key.length > 128) {
    throw new RemembraError("INVALID_INPUT", "idempotency key is invalid");
  }
  if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)) {
    throw new RemembraError("INVALID_INPUT", "idempotency fingerprint must be a 64-character digest");
  }
  if (input.operation !== undefined && (typeof input.operation !== "string" || !/^[a-z][a-z0-9_]{0,15}$/.test(input.operation))) {
    throw new RemembraError("INVALID_INPUT", "idempotency operation is invalid");
  }
}

function ensureSafeDirectorySync(directory: string): void {
  const resolved = path.resolve(directory);
  const filesystemRoot = path.parse(resolved).root;
  const segments = resolved.slice(filesystemRoot.length).split(path.sep).filter(Boolean);
  let current = filesystemRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) invalid("claim directory must not contain symlinks");
    if (!stat.isDirectory()) invalid("claim path is not a directory");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (current === resolved && ((stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid))) {
      invalid("claim directory must be owner-only and owned by the current user");
    }
  }
}

function assertSafeFileSync(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) invalid("claim database must not be a symlink");
    if (!stat.isFile()) invalid("claim database path is not a regular file");
    if ((stat.mode & 0o077) !== 0) invalid("claim database must not be group/world accessible");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) invalid("claim database is not owned by the current user");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function loadIntegrityKeySync(root: string, supplied?: Buffer): Buffer {
  if (supplied) {
    if (supplied.length < 32 || supplied.length > 128) {
      throw new RemembraError("INVALID_INPUT", "idempotency integrity key must be 32-128 bytes");
    }
    return Buffer.from(supplied);
  }
  const keyPath = path.join(root, "claims.key");
  assertSafeFileSync(keyPath);
  try {
    const handle = fs.openSync(keyPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      const key = randomBytes(32);
      fs.writeFileSync(handle, key);
      return key;
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertSafeFileSync(keyPath);
  const key = fs.readFileSync(keyPath);
  if (key.length < 32 || key.length > 128) invalid("integrity key has an invalid length");
  return key;
}

function ledgerIdentitySync(root: string, databasePath: string): { identity: string; created: boolean } {
  const identityPath = path.join(root, "claims.identity");
  assertSafeFileSync(identityPath);
  let identity: string | undefined;
  try {
    identity = fs.readFileSync(identityPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let databaseExists = false;
  try {
    fs.lstatSync(databasePath);
    databaseExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (identity !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(identity)) invalid("ledger identity is invalid");
    if (!databaseExists) invalid("ledger database is missing while its identity remains");
    return { identity, created: false };
  }
  if (databaseExists) invalid("ledger database exists without its identity; refuse to reset claim history");
  const createdIdentity = randomBytes(32).toString("hex");
  let handle: number | undefined;
  try {
    handle = fs.openSync(identityPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(handle, `${createdIdentity}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return ledgerIdentitySync(root, databasePath);
    throw new RemembraError("SERVICE_UNAVAILABLE", "ledger identity could not be created", { cause: error });
  }
  return { identity: createdIdentity, created: true };
}

function metaMac(key: Buffer, identity: string, generation: number, restorePending: boolean): string {
  return createHmac("sha256", key).update(`identity:${identity}:generation:${generation}:restore:${restorePending ? 1 : 0}`, "utf8").digest("base64url");
}

function recordMac(key: Buffer, row: Omit<ClaimRow, "mac">, legacy = false): string {
  const payload = JSON.stringify([
    row.scopeHash,
    row.keyHash,
    row.fingerprint,
    row.state,
    row.createdAt,
    row.completedAt ?? "",
    row.response ?? "",
    row.responseBytes,
    row.reservedBytes,
    row.generation,
    ...(legacy ? [] : [row.operation]),
  ]);
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

function parseRow(value: unknown, integrityKey: Buffer, legacy = false): ClaimRow {
  if (!isRecord(value)) invalid("claim row has an invalid shape");
  const row: ClaimRow = {
    scopeHash: String(value.scopeHash),
    keyHash: String(value.keyHash),
    fingerprint: String(value.fingerprint),
    state: value.state as ClaimState,
    createdAt: Number(value.createdAt),
    completedAt: value.completedAt === null ? null : Number(value.completedAt),
    response: value.response === null ? null : String(value.response),
    responseBytes: Number(value.responseBytes),
    reservedBytes: Number(value.reservedBytes),
    operation: value.operation === undefined || value.operation === null ? "" : String(value.operation),
    mac: String(value.mac),
    generation: Number(value.generation),
  };
  if (!/^[a-f0-9]{64}$/.test(row.scopeHash) || !/^[a-f0-9]{64}$/.test(row.keyHash) || !/^[a-f0-9]{64}$/.test(row.fingerprint)) {
    invalid("claim row has invalid hashes");
  }
  if (row.state !== "in_progress" && row.state !== "completed" && row.state !== "released") invalid("claim row has an invalid state");
  if (row.operation !== "" && !/^[a-z][a-z0-9_]{0,15}$/.test(row.operation)) invalid("claim row has an invalid operation");
  if (!Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.generation) || row.generation < 0) {
    invalid("claim row has invalid timestamps");
  }
  if ((row.state === "in_progress" || row.state === "released") && (row.completedAt !== null || row.response !== null || row.responseBytes !== 0)) {
    invalid("unfinished claim contains a response");
  }
  if (row.state === "completed" && (row.completedAt === null || !Number.isSafeInteger(row.completedAt) || row.response === null || row.responseBytes < 0)) {
    invalid("completed claim is incomplete");
  }
  if (row.state === "completed" && Buffer.byteLength(row.response ?? "", "utf8") !== row.responseBytes) {
    invalid("claim response byte accounting is invalid");
  }
  if (!Number.isSafeInteger(row.responseBytes) || row.responseBytes < 0 || !Number.isSafeInteger(row.reservedBytes) || row.reservedBytes < 0) {
    invalid("claim row has invalid byte accounting");
  }
  if (legacy && row.state === "released") invalid("legacy claim rows cannot hold a released state");
  const expectedMac = recordMac(integrityKey, row, legacy);
  if (row.mac.length < 40 || row.mac.length > 128 || row.mac !== expectedMac) invalid("claim row integrity check failed");
  return row;
}

function parseResponse(row: ClaimRow): unknown {
  if (row.state !== "completed" || row.response === null) invalid("claim has no completed response");
  try {
    return JSON.parse(row.response) as unknown;
  } catch {
    invalid("claim response is not valid JSON");
  }
}

/**
 * Durable local SQLite claim ledger. SQLite supplies cross-process transactions,
 * atomic publication, and busy-timeout handling; no raw key or scope is stored.
 */
export class FileBatchIdempotencyStore implements BatchIdempotencyStore {
  readonly databasePath: string;
  private readonly restoreMarkerPath: string;
  private readonly db: Database.Database;
  private readonly integrityKey: Buffer;
  private readonly identity: string;
  private readonly newLedger: boolean;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerScope: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private closed = false;

  constructor(root: string, options: FileBatchIdempotencyStoreOptions = {}) {
    const resolvedRoot = path.resolve(root);
    ensureSafeDirectorySync(resolvedRoot);
    const entries = fs.readdirSync(resolvedRoot);
    if (entries.some((name) => name.endsWith(".json"))) {
      invalid("legacy JSON claim files require explicit operator migration");
    }
    const allowedEntries = /^(claims\.sqlite(?:-journal|-wal|-shm)?|claims\.identity|claims\.key|restore\.pending)$/;
    if (entries.some((name) => !allowedEntries.test(name))) {
      invalid("claim directory contains unrelated files");
    }
    this.restoreMarkerPath = path.join(resolvedRoot, "restore.pending");
    this.databasePath = path.join(resolvedRoot, "claims.sqlite");
    this.maxBytes = options.maxBytes ?? MAX_BATCH_IDEMPOTENCY_RESPONSE_BYTES;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxEntriesPerScope = options.maxEntriesPerScope ?? Math.min(1_000, this.maxEntries);
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > MAX_BATCH_IDEMPOTENCY_RESPONSE_BYTES) {
      throw new RemembraError("INVALID_INPUT", `idempotency maxBytes must be between 1024 and ${MAX_BATCH_IDEMPOTENCY_RESPONSE_BYTES}`);
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 100_000) {
      throw new RemembraError("INVALID_INPUT", "idempotency maxEntries must be between 1 and 100000");
    }
    if (!Number.isInteger(this.maxEntriesPerScope) || this.maxEntriesPerScope < 1 || this.maxEntriesPerScope > this.maxEntries) {
      throw new RemembraError("INVALID_INPUT", "idempotency maxEntriesPerScope must be between 1 and maxEntries");
    }
    if (!Number.isInteger(this.maxTotalBytes) || this.maxTotalBytes < this.maxBytes || this.maxTotalBytes > 1024 * 1024 * 1024) {
      throw new RemembraError("INVALID_INPUT", "idempotency maxTotalBytes is outside the supported range");
    }
    this.integrityKey = loadIntegrityKeySync(resolvedRoot, options.integrityKey);
    const ledger = ledgerIdentitySync(resolvedRoot, this.databasePath);
    this.identity = ledger.identity;
    this.newLedger = ledger.created;
    assertSafeFileSync(this.databasePath);
    try {
      this.db = new Database(this.databasePath, { readonly: false, fileMustExist: false });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("busy_timeout = 5000");
      const existingTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const tableNames = new Set(existingTables.map((row) => row.name));
      if (!this.newLedger) {
        if (
          tableNames.size !== 2
          || !tableNames.has("batch_idempotency_meta")
          || !tableNames.has("batch_idempotency_claims")
        ) {
          invalid("ledger database does not match its recorded identity");
        }
        const existingMeta = this.db.prepare("SELECT id FROM batch_idempotency_meta WHERE id = 1").get();
        if (!existingMeta) invalid("ledger generation metadata is missing");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS batch_idempotency_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          identity TEXT NOT NULL,
          generation INTEGER NOT NULL,
          restore_pending INTEGER NOT NULL DEFAULT 0 CHECK (restore_pending IN (0, 1)),
          mac TEXT NOT NULL
        );
      `);
      if (this.newLedger) {
        this.createClaimTable("batch_idempotency_claims");
        this.db.prepare("INSERT INTO batch_idempotency_meta (id, identity, generation, restore_pending, mac) VALUES (1, ?, 1, 0, ?)")
          .run(this.identity, metaMac(this.integrityKey, this.identity, 1, false));
      } else {
        this.migrateClaimTable();
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_batch_idempotency_state_time
          ON batch_idempotency_claims(state, completed_at);
      `);
      this.currentGeneration();
      fs.chmodSync(this.databasePath, 0o600);
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency database could not be opened", { cause: error });
    }
  }

  private createClaimTable(table: string): void {
    this.db.exec(`
      CREATE TABLE ${table} (
        scope_hash TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed', 'released')),
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        response TEXT,
        response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
        reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
        mac TEXT NOT NULL,
        generation INTEGER NOT NULL,
        operation TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope_hash, key_hash)
      );
    `);
  }

  /**
   * Accept only the two known claim-table shapes. A ledger written before the
   * released-state binding is verified row by row and rebuilt in place; any
   * other shape fails closed rather than resetting key history.
   */
  private migrateClaimTable(): void {
    const columns = (this.db.prepare("PRAGMA table_info(batch_idempotency_claims)").all() as Array<{ name: string }>)
      .map((entry) => entry.name);
    if (columns.length === CLAIM_COLUMNS_V2.length && CLAIM_COLUMNS_V2.every((name, index) => columns[index] === name)) return;
    if (columns.length !== CLAIM_COLUMNS_V1.length || !CLAIM_COLUMNS_V1.every((name, index) => columns[index] === name)) {
      invalid("ledger claim table does not match a supported schema");
    }
    const rebuild = this.db.transaction(() => {
      const legacyRows = this.db.prepare(
        "SELECT scope_hash AS scopeHash, key_hash AS keyHash, fingerprint, state, created_at AS createdAt, completed_at AS completedAt, response, response_bytes AS responseBytes, reserved_bytes AS reservedBytes, mac, generation FROM batch_idempotency_claims",
      ).all();
      // Rows are HMAC-verified with either the pre-binding or the current
      // payload and rewritten with the current one, so a ledger interrupted
      // mid-upgrade still migrates without weakening integrity.
      const verified = legacyRows.map((row) => {
        try {
          return { ...parseRow(row, this.integrityKey, true), operation: "" };
        } catch {
          return parseRow(row, this.integrityKey, false);
        }
      });
      this.createClaimTable("batch_idempotency_claims_v2");
      const insert = this.db.prepare(
        "INSERT INTO batch_idempotency_claims_v2 (scope_hash, key_hash, fingerprint, state, created_at, completed_at, response, response_bytes, reserved_bytes, mac, generation, operation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of verified) {
        insert.run(
          row.scopeHash,
          row.keyHash,
          row.fingerprint,
          row.state,
          row.createdAt,
          row.completedAt,
          row.response,
          row.responseBytes,
          row.reservedBytes,
          recordMac(this.integrityKey, row),
          row.generation,
          "",
        );
      }
      this.db.prepare("DROP TABLE batch_idempotency_claims").run();
      this.db.prepare("ALTER TABLE batch_idempotency_claims_v2 RENAME TO batch_idempotency_claims").run();
    });
    rebuild.immediate();
  }

  private currentMeta(): { generation: number; restorePending: boolean } {
    const value = this.db.prepare("SELECT identity, generation, restore_pending, mac FROM batch_idempotency_meta WHERE id = 1").get() as { identity: string; generation: number; restore_pending: number; mac: string } | undefined;
    if (!value || value.identity !== this.identity || !Number.isSafeInteger(value.generation) || value.generation < 0 || (value.restore_pending !== 0 && value.restore_pending !== 1)) {
      invalid("generation metadata is missing");
    }
    const restorePending = value.restore_pending === 1;
    if (value.mac !== metaMac(this.integrityKey, this.identity, value.generation, restorePending)) invalid("generation metadata integrity check failed");
    return { generation: value.generation, restorePending };
  }

  private currentGeneration(): number {
    return this.currentMeta().generation;
  }

  private row(scopeHash: string, keyHash: string): ClaimRow | undefined {
    const value = this.db.prepare(
      "SELECT scope_hash AS scopeHash, key_hash AS keyHash, fingerprint, state, created_at AS createdAt, completed_at AS completedAt, response, response_bytes AS responseBytes, reserved_bytes AS reservedBytes, mac, generation, operation FROM batch_idempotency_claims WHERE scope_hash = ? AND key_hash = ?",
    ).get(scopeHash, keyHash);
    return value === undefined ? undefined : parseRow(value, this.integrityKey);
  }

  async claim(input: BatchIdempotencyInput): Promise<BatchIdempotencyClaim> {
    if (this.restorePending) throw new RemembraError("SERVICE_UNAVAILABLE", "data restore is pending");
    validateInput(input);
    const scopeHash = input.scope;
    const keyHash = digest(input.key);
    const transaction = this.db.transaction(() => {
      if (this.currentMeta().restorePending) throw new RemembraError("SERVICE_UNAVAILABLE", "data restore is pending");
      let existing = this.row(scopeHash, keyHash);
      if (existing) {
        if (existing.scopeHash !== scopeHash || existing.keyHash !== keyHash) invalid("claim binding mismatch");
        if (existing.generation !== this.currentGeneration()) invalid("claim generation is stale; invalidate the ledger");
        if (existing.state === "released") {
          // A released claim never applied a write, but the key stays bound to
          // the operation it was first used for.
          if (existing.operation === "") {
            throw new RemembraError("SERVICE_UNAVAILABLE", "a released idempotency key cannot be re-executed");
          }
          if (input.operation !== existing.operation) {
            throw new RemembraError("CONFLICT", "idempotency key was already used for a different operation");
          }
          this.db.prepare("DELETE FROM batch_idempotency_claims WHERE scope_hash = ? AND key_hash = ? AND state = 'released'")
            .run(scopeHash, keyHash);
          existing = undefined;
        }
      }
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new RemembraError("CONFLICT", "idempotency key was already used with a different request");
        }
        if (existing.state === "in_progress") {
          throw new RemembraError("SERVICE_UNAVAILABLE", "an identical idempotent request is already in progress");
        }
        return { status: "replay" as const, response: parseResponse(existing) };
      }

      const totals = this.db.prepare(
        "SELECT COUNT(*) AS entryCount, COALESCE(SUM(CASE WHEN state = 'in_progress' THEN reserved_bytes ELSE response_bytes END), 0) AS totalBytes FROM batch_idempotency_claims WHERE state <> 'released'",
      ).get() as { entryCount: number; totalBytes: number };
      const scopeCount = this.db.prepare(
        "SELECT COUNT(*) AS scopeCount FROM batch_idempotency_claims WHERE scope_hash = ? AND state <> 'released'",
      ).get(scopeHash) as { scopeCount: number };
      if (
        totals.entryCount >= this.maxEntries
        || totals.totalBytes + this.maxBytes > this.maxTotalBytes
        || scopeCount.scopeCount >= this.maxEntriesPerScope
      ) {
        invalid("claim capacity is exhausted");
      }
      const createdAt = this.now();
      const generation = this.currentGeneration();
      const row: Omit<ClaimRow, "mac"> = {
        scopeHash,
        keyHash,
        fingerprint: input.fingerprint,
        state: "in_progress",
        createdAt,
        completedAt: null,
        response: null,
        responseBytes: 0,
        reservedBytes: this.maxBytes,
        operation: input.operation ?? "",
        generation,
      };
      this.db.prepare(
        "INSERT INTO batch_idempotency_claims (scope_hash, key_hash, fingerprint, state, created_at, completed_at, response, response_bytes, reserved_bytes, mac, generation, operation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(scopeHash, keyHash, input.fingerprint, "in_progress", createdAt, null, null, 0, this.maxBytes, recordMac(this.integrityKey, row), generation, row.operation);
      return { status: "fresh" as const };
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency claim could not be acquired", { cause: error });
    }
  }

  async complete(input: BatchIdempotencyInput & { response: unknown }): Promise<void> {
    if (this.restorePending) throw new RemembraError("SERVICE_UNAVAILABLE", "data restore is pending");
    validateInput(input);
    let response: string;
    try {
      const serialized = JSON.stringify(input.response);
      if (typeof serialized !== "string") throw new Error("response is not JSON-serializable");
      if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) throw new Error("response is too large");
      response = serialized;
    } catch (error) {
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency response cannot be persisted", { cause: error });
    }
    const scopeHash = input.scope;
    const keyHash = digest(input.key);
    const transaction = this.db.transaction(() => {
      if (this.currentMeta().restorePending) throw new RemembraError("SERVICE_UNAVAILABLE", "data restore is pending");
      const existing = this.row(scopeHash, keyHash);
      if (!existing) invalid("claim does not exist");
      if (existing.scopeHash !== scopeHash || existing.keyHash !== keyHash) invalid("claim binding mismatch");
      if (existing.generation !== this.currentGeneration()) invalid("claim generation is stale; invalidate the ledger");
      if (existing.fingerprint !== input.fingerprint) {
        throw new RemembraError("CONFLICT", "idempotency key was already used with a different request");
      }
      if (existing.state === "completed") return;
      if (existing.state === "released") invalid("a released claim cannot be completed");
      const completed: Omit<ClaimRow, "mac"> = {
        ...existing,
        state: "completed",
        completedAt: this.now(),
        response,
        responseBytes: Buffer.byteLength(response, "utf8"),
        reservedBytes: 0,
      };
      const result = this.db.prepare(
        "UPDATE batch_idempotency_claims SET state = 'completed', completed_at = ?, response = ?, response_bytes = ?, reserved_bytes = ?, mac = ? WHERE scope_hash = ? AND key_hash = ? AND fingerprint = ? AND state = 'in_progress'",
      ).run(completed.completedAt, response, completed.responseBytes, 0, recordMac(this.integrityKey, completed), scopeHash, keyHash, input.fingerprint);
      if (result.changes !== 1) invalid("claim changed while it was being completed");
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency result could not be persisted", { cause: error });
    }
  }

  /**
   * Release a reserved claim that provably applied no write. The key is not
   * freed: a released tombstone keeps binding the key to its operation while
   * allowing the identical operation to be retried.
   */
  async abandon(input: BatchIdempotencyInput): Promise<void> {
    if (this.restorePending) throw new RemembraError("SERVICE_UNAVAILABLE", "data restore is pending");
    validateInput(input);
    const scopeHash = input.scope;
    const keyHash = digest(input.key);
    const transaction = this.db.transaction(() => {
      if (this.currentMeta().restorePending) throw new RemembraError("SERVICE_UNAVAILABLE", "data restore is pending");
      const existing = this.row(scopeHash, keyHash);
      if (!existing) return;
      if (existing.generation !== this.currentGeneration()) invalid("claim generation is stale; invalidate the ledger");
      if (existing.fingerprint !== input.fingerprint) {
        throw new RemembraError("CONFLICT", "idempotency key was already used with a different request");
      }
      if (existing.state === "released") {
        if (existing.operation !== (input.operation ?? "")) {
          throw new RemembraError("CONFLICT", "idempotency key was already used for a different operation");
        }
        return;
      }
      if (existing.state !== "in_progress") invalid("only an in-progress claim can be abandoned");
      const released: Omit<ClaimRow, "mac"> = {
        ...existing,
        state: "released",
        completedAt: null,
        reservedBytes: 0,
        operation: input.operation ?? existing.operation,
      };
      const result = this.db.prepare(
        "UPDATE batch_idempotency_claims SET state = 'released', reserved_bytes = 0, operation = ?, mac = ? WHERE scope_hash = ? AND key_hash = ? AND fingerprint = ? AND state = 'in_progress'",
      ).run(released.operation, recordMac(this.integrityKey, released), scopeHash, keyHash, input.fingerprint);
      if (result.changes !== 1) invalid("claim changed while it was being abandoned");
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency claim could not be released", { cause: error });
    }
  }

  private restoreMarkerExists(): boolean {
    try {
      fs.lstatSync(this.restoreMarkerPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  get restorePending(): boolean {
    if (this.restoreMarkerExists()) return true;
    try {
      return this.currentMeta().restorePending;
    } catch {
      return true;
    }
  }

  /**
   * Verified owner of the durable gate. An unreadable, replaced, or legacy
   * marker yields `undefined` so callers never auto-clear it.
   */
  get restoreReason(): BatchRestoreReason | undefined {
    if (!this.restorePending) return undefined;
    return readRestoreMarkerReason(this.restoreMarkerPath);
  }

  async beginRestore(reason: BatchRestoreReason = "restore"): Promise<void> {
    if (reason !== "restore" && reason !== "migration") {
      throw new RemembraError("INVALID_INPUT", "restore gate reason is invalid");
    }
    const publish = this.db.transaction(() => {
      const current = this.currentMeta();
      if (current.restorePending) throw new RemembraError("SERVICE_UNAVAILABLE", "a restore is already pending");
      const active = this.db.prepare("SELECT 1 FROM batch_idempotency_claims WHERE state = 'in_progress' LIMIT 1").get();
      if (active) throw new RemembraError("SERVICE_UNAVAILABLE", "an idempotent mutation is still in progress");
      this.db.prepare("UPDATE batch_idempotency_meta SET restore_pending = 1, mac = ? WHERE id = 1")
        .run(metaMac(this.integrityKey, this.identity, current.generation, true));
    });
    try {
      publish.immediate();
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "restore gate could not be published", { cause: error });
    }

    const marker = `${JSON.stringify({ format: "remembra-batch-restore", version: 2, reason, createdAt: new Date().toISOString() })}\n`;
    let handle: number | undefined;
    try {
      if (!this.restoreMarkerExists()) {
        handle = fs.openSync(this.restoreMarkerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        fs.writeFileSync(handle, marker, "utf8");
        fs.fsyncSync(handle);
        fs.closeSync(handle);
        handle = undefined;
        fs.chmodSync(this.restoreMarkerPath, 0o600);
      } else {
        assertSafeFileSync(this.restoreMarkerPath);
      }
    } catch (error) {
      if (handle !== undefined) fs.closeSync(handle);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        const revert = this.db.transaction(() => {
          const current = this.currentMeta();
          if (current.restorePending) {
            this.db.prepare("UPDATE batch_idempotency_meta SET restore_pending = 0, mac = ? WHERE id = 1")
              .run(metaMac(this.integrityKey, this.identity, current.generation, false));
          }
        });
        revert.immediate();
        throw new RemembraError("SERVICE_UNAVAILABLE", "restore gate could not be established", { cause: error });
      }
    }
  }

  async completeRestore(): Promise<void> {
    // The gate marker is verified and removed before any claim history is
    // dropped: an unsafe marker must never silently discard replay claims.
    // The database flag stays set until invalidation succeeds, so a failure
    // here still fails closed.
    try {
      const stat = fs.lstatSync(this.restoreMarkerPath);
      if (stat.isSymbolicLink() || !stat.isFile()) invalid("restore gate is unsafe; move it aside and retry");
      fs.unlinkSync(this.restoreMarkerPath);
      const directory = fs.openSync(path.dirname(this.restoreMarkerPath), fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A gate held in the database without its marker is still cleared
        // below; the durable flag keeps failing closed until then.
      } else if (error instanceof RemembraError) {
        throw error;
      } else {
        throw new RemembraError("SERVICE_UNAVAILABLE", "restore gate could not be cleared", { cause: error });
      }
    }
    await this.invalidate();
  }

  async invalidate(): Promise<void> {
    const transaction = this.db.transaction(() => {
      const current = this.currentGeneration();
      const next = current + 1;
      if (!Number.isSafeInteger(next)) invalid("generation overflow");
      this.db.prepare("DELETE FROM batch_idempotency_claims").run();
      this.db.prepare("UPDATE batch_idempotency_meta SET generation = ?, restore_pending = 0, mac = ? WHERE id = 1")
        .run(next, metaMac(this.integrityKey, this.identity, next, false));
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency state could not be invalidated", { cause: error });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** Descriptive alias for new code; FileBatchIdempotencyStore remains compatible. */
export { FileBatchIdempotencyStore as SqliteBatchIdempotencyStore };
