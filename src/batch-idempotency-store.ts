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
}

export type BatchIdempotencyClaim =
  | { status: "fresh" }
  | { status: "replay"; response: unknown };

export interface BatchIdempotencyStore {
  claim(input: BatchIdempotencyInput): Promise<BatchIdempotencyClaim>;
  complete(input: BatchIdempotencyInput & { response: unknown }): Promise<void>;
  /** Invalidate all claims after a data rollback/restore or operator reset. */
  invalidate(): Promise<void>;
  close?(): void;
}

export interface FileBatchIdempotencyStoreOptions {
  /** Maximum serialized response accepted for one claim. */
  maxBytes?: number;
  /** Completed claims older than this are eligible for removal. */
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

interface ClaimRow {
  scopeHash: string;
  keyHash: string;
  fingerprint: string;
  state: "in_progress" | "completed";
  createdAt: number;
  completedAt: number | null;
  response: string | null;
  responseBytes: number;
  reservedBytes: number;
  mac: string;
  generation: number;
}

function invalid(message: string): never {
  throw new RemembraError("SERVICE_UNAVAILABLE", `batch idempotency: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (current === resolved && uid !== undefined && stat.uid !== uid) invalid("claim directory is not owned by the current user");
  }
  try {
    fs.chmodSync(resolved, 0o700);
  } catch {
    invalid("claim directory permissions could not be restricted");
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

function recordMac(key: Buffer, row: Omit<ClaimRow, "mac">): string {
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
  ]);
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

function parseRow(value: unknown, integrityKey: Buffer): ClaimRow {
  if (!isRecord(value)) invalid("claim row has an invalid shape");
  const row: ClaimRow = {
    scopeHash: String(value.scopeHash),
    keyHash: String(value.keyHash),
    fingerprint: String(value.fingerprint),
    state: value.state as ClaimRow["state"],
    createdAt: Number(value.createdAt),
    completedAt: value.completedAt === null ? null : Number(value.completedAt),
    response: value.response === null ? null : String(value.response),
    responseBytes: Number(value.responseBytes),
    reservedBytes: Number(value.reservedBytes),
    mac: String(value.mac),
    generation: Number(value.generation),
  };
  if (!/^[a-f0-9]{64}$/.test(row.scopeHash) || !/^[a-f0-9]{64}$/.test(row.keyHash) || !/^[a-f0-9]{64}$/.test(row.fingerprint)) {
    invalid("claim row has invalid hashes");
  }
  if (row.state !== "in_progress" && row.state !== "completed") invalid("claim row has an invalid state");
  if (!Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.generation) || row.generation < 0) {
    invalid("claim row has invalid timestamps");
  }
  if (row.state === "in_progress" && (row.completedAt !== null || row.response !== null || row.responseBytes !== 0)) {
    invalid("in-progress claim contains a response");
  }
  if (row.state === "completed" && (row.completedAt === null || !Number.isSafeInteger(row.completedAt) || row.response === null || row.responseBytes < 0)) {
    invalid("completed claim is incomplete");
  }
  if (!Number.isSafeInteger(row.responseBytes) || row.responseBytes < 0 || !Number.isSafeInteger(row.reservedBytes) || row.reservedBytes < 0) {
    invalid("claim row has invalid byte accounting");
  }
  const expectedMac = recordMac(integrityKey, row);
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
  private readonly db: Database.Database;
  private readonly integrityKey: Buffer;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerScope: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private closed = false;

  constructor(root: string, options: FileBatchIdempotencyStoreOptions = {}) {
    const resolvedRoot = path.resolve(root);
    ensureSafeDirectorySync(resolvedRoot);
    this.maxBytes = options.maxBytes ?? MAX_BATCH_IDEMPOTENCY_RESPONSE_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxEntriesPerScope = options.maxEntriesPerScope ?? Math.min(1_000, this.maxEntries);
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > MAX_BATCH_IDEMPOTENCY_RESPONSE_BYTES) {
      throw new RemembraError("INVALID_INPUT", `idempotency maxBytes must be between 1024 and ${MAX_BATCH_IDEMPOTENCY_RESPONSE_BYTES}`);
    }
    if (!Number.isInteger(this.maxAgeMs) || this.maxAgeMs < 60_000) {
      throw new RemembraError("INVALID_INPUT", "idempotency maxAgeMs must be at least 60000");
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
    this.databasePath = path.join(resolvedRoot, "claims.sqlite");
    assertSafeFileSync(this.databasePath);
    try {
      this.db = new Database(this.databasePath, { readonly: false, fileMustExist: false });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("busy_timeout = 5000");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS batch_idempotency_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generation INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO batch_idempotency_meta (id, generation) VALUES (1, 1);
        CREATE TABLE IF NOT EXISTS batch_idempotency_claims (
          scope_hash TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          response TEXT,
          response_bytes INTEGER NOT NULL DEFAULT 0,
          reserved_bytes INTEGER NOT NULL DEFAULT 0,
          mac TEXT NOT NULL,
          generation INTEGER NOT NULL,
          PRIMARY KEY (scope_hash, key_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_batch_idempotency_state_time
          ON batch_idempotency_claims(state, completed_at);
      `);
      fs.chmodSync(this.databasePath, 0o600);
      this.pruneCompleted();
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency database could not be opened", { cause: error });
    }
  }

  private currentGeneration(): number {
    const value = this.db.prepare("SELECT generation FROM batch_idempotency_meta WHERE id = 1").get() as { generation: number } | undefined;
    if (!value || !Number.isSafeInteger(value.generation)) invalid("generation metadata is missing");
    return value.generation;
  }

  private row(scopeHash: string, keyHash: string): ClaimRow | undefined {
    const value = this.db.prepare(
      "SELECT scope_hash AS scopeHash, key_hash AS keyHash, fingerprint, state, created_at AS createdAt, completed_at AS completedAt, response, response_bytes AS responseBytes, reserved_bytes AS reservedBytes, mac, generation FROM batch_idempotency_claims WHERE scope_hash = ? AND key_hash = ?",
    ).get(scopeHash, keyHash);
    return value === undefined ? undefined : parseRow(value, this.integrityKey);
  }

  private pruneCompleted(): void {
    const cutoff = this.now() - this.maxAgeMs;
    this.db.prepare("DELETE FROM batch_idempotency_claims WHERE state = 'completed' AND completed_at < ?").run(cutoff);
  }

  async claim(input: BatchIdempotencyInput): Promise<BatchIdempotencyClaim> {
    validateInput(input);
    const scopeHash = input.scope;
    const keyHash = digest(input.key);
    const transaction = this.db.transaction(() => {
      const existing = this.row(scopeHash, keyHash);
      if (existing) {
        if (existing.scopeHash !== scopeHash || existing.keyHash !== keyHash) invalid("claim binding mismatch");
        if (existing.generation !== this.currentGeneration()) invalid("claim generation is stale; invalidate the ledger");
        if (existing.fingerprint !== input.fingerprint) {
          throw new RemembraError("CONFLICT", "idempotency key was already used with a different request");
        }
        if (existing.state === "in_progress") {
          throw new RemembraError("SERVICE_UNAVAILABLE", "an identical idempotent request is already in progress");
        }
        return { status: "replay" as const, response: parseResponse(existing) };
      }

      this.pruneCompleted();
      const totals = this.db.prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN state = 'in_progress' THEN reserved_bytes ELSE response_bytes END), 0) AS bytes FROM batch_idempotency_claims",
      ).get() as { count: number; bytes: number };
      const scopeCount = this.db.prepare("SELECT COUNT(*) AS count FROM batch_idempotency_claims WHERE scope_hash = ?").get(scopeHash) as { count: number };
      if (totals.count >= this.maxEntries || totals.bytes + this.maxBytes > this.maxTotalBytes || scopeCount.count >= this.maxEntriesPerScope) {
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
        generation,
      };
      this.db.prepare(
        "INSERT INTO batch_idempotency_claims (scope_hash, key_hash, fingerprint, state, created_at, completed_at, response, response_bytes, reserved_bytes, mac, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(scopeHash, keyHash, input.fingerprint, "in_progress", createdAt, null, null, 0, this.maxBytes, recordMac(this.integrityKey, row), generation);
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
      const existing = this.row(scopeHash, keyHash);
      if (!existing) invalid("claim does not exist");
      if (existing.scopeHash !== scopeHash || existing.keyHash !== keyHash) invalid("claim binding mismatch");
      if (existing.generation !== this.currentGeneration()) invalid("claim generation is stale; invalidate the ledger");
      if (existing.fingerprint !== input.fingerprint) {
        throw new RemembraError("CONFLICT", "idempotency key was already used with a different request");
      }
      if (existing.state === "completed") return;
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

  async invalidate(): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM batch_idempotency_claims").run();
      this.db.prepare("UPDATE batch_idempotency_meta SET generation = generation + 1 WHERE id = 1").run();
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
