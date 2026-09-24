import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RemembraError } from "./errors.js";
import type { RecoveryEvent, RecoveryState } from "./recovery-state.js";

export const RECOVERY_STATE_FORMAT = "remembra-recovery-state" as const;
export const RECOVERY_STATE_VERSION = 1 as const;

export interface RecoveryStateStore {
  /** Return the last durable state, or undefined when no state has been recorded. */
  read(): Promise<RecoveryState | undefined>;
  /** Persist one transition through an atomic same-directory replacement. */
  write(state: RecoveryState, event: RecoveryEvent): Promise<void>;
}

export interface FileRecoveryStateStoreOptions {
  /** Maximum state-file size accepted by readers. */
  maxBytes?: number;
}

interface RecoveryStateRecord {
  format: typeof RECOVERY_STATE_FORMAT;
  version: typeof RECOVERY_STATE_VERSION;
  state: RecoveryState;
  event: RecoveryEvent;
  updatedAt: string;
}

const STATES = new Set<RecoveryState>(["Healthy", "Degraded", "Recovering", "Failed", "ReadOnly"]);
const EVENTS = new Set<RecoveryEvent>([
  "ready",
  "verified",
  "degraded",
  "storage_error",
  "recovery_started",
  "read_only",
  "failed",
]);

function invalid(message: string): never {
  throw new RemembraError("SERVICE_UNAVAILABLE", `recovery state: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): RecoveryStateRecord {
  if (!isRecord(value)) invalid("state file has an invalid shape");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "event,format,state,updatedAt,version") {
    invalid("state file has unexpected fields");
  }
  if (value.format !== RECOVERY_STATE_FORMAT || value.version !== RECOVERY_STATE_VERSION) {
    invalid("state file has an unsupported format");
  }
  if (typeof value.state !== "string" || !STATES.has(value.state as RecoveryState)) {
    invalid("state file has an invalid state");
  }
  if (typeof value.event !== "string" || !EVENTS.has(value.event as RecoveryEvent)) {
    invalid("state file has an invalid event");
  }
  if (typeof value.updatedAt !== "string" || value.updatedAt.length < 1 || value.updatedAt.length > 64) {
    invalid("state file has an invalid timestamp");
  }
  if (!Number.isFinite(Date.parse(value.updatedAt))) invalid("state file has an invalid timestamp");
  return {
    format: RECOVERY_STATE_FORMAT,
    version: RECOVERY_STATE_VERSION,
    state: value.state as RecoveryState,
    event: value.event as RecoveryEvent,
    updatedAt: value.updatedAt,
  };
}

async function assertSafeParent(parent: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(parent, { recursive: true });
  const resolved = path.resolve(parent);
  const filesystemRoot = path.parse(resolved).root;
  const segments = resolved.slice(filesystemRoot.length).split(path.sep).filter(Boolean);
  let current = filesystemRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) invalid("state parent must not contain symlinks");
    if (!stat.isDirectory()) invalid("state parent is not a directory");
  }
}

async function inspectTarget(filePath: string, maxBytes: number): Promise<"missing" | "file"> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) invalid("state file must not be a symlink");
    if (!stat.isFile()) invalid("state path is not a regular file");
    if (stat.size > maxBytes) invalid("state file is too large");
    return "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** A small, strict, atomically replaced recovery-state file. */
export class FileRecoveryStateStore implements RecoveryStateStore {
  private readonly filePath: string;
  private readonly maxBytes: number;

  constructor(filePath: string, options: FileRecoveryStateStoreOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.maxBytes = options.maxBytes ?? 16 * 1024;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 256) {
      throw new RemembraError("INVALID_INPUT", "recovery state maxBytes must be at least 256");
    }
  }

  async read(): Promise<RecoveryState | undefined> {
    try {
      await assertSafeParent(path.dirname(this.filePath), false);
      const target = await inspectTarget(this.filePath, this.maxBytes);
      if (target === "missing") return undefined;
      const raw = await fs.readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        invalid("state file is not valid JSON");
      }
      return parseRecord(parsed).state;
    } catch (error) {
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "recovery state could not be read", { cause: error });
    }
  }

  async write(state: RecoveryState, event: RecoveryEvent): Promise<void> {
    if (!STATES.has(state) || !EVENTS.has(event)) invalid("transition is outside the recovery vocabulary");
    const record: RecoveryStateRecord = {
      format: RECOVERY_STATE_FORMAT,
      version: RECOVERY_STATE_VERSION,
      state,
      event,
      updatedAt: new Date().toISOString(),
    };
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) invalid("state file is too large");

    const parent = path.dirname(this.filePath);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const temp = path.join(parent, `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await assertSafeParent(parent, true);
      const existing = await inspectTarget(this.filePath, this.maxBytes);
      if (existing === "file") {
        // Do not follow or replace a path that changed type between checks.
        const stat = await fs.lstat(this.filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) invalid("state path is not a regular file");
      }
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      if (error instanceof RemembraError) throw error;
      throw new RemembraError("SERVICE_UNAVAILABLE", "recovery state could not be written", { cause: error });
    }
  }
}
