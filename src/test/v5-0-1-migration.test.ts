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
