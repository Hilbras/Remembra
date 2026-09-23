import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import type http from "node:http";

async function tempStore(): Promise<MemoryStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p2-"));
  return new MemoryStore(dir);
}

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

// --- schema version field (audit #10) ---

test("new files carry schema version in frontmatter", async () => {
  const store = await tempStore();
  const m = await store.store(storeInput("versioned fact"));
  const file = path.join(store["root"], "global", `${m.id}.md`);
  const raw = await fs.readFile(file, "utf8");
  assert.match(raw, /^version: 3$/m, "4.7.0 schema — older readers skip these (downgrade contract)");
  assert.match(raw, /^revision: 1$/m, "the memory's own concurrency counter (plan §3.5)");
});

test("newer schema files are refused rather than exposing unknown policy fields", async () => {
  const store = await tempStore();
  const newerId = "newer123";
  await fs.mkdir(path.join(store["root"], "global"), { recursive: true });
  await fs.writeFile(
    path.join(store["root"], "global", `${newerId}.md`),
    `---\nid: ${newerId}\nversion: 4\ntype: fact\nscope: global\ntags: []\nimportance: 3\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nFuture policy\n`,
    "utf8",
  );
  assert.equal((await store.all()).length, 0);
});

test("old files without a version field still parse (backward compat)", async () => {
  const store = await tempStore();
  const oldId = "abcd1234"; // 8-char v1-era id, no version line
  await fs.mkdir(path.join(store["root"], "global"), { recursive: true });
  await fs.writeFile(
    path.join(store["root"], "global", `${oldId}.md`),
    `---\nid: ${oldId}\ntype: decision\nscope: global\ntags: []\nimportance: 4\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nUse the old format.\n`,
    "utf8",
  );
  const all = await store.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, oldId);
  assert.equal(all[0].content, "Use the old format.");
  const { results } = await new MemoryService(store, { embeddingProvider: "none" }).search({
    query: "format",
  });
  assert.equal(results.length, 1);
});

// --- malformed files (audit: corrupt files silently skipped) ---

test("malformed file is skipped, search survives, warning emitted once", async () => {
  const store = await tempStore();
  await store.store(storeInput("good memory about widgets"));
  const badName = `bad-${randomUUID().slice(0, 8)}.md`;
  const globalDir = path.join(store["root"], "global");
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(path.join(globalDir, badName), "totally not markdown {{{", "utf8");

  const orig = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    const line = String(args[0]);
    if (line.includes("skipping unparseable")) warnings.push(line);
  };
  try {
    const first = await store.all();
    const second = await store.all();
    assert.equal(first.length, 1, "garbage file excluded");
    assert.equal(second.length, 1);
    const { results } = await new MemoryService(store, { embeddingProvider: "none" }).search({
      query: "widgets",
    });
    assert.equal(results.length, 1);
  } finally {
    console.error = orig;
  }
  assert.equal(warnings.length, 1, `expected exactly 1 warn-once, got ${warnings.length}`);
  assert.ok(warnings[0].includes("skipping unparseable"));
});

// --- digest edge cases (audit: empty transcript, partial failure rollback) ---

test("empty transcript extract → digest returns zeros without crashing", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [],
  });
  const r = await svc.digest({ transcript: "   " });
  assert.equal(r.extracted, 0);
  assert.equal(r.stored.length, 0);
  assert.equal(r.merged, 0);
  assert.equal(r.skippedDuplicates, 0);
});

test("HTTP digest with empty transcript → 400", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none", extractFn: async () => [] });
  const server: http.Server = createHttpServer(svc, { port: 0, apiKey: "k", host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/memories/digest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({ transcript: "" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("extraction failure rolls back the whole digest (nothing stored)", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => {
      throw new Error("LLM exploded");
    },
  });
  await assert.rejects(() => svc.digest({ transcript: "session notes" }), /LLM exploded/);
  assert.equal((await store.all()).length, 0, "no partial state after failed extraction");
});

test("merge LLM failure fails open: new fact stored fresh, digest completes", async () => {
  const store = await tempStore();
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    mergeFn: async () => {
      throw new Error("merge LLM down");
    },
  });
  await svc.store(
    storeInput("The deploy target is staging cluster alpha", { type: "decision" }),
  );
  // Bypass digest's default extractFn via the same service's merge path:
  // re-create the service shape with an extractFn that yields the evolved fact.
  const origMerge = svc["mergeFn"];
  assert.ok(typeof origMerge === "function");
  const svc2 = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [
      {
        type: "decision" as const,
        content: "The deploy target is production cluster alpha",
        tags: [],
        importance: 3,
        scope: "global",
      },
    ],
    mergeFn: async () => {
      throw new Error("merge LLM down");
    },
  });
  const r = await svc2.digest({ transcript: "x" });
  assert.equal(r.stored.length, 1, "evolved fact not lost when merge fails");
  assert.equal(r.merged, 0);
  const all = await store.all();
  assert.equal(all.length, 2, "original + fresh copy both present");
});

// --- concurrency (audit: parallel writers) ---

test("parallel stores never collide or corrupt files", async () => {
  const store = await tempStore();
  const inputs = Array.from({ length: 40 }, (_, i) =>
    storeInput(`parallel fact ${i}`, { scope: i % 2 ? "/proj/b" : "/proj/a" }),
  );
  const stored = await Promise.all(inputs.map((i) => store.store(i)));
  assert.equal(new Set(stored.map((m) => m.id)).size, 40, "unique ids under concurrency");
  const all = await store.all();
  assert.equal(all.length, 40, "every parallel write landed intact");
});

test("simultaneous digests are serialized — no double-stored duplicates", async () => {
  const store = await tempStore();
  let extractCalls = 0;
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => {
      extractCalls++;
      await new Promise((r) => setTimeout(r, 20)); // widen the race window
      return [
        { type: "fact" as const, content: "shared extracted fact", tags: [], importance: 3, scope: "global" },
      ];
    },
  });
  const [a, b] = await Promise.all([
    svc.digest({ transcript: "session one", source: "s1" }),
    svc.digest({ transcript: "session two", source: "s2" }),
  ]);
  assert.equal(extractCalls, 2);
  const totalStored = a.stored.length + b.stored.length;
  assert.equal(totalStored, 1, "second digest must see first's write (lock)");
  assert.equal((await store.all()).length, 1, "exactly one file on disk");
});

// --- export / import backup (audit #8) ---

test("export → import round trip preserves memories incl. archived state", async () => {
  const src = await tempStore();
  const svc = new MemoryService(src, { embeddingProvider: "none" });
  await svc.store(storeInput("a global fact", { type: "fact" }));
  await svc.store(storeInput("a role", { type: "role", content: "Always be terse." }));
  const old = await svc.store(storeInput("an old fact"));
  await src.archive(old.id); // archived memories must survive backup too

  const snapshot = await svc.exportSnapshot();
  assert.equal(snapshot.format, "remembra-export");
  assert.equal(snapshot.memories.length, 3);

  const dst = await tempStore();
  const dstSvc = new MemoryService(dst, { embeddingProvider: "none" });
  const result = await dstSvc.importSnapshot(snapshot);
  assert.equal(result.imported, 3);
  assert.equal(result.skipped, 0);

  const dstAll = await dst.all(true);
  assert.equal(dstAll.length, 3);
  const reimported = dstAll.find((m) => m.id === old.id);
  assert.ok(reimported, "id preserved");
  assert.ok(reimported.archivedAt, "archived state preserved");

  // Idempotent: importing again changes nothing.
  const again = await dstSvc.importSnapshot(snapshot);
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 3);
  assert.equal((await dst.all(true)).length, 3);
});

test("import dedups by content even across differing ids", async () => {
  const src = await tempStore();
  const srcSvc = new MemoryService(src, { embeddingProvider: "none" });
  await srcSvc.store(storeInput("duplicate content"));
  const snapshot = await srcSvc.exportSnapshot();
  // Simulate a foreign export where ids differ but content matches.
  snapshot.memories = snapshot.memories.map((m) => ({ ...m, id: randomUUID().replace(/-/g, "").slice(0, 12) }));

  const dst = await tempStore();
  await new MemoryService(dst, { embeddingProvider: "none" }).store(
    storeInput("duplicate content"),
  );
  const dstSvc = new MemoryService(dst, { embeddingProvider: "none" });
  const result = await dstSvc.importSnapshot(snapshot);
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.equal((await dst.all()).length, 1);
});

test("import validates the WHOLE file before writing (rollback)", async () => {
  const dst = await tempStore();
  const dstSvc = new MemoryService(dst, { embeddingProvider: "none" });
  const good = {
    id: "aaaa1111bbbb",
    type: "fact",
    content: "valid entry",
    scope: "global",
    tags: [],
    importance: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const base = {
    format: "remembra-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    memories: [good],
  };

  // Wrong envelope → rejected.
  await assert.rejects(() => dstSvc.importSnapshot({ ...base, format: "zip" }));

  // Traversal scope hidden later in the file → rejected atomically,
  // the valid entry BEFORE it must not be written either.
  await assert.rejects(() =>
    dstSvc.importSnapshot({
      ...base,
      memories: [good, { ...good, id: "bbbb2222cccc", scope: "../../../../etc" }],
    }),
  );
  assert.equal((await dst.all(true)).length, 0, "no partial import after rejection");

  // Garbage instead of a snapshot → rejected.
  await assert.rejects(() => dstSvc.importSnapshot("not a snapshot"));
});
