import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { search } from "../retrieval.js";
import { StoreInput } from "../types.js";

async function tempStore(): Promise<MemoryStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-"));
  return new MemoryStore(dir);
}

test("store and retrieve round-trip", async () => {
  const store = await tempStore();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "Uses PostgreSQL 16" }));
  const all = await store.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].content, "Uses PostgreSQL 16");
  assert.equal(all[0].scope, "global");
  assert.equal((await store.get(m.id))?.id, m.id);
});

test("scoped memories don't leak into other scopes", async () => {
  const store = await tempStore();
  await store.store(StoreInput.parse({ type: "fact", content: "global fact", scope: "global" }));
  await store.store(StoreInput.parse({ type: "fact", content: "repo decision", scope: "/repo/a" }));

  const inB = search(await store.all(), { scope: "/repo/b" });
  assert.ok(inB.every((m) => m.scope !== "/repo/a"));

  const inA = search(await store.all(), { scope: "/repo/a" });
  assert.ok(inA.some((m) => m.content === "repo decision"));
  assert.ok(inA.some((m) => m.content === "global fact"));
});

test("roles always surface", async () => {
  const store = await tempStore();
  await store.store(StoreInput.parse({ type: "role", content: "Answer concisely" }));
  await store.store(StoreInput.parse({ type: "fact", content: "something unrelated" }));
  const results = search(await store.all(), { query: "quantum bananas", scope: "/repo/x" });
  assert.equal(results[0].type, "role");
});

test("keyword ranking prefers matches", async () => {
  const store = await tempStore();
  await store.store(StoreInput.parse({ type: "decision", content: "Chose PostgreSQL over MongoDB", tags: ["db"] }));
  await store.store(StoreInput.parse({ type: "fact", content: "Frontend uses React" }));
  const results = search(await store.all(), { query: "postgres database", scope: "global" });
  assert.match(results[0].content, /PostgreSQL/);
});

test("forget removes a memory", async () => {
  const store = await tempStore();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "temp" }));
  assert.equal(await store.forget(m.id), true);
  assert.equal((await store.all()).length, 0);
  assert.equal(await store.forget("nope"), false);
});
