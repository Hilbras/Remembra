import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSignedSnapshotFile, writeSignedSnapshotFile } from "../recovery.js";

const key = Buffer.from("recovery file test key");
const snapshot = {
  format: "remembra-export" as const,
  version: 4,
  exportedAt: "2026-01-01T00:00:00.000Z",
  memories: [{
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    type: "fact" as const,
    content: "recoverable",
    scope: "global",
    tags: [],
    importance: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }],
};

test("signed recovery files are atomically written and verified", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-recovery-"));
  const file = path.join(root, "snapshot.json");
  await writeSignedSnapshotFile(file, snapshot, key);
  const loaded = await readSignedSnapshotFile(file, key);
  assert.equal(loaded.memories[0].content, "recoverable");
  await assert.rejects(() => writeSignedSnapshotFile(file, snapshot, key), /already exists/);
  await writeSignedSnapshotFile(file, snapshot, key, { overwrite: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("recovery readers reject tampering, symlinks, and oversized files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-recovery-invalid-"));
  const file = path.join(root, "snapshot.json");
  await writeSignedSnapshotFile(file, snapshot, key);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  raw.memories[0].content = "tampered";
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => readSignedSnapshotFile(file, key), /signature verification failed/);
  await assert.rejects(() => readSignedSnapshotFile(file, key, { maxBytes: 10 }), /exceeds/);

  const link = path.join(root, "link.json");
  await fs.symlink(file, link);
  await assert.rejects(() => readSignedSnapshotFile(link, key), /symlink/);
  await fs.rm(root, { recursive: true, force: true });
});
