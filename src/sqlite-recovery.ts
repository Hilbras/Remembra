import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { RemembraError } from "./errors.js";
import { SCHEMA_VERSION } from "./types.js";

export interface SqliteRecoveryOptions {
  /** Reject unexpectedly large backup files before opening them. */
  maxBytes?: number;
  /** Permit replacement of an existing regular target. */
  overwrite?: boolean;
}

interface SqliteVerification {
  schemaVersion: number;
  integrity: "ok";
}

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `sqlite recovery: ${message}`);
}

function resolvedDifferent(left: string, right: string, label: string): void {
  if (path.resolve(left) === path.resolve(right)) invalid(`${label} must be different`);
}

async function inspectPath(filePath: string, label: string, maxBytes?: number): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) invalid(`${label} must not be a symlink`);
  if (!stat.isFile()) invalid(`${label} must be a regular file`);
  if (maxBytes !== undefined && stat.size > maxBytes) invalid(`${label} exceeds ${maxBytes} bytes`);
}

async function assertTarget(filePath: string, overwrite: boolean): Promise<void> {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) invalid("refusing to use a symlink target");
    if (!stat.isFile()) invalid("target is not a regular file");
    if (!overwrite) invalid("target already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function openVerified(filePath: string): { db: Database.Database; verification: SqliteVerification } {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") invalid(`integrity_check failed: ${integrity}`);
    const schemaVersion = Number(db.pragma("user_version", { simple: true }));
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) invalid("database has no valid schema version");
    if (schemaVersion > SCHEMA_VERSION) invalid(`database schema ${schemaVersion} is newer than supported ${SCHEMA_VERSION}`);
    const memories = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
    if (!memories) invalid("database is missing the memories table");
    return { db, verification: { schemaVersion, integrity: "ok" } };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Verify a standalone SQLite backup without mutating it. */
export async function verifySqliteBackup(
  filePath: string,
  options: Pick<SqliteRecoveryOptions, "maxBytes"> = {},
): Promise<SqliteVerification> {
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) invalid("maxBytes is out of range");
  await inspectPath(path.resolve(filePath), "backup", maxBytes);
  const opened = openVerified(path.resolve(filePath));
  try {
    return opened.verification;
  } finally {
    opened.db.close();
  }
}

/** Create a consistent standalone SQLite backup and publish it atomically. */
export async function backupSqlite(
  sourcePath: string,
  backupPath: string,
  options: SqliteRecoveryOptions = {},
): Promise<{ path: string; schemaVersion: number }> {
  const source = path.resolve(sourcePath);
  const target = path.resolve(backupPath);
  resolvedDifferent(source, target, "source and backup paths");
  await inspectPath(source, "SQLite source");
  await assertTarget(target, options.overwrite ?? false);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let db: Database.Database | undefined;
  try {
    db = new Database(source, { readonly: true, fileMustExist: true });
    await db.backup(temp);
    db.close();
    db = undefined;
    await fs.chmod(temp, 0o600);
    const verification = await verifySqliteBackup(temp, { maxBytes: options.maxBytes });
    const handle = await fs.open(temp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    return { path: target, schemaVersion: verification.schemaVersion };
  } catch (error) {
    db?.close();
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Restore a verified standalone backup by same-directory rename. The target
 * service must be closed first; active SQLite sidecars are rejected rather than
 * being silently mixed with the published file.
 */
export async function restoreSqliteBackup(
  backupPath: string,
  targetPath: string,
  options: SqliteRecoveryOptions = {},
): Promise<{ path: string; schemaVersion: number }> {
  const source = path.resolve(backupPath);
  const target = path.resolve(targetPath);
  resolvedDifferent(source, target, "backup and target paths");
  const verification = await verifySqliteBackup(source, { maxBytes: options.maxBytes });
  await assertTarget(target, options.overwrite ?? false);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${target}${suffix}`;
    try {
      await inspectPath(sidecar, `target sidecar ${suffix}`);
      invalid(`target has an active SQLite sidecar (${suffix}); close/checkpoint the database first`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.copyFile(source, temp);
    await fs.chmod(temp, 0o600);
    await verifySqliteBackup(temp, { maxBytes: options.maxBytes });
    const handle = await fs.open(temp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    return { path: target, schemaVersion: verification.schemaVersion };
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}
