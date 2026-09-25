import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemembraError } from "../errors.js";
import { createTenantContext } from "../tenant.js";
import { validateStartupConfiguration, validateStorageRoot } from "../startup-validation.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { StoreInput } from "../types.js";
import { backupSqlite } from "../sqlite-recovery.js";
import { FileBatchIdempotencyStore } from "../batch-idempotency-store.js";

test("REC-START-001: trusted configuration validates without requiring provider keys", () => {
  const config = validateStartupConfiguration({
    env: { REMEMBRA_EMBEDDINGS: "none", REMEMBRA_LLM: "ollama" },
    tenantMode: "legacy",
  });
  assert.equal(config.embeddingProvider, "none");
  assert.equal(config.llmProvider, "ollama");
  assert.equal(config.degraded, false);
  assert.equal(config.checks.some((check) => check.name === "provider configuration"), true);
});

test("REC-START-001: invalid provider, numeric, and key configuration fails before serving", () => {
  for (const env of [
    { REMEMBRA_EMBEDDINGS: "unknown" },
    { REMEMBRA_PROVIDER_TIMEOUT_MS: "not-a-number" },
    { REMEMBRA_PROVIDER_RETRIES: "1.5" },
    { REMEMBRA_ENCRYPT_KEY: "short" },
    { REMEMBRA_SNAPSHOT_KEY: "not-hex" },
  ]) {
    assert.throws(
      () => validateStartupConfiguration({ env, tenantMode: "legacy" }),
      (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
    );
  }
});

test("REC-START-001: strict startup requires a trusted tenant context", () => {
  assert.throws(
    () => validateStartupConfiguration({ env: {}, tenantMode: "strict" }),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
  const tenant = createTenantContext({
    organizationId: "org-a",
    membershipVersion: "membership-1",
    capabilities: ["tenant:read"],
  });
  assert.doesNotThrow(() => validateStartupConfiguration({ env: {}, tenantMode: "strict", tenant }));
});

test("REC-START-001: storage validation creates a safe root, probes writes, and rejects symlinks", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-startup-"));
  const root = path.join(parent, "nested", "store");
  try {
    assert.equal(await validateStorageRoot(root), path.resolve(root));
    assert.equal((await fs.lstat(root)).isDirectory(), true);
    const outside = path.join(parent, "outside.sqlite");
    await fs.writeFile(outside, "database");
    await fs.symlink(outside, path.join(root, "data.sqlite"));
    await assert.rejects(() => validateStorageRoot(root), /must not be a symlink/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function baseEnv(root: string): Record<string, string> {
  return {
    REMEMBRA_HOME: root,
    REMEMBRA_TENANT_MODE: "legacy",
    REMEMBRA_EMBEDDINGS: "none",
    REMEMBRA_LLM: "ollama",
  };
}

test("REC-START-001: an unusable existing idempotency ledger fails normal startup closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-bad-ledger-"));
  const claims = path.join(root, ".idempotency");
  await fs.mkdir(claims, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(claims, "unrelated.txt"), "not a ledger", { mode: 0o600 });
  try {
    const result = await runCli(["audit", "1"], baseEnv(root));
    assert.notEqual(result.code, 0);
    assert.equal(await fs.stat(path.join(root, "data.sqlite")).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-ATOMIC-001: a rejected restore command does not leave a durable gate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-rejected-restore-"));
  try {
    const result = await runCli(["restore", path.join(root, "missing.sqlite")], baseEnv(root));
    assert.notEqual(result.code, 0);
    assert.equal(
      await fs.stat(path.join(root, ".idempotency", "restore.pending")).then(() => true, () => false),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-ATOMIC-001: recover verify reconciles an interrupted SQLite restore before verification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-verify-interrupted-"));
  const staged = path.join(root, ".data.sqlite.staged");
  const rollback = path.join(root, "data.sqlite.pre-restore");
  const backend = new SqliteBackend({ root });
  await backend.store(StoreInput.parse({ type: "fact", content: "survives interrupted restore" }));
  const dbPath = backend.getDbPath();
  backend.close();
  await backupSqlite(dbPath, staged);
  await fs.rename(dbPath, rollback);
  await fs.writeFile(`${dbPath}.restore-journal.json`, JSON.stringify({
    format: "remembra-sqlite-restore",
    version: 1,
    target: dbPath,
    temp: staged,
    rollback,
    phase: "previous-moved",
  }), { mode: 0o600 });
  const ledger = new FileBatchIdempotencyStore(path.join(root, ".idempotency"));
  await ledger.beginRestore();
  ledger.close();
  try {
    const result = await runCli(["recover", "verify"], baseEnv(root));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"verified":true/);
    const recovered = new SqliteBackend({ root });
    try {
      assert.equal((await recovered.all(true)).length, 1);
      assert.equal((await recovered.all(true))[0]?.content, "survives interrupted restore");
    } finally {
      recovered.close();
    }
    assert.equal(await fs.stat(`${dbPath}.restore-journal.json`).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(root, ".idempotency", "restore.pending")).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-START-001: invalid configuration fails before legacy storage is migrated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-cli-startup-"));
  const legacyDir = path.join(root, "global");
  const legacyFile = path.join(legacyDir, "abcdef12.md");
  await fs.mkdir(legacyDir);
  await fs.writeFile(legacyFile, [
    "---",
    "id: abcdef12",
    "type: fact",
    "scope: global",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "---",
    "legacy memory",
    "",
  ].join("\n"));
  try {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        REMEMBRA_HOME: root,
        REMEMBRA_TENANT_MODE: "legacy",
        REMEMBRA_EMBEDDINGS: "none",
        REMEMBRA_LLM: "ollama",
        REMEMBRA_ENCRYPT_KEY: "invalid-startup-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
    assert.notEqual(code, 0);
    assert.match(stderr, /startup validation/);
    assert.equal(await fs.stat(path.join(root, "data.sqlite")).then(() => true, () => false), false);
    assert.equal((await fs.lstat(legacyFile)).isFile(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
