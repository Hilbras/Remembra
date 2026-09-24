import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createSignedSnapshot, verifySignedSnapshot, type SignedSnapshot } from "./snapshot-integrity.js";
import { SnapshotInput } from "./types.js";

export interface SnapshotFileOptions {
  /** Maximum serialized snapshot size accepted by readers (default 100 MiB). */
  maxBytes?: number;
  /** Replace an existing regular file atomically. Symlinks are never followed. */
  overwrite?: boolean;
}

function invalid(message: string): never {
  throw new Error(`snapshot file: ${message}`);
}

async function assertSafeTarget(filePath: string, overwrite: boolean): Promise<void> {
  const parent = path.dirname(path.resolve(filePath));
  await fs.mkdir(parent, { recursive: true });
  let existing;
  try {
    existing = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (existing.isSymbolicLink()) invalid("refusing to use a symlink target");
  if (!existing.isFile()) invalid("target is not a regular file");
  if (!overwrite) throw new Error("snapshot file already exists");
}

/** Write a canonical signed snapshot through a same-directory temp + rename. */
export async function writeSignedSnapshotFile(
  filePath: string,
  snapshot: unknown,
  key: Buffer | Uint8Array,
  options: SnapshotFileOptions = {},
): Promise<SignedSnapshot> {
  const parsed = SnapshotInput.safeParse(snapshot);
  if (!parsed.success) invalid("snapshot body is invalid");
  const signed = parsed.data.integrity
    ? verifySignedSnapshot(parsed.data, key)
    : createSignedSnapshot(parsed.data, key);
  const target = path.resolve(filePath);
  await assertSafeTarget(target, options.overwrite ?? false);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(signed), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, target);
    return signed;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/** Read a bounded regular file and verify its HMAC before returning records. */
export async function readSignedSnapshotFile(
  filePath: string,
  key: Buffer | Uint8Array,
  options: Pick<SnapshotFileOptions, "maxBytes"> = {},
): Promise<SignedSnapshot> {
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const target = path.resolve(filePath);
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) invalid("refusing to read a symlink");
  if (!stat.isFile()) invalid("target is not a regular file");
  if (stat.size > maxBytes) invalid(`file exceeds ${maxBytes} bytes`);
  const raw = await fs.readFile(target, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("file is not valid JSON");
  }
  return verifySignedSnapshot(parsed, key);
}

export function parseSnapshotForRecovery(value: unknown): ReturnType<typeof SnapshotInput.parse> {
  return SnapshotInput.parse(value);
}
