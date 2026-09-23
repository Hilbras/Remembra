import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";

async function tempService(): Promise<MemoryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-svc-"));
  return new MemoryService(new MemoryStore(dir));
}

test("store returns id and message", async () => {
  const svc = await tempService();
  const result = await svc.store({ type: "fact", content: "hello" });
  assert.ok(result.id);
  assert.match(result.message, /Stored fact memory/);
});

test("store rejects invalid input", async () => {
  const svc = await tempService();
  await assert.rejects(() => svc.store({ type: "banana", content: "x" }));
});

test("search returns formatted text and results", async () => {
  const svc = await tempService();
  await svc.store({ type: "decision", content: "Chose X over Y", scope: "global" });
  const { text, results } = await svc.search({ query: "chose", scope: "global" });
  assert.equal(results.length, 1);
  assert.match(text, /DECISION/);
});

test("list filters by type and scope", async () => {
  const svc = await tempService();
  await svc.store({ type: "fact", content: "a", scope: "global" });
  await svc.store({ type: "role", content: "b", scope: "/p" });
  const { memories } = await svc.list({ type: "role" });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].type, "role");
});

test("forget reports missing ids", async () => {
  const svc = await tempService();
  const res = await svc.forget("doesnotexist");
  assert.equal(res.ok, false);
  assert.match(res.text, /No memory/);
});
