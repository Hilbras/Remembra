import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../store.js";
import {
  reconcileSnapshotImport,
  snapshotImportJournalPath,
  writeSnapshotImportJournal,
} from "../snapshot-import-recovery.js";

async function temporaryRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("REC-CRASH-001: an interrupted file import is rolled back on the next startup", async () => {
  const root = await temporaryRoot("remembra-v503-import-recovery-");
  const partial = path.join(root, "global", "partial.md");
  await fs.mkdir(path.dirname(partial), { recursive: true });
  await fs.writeFile(partial, "partial import", "utf8");
  try {
    await writeSnapshotImportJournal(root, [partial]);
    const result = await reconcileSnapshotImport(root);
    assert.deepEqual(result, { recovered: true, rolledBack: 1 });
    await assert.rejects(() => fs.stat(partial));
    await assert.rejects(() => fs.stat(snapshotImportJournalPath(root)));
    assert.deepEqual(await reconcileSnapshotImport(root), { recovered: false, rolledBack: 0 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-ATOMIC-001: a successful file batch removes its rollback journal", async () => {
  const root = await temporaryRoot("remembra-v503-import-success-");
  const store = new MemoryStore(root);
  const now = new Date().toISOString();
  try {
    const result = await store.importBatch([
      {
        id: "10000000-0000-4000-8000-000000000001",
        type: "fact",
        content: "successful import one",
        scope: "global",
        tags: [],
        importance: 3,
        confidence: 1,
        trust: "trusted",
        provenance: { sourceType: "manual" },
        owner: "global",
        access: "global",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        type: "fact",
        content: "successful import two",
        scope: "global",
        tags: [],
        importance: 3,
        confidence: 1,
        trust: "trusted",
        provenance: { sourceType: "manual" },
        owner: "global",
        access: "global",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    assert.deepEqual(result, { imported: 2, skipped: 0 });
    assert.equal((await store.all()).length, 2);
    await assert.rejects(() => fs.stat(snapshotImportJournalPath(root)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-CRASH-001: SIGKILL during a file import is rolled back on restart", async () => {
  const root = await temporaryRoot("remembra-v503-import-crash-");
  const storeModule = path.resolve("dist/store.js");
  const childScript = `
    import { pathToFileURL } from "node:url";
    const { MemoryStore } = await import(pathToFileURL(process.env.REMEMBRA_STORE_MODULE));
    const root = process.env.REMEMBRA_CRASH_ROOT;
    const store = new MemoryStore(root, {
      onImportRecord: async ({ index }) => {
        if (index !== 0) return;
        process.send?.("first-record-written");
        await new Promise(() => {});
      },
    });
    const now = new Date().toISOString();
    const memories = Array.from({ length: 3 }, (_, index) => ({
      id: "00000000-0000-4000-8000-00000000000" + (index + 1),
      type: "fact",
      content: "crash import " + index,
      scope: "global",
      tags: [],
      importance: 3,
      confidence: 1,
      trust: "trusted",
      provenance: { sourceType: "manual" },
      owner: "global",
      access: "global",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    await store.importBatch(memories);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    env: {
      ...process.env,
      REMEMBRA_STORE_MODULE: storeModule,
      REMEMBRA_CRASH_ROOT: root,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`import crash child timed out${stderr ? `: ${stderr}` : ""}`));
      }, 10_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("message", () => {
        clearTimeout(timer);
        child.kill("SIGKILL");
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const recovered = new MemoryStore(root);
    try {
      assert.equal((await recovered.all()).length, 0);
      await assert.rejects(() => fs.stat(snapshotImportJournalPath(root)));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
});

test("REC-CRASH-001: recovery never deletes two unparseable twin files", async () => {
  const root = await temporaryRoot("remembra-v503-unparseable-twins-");
  const id = "20000000-0000-4000-8000-000000000001";
  const active = path.join(root, "global", `${id}.md`);
  const archived = path.join(root, "archived", "global", `${id}.md`);
  await fs.mkdir(path.dirname(active), { recursive: true });
  await fs.mkdir(path.dirname(archived), { recursive: true });
  await fs.writeFile(active, "not valid frontmatter", "utf8");
  await fs.writeFile(archived, "not valid frontmatter", "utf8");
  try {
    const store = new MemoryStore(root);
    assert.deepEqual(await store.all(true), []);
    await fs.access(active);
    await fs.access(archived);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("REC-CRASH-001: an out-of-root import journal fails closed", async () => {
  const root = await temporaryRoot("remembra-v503-import-root-");
  const outside = await temporaryRoot("remembra-v503-import-outside-");
  const outsideFile = path.join(outside, "outside.md");
  await fs.writeFile(outsideFile, "must not be removed", "utf8");
  try {
    await assert.rejects(
      () => writeSnapshotImportJournal(root, [outsideFile]),
      (error: unknown) => (error as { code?: string }).code === "INVALID_INPUT",
    );
    assert.equal(await fs.readFile(outsideFile, "utf8"), "must not be removed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
