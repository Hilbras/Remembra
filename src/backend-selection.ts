import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryStore } from "./store.js";
import { SqliteBackend } from "./sqlite-backend.js";
import { logEvent } from "./log.js";

export type InitialBackendName = "sqlite" | "file";

export interface InitialBackendSelection {
  store: SqliteBackend | MemoryStore;
  backend: InitialBackendName;
  fallback: boolean;
}

async function ensureStorageRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    existing = await fs.lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) throw new Error("storage root must not be a symlink");
  if (existing && !existing.isDirectory()) throw new Error("storage root must be a directory");
  if (!existing) await fs.mkdir(resolved, { recursive: true });
  const after = await fs.lstat(resolved);
  if (after.isSymbolicLink() || !after.isDirectory()) throw new Error("storage root is not a safe directory");
  return resolved;
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length <= 64) return code;
  }
  if (error instanceof Error && error.name) return error.name.slice(0, 64);
  return "unknown";
}

/** Select the durable backend before any service or transport is exposed. */
export async function selectInitialBackend(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InitialBackendSelection> {
  const resolvedRoot = await ensureStorageRoot(root);
  try {
    const store = new SqliteBackend({ root: resolvedRoot });
    try {
      await store.ready();
      return { store, backend: "sqlite", fallback: false };
    } catch (error) {
      store.close();
      throw error;
    }
  } catch (error) {
    if (env.REMEMBRA_ALLOW_FILE_FALLBACK !== "1") {
      throw new Error(`SQLite backend unavailable (${safeErrorCode(error)})`, { cause: error });
    }
    logEvent(
      "warn",
      "storage.fallback",
      { backend: "file", fallback: true, error: safeErrorCode(error) },
      "SQLite backend unavailable; file backend explicitly enabled",
    );
    return { store: new MemoryStore(resolvedRoot), backend: "file", fallback: true };
  }
}
