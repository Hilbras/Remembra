import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RemembraError } from "./errors.js";
import { canonicalJson } from "./tenant-migration.js";

export const BATCH_IDEMPOTENCY_FORMAT = "remembra-batch-idempotency" as const;
export const BATCH_IDEMPOTENCY_VERSION = 1 as const;

export interface BatchIdempotencyInput {
  /** Host-derived principal/tenant scope; never an authorization payload. */
  scope: string;
  /** Validated client key. The raw value is never written to disk. */
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
}

export interface FileBatchIdempotencyStoreOptions {
  /** Maximum serialized claim file size. */
  maxBytes?: number;
  /** Completed claims older than this are eligible for removal. */
  maxAgeMs?: number;
  /** Maximum active claims retained; capacity exhaustion fails closed. */
  maxEntries?: number;
}

interface StoredRecord {
  format: typeof BATCH_IDEMPOTENCY_FORMAT;
  version: typeof BATCH_IDEMPOTENCY_VERSION;
  scopeHash: string;
  keyHash: string;
  fingerprint: string;
  state: "in_progress" | "completed";
  createdAt: string;
  completedAt?: string;
  response?: unknown;
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

function validateInput(input: BatchIdempotencyInput): void {
  if (typeof input.scope !== "string" || input.scope.length < 1 || input.scope.length > 1024) {
    throw new RemembraError("INVALID_INPUT", "idempotency scope is invalid");
  }
  if (typeof input.key !== "string" || input.key.length < 1 || input.key.length > 256) {
    throw new RemembraError("INVALID_INPUT", "idempotency key is invalid");
  }
  if (typeof input.fingerprint !== "string" || input.fingerprint.length < 1 || input.fingerprint.length > 128) {
    throw new RemembraError("INVALID_INPUT", "idempotency fingerprint is invalid");
  }
}

function validateTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    invalid("claim has an invalid timestamp");
  }
  return value;
}

function parseRecord(value: unknown): StoredRecord {
  if (!isRecord(value)) invalid("claim has an invalid shape");
  const expected = value.state === "completed"
    ? "completedAt,createdAt,fingerprint,format,keyHash,response,scopeHash,state,version"
    : "createdAt,fingerprint,format,keyHash,scopeHash,state,version";
  if (Object.keys(value).sort().join(",") !== expected) invalid("claim has unexpected fields");
  if (value.format !== BATCH_IDEMPOTENCY_FORMAT || value.version !== BATCH_IDEMPOTENCY_VERSION) {
    invalid("claim has an unsupported format");
  }
  if (typeof value.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.scopeHash)) invalid("claim has an invalid scope hash");
  if (typeof value.keyHash !== "string" || !/^[a-f0-9]{64}$/.test(value.keyHash)) invalid("claim has an invalid key hash");
  if (typeof value.fingerprint !== "string" || value.fingerprint.length < 1 || value.fingerprint.length > 128) {
    invalid("claim has an invalid fingerprint");
  }
  if (value.state !== "in_progress" && value.state !== "completed") invalid("claim has an invalid state");
  const record: StoredRecord = {
    format: BATCH_IDEMPOTENCY_FORMAT,
    version: BATCH_IDEMPOTENCY_VERSION,
    scopeHash: value.scopeHash,
    keyHash: value.keyHash,
    fingerprint: value.fingerprint,
    state: value.state,
    createdAt: validateTimestamp(value.createdAt),
  };
  if (value.state === "completed") {
    record.completedAt = validateTimestamp(value.completedAt);
    if (!Object.prototype.hasOwnProperty.call(value, "response")) invalid("completed claim has no response");
    record.response = value.response;
  }
  return record;
}

async function assertSafeDirectory(directory: string, create: boolean): Promise<void> {
  const resolved = path.resolve(directory);
  const filesystemRoot = path.parse(resolved).root;
  const segments = resolved.slice(filesystemRoot.length).split(path.sep).filter(Boolean);
  let current = filesystemRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return;
      await fs.mkdir(current);
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink()) invalid("claim directory must not contain symlinks");
    if (!stat.isDirectory()) invalid("claim path is not a directory");
  }
}

async function inspectFile(filePath: string, maxBytes: number): Promise<"missing" | "file"> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) invalid("claim file must not be a symlink");
    if (!stat.isFile()) invalid("claim path is not a regular file");
    if (stat.size > maxBytes) invalid("claim file is too large");
    return "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function readRecord(filePath: string, maxBytes: number): Promise<StoredRecord | undefined> {
  await assertSafeDirectory(path.dirname(filePath), false);
  if (await inspectFile(filePath, maxBytes) === "missing") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof RemembraError) throw error;
    invalid("claim file is not valid JSON");
  }
  return parseRecord(parsed);
}

