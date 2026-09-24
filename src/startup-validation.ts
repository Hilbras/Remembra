import { randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { RemembraError } from "./errors.js";
import { loadMemoryPolicy, type MemoryPolicy } from "./policy.js";
import { isTenantContext, type TenantContext, type TenantMode } from "./tenant.js";

export interface StartupCheck {
  name: string;
  ok: true;
}

export interface StartupConfiguration {
  policy: MemoryPolicy;
  snapshotKey?: Buffer;
  embeddingProvider: "openai" | "ollama" | "none";
  llmProvider: "openai" | "anthropic" | "ollama";
  degraded: boolean;
  checks: readonly StartupCheck[];
}

export interface StartupConfigurationInput {
  env?: NodeJS.ProcessEnv;
  tenantMode: TenantMode;
  tenant?: TenantContext;
  policy?: MemoryPolicy;
}

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `startup validation: ${message}`);
}

function checked(checks: StartupCheck[], name: string): void {
  checks.push({ name, ok: true });
}

function validateNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  integer: boolean,
): void {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    invalid(`${name} must be a finite ${integer ? "integer" : "number"} >= ${minimum}`);
  }
}

function validateProviderNames(env: NodeJS.ProcessEnv): {
  embeddingProvider: "openai" | "ollama" | "none";
  llmProvider: "openai" | "anthropic" | "ollama";
} {
  const embedding = (env.REMEMBRA_EMBEDDINGS ?? "none").trim().toLowerCase();
  if (embedding !== "openai" && embedding !== "ollama" && embedding !== "none") {
    invalid(`REMEMBRA_EMBEDDINGS must be one of openai|ollama|none`);
  }
  const llm = (env.REMEMBRA_LLM ?? "openai").trim().toLowerCase();
  if (llm !== "openai" && llm !== "anthropic" && llm !== "ollama") {
    invalid("REMEMBRA_LLM must be one of openai|anthropic|ollama");
  }
  validateNumber(env, "REMEMBRA_PROVIDER_TIMEOUT_MS", 1, false);
  validateNumber(env, "REMEMBRA_PROVIDER_RETRIES", 0, true);
  validateNumber(env, "REMEMBRA_PROVIDER_BUDGET_MS", 1, false);
  validateNumber(env, "REMEMBRA_PROVIDER_BACKOFF_MS", 0, false);
  return { embeddingProvider: embedding, llmProvider: llm };
}

function validateKey(env: NodeJS.ProcessEnv, name: string): Buffer | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(value)) invalid(`${name} must be 64 hexadecimal characters`);
  return Buffer.from(value, "hex");
}

/** Validate trusted configuration before any storage mutation or listener creation. */
export function validateStartupConfiguration(input: StartupConfigurationInput): StartupConfiguration {
  const env = input.env ?? process.env;
  const checks: StartupCheck[] = [];
  const policy = input.policy ?? loadMemoryPolicy({ env });
  checked(checks, "policy");

  const providers = validateProviderNames(env);
  checked(checks, "provider configuration");

  const snapshotKey = validateKey(env, "REMEMBRA_SNAPSHOT_KEY");
  checked(checks, "snapshot configuration");
  validateKey(env, "REMEMBRA_ENCRYPT_KEY");
  checked(checks, "encryption configuration");

  if (input.tenantMode === "strict") {
    if (!input.tenant || !isTenantContext(input.tenant)) {
      invalid("strict tenant mode requires a trusted tenant context");
    }
  } else if (input.tenant && !isTenantContext(input.tenant)) {
    invalid("tenant context is malformed");
  }
  checked(checks, "tenant configuration");

  return {
    policy,
    ...(snapshotKey ? { snapshotKey } : {}),
    ...providers,
    degraded: false,
    checks,
  };
}

async function ensureSafePathComponents(target: string): Promise<void> {
  const root = path.parse(target).root;
  const relative = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of relative) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) invalid(`storage path component is a symlink: ${current}`);
      if (!stat.isDirectory()) invalid(`storage path component is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
}

async function assertRegularIfPresent(filePath: string, label: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) invalid(`${label} must not be a symlink`);
    if (!stat.isFile()) invalid(`${label} must be a regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** Validate/create the storage root and perform a no-secret write probe. */
export async function validateStorageRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  await ensureSafePathComponents(resolved);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) invalid("storage root is not a safe directory");
  await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);

  await assertRegularIfPresent(path.join(resolved, "data.sqlite"), "SQLite database");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await assertRegularIfPresent(path.join(resolved, `data.sqlite${suffix}`), `SQLite sidecar ${suffix}`);
  }

  const probe = path.join(resolved, `.remembra-startup-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(probe, "wx", 0o600);
    await handle.writeFile("startup probe\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    throw new RemembraError("SERVICE_UNAVAILABLE", "storage root is not writable", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(probe).catch(() => {});
  }
  return resolved;
}
