import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSignedSnapshot } from "../snapshot-integrity.js";
import { SNAPSHOT_FORMAT } from "../types.js";
import { analyzeTenantSnapshot } from "../tenant-snapshot-migration.js";

const key = Buffer.from("ab".repeat(32), "hex");

async function runMigrationCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js"), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("SEC-SNAPSHOT-001: migration analysis reports tenantless and mixed inputs without writing", () => {
  const tenantless = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: [{
      id: "42345678-1234-4234-8234-123456789abc",
      type: "fact",
      content: "legacy memory",
      scope: "global",
      tags: [],
      importance: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, key);
  const report = analyzeTenantSnapshot(tenantless, key);
  assert.equal(report.total, 1);
  assert.equal(report.tenantless, 1);
  assert.equal(report.tenantBound, 0);
  assert.equal(report.mixed, false);
  assert.deepEqual(report.organizations, []);
  assert.equal(report.requiresExplicitMigration, true);
});

test("SEC-SNAPSHOT-001: migrate analyze CLI emits a report without writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-cli-analyze-"));
  const snapshot = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: [{
      id: "52345678-1234-4234-8234-123456789abc",
      type: "fact",
      content: "legacy CLI memory",
      scope: "global",
      tags: [],
      importance: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, key);
  const input = path.join(root, "snapshot.json");
  await fs.writeFile(input, JSON.stringify(snapshot), { mode: 0o600 });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js"), "migrate", "analyze", input], {
      env: {
        ...process.env,
        REMEMBRA_HOME: path.join(root, "store"),
        REMEMBRA_TENANT_MODE: "legacy",
        REMEMBRA_SNAPSHOT_KEY: key.toString("hex"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  try {
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { total: number; requiresExplicitMigration: boolean };
    assert.equal(report.total, 1);
    assert.equal(report.requiresExplicitMigration, true);
    assert.equal(await fs.stat(path.join(root, "store", "data.sqlite")).then(() => true, () => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-SNAPSHOT-001: migrate plan/apply CLI is explicit, target-bound, and dry-runnable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v501-cli-migrate-"));
  const snapshot = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: [{
      id: "62345678-1234-4234-8234-123456789abc",
      type: "fact",
      content: "legacy apply memory",
      scope: "global",
      tags: [],
      importance: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, key);
  const input = path.join(root, "snapshot.json");
  const planPath = path.join(root, "migration-plan.json");
  const exportPath = path.join(root, "export.json");
  await fs.writeFile(input, JSON.stringify(snapshot), { mode: 0o600 });
  const env = {
    REMEMBRA_HOME: path.join(root, "store"),
    REMEMBRA_TENANT_MODE: "strict",
    REMEMBRA_TENANT_ID: "org-a",
    REMEMBRA_TENANT_MEMBERSHIP_VERSION: "membership-1",
    REMEMBRA_SNAPSHOT_KEY: key.toString("hex"),
  };
  try {
    const planned = await runMigrationCli(
      ["migrate", "plan", input, "--out", planPath, "--source-namespace", "legacy-root"],
      env,
    );
    assert.equal(planned.code, 0, planned.stderr);
    assert.equal(await fs.stat(planPath).then(() => true, () => false), true);
    const originalPlan = JSON.parse(await fs.readFile(planPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(planPath, JSON.stringify({ ...originalPlan, targetOrganizationId: "org-b" }), { mode: 0o600 });
    const tampered = await runMigrationCli(["migrate", "apply", input, "--plan", planPath], env);
    assert.notEqual(tampered.code, 0, "tampered plans must be rejected");
    await fs.writeFile(planPath, JSON.stringify(originalPlan), { mode: 0o600 });

    const dryRun = await runMigrationCli(
      ["migrate", "apply", input, "--plan", planPath, "--dry-run"],
      env,
    );
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.equal((JSON.parse(dryRun.stdout) as { dryRun: boolean }).dryRun, true);

    const applied = await runMigrationCli(
      ["migrate", "apply", input, "--plan", planPath],
      env,
    );
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal((JSON.parse(applied.stdout) as { imported: number }).imported, 1);
    const retry = await runMigrationCli(["migrate", "apply", input, "--plan", planPath], env);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal((JSON.parse(retry.stdout) as { imported: number; skipped: number }).imported, 0);
    assert.equal((JSON.parse(retry.stdout) as { skipped: number }).skipped, 1);

    const exported = await runMigrationCli(["export", exportPath], env);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, /Exported 1 memories/);
    const exportedSnapshot = JSON.parse(await fs.readFile(exportPath, "utf8")) as { memories: unknown[] };
    assert.equal(exportedSnapshot.memories.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