async function writeExclusive(filePath: string, record: StoredRecord, maxBytes: number): Promise<void> {
  await assertSafeDirectory(path.dirname(filePath), false);
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) invalid("claim file is too large");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await fs.unlink(filePath).catch(() => {});
    }
    throw error;
  }
  await handle.close();
}

async function replaceAtomically(filePath: string, record: StoredRecord, maxBytes: number): Promise<void> {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) invalid("claim file is too large");
  const parent = path.dirname(filePath);
  await assertSafeDirectory(parent, true);
  const temp = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/** Durable, fail-closed local claim store for V5.4 batch idempotency. */
export class FileBatchIdempotencyStore implements BatchIdempotencyStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;

  constructor(root: string, options: FileBatchIdempotencyStoreOptions = {}) {
    this.root = path.resolve(root);
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1024) {
      throw new RemembraError("INVALID_INPUT", "idempotency maxBytes must be at least 1024");
    }
    if (!Number.isInteger(this.maxAgeMs) || this.maxAgeMs < 60_000) {
      throw new RemembraError("INVALID_INPUT", "idempotency maxAgeMs must be at least 60000");
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 100_000) {
      throw new RemembraError("INVALID_INPUT", "idempotency maxEntries must be between 1 and 100000");
    }
  }

  private filePath(input: BatchIdempotencyInput): string {
    return path.join(this.root, `${digest(input.scope)}.${digest(input.key)}.json`);
  }

  private async prune(): Promise<void> {
    await assertSafeDirectory(this.root, true);
    const now = Date.now();
    let active = 0;
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (entry.name.endsWith(".tmp")) {
        if (!entry.isFile()) invalid("claim directory contains an unsafe temporary entry");
        const tempPath = path.join(this.root, entry.name);
        const stat = await fs.lstat(tempPath);
        if (stat.isSymbolicLink() || !stat.isFile()) invalid("claim directory contains an unsafe temporary entry");
        if (now - stat.mtimeMs > this.maxAgeMs) await fs.unlink(tempPath).catch(() => {});
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile()) invalid("claim directory contains an unsafe entry");
      const filePath = path.join(this.root, entry.name);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) invalid("claim directory contains an unsafe entry");
      if (now - stat.mtimeMs > this.maxAgeMs) {
        const record = await readRecord(filePath, this.maxBytes);
        if (record?.state === "completed") await fs.unlink(filePath).catch(() => {});
        else active++;
      } else {
        active++;
      }
    }
    if (active >= this.maxEntries) invalid("claim capacity is exhausted");
  }

  async claim(input: BatchIdempotencyInput): Promise<BatchIdempotencyClaim> {
    try {
      validateInput(input);
      await this.prune();
      const filePath = this.filePath(input);
      const record: StoredRecord = {
        format: BATCH_IDEMPOTENCY_FORMAT,
        version: BATCH_IDEMPOTENCY_VERSION,
        scopeHash: digest(input.scope),
        keyHash: digest(input.key),
        fingerprint: input.fingerprint,
        state: "in_progress",
        createdAt: new Date().toISOString(),
      };
      try {
        await writeExclusive(filePath, record, this.maxBytes);
        return { status: "fresh" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await readRecord(filePath, this.maxBytes);
      if (!existing) invalid("claim disappeared during acquisition");
      if (existing.fingerprint !== input.fingerprint) {
        throw new RemembraError("CONFLICT", "idempotency key was already used with a different request");
      }
      if (existing.state === "in_progress") {
        throw new RemembraError("SERVICE_UNAVAILABLE", "an identical idempotent request is already in progress");
      }
      return { status: "replay", response: existing.response };
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency claim could not be read or created", { cause: error });
    }
  }

  async complete(input: BatchIdempotencyInput & { response: unknown }): Promise<void> {
    try {
      validateInput(input);
      const filePath = this.filePath(input);
      const existing = await readRecord(filePath, this.maxBytes);
      if (!existing) invalid("claim does not exist");
      if (existing.fingerprint !== input.fingerprint) {
        throw new RemembraError("CONFLICT", "idempotency key was already used with a different request");
      }
      if (existing.state === "completed") return;
      const completed: StoredRecord = {
        ...existing,
        state: "completed",
        completedAt: new Date().toISOString(),
        response: input.response,
      };
      await replaceAtomically(filePath, completed, this.maxBytes);
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "batch idempotency result could not be persisted", { cause: error });
    }
  }
}
