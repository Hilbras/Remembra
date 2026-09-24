import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemembraError } from "../errors.js";
import { createTenantContext } from "../tenant.js";
import { validateStartupConfiguration, validateStorageRoot } from "../startup-validation.js";

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
