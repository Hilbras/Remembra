import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteBackend } from "../sqlite-backend.js";
import {
  backupSqlite,
  restoreSqliteBackup,
  verifySqliteBackup,
} from "../sqlite-recovery.js";
import { StoreInput } from "../types.js";

test("SQLite recovery creates a verified backup and atomically restores a closed target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-sqlite-recovery-"));
  const sourceRoot = path.join(root, "source");
  await fs.mkdir(sourceRoot, { recursive: true });
  const source = new SqliteBackend({ root: sourceRoot });
  const tenant = { organizationId: "org-a", projectId: "project-a" };
  const stored = await source.store(StoreInput.parse({ type: "fact", content: "durable sqlite memory", scope: "project/project-a" }), undefined, tenant);
  source.close();
  const sourcePath = source.getDbPath();
  const backupPath = path.join(root, "backup.sqlite");
  const backup = await backupSqlite(sourcePath, backupPath);
  assert.equal(backup.schemaVersion, 3);
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  assert.deepEqual(await verifySqliteBackup(backupPath), { schemaVersion: 3, integrity: "ok" });

  const targetPath = path.join(root, "target", "data.sqlite");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const restored = await restoreSqliteBackup(backupPath, targetPath);
  assert.equal(restored.schemaVersion, 3);
  const reopened = new SqliteBackend({ dbPath: targetPath });
  assert.equal((await reopened.get(stored.id, tenant))?.content, "durable sqlite memory");
  reopened.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("SQLite recovery rejects corruption, symlink targets, and active sidecars", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-sqlite-recovery-invalid-"));
  const sourceRoot = path.join(root, "source");
  await fs.mkdir(sourceRoot, { recursive: true });
  const source = new SqliteBackend({ root: sourceRoot });
  source.close();
  const backupPath = path.join(root, "backup.sqlite");
  await backupSqlite(source.getDbPath(), backupPath);
  const corrupt = path.join(root, "corrupt.sqlite");
  const bytes = await fs.readFile(backupPath);
  bytes[0] = 0;
  await fs.writeFile(corrupt, bytes);
  await assert.rejects(() => verifySqliteBackup(corrupt));

  const targetPath = path.join(root, "target.sqlite");
  const link = path.join(root, "target-link.sqlite");
  await fs.symlink(targetPath, link);
  await assert.rejects(() => restoreSqliteBackup(backupPath, link, { overwrite: true }), /symlink/);
  await fs.writeFile(`${targetPath}-wal`, "active sidecar");
  await assert.rejects(
    () => restoreSqliteBackup(backupPath, targetPath, { overwrite: true }),
    /sidecar/,
  );
  await fs.rm(root, { recursive: true, force: true });
});
