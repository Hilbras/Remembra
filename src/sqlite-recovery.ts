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
  /** Retain the replaced target at rollbackPath for explicit rollback. */
  keepPrevious?: boolean;
  rollbackPath?: string;
}

interface SqliteVerification {
  schemaVersion: number;
  integrity: "ok";
}

export interface SqliteRestoreResult {
  path: string;
  schemaVersion: number;
  rollbackPath?: string;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    await inspectPath(filePath, "SQLite target");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const RESTORE_JOURNAL_SUFFIX = ".restore-journal.json";
type RestoreJournalPhase = "prepared" | "previous-moved";

interface RestoreJournal {
  format: "remembra-sqlite-restore";
  version: 1;
  target: string;
  temp: string;
  rollback: string;
  phase: RestoreJournalPhase;
}

function restoreJournalPath(targetPath: string): string {
  return `${path.resolve(targetPath)}${RESTORE_JOURNAL_SUFFIX}`;
}

async function writeRestoreJournal(journal: RestoreJournal): Promise<void> {
  const journalPath = restoreJournalPath(journal.target);
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const temp = `${journalPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(journal), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, journalPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function removeRestoreJournal(targetPath: string): Promise<void> {
  await fs.unlink(restoreJournalPath(targetPath)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function readRestoreJournal(targetPath: string): Promise<RestoreJournal | undefined> {
  const journalPath = restoreJournalPath(targetPath);
  let raw: string;
  try {
    const stat = await fs.lstat(journalPath);
    if (stat.isSymbolicLink()) invalid("restore journal must not be a symlink");
    if (!stat.isFile()) invalid("restore journal must be a regular file");
    if (stat.size > 64 * 1024) invalid("restore journal is too large");
    raw = await fs.readFile(journalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("restore journal is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") invalid("restore journal has an invalid shape");
  const value = parsed as Record<string, unknown>;
  if (value.format !== "remembra-sqlite-restore" || value.version !== 1) invalid("restore journal has an invalid format");
  if (typeof value.target !== "string" || typeof value.temp !== "string" || typeof value.rollback !== "string") {
    invalid("restore journal has invalid paths");
  }
  if (value.phase !== "prepared" && value.phase !== "previous-moved") invalid("restore journal has an invalid phase");
  const target = path.resolve(value.target);
  const directory = path.dirname(target);
  if (path.resolve(value.temp) === target || path.resolve(value.rollback) === target) invalid("restore journal paths must be distinct");
  if (path.dirname(path.resolve(value.temp)) !== directory || path.dirname(path.resolve(value.rollback)) !== directory) {
    invalid("restore journal paths must share the target directory");
  }
  return {
    format: "remembra-sqlite-restore",
    version: 1,
    target,
    temp: path.resolve(value.temp),
    rollback: path.resolve(value.rollback),
    phase: value.phase,
  };
}

/** Complete or roll back a restore left between its publication renames. */
export async function reconcileSqliteRestore(targetPath: string): Promise<{
  recovered: boolean;
  action: "none" | "kept-target" | "published-staged" | "restored-previous";
}> {
  const journal = await readRestoreJournal(targetPath);
  if (!journal) return { recovered: false, action: "none" };

  let targetExists = await regularFileExists(journal.target);
  const tempExists = await regularFileExists(journal.temp);
  const rollbackExists = await regularFileExists(journal.rollback);

  if (targetExists && journal.phase === "prepared") {
    if (rollbackExists) {
      await verifySqliteBackup(journal.target, { maxBytes: undefined });
      await fs.unlink(journal.temp).catch(() => {});
      await removeRestoreJournal(journal.target);
      return { recovered: true, action: "kept-target" };
    }
    await fs.rename(journal.target, journal.rollback);
    await syncDirectory(path.dirname(journal.target));
    targetExists = false;
  }

  if (targetExists) {
    await verifySqliteBackup(journal.target, { maxBytes: undefined });
    await fs.unlink(journal.temp).catch(() => {});
    await removeRestoreJournal(journal.target);
    return { recovered: true, action: "kept-target" };
  }

  if (tempExists) {
    await verifySqliteBackup(journal.temp, { maxBytes: undefined });
    await fs.rename(journal.temp, journal.target);
    await syncDirectory(path.dirname(journal.target));
    await verifySqliteBackup(journal.target, { maxBytes: undefined });
    await removeRestoreJournal(journal.target);
    return { recovered: true, action: "published-staged" };
  }

  if (rollbackExists) {
    await verifySqliteBackup(journal.rollback, { maxBytes: undefined });
    await fs.rename(journal.rollback, journal.target);
    await syncDirectory(path.dirname(journal.target));
    await verifySqliteBackup(journal.target, { maxBytes: undefined });
    await removeRestoreJournal(journal.target);
    return { recovered: true, action: "restored-previous" };
  }

  invalid("restore journal has no recoverable database");
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
): Promise<SqliteRestoreResult> {
  const source = path.resolve(backupPath);
  const target = path.resolve(targetPath);
  resolvedDifferent(source, target, "backup and target paths");
  const verification = await verifySqliteBackup(source, { maxBytes: options.maxBytes });
  const targetExists = await regularFileExists(target);
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
  const rollbackPath = options.keepPrevious && targetExists
    ? path.resolve(options.rollbackPath ?? `${target}.pre-restore`)
    : undefined;
  if (rollbackPath) {
    resolvedDifferent(target, rollbackPath, "target and rollback paths");
    await assertTarget(rollbackPath, options.overwrite ?? false);
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let previousMoved = false;
  const journal: RestoreJournal | undefined = rollbackPath
    ? { format: "remembra-sqlite-restore", version: 1, target, temp, rollback: rollbackPath, phase: "prepared" }
    : undefined;
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
    if (journal) await writeRestoreJournal(journal);
    if (rollbackPath) {
      await fs.rename(target, rollbackPath);
      previousMoved = true;
      if (journal) await writeRestoreJournal({ ...journal, phase: "previous-moved" });
    }
    await fs.rename(temp, target);
    await syncDirectory(path.dirname(target));
    if (journal) {
      await verifySqliteBackup(target, { maxBytes: options.maxBytes });
      await removeRestoreJournal(target);
    }
    return { path: target, schemaVersion: verification.schemaVersion, ...(rollbackPath ? { rollbackPath } : {}) };
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    if (previousMoved) {
      const targetStillExists = await regularFileExists(target);
      if (!targetStillExists) await fs.rename(rollbackPath!, target).catch(() => {});
    }
    if (journal) await removeRestoreJournal(target).catch(() => {});
    throw error;
  }
}

/** Restore a retained pre-restore SQLite file after a failed/undesired publication. */
export async function rollbackSqliteBackup(
  rollbackPath: string,
  targetPath: string,
  options: Pick<SqliteRecoveryOptions, "maxBytes" | "overwrite"> = {},
): Promise<SqliteRestoreResult> {
  return restoreSqliteBackup(rollbackPath, targetPath, {
    ...options,
    overwrite: options.overwrite ?? true,
    keepPrevious: false,
  });
}
