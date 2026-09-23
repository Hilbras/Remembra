import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer, resolveListen } from "../http.js";
import { isSafeScope, StoreInput, DigestInput } from "../types.js";
import type http from "node:http";

async function tempStore(): Promise<{ store: MemoryStore; root: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-sec-"));
  return { store: new MemoryStore(dir), root: dir };
}

// --- P0: directory traversal ---

test("P0: traversal scopes are rejected by validation", () => {
  const vectors = ["../../../../etc", "..", "../", "a/../../b", "./..", "foo/../../../var"];
  for (const v of vectors) {
    assert.equal(isSafeScope(v), false, `should reject: ${v}`);
    assert.throws(() => StoreInput.parse({ type: "fact", content: "x", scope: v }), `parse should throw: ${v}`);
  }
  // Encoded form is sanitized to a literal single segment (no '/'), so it's contained — not a vector.
  assert.equal(isSafeScope("..%2F..%2Fetc"), true);
});

test("P0: legitimate scopes still accepted", () => {
  const ok = ["global", "/home/gin/work/Hilbras/Memory", "chatgpt", "my-project.v2", "a/b/c"];
  for (const s of ok) assert.equal(isSafeScope(s), true, `should accept: ${s}`);
  assert.equal(StoreInput.parse({ type: "fact", content: "x", scope: "/home/gin/work/x" }).scope, "/home/gin/work/x");
});

test("P0 pen test: escaped path never reaches the filesystem", async () => {
  const { store, root } = await tempStore();
  // Bypass StoreInput (defense in depth: fileFor itself must refuse).
  const evil = {
    id: "deadbeefdead",
    type: "fact" as const,
    content: "pwned",
    scope: "../../../../tmp/remembra-p0",
    tags: [],
    importance: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await assert.rejects(
    () => store.store(evil as never),
    /outside the storage root/,
    "fileFor must throw for escaping scopes",
  );
  // Nothing escaped, nothing partially written in root.
  await fs.access(root);
  await assert.rejects(() => fs.access("/tmp/remembra-p0/deadbeefdead.md"));
});

test("P0 pen test: HTTP store with traversal scope returns 400, writes nothing", async () => {
  const { store, root } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const server: http.Server = createHttpServer(svc, { port: 0, apiKey: "k", host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({ type: "fact", content: "x", scope: "../../../../tmp/evil" }),
    });
    assert.equal(res.status, 400);
    await assert.rejects(() => fs.access("/tmp/evil"));
    const files = await fs.readdir(path.join(root, "global")).catch(() => []);
    assert.equal(files.filter((f) => f.endsWith(".md")).length, 0);
  } finally {
    server.close();
  }
});

// --- listen policy (default-deny) ---

test("listen policy: no key + no host → loopback only", () => {
  assert.deepEqual(resolveListen(undefined, false), { host: "127.0.0.1" });
});

test("listen policy: key + no host → all interfaces", () => {
  assert.deepEqual(resolveListen(undefined, true), {});
});

test("listen policy: public host without key → refused", () => {
  const r = resolveListen("0.0.0.0", false);
  assert.ok(r.error?.includes("Refusing"));
  const r2 = resolveListen("example.com", false);
  assert.ok(r2.error);
});

test("listen policy: loopback host without key → allowed", () => {
  assert.deepEqual(resolveListen("127.0.0.1", false), { host: "127.0.0.1" });
  assert.deepEqual(resolveListen("::1", false), { host: "::1" });
});

test("createHttpServer throws when asked to bind publicly without a key", () => {
  const { store } = { store: null as never };
  void store;
  assert.throws(
    () =>
      createHttpServer(new MemoryService(new MemoryStore(os.tmpdir()), { embeddingProvider: "none" }), {
        port: 0,
        host: "0.0.0.0",
      }),
    /Refusing to listen/,
  );
});

// --- digest validation ---

test("digest input: transcript required, scope type-checked", () => {
  assert.throws(() => DigestInput.parse({}));
  assert.throws(() => DigestInput.parse({ transcript: "" }));
  assert.throws(() => DigestInput.parse({ transcript: "ok", scope: 123 }));
  assert.throws(() => DigestInput.parse({ transcript: "ok", scope: "../x" }));
  const parsed = DigestInput.parse({ transcript: "ok", source: "cli" });
  assert.equal(parsed.transcript, "ok");
  assert.equal(parsed.source, "cli");
});

// --- body size limit ---

test("oversized body → 413", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, apiKey: "k", host: "127.0.0.1", maxBodyBytes: 256 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({ type: "fact", content: "x".repeat(10_000) }),
    });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});

// --- content-length present ---

test("responses include content-length", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const server = createHttpServer(svc, { port: 0, apiKey: "k", host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/health`);
    assert.ok(res.headers.get("content-length"));
  } finally {
    server.close();
  }
});

// --- atomic writes ---

test("store leaves no temp files behind", async () => {
  const { store, root } = await tempStore();
  await store.store({ type: "fact", content: "a", scope: "global", tags: [], importance: 3, source: undefined } as never);
  await store.store({ type: "fact", content: "b", scope: "/proj", tags: [], importance: 3, source: undefined } as never);
  const leftovers = await findFiles(root, (f) => f.endsWith(".tmp"));
  assert.equal(leftovers.length, 0);
});

async function findFiles(dir: string, pred: (f: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (pred(full)) out.push(full);
    }
  }
  return out;
}

// --- IDs ---

test("IDs are 12 chars and unique", async () => {
  const { store } = await tempStore();
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const m = await store.store({ type: "fact", content: `m${i}`, scope: "global", tags: [], importance: 3, source: undefined } as never);
    assert.equal(m.id.length, 12);
    ids.add(m.id);
  }
  assert.equal(ids.size, 200);
});
