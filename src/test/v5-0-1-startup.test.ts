import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectInitialBackend } from "../backend-selection.js";
import { MemoryService } from "../service.js";

async function tempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("SEC-STORAGE-001: a missing root is created and SQLite remains the default backend", async () => {
  const parent = await tempRoot("remembra-v501-root-");
  const root = path.join(parent, "nested", "store");
  const selection = await selectInitialBackend(root, {});
  try {
    assert.equal(selection.backend, "sqlite");
    assert.equal(selection.fallback, false);
    assert.equal((await fs.lstat(root)).isDirectory(), true);
    if ("close" in selection.store) selection.store.close();
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("SEC-STORAGE-001: corrupt SQLite fails closed without writing a file backend", async () => {
  const root = await tempRoot("remembra-v501-corrupt-");
  await fs.writeFile(path.join(root, "data.sqlite"), "not a sqlite database");
  await assert.rejects(
    () => selectInitialBackend(root, {}),
    /SQLite backend unavailable/i,
  );
  assert.equal(await fs.stat(path.join(root, "global")).then(() => true, () => false), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("SEC-STORAGE-001: file fallback requires explicit opt-in and is observable", async () => {
  const root = await tempRoot("remembra-v501-fallback-");
  await fs.writeFile(path.join(root, "data.sqlite"), "not a sqlite database");
  const selection = await selectInitialBackend(root, { REMEMBRA_ALLOW_FILE_FALLBACK: "1" });
  try {
    assert.equal(selection.backend, "file");
    assert.equal(selection.fallback, true);
    const health = await new MemoryService(selection.store, {
      embeddingProvider: "none",
      backend: selection.backend,
      backendFallback: selection.fallback,
    }).health();
    assert.equal(health.backend, "file");
    assert.equal(health.fallback, true);
    assert.equal(health.state, "Degraded");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-STORAGE-001: backend selection waits for legacy migration readiness", async () => {
  const root = await tempRoot("remembra-v501-migration-ready-");
  await fs.mkdir(path.join(root, "global"), { recursive: true });
  await fs.writeFile(path.join(root, "global", "abcdef12.md"), [
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
  const selection = await selectInitialBackend(root, {});
  try {
    assert.equal((await selection.store.all()).length, 1);
  } finally {
    if ("close" in selection.store) selection.store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});