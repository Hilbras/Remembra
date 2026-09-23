import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteBackend } from "../sqlite-backend.js";
import { StoreInput } from "../types.js";

async function tempSqlite(): Promise<{ store: SqliteBackend; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-sql-"));
  const store = new SqliteBackend({ root: dir });
  return { store, dir };
}

test("sqlite: store and retrieve round-trip", async () => {
  const { store, dir } = await tempSqlite();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "Uses SQLite natively" }));
  assert.ok(m.id.length > 0);
  assert.equal(m.type, "fact");
  assert.equal(m.content, "Uses SQLite natively");
  assert.equal(m.scope, "global");
  assert.equal(m.version, 1);
  const got = await store.get(m.id);
  assert.ok(got);
  assert.equal(got!.content, "Uses SQLite natively");
  assert.equal(got!.id, m.id);
  const all = await store.all();
  assert.equal(all.length, 1);
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("sqlite: agent attribution, ownership, and access round-trip", async () => {
  const { store } = await tempSqlite();
  const m = await store.store(StoreInput.parse({
    type: "fact",
    content: "Agent-only research",
    owner: "agent",
    access: "private",
    provenance: {
      sourceType: "agent",
      agentId: "researcher-1",
      agentType: "researcher",
      agentVersion: "2.0.0",
      conversationId: "conversation-1",
      taskId: "task-1",
      runId: "run-1",
    },
  }));

  const got = await store.get(m.id);
  assert.equal(got?.owner, "agent");
  assert.equal(got?.access, "private");
  assert.deepEqual(got?.provenance, m.provenance);
  store.close();
});

test("sqlite: update with version bump", async () => {
  const { store } = await tempSqlite();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "original" }));
  assert.equal(m.version, 1);
  const updated = await store.update({ ...m, content: "changed" });
  assert.equal(updated.version, 2);
  assert.equal(updated.content, "changed");
  // CAS conflict
  try {
    await store.update({ ...updated, content: "will fail" }, { expectedVersion: 1 });
    assert.fail("should have thrown");
  } catch (e: unknown) {
    assert.ok((e as Error).message.includes("CONFLICT") || (e as Error).message.includes("version"));
  }
  store.close();
});

test("sqlite: archive and revive", async () => {
  const { store } = await tempSqlite();
  const m = await store.store(StoreInput.parse({ type: "preference", content: "dark mode" }));
  assert.equal((await store.all()).length, 1);
  const archived = await store.archive(m.id);
  assert.ok(archived);
  assert.ok(archived.archivedAt);
  assert.equal((await store.all()).length, 0);
  assert.equal((await store.all(true)).length, 1);
  const revived = await store.revive(m.id);
  assert.ok(revived);
  assert.equal(revived.archivedAt, undefined);
  assert.equal((await store.all()).length, 1);
  store.close();
});

test("sqlite: forget removes memory", async () => {
  const { store } = await tempSqlite();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "to delete" }));
  assert.equal((await store.all()).length, 1);
  const removed = await store.forget(m.id);
  assert.equal(removed, true);
  assert.equal((await store.all()).length, 0);
  assert.equal(await store.get(m.id), null);
  store.close();
});

test("sqlite: importMemory rejects duplicates", async () => {
  const { store } = await tempSqlite();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "unique" }));
  const dup = await store.importMemory(m);
  assert.equal(dup, false);
  store.close();
});

test("sqlite: touch updates lastSeen", async () => {
  const { store } = await tempSqlite();
  // Create memory with a stale updatedAt (>1h ago) so touch fires.
  const staleAt = new Date(Date.now() - 7200_000).toISOString();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "touch me" }));
  // Overwrite updatedAt via test hook to simulate old memory.
  store._testExec("UPDATE memories SET updated_at = ?, last_seen = ? WHERE id = ?", staleAt, staleAt, m.id);
  await store.touch(m.id);
  const got = await store.get(m.id);
  assert.ok(got?.lastSeen);
  assert.ok(Date.parse(got.lastSeen) > Date.now() - 60_000);
  store.close();
});

test("sqlite: history snapshots on content change", async () => {
  const { store } = await tempSqlite();
  const m = await store.store(StoreInput.parse({ type: "fact", content: "v1" }));
  await store.update({ ...m, content: "v2" });
  await store.update({ ...m, content: "v3" });
  const hist = await store.history!(m.id);
  assert.ok(hist.length >= 2);
  assert.equal(hist[0].content, "v2");
  store.close();
});

test("sqlite: FTS5 search returns IDs", async () => {
  const { store } = await tempSqlite();
  await store.store(StoreInput.parse({ type: "fact", content: "PostgreSQL is great" }));
  await store.store(StoreInput.parse({ type: "fact", content: "SQLite is also great" }));
  const matches = store.ftsSearch("great");
  // FTS5 may be unavailable on some builds; fall back gracefully.
  if (store["ftsEnabled"]) {
    assert.equal(matches.length, 2);
  } else {
    assert.equal(matches.length, 0);
  }
  store.close();
});

test("sqlite: embedding stored as BLOB", async () => {
  const { store } = await tempSqlite();
  const emb = [0.1, 0.2, 0.3];
  const m = await store.store(StoreInput.parse({ type: "fact", content: "embedded" }), emb);
  // Verify via get() round-trip.
  const got = await store.get(m.id);
  assert.ok(got?.embedding, "embedding should round-trip through get()");
  assert.equal(got!.embedding!.length, 3);
  assert.ok(Math.abs(got!.embedding![0] - 0.1) < 0.001);
  store.close();
});

test("sqlite: cacheStats reports counts", async () => {
  const { store } = await tempSqlite();
  await store.store(StoreInput.parse({ type: "fact", content: "a" }));
  await store.store(StoreInput.parse({ type: "fact", content: "b" }));
  const stats = store.cacheStats();
  assert.equal(stats.size, 2);
  store.close();
});