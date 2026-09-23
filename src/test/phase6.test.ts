import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import { search } from "../retrieval.js";
import type { Memory, SearchQuery } from "../types.js";

async function tempStore(): Promise<{ store: MemoryStore; root: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p6-"));
  return { store: new MemoryStore(dir), root: dir };
}

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

async function startServer(
  store: MemoryStore,
  extra: { maxBodyBytes?: number } = {},
): Promise<{ server: http.Server; base: string }> {
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1", ...extra });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const isCode =
  (code: string) =>
  (err: unknown): boolean =>
    (err as { code?: string })?.code === code;

// ---------------------------------------------------------------------------
// 1. Concurrency stress — including the two lock bugs this phase flushed out:
//    (a) fresh own-pid lock stolen from a sibling store instance;
//    (b) failed recovery permanently poisoning the instance.
// ---------------------------------------------------------------------------

test("lock: fresh own-pid lock is waited on, not stolen; age rule still rescues", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p6lock-"));
  const store = new MemoryStore(dir, { lockTimeoutMs: 400, lockStaleMs: 1000 });
  const lock = path.join(dir, ".remembra.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");

  // (a) our own pid + fresh = a live sibling instance → must WAIT → timeout.
  // Before the fix this was stolen instantly (mutual exclusion broken).
  await assert.rejects(() => store.store(storeInput("blocked")), isCode("LOCK_TIMEOUT"));

  // (b) the failed recovery above must not poison the instance, and the age
  // rule must still rescue an abandoned own-pid file.
  const old = new Date(Date.now() - 5000);
  await fs.utimes(lock, old, old);
  const m = await store.store(storeInput("after steal"));
  assert.ok(m.id, "second attempt succeeds: retryable recovery + stale-by-age steal");
});

test("stress: two store instances hammer one root — consistent, never dual-homed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p6s-"));
  const a = new MemoryStore(dir, { lockTimeoutMs: 20_000 });
  const b = new MemoryStore(dir, { lockTimeoutMs: 20_000 });
  const seeds = await Promise.all(
    Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).store(storeInput(`seed ${i}`))),
  );

  await Promise.all([
    ...Array.from({ length: 12 }, (_, i) => a.store(storeInput(`a write ${i}`))),
    ...Array.from({ length: 12 }, (_, i) => b.store(storeInput(`b write ${i}`))),
    ...Array.from({ length: 6 }, () => a.all()),
    ...Array.from({ length: 6 }, () => b.all()),
    a.archive(seeds[0].id),
    b.archive(seeds[0].id), // same id from both instances → serialized by the file lock
    b.archive(seeds[1].id),
    a.update({ ...seeds[2], content: "updated by a" }),
    b.update({ ...seeds[3], content: "updated by b" }),
    a.revive(seeds[0].id), // racy against its archives — any order must end single-homed
    ...Array.from({ length: 4 }, (_, i) => a.get(seeds[i].id)),
  ]); // any rejection fails the test

  const actIds = (await fs.readdir(path.join(dir, "global")))
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.basename(f, ".md"));
  const archIds: string[] = [];
  for (const d of [path.join(dir, "archived", "global"), path.join(dir, "archived", "scopes")]) {
    const entries = await fs.readdir(d, { recursive: true }).catch(() => [] as string[]);
    archIds.push(...entries.filter((f) => String(f).endsWith(".md")).map((f) => path.basename(String(f), ".md")));
  }
  for (const id of actIds) assert.ok(!archIds.includes(id), `${id} exists in BOTH trees`);
  assert.equal(actIds.length + archIds.length, 30, "6 seeds + 24 writes, moves never duplicate");

  const active = await a.all();
  assert.equal(active.length, actIds.length, "reads agree with the directories");
  assert.ok(active.some((m) => m.content === "updated by a"), "update from instance a landed");
});

