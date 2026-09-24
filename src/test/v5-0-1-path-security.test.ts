import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../store.js";
import { StoreInput } from "../types.js";
import { RemembraError } from "../errors.js";

async function tempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("SEC-PATH-001: history rejects traversal and separator IDs", async () => {
  const root = await tempRoot("remembra-v501-path-");
  const store = new MemoryStore(root);
  const memory = await store.store(StoreInput.parse({ type: "fact", content: "private history" }));
  const invalidIds = ["", ".", "..", "../global", "../../outside", "foo/../bar", "foo\\..\\bar", "/absolute", "bad\0id"];
  try {
    for (const id of invalidIds) {
      await assert.rejects(
        () => store.history(id),
        (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
        `history should reject ${JSON.stringify(id)}`,
      );
    }
    assert.equal((await store.history(memory.id)).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SEC-PATH-001: symlinked history directories cannot redirect writes", async () => {
  const root = await tempRoot("remembra-v501-symlink-");
  const outside = await tempRoot("remembra-v501-outside-");
  const store = new MemoryStore(root);
  const memory = await store.store(StoreInput.parse({ type: "fact", content: "before" }));
  await fs.mkdir(path.join(root, ".history"), { recursive: true });
  await fs.symlink(outside, path.join(root, ".history", memory.id), "dir");
  try {
    await assert.rejects(
      () => store.update({ ...memory, content: "after" }),
      (error: unknown) => error instanceof RemembraError && ["INVALID_INPUT", "IO_ERROR"].includes(error.code),
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
