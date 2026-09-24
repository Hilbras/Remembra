import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSignedSnapshot } from "../snapshot-integrity.js";
import { SqliteBackend } from "../sqlite-backend.js";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { SNAPSHOT_FORMAT } from "../types.js";

function record(id: string, content: string) {
  return {
    id,
    type: "fact" as const,
    content,
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted" as const,
    owner: "global" as const,
    access: "global" as const,
    provenance: { sourceType: "manual" as const },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("REC-ATOMIC-001: service uses the backend atomic batch import path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-import-"));
  const key = Buffer.from("9a".repeat(32), "hex");
  const backend = new SqliteBackend({ root });
  const service = new MemoryService(backend, { embeddingProvider: "none", snapshotKey: key });
  const snapshot = createSignedSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 3,
    exportedAt: "2026-01-01T00:00:00.000Z",
    memories: [
      record("12345678-1234-4234-8234-123456789abc", "batch one"),
      record("22345678-1234-4234-8234-123456789abc", "batch two"),
    ],
  }, key);
  const originalImport = backend.importMemory.bind(backend);
  (backend as unknown as { importMemory: typeof backend.importMemory }).importMemory = async () => {
    throw new Error("single-record import should not be used");
  };
  try {
    const result = await service.importSnapshot(snapshot);
    assert.deepEqual(result, { imported: 2, skipped: 0 });
    assert.equal((await backend.all()).length, 2);
  } finally {
    (backend as unknown as { importMemory: typeof backend.importMemory }).importMemory = originalImport;
    await service.shutdownBackgroundJobs();
    backend.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-FAIL-001: SQLite batch import rolls back a transaction on injected failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-sqlite-failure-"));
  const backend = new SqliteBackend({ root });
  const originalInsert = (backend as unknown as { insertRow: (memory: unknown) => void }).insertRow.bind(backend);
  let inserts = 0;
  (backend as unknown as { insertRow: (memory: unknown) => void }).insertRow = (memory) => {
    if (inserts++ === 1) throw new Error("injected sqlite transaction failure");
    originalInsert(memory);
  };
  try {
    await assert.rejects(
      () => backend.importBatch([
        record("52345678-1234-4234-8234-123456789abc", "sqlite batch one"),
        record("62345678-1234-4234-8234-123456789abc", "sqlite batch two"),
      ] as never),
      /injected sqlite transaction failure/,
    );
    assert.equal((await backend.all()).length, 0);
  } finally {
    backend.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-FAIL-001: SQLite batch import rolls back SQLITE_FULL without partial rows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-sqlite-full-"));
  let calls = 0;
  const backend = new SqliteBackend({
    root,
    beforeMutation: () => {
      if (calls++ === 1) {
        throw Object.assign(new Error("injected SQLITE_FULL"), { code: "SQLITE_FULL" });
      }
    },
  });
  try {
    await assert.rejects(
      () => backend.importBatch([
        record("72345678-1234-4234-8234-123456789abc", "sqlite full one"),
        record("82345678-1234-4234-8234-123456789abc", "sqlite full two"),
      ] as never),
      (error: unknown) => (error as { code?: string }).code === "SQLITE_FULL",
    );
    assert.equal((await backend.all()).length, 0);
  } finally {
    backend.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const code of ["ENOSPC", "EACCES", "EPERM", "EIO"]) {
  test(`REC-FAIL-001: file batch import rolls back ${code} without partial files`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `remembra-v503-file-${code}-`));
    let writes = 0;
    const backend = new MemoryStore(root, {
      beforeWrite: () => {
        if (writes++ === 1) throw Object.assign(new Error(`injected ${code}`), { code });
      },
    });
    try {
      await assert.rejects(
        () => backend.importBatch([
          record("92345678-1234-4234-8234-123456789abc", "file failure one"),
          record("a2345678-1234-4234-8234-123456789abc", "file failure two"),
        ] as never),
        (error: unknown) => {
          const value = error as { code?: string; message?: string };
          return value.code === "IO_ERROR" && value.message?.includes(`(${code})`) === true;
        },
      );
      assert.equal((await backend.all()).length, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("REC-ATOMIC-001: file batch import rolls back files written before an operational failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v503-file-import-"));
  const backend = new MemoryStore(root);
  const good = record("32345678-1234-4234-8234-123456789abc", "file batch one");
  const bad = record("42345678-1234-4234-8234-123456789abc", "file batch two");
  Object.defineProperty(bad, "scope", { get() { throw new Error("injected file write failure"); } });
  try {
    await assert.rejects(
      () => backend.importBatch([good, bad] as never),
      /injected file write failure/,
    );
    assert.equal((await backend.all()).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