test("stress: concurrent reads while writing never throw or surface torn data", async () => {
  const { store } = await tempStore();
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => store.store(storeInput(`writer ${i}`))),
    ...Array.from({ length: 20 }, () => store.all()),
    ...Array.from({ length: 10 }, () => store.get("nonexistent-id")),
  ]);
  const all = await store.all();
  assert.equal(all.length, 20);
  for (const m of all) assert.ok(m.id && m.updatedAt && typeof m.content === "string");
});

// ---------------------------------------------------------------------------
// 2. Directory traversal — extra angles beyond the Phase 1 pen tests:
//    the digest path, with the caller skipping its own validation.
// ---------------------------------------------------------------------------

test("digest: traversal scope contained at the service layer (defense in depth)", async () => {
  const { store } = await tempStore();
  const evil = "../../../../tmp/remembra-p6-evil";

  // shape 1: evil scope on the digest options, extract items inherit it
  const a = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [{ type: "fact" as const, content: "inherits evil scope", tags: [], importance: 3 }],
  });
  await assert.rejects(() => a.digest({ transcript: "t", scope: evil }), isCode("INVALID_INPUT"));

  // shape 2: evil scope directly on an extracted item
  const b = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => [
      { type: "fact" as const, content: "evil directly", tags: [], importance: 3, scope: evil },
    ],
  });
  await assert.rejects(() => b.digest({ transcript: "t" }), isCode("INVALID_INPUT"));

  await assert.rejects(() => fs.access("/tmp/remembra-p6-evil"), "nothing escaped");
  assert.equal((await store.all()).length, 0, "nothing stored from either shape");
});

// ---------------------------------------------------------------------------
// 3. Large payloads
// ---------------------------------------------------------------------------

test("large payload: 2 MiB content round-trips over HTTP and is searchable", async () => {
  const { store } = await tempStore();
  const { server, base } = await startServer(store);
  try {
    const content = `BIGPAYLOADMARKER ${"z".repeat(2 * 1024 * 1024)}`;
    const res = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fact", content, scope: "global", tags: [], importance: 3 }),
    });
    assert.equal(res.status, 201);
    const { memory } = await res.json();

    const reloaded = await store.get(memory.id);
    assert.equal(reloaded?.content.length, content.length, "byte-exact after the round trip");

    const found = await new MemoryService(store, { embeddingProvider: "none" }).search({
      query: "bigpayloadmarker",
      limit: 5,
    });
    assert.equal(found.results[0]?.id, memory.id, "findable after storage");
  } finally {
    server.close();
  }
});

test("large payload: declared overflow → 413, server keeps serving", async () => {
  const { store } = await tempStore();
  const { server, base } = await startServer(store, { maxBodyBytes: 1024 * 1024 });
  try {
    const tooBig = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fact", content: "z".repeat(1024 * 1024 + 1000), scope: "global", tags: [], importance: 3 }),
    });
    assert.equal(tooBig.status, 413);
    assert.equal((await fetch(`${base}/health`)).status, 200, "server survived the 413");
    const ok = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fact", content: "small enough", scope: "global", tags: [], importance: 3 }),
    });
    assert.equal(ok.status, 201, "normal traffic still works");
    assert.equal((await store.all()).length, 1, "rejected body stored nothing");
  } finally {
    server.close();
  }
});

