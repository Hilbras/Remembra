import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RemembraError } from "./errors.js";

export const SNAPSHOT_IMPORT_FORMAT = "remembra-snapshot-import" as const;
export const SNAPSHOT_IMPORT_VERSION = 1 as const;
const JOURNAL_SUFFIX = ".snapshot-import-journal.json";
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_PATHS = 100_000;

interface SnapshotImportJournal {
  format: typeof SNAPSHOT_IMPORT_FORMAT;
  version: typeof SNAPSHOT_IMPORT_VERSION;
  phase: "writing";
  paths: string[];
}

export interface SnapshotImportRecoveryResult {
  recovered: boolean;
  rolledBack: number;
}

function invalid(message: string, code: "INVALID_INPUT" | "IO_ERROR" = "INVALID_INPUT"): never {
  throw new RemembraError(code, `snapshot import recovery: ${message}`);
}

function journalPath(root: string): string {
  return `${path.resolve(root)}${JOURNAL_SUFFIX}`;
}

function assertContained(root: string, target: string): string {
  if (!path.isAbsolute(target)) invalid("journal paths must be absolute");
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalid("journal path escapes storage root");
  }
  return resolvedTarget;
}

function normalizePaths(root: string, values: unknown): string[] {
  if (!Array.isArray(values) || values.length > MAX_PATHS) invalid("journal has an invalid path list");
  const journal = journalPath(root);
  return values.map((value) => {
    if (typeof value !== "string") invalid("journal has a non-string path");
    const resolved = assertContained(root, value);
    if (resolved === journal) invalid("journal cannot contain itself");
    return resolved;
  });
}

function parseJournal(value: unknown, root: string): SnapshotImportJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("journal has an invalid shape");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "format,paths,phase,version") invalid("journal has unexpected fields");
  if (record.format !== SNAPSHOT_IMPORT_FORMAT || record.version !== SNAPSHOT_IMPORT_VERSION) {
    invalid("journal has an unsupported format");
  }
  if (record.phase !== "writing") invalid("journal has an invalid phase");
  return {
    format: SNAPSHOT_IMPORT_FORMAT,
    version: SNAPSHOT_IMPORT_VERSION,
    phase: "writing",
    paths: normalizePaths(root, record.paths),
  };
}

async function assertSafeRoot(root: string, create: boolean): Promise<string> {
  const resolved = path.resolve(root);
  if (create) await fs.mkdir(resolved, { recursive: true });
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") invalid("storage root does not exist", "IO_ERROR");
    throw error;
  }
  if (stat.isSymbolicLink()) invalid("storage root must not be a symlink", "IO_ERROR");
  if (!stat.isDirectory()) invalid("storage root is not a directory", "IO_ERROR");
  return resolved;
}

export function snapshotImportJournalPath(root: string): string {
  return journalPath(root);
}

export async function writeSnapshotImportJournal(root: string, paths: readonly string[]): Promise<void> {
  const resolvedRoot = await assertSafeRoot(root, true);
  const normalized = normalizePaths(resolvedRoot, paths);
  const journal: SnapshotImportJournal = {
    format: SNAPSHOT_IMPORT_FORMAT,
    version: SNAPSHOT_IMPORT_VERSION,
    phase: "writing",
    paths: normalized,
  };
  const serialized = `${JSON.stringify(journal)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES) invalid("journal is too large", "IO_ERROR");
  const target = journalPath(resolvedRoot);
  const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink()) invalid("journal target must not be a symlink", "IO_ERROR");
    if (existing && !existing.isFile()) invalid("journal target is not a regular file", "IO_ERROR");
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    if (error instanceof RemembraError) throw error;
    throw new RemembraError("IO_ERROR", "snapshot import journal could not be written", { cause: error });
  }
}

export async function removeSnapshotImportJournal(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const target = journalPath(resolvedRoot);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) invalid("journal target must not be a symlink", "IO_ERROR");
    if (!stat.isFile()) invalid("journal target is not a regular file", "IO_ERROR");
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof RemembraError) throw error;
    throw new RemembraError("IO_ERROR", "snapshot import journal could not be removed", { cause: error });
  }
}

async function readSnapshotImportJournal(root: string): Promise<SnapshotImportJournal | undefined> {
  const resolvedRoot = path.resolve(root);
  try {
    const rootStat = await fs.lstat(resolvedRoot);
    if (rootStat.isSymbolicLink()) invalid("storage root must not be a symlink", "IO_ERROR");
    if (!rootStat.isDirectory()) invalid("storage root is not a directory", "IO_ERROR");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const target = journalPath(resolvedRoot);
  let raw: string;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) invalid("journal target must not be a symlink", "IO_ERROR");
    if (!stat.isFile()) invalid("journal target is not a regular file", "IO_ERROR");
    if (stat.size > MAX_JOURNAL_BYTES) invalid("journal is too large", "IO_ERROR");
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof RemembraError) throw error;
    throw new RemembraError("IO_ERROR", "snapshot import journal could not be read", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("journal is not valid JSON", "IO_ERROR");
  }
  return parseJournal(parsed, resolvedRoot);
}

/** Roll back an import that was interrupted after its journal was published. */
export async function reconcileSnapshotImport(root: string): Promise<SnapshotImportRecoveryResult> {
  const journal = await readSnapshotImportJournal(root);
  if (!journal) return { recovered: false, rolledBack: 0 };
  let rolledBack = 0;
  for (const file of journal.paths) {
    let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new RemembraError("IO_ERROR", "snapshot import target could not be inspected", { cause: error });
    }
    if (stat.isSymbolicLink()) invalid("snapshot import target became a symlink", "IO_ERROR");
    if (!stat.isFile()) invalid("snapshot import target is not a regular file", "IO_ERROR");
    await fs.unlink(file);
    rolledBack++;
  }
  await fs.unlink(journalPath(root)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new RemembraError("IO_ERROR", "snapshot import journal could not be removed", { cause: error });
  });
  return { recovered: true, rolledBack };
}
