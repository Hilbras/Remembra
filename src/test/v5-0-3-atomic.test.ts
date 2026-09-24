import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteBackend } from "../sqlite-backend.js";
import { backupSqlite, reconcileSqliteRestore } from "../sqlite-recovery.js";
import { StoreInput } from "../types.js";

async function fixture(): Promise<{
  root: string;
  backupPath: string;
  targetPath: string;
  rollbackPath: string;
  tempPath: string;
  newId: string;
  oldId: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-atomic-"));
  const sourceRoot = path.join(root, "source");
  await fs.mkdir(sourceRoot, { recursive: true });
  const source = new SqliteBackend({ root: sourceRoot });
  const newMemory = await source.store(StoreInput.parse({ type: "fact", content: "new verified database" }));
  source.close();
  const backupPath = path.join(root, "backup.sqlite");
  await backupSqlite(source.getDbPath(), backupPath);

  const targetPath = path.join(root, "target", "data.sqlite");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const target = new SqliteBackend({ dbPath: targetPath });
  const oldMemory = await target.store(StoreInput.parse({ type: "fact", content: "previous verified database" }));
  target.close();
  return {
    root,
    backupPath,
    targetPath,
    rollbackPath: `${targetPath}.pre-restore`,
    tempPath: `${targetPath}.restore-staged`,
    newId: newMemory.id,
    oldId: oldMemory.id,
  };
}

async function writeJournal(values: { targetPath: string; tempPath: string; rollbackPath: string }): Promise<void> {
  await fs.writeFile(`${values.targetPath}.restore-journal.json`, JSON.stringify({
    format: "remembra-sqlite-restore",
    version: 1,
    target: values.targetPath,
    temp: values.tempPath,
    rollback: values.rollbackPath,
    phase: "previous-moved",
  }), { mode: 0o600 });
}

test("REC-ATOMIC-001: startup reconciliation publishes a verified staged restore", async () => {
  const fixtureValue = await fixture();
  try {
    await fs.copyFile(fixtureValue.backupPath, fixtureValue.tempPath);
    await fs.rename(fixtureValue.targetPath, fixtureValue.rollbackPath);
    await writeJournal(fixtureValue);
    const result = await reconcileSqliteRestore(fixtureValue.targetPath);
    assert.equal(result.action, "published-staged");
    const store = new SqliteBackend({ dbPath: fixtureValue.targetPath });
    assert.equal((await store.get(fixtureValue.newId))?.content, "new verified database");
    store.close();
    assert.equal(await fs.stat(`${fixtureValue.targetPath}.restore-journal.json`).then(() => true, () => false), false);
    assert.equal((await fs.lstat(fixtureValue.rollbackPath)).isFile(), true);
  } finally {
    await fs.rm(fixtureValue.root, { recursive: true, force: true });
  }
});

test("REC-ATOMIC-001: startup reconciliation restores the retained previous database when staging is gone", async () => {
  const fixtureValue = await fixture();
  try {
    await fs.rename(fixtureValue.targetPath, fixtureValue.rollbackPath);
    await writeJournal({ ...fixtureValue, tempPath: `${fixtureValue.targetPath}.missing` });
    const result = await reconcileSqliteRestore(fixtureValue.targetPath);
    assert.equal(result.action, "restored-previous");
    const store = new SqliteBackend({ dbPath: fixtureValue.targetPath });
    assert.equal((await store.get(fixtureValue.oldId))?.content, "previous verified database");
    store.close();
    assert.equal(await fs.stat(`${fixtureValue.targetPath}.restore-journal.json`).then(() => true, () => false), false);
  } finally {
    await fs.rm(fixtureValue.root, { recursive: true, force: true });
  }
});