test("large payload: mid-body overflow without content-length is rejected or aborted", async () => {
  const { store } = await tempStore();
  const { server, base } = await startServer(store, { maxBodyBytes: 64 * 1024 });
  try {
    const payload = JSON.stringify({
      type: "fact",
      content: "chunked".padEnd(200_000, "z"),
      scope: "global",
      tags: [],
      importance: 3,
    });
    // No content-length → the pre-check can't fire; the streaming counter must.
    const outcome = await new Promise<string>((resolve) => {
      const req = http.request(
        `${base}/memories`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(`status:${res.statusCode}:${body}`));
        },
      );
      req.on("error", (e) => resolve(`error:${e.message}`));
      req.write(payload.slice(0, 32_000)); // server now over its limit mid-stream? no — under; next write blows past
      setTimeout(() => {
        req.write(payload.slice(32_000));
        req.end();
      }, 10);
    });
    assert.ok(
      outcome.startsWith("status:413") || outcome.startsWith("error:"),
      `expected 413 or a connection abort, got: ${outcome.slice(0, 80)}`,
    );
    assert.equal((await fetch(`${base}/health`)).status, 200, "server still alive");
    assert.equal((await store.all()).length, 0, "nothing stored");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Malformed file recovery — variety, preservation, idempotence.
// ---------------------------------------------------------------------------

test("malformed files of every shape are skipped, preserved, and idempotent", async () => {
  const { store, root } = await tempStore();
  const good = await store.store(storeInput("the one good memory"));
  const gdir = path.join(root, "global");
  const corrupt: Record<string, string> = {
    "c-empty.md": "",
    "c-binary.md": "\u0000\u0001\u0002\u0003 not frontmatter at all",
    "c-open.md": "---\nid: copen\ntype: fact\n", // never closes
    "c-text.md": "plain text pretending to be a memory\nno delimiters here",
  };
  for (const [name, data] of Object.entries(corrupt)) await fs.writeFile(path.join(gdir, name), data);
  const filesBefore = (await fs.readdir(gdir)).length;

  for (let pass = 0; pass < 3; pass++) {
    const all = await store.all();
    assert.deepEqual(all.map((m) => m.id), [good.id], `pass ${pass}: only the valid memory`);
  }
  assert.equal((await fs.readdir(gdir)).length, filesBefore, "corrupt files preserved, not destroyed");

  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const listed = await svc.list({});
  assert.equal(listed.total, 1);
  const found = await svc.search({ query: "good memory", limit: 10 });
  assert.ok(found.results.every((m) => m.id === good.id));
});

// ---------------------------------------------------------------------------
// 5. Cross-scope isolation under load
// ---------------------------------------------------------------------------

test("cross-scope isolation holds under concurrent multi-scope writes and digests", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const scopes = ["/load/a", "/load/b", "/load/c", "/load/d"];

  await Promise.all([
    ...scopes.flatMap((s) =>
      Array.from({ length: 10 }, (_, i) => svc.store(storeInput(`unique ${s} item ${i}`, { scope: s }))),
    ),
    ...Array.from({ length: 3 }, (_, i) => svc.store(storeInput(`global fact ${i}`))),
    // one digest per scope, all four running concurrently against one store
    ...scopes.map((s) =>
      new MemoryService(store, {
        embeddingProvider: "none",
        extractFn: async () => [
          { type: "fact" as const, content: `digest marker for ${s}`, tags: [], importance: 3, scope: s },
        ],
      }).digest({ transcript: `session for ${s}` }),
    ),
  ]);

  assert.equal((await store.all()).length, scopes.length * 11 + 3);

  for (const s of scopes) {
    const listed = await svc.list({ scope: s });
    assert.equal(listed.total, 10 + 1 + 3, `${s}: own 10 + own digest 1 + global 3`);
    assert.ok(listed.memories.every((m) => m.scope === s || m.scope === "global"), `${s} list leak`);

    const { results } = await svc.search({ query: "unique digest", scope: s, limit: 50 });
    assert.ok(results.every((m) => m.scope === s || m.scope === "global"), `${s} search leak`);
    assert.ok(results.some((m) => m.scope === s), `${s} own scope present`);
    assert.ok(
      !results.some((m) => m.scope.startsWith("/load/") && m.scope !== s),
      `${s} must not see sibling scopes`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Property-based scoring invariants (seeded PRNG, no new dependencies)
// ---------------------------------------------------------------------------

const WORDS = [
  "postgres", "auth", "token", "deploy", "staging", "cluster", "rate", "react",
  "cache", "branch", "pipeline", "memory", "region", "quota", "session",
];

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

/** Random memory set; updatedAt strictly decreasing → unique → total sort order. */
function genSet(rand: () => number, n: number): Memory[] {
  let t = Date.now();
  const out: Memory[] = [];
  for (let i = 0; i < n; i++) {
    t -= 1000 + Math.floor(rand() * 86_400_000);
    const type: Memory["type"] = rand() < 0.15 ? "role" : (pick(rand, ["fact", "decision", "history"]) as Memory["type"]);
    const content = Array.from({ length: 3 + Math.floor(rand() * 4) }, () => pick(rand, WORDS)).join(" ");
    const hasEmb = rand() < 0.85;
    out.push({
      id: `prop-${i}`,
      type,
      content,
      scope: pick(rand, ["global", "/x", "/y"]),
      tags: rand() < 0.5 ? [pick(rand, WORDS)] : [],
      importance: 1 + Math.floor(rand() * 5),
      confidence: 1,
      trust: "trusted",
      version: 1,
      createdAt: new Date(t).toISOString(),
      updatedAt: new Date(t).toISOString(),
      provenance: rand() < 0.5 ? { sourceType: "manual" } : { sourceType: "conversation" },
      ...(hasEmb ? { embedding: Array.from({ length: 8 }, () => rand() - 0.5) } : {}),
    });
  }
  return out;
}

type Mode = "keyword" | "semantic";
function genArgs(rand: () => number, mode: Mode): { q: SearchQuery; qv: number[] | null } {
  const q: SearchQuery = {
    query: `${pick(rand, WORDS)} ${pick(rand, WORDS)}`,
    scope: pick(rand, ["/x", "/y", "/z"]), // /z has no memories → globals only
    limit: 50, // ≥ set size → full universe for rank comparisons
  };
  const qv = mode === "semantic" ? Array.from({ length: 8 }, () => rand() - 0.5) : null;
  return { q, qv };
}

const ROUNDS = 30;

test("property: roles always rank first and scopes never leak (random rounds)", () => {
  for (const mode of ["keyword", "semantic"] as Mode[]) {
    const rand = makeRng(mode === "keyword" ? 0xA11CE : 0xB0B);
    for (let round = 0; round < ROUNDS; round++) {
      const set = genSet(rand, 30);
      const { q, qv } = genArgs(rand, mode);
      const results = search(set, q, qv);

      let seenNonRole = false;
      for (const m of results) {
        assert.ok(
          m.scope === "global" || m.scope === q.scope,
          `${mode}/${round}: scope leak — ${m.scope} with query scope ${q.scope}`,
        );
        if (m.type === "role") {
          assert.ok(!seenNonRole, `${mode}/${round}: role ranked below a non-role`);
        } else {
          seenNonRole = true;
        }
      }
      assert.ok(results.length <= (q.limit ?? 10), `${mode}/${round}: limit respected`);
    }
  }
});

test("property: search is deterministic and independent of input order", () => {
  for (const mode of ["keyword", "semantic"] as Mode[]) {
    const rand = makeRng(mode === "keyword" ? 0xDE7 : 0xF00D);
    for (let round = 0; round < 15; round++) {
      const set = genSet(rand, 25);
      const { q, qv } = genArgs(rand, mode);
      const a = search(set, q, qv).map((m) => m.id);
      const b = search(set, q, qv).map((m) => m.id);
      assert.deepEqual(a, b, `${mode}/${round}: repeat call must be identical`);
      const shuffled = [...set].reverse();
      const c = search(shuffled, q, qv).map((m) => m.id);
      assert.deepEqual(a, c, `${mode}/${round}: input order must not change ranking`);
      assert.equal(new Set(a).size, a.length, `${mode}/${round}: no duplicate results`);
    }
  }
});

test("property: raising importance never lowers a memory's rank", () => {
  for (const mode of ["keyword", "semantic"] as Mode[]) {
    const rand = makeRng(mode === "keyword" ? 0x1234 : 0x5678);
    for (let round = 0; round < 15; round++) {
      const set = genSet(rand, 25);
      const target = set[Math.floor(rand() * set.length)];
      const { q, qv } = genArgs(rand, mode);

      const before = search(set, q, qv).map((m) => m.id);
      const beforeIdx = before.indexOf(target.id);
      if (beforeIdx === -1) continue; // outside the ranked universe (scope-gated)

      const boosted = set.map((m) => (m.id === target.id ? { ...m, importance: 5 } : m));
      const after = search(boosted, q, qv).map((m) => m.id);
      const afterIdx = after.indexOf(target.id);
      assert.notEqual(afterIdx, -1, `${mode}/${round}: gate must not change`);
      assert.ok(afterIdx <= beforeIdx, `${mode}/${round}: rank worsened ${beforeIdx} → ${afterIdx}`);
    }
  }
});

test("property: refreshing recency never lowers a memory's rank", () => {
  for (const mode of ["keyword", "semantic"] as Mode[]) {
    const rand = makeRng(mode === "keyword" ? 0x999 : 0x888);
    for (let round = 0; round < 15; round++) {
      const set = genSet(rand, 25);
      const target = set[Math.floor(rand() * set.length)];
      const { q, qv } = genArgs(rand, mode);

      const before = search(set, q, qv).map((m) => m.id);
      const beforeIdx = before.indexOf(target.id);
      if (beforeIdx === -1) continue;

      const refreshed = set.map((m) =>
        m.id === target.id ? { ...m, updatedAt: new Date().toISOString() } : m,
      );
      const after = search(refreshed, q, qv).map((m) => m.id);
      const afterIdx = after.indexOf(target.id);
      assert.notEqual(afterIdx, -1);
      assert.ok(afterIdx <= beforeIdx, `${mode}/${round}: rank worsened ${beforeIdx} → ${afterIdx}`);
    }
  }
});

test("property: manual provenance never lowers a memory's rank", () => {
  for (const mode of ["keyword", "semantic"] as Mode[]) {
    const rand = makeRng(mode === "keyword" ? 0xACE : 0xBED);
    for (let round = 0; round < 15; round++) {
      const set = genSet(rand, 25);
      const target = set.find((m) => m.provenance.sourceType !== "manual");
      if (!target) continue;
      const { q, qv } = genArgs(rand, mode);

      const before = search(set, q, qv).map((m) => m.id);
      const beforeIdx = before.indexOf(target.id);
      if (beforeIdx === -1) continue;

      const promoted = set.map((m) =>
        m.id === target.id ? { ...m, provenance: { sourceType: "manual" as const } } : m,
      );
      const after = search(promoted, q, qv).map((m) => m.id);
      const afterIdx = after.indexOf(target.id);
      assert.notEqual(afterIdx, -1);
      assert.ok(afterIdx <= beforeIdx, `${mode}/${round}: rank worsened ${beforeIdx} → ${afterIdx}`);
    }
  }
});

test("property: limit bounds results to a unique subset of the input", () => {
  for (const mode of ["keyword", "semantic"] as Mode[]) {
    const rand = makeRng(mode === "keyword" ? 0x515 : 0x246);
    for (let round = 0; round < 20; round++) {
      const set = genSet(rand, 25);
      const { q, qv } = genArgs(rand, mode);
      q.limit = 1 + Math.floor(rand() * 25);
      const ids = search(set, q, qv).map((m) => m.id);
      assert.ok(ids.length <= q.limit, `${mode}/${round}: ${ids.length} > limit ${q.limit}`);
      assert.equal(new Set(ids).size, ids.length, `${mode}/${round}: duplicates`);
      const input = new Set(set.map((m) => m.id));
      for (const id of ids) assert.ok(input.has(id), `${mode}/${round}: result ${id} not in input`);
    }
  }
});
