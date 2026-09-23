// v4.0.0 — Web UI static serving + the write API the dashboard drives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import { metrics } from "../metrics.js";
import { RemembraError } from "../errors.js";
import type { Memory } from "../types.js";

async function tempStore(): Promise<{ store: MemoryStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v4-"));
  return { store: new MemoryStore(root), root };
}

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function startServer(
  svc: MemoryService,
  apiKey?: string,
): Promise<{ server: http.Server; base: string }> {
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1", apiKey });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

interface Resp {
  status: number;
  data: Record<string, unknown> | null;
}

async function req(
  base: string,
  method: string,
  urlPath: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<Resp> {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      ...(opts.key ? { "x-api-key": opts.key } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, data };
}

/** Raw-path GET (no client-side URL normalization — pen tests need exact bytes). */
function rawGet(
  base: string,
  rawPath: string,
): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: rawPath, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// ---------- static shell ----------

test("ui shell: GET / serves HTML with CSP, nosniff, no inline script/style", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { server, base } = await startServer(svc, "k1");
  try {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes("unsafe-inline"), "CSP must not allow inline script/style");

    const body = await res.text();
    assert.ok(body.includes("/ui/app.js"), "references compiled entry");
    assert.ok(body.includes("/ui/styles.css"), "references stylesheet");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(body), "no inline <script> blocks");
    assert.ok(!/ style="/.test(body), "no inline style attributes (CSP style-src-attr)");
    assert.ok(body.includes('data-theme="dark"'), "dark default before app boots");
  } finally {
    server.close();
  }
});

test("ui assets: styles.css / app.js / pages/*.js served with correct MIME", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { server, base } = await startServer(svc, "k1");
  try {
    const css = await fetch(base + "/ui/styles.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    const cssText = await css.text();
    assert.ok(cssText.includes("--gold"), "gold design tokens present");
    assert.ok(cssText.includes(':root[data-theme="light"]'), "light theme override present");

    const js = await fetch(base + "/ui/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    const page = await fetch(base + "/ui/pages/list.js");
    assert.equal(page.status, 200, "nested module paths resolve");

    const head = await fetch(base + "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0, "HEAD has no body");
  } finally {
    server.close();
  }
});

test("ui pen test: traversal and non-whitelisted paths never leak files", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { server, base } = await startServer(svc, "k1");
  try {
    // Encoded-inside-segment traversals are handled by the static handler → 404.
    const staticCases = [
      "/ui/%2e%2e%2fpackage.json",
      "/ui/..%2fpackage.json",
      "/ui/..%5cpackage.json",
      "/ui/app.js%2f..%2f..%2fpackage.json",
      "/ui/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/ui//etc/passwd",
      "/ui/secret.txt",
      "/ui/.env",
      "/ui/styles.css.bak",
      "/ui/%00../package.json",
    ];
    for (const p of staticCases) {
      const { status, body } = await rawGet(base, p);
      assert.equal(status, 404, `${p} → 404, got ${status}`);
      assert.ok(!body.includes("devDependencies"), `${p} leaked package.json`);
      assert.ok(!body.includes("root:x"), `${p} leaked /etc/passwd`);
    }
    // /ui bare IS the shell alias → 200.
    assert.equal((await rawGet(base, "/ui")).status, 200);

    // Plain dot-segments are normalized by the server's URL parser onto the
    // data plane → gated by auth / no-route. Never 200, never a leak.
    const dataPlaneCases = [
      "/ui/../package.json",
      "/ui/../../etc/passwd",
      "/ui/%2e%2e/%2e%2e/etc/passwd",
      "/../package.json",
    ];
    for (const p of dataPlaneCases) {
      const { status, body } = await rawGet(base, p);
      assert.ok(status === 401 || status === 404, `${p} → 401/404, got ${status}`);
      assert.ok(!body.includes("devDependencies"), `${p} leaked package.json`);
      assert.ok(!body.includes("root:x"), `${p} leaked /etc/passwd`);
    }
  } finally {
    server.close();
  }
});

test("ui auth boundary: shell open, data gated (keyed server)", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { server, base } = await startServer(svc, "k1");
  try {
    assert.equal((await fetch(base + "/")).status, 200, "shell unauthenticated");
    assert.equal((await fetch(base + "/ui/app.js")).status, 200, "assets unauthenticated");
    assert.equal((await fetch(base + "/health")).status, 200, "health unauthenticated");

    assert.equal((await fetch(base + "/memories")).status, 401, "data gated");
    assert.equal((await fetch(base + "/snapshot")).status, 401, "export gated");
    assert.equal((await fetch(base + "/memories")).status, 401, "still gated");
    const ok = await fetch(base + "/memories", { headers: { "x-api-key": "k1" } });
    assert.equal(ok.status, 200, "keyed data call works");
  } finally {
    server.close();
  }
});

test("ui route label: static requests counted as route=ui, snapshot as data_io", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { server, base } = await startServer(svc, "k1");
  try {
    await fetch(base + "/");
    await fetch(base + "/ui/styles.css");
    await fetch(base + "/snapshot", { headers: { "x-api-key": "k1" } });
    const text = metrics.render();
    assert.ok(text.includes('route="ui"'), "static route labeled ui");
    assert.ok(text.includes('route="data_io"'), "snapshot labeled data_io");
  } finally {
    server.close();
  }
});

test("ui opt-out: REMEMBRA_UI=0 disables the shell", async () => {
  const restore = withEnv({ REMEMBRA_UI: "0" });
  try {
    const { store } = await tempStore();
    const svc = new MemoryService(store, { embeddingProvider: "none" });
    const { server, base } = await startServer(svc);
    try {
      assert.equal((await fetch(base + "/")).status, 404, "shell off");
      assert.equal((await fetch(base + "/ui/app.js")).status, 404, "assets off");
    } finally {
      server.close();
    }
  } finally {
    restore();
  }
});

// ---------- write API (service level) ----------

test("update: partial patch preserves untouched fields", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { memory } = await svc.store(
    storeInput("original content", { scope: "/repo", tags: ["keep"], source: "unit" }),
  );
  const { memory: next } = await svc.update(memory.id, { importance: 5 });
  assert.equal(next.content, "original content");
  assert.equal(next.scope, "/repo");
  assert.deepEqual(next.tags, ["keep"]);
  assert.equal(next.source, "unit");
  assert.equal(next.importance, 5);
  assert.equal(next.id, memory.id);
});

test("update: content change snapshots history; idempotent empty patch rejected", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { memory } = await svc.store(storeInput("before the edit"));
  assert.equal((await svc.history({ id: memory.id })).versions.length, 1, "current only");

  await svc.update(memory.id, { content: "after the edit" });
  const hist = await svc.history({ id: memory.id });
  assert.equal(hist.versions.length, 2, "current + snapshot");
  assert.equal(hist.versions[1].content, "before the edit", "pre-image kept");
  assert.ok(hist.versions[0].diff.includes("+after the edit"));

  // No-op patch (no fields) is invalid input.
  await assert.rejects(
    () => svc.update(memory.id, {}),
    (e: RemembraError) => e.code === "INVALID_INPUT",
  );
  // Traversal scope is rejected at the schema layer.
  await assert.rejects(
    () => svc.update(memory.id, { scope: "../etc" }),
    (e: RemembraError) => e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => svc.update("ffffffffffff", { content: "x" }),
    (e: RemembraError) => e.code === "NOT_FOUND",
  );
});

test("update: scope change moves the file between trees (exactly one copy)", async () => {
  const { store, root } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { memory } = await svc.store(storeInput("mover"));

  const filesFor = async (): Promise<string[]> => {
    const all = await fs.readdir(root, { recursive: true, encoding: "utf8" });
    return all.filter((f) => f.includes(memory.id));
  };
  assert.equal((await filesFor()).length, 1, "one file before move");

  const { memory: moved } = await svc.update(memory.id, { scope: "/moved-project" });
  assert.equal(moved.scope, "/moved-project");
  const after = await filesFor();
  assert.equal(after.length, 1, "old tree entry unlinked — no dual-homing");
  assert.ok(after[0].includes("moved-project"), "file lives under the new scope");
  assert.equal((await store.all(true)).length, 1, "list still sees exactly one memory");

  // Content update with a stale vector: fail-open clears it (keyword fallback).
  const beforeVec = await store.get(memory.id);
  assert.ok(beforeVec);
  await store.update({ ...beforeVec, embedding: [1, 0] });
  const { memory: upd } = await svc.update(memory.id, { content: "changed again" });
  assert.equal(upd.embedding, undefined, "stale embedding dropped when re-embed is off");
});

test("archive/revive: lifecycle flips visibility in list and search", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { memory } = await svc.store(storeInput("lifecycle widget"));

  const archived = await svc.archive(memory.id);
  assert.ok(archived.memory.archivedAt, "archivedAt set");
  assert.equal((await svc.list({})).memories.length, 0, "list hides archived");
  assert.equal((await svc.list({ includeArchived: true })).memories.length, 1, "opt-in shows it");
  assert.equal((await svc.search({ query: "lifecycle widget" })).results.length, 0, "search hides it");

  await svc.revive(memory.id);
  assert.equal((await svc.list({})).memories.length, 1, "revive restores");
  assert.equal((await svc.search({ query: "lifecycle widget" })).results.length, 1);

  await assert.rejects(
    () => svc.archive("ffffffffffff"),
    (e: RemembraError) => e.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => svc.revive("ffffffffffff"),
    (e: RemembraError) => e.code === "NOT_FOUND",
  );
});

// ---------- write API (HTTP level) ----------

test("http: PUT patch, archive/revive routes, body validation", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const { server, base } = await startServer(svc, "k1");
  try {
    const created = await req(base, "POST", "/memories", {
      key: "k1",
      body: { type: "fact", content: "http patch me", scope: "global" },
    });
    assert.equal(created.status, 201);
    const id = (created.data?.memory as Memory).id;

    const patched = await req(base, "PUT", `/memories/${id}`, {
      key: "k1",
      body: { content: "patched", importance: 4, scope: "/proj" },
    });
    assert.equal(patched.status, 200);
    const pm = (patched.data?.memory as Memory);
    assert.equal(pm.content, "patched");
    assert.equal(pm.importance, 4);
    assert.equal(pm.scope, "/proj");

    assert.equal((await req(base, "PUT", `/memories/${id}`, { key: "k1", body: {} })).status, 400);
    assert.equal(
      (await req(base, "PUT", `/memories/${id}`, { key: "k1", body: { scope: "../x" } })).status,
      400,
    );
    assert.equal(
      (await req(base, "PUT", "/memories/ffffffffffff", { key: "k1", body: { content: "x" } })).status,
      404,
    );
    assert.equal((await req(base, "PUT", `/memories/${id}`, { body: { content: "x" } })).status, 401);

    const arch = await req(base, "POST", `/memories/${id}/archive`, { key: "k1" });
    assert.equal(arch.status, 200);
    const list = await req(base, "GET", "/memories", { key: "k1" });
    assert.equal((list.data?.total as number) ?? 0, 0, "archived hidden from default list");
    const rev = await req(base, "POST", `/memories/${id}/revive`, { key: "k1" });
    assert.equal(rev.status, 200);
    const list2 = await req(base, "GET", "/memories", { key: "k1" });
    assert.equal(list2.data?.total, 1, "revived visible again");

    assert.equal(
      (await req(base, "POST", "/memories/ffffffffffff/archive", { key: "k1" })).status,
      404,
    );
  } finally {
    server.close();
  }
});

test("http: snapshot export + idempotent import roundtrip into a fresh store", async () => {
  const { store } = await tempStore();
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  await svc.store(storeInput("alpha one"));
  await svc.store(storeInput("beta two", { type: "decision" }));
  const { server, base } = await startServer(svc, "k1");
  try {
    const snapRes = await fetch(base + "/snapshot");
    assert.equal(snapRes.status, 401, "export requires key");
    const snap = await (await fetch(base + "/snapshot", { headers: { "x-api-key": "k1" } })).json();
    assert.equal((snap as { format: string }).format, "remembra-export");
    assert.equal((snap as { memories: unknown[] }).memories.length, 2);

    // Re-import into the same store: idempotent (all skipped).
    const dup = await req(base, "POST", "/import", { key: "k1", body: snap });
    assert.equal(dup.status, 200);
    assert.deepEqual(dup.data, { imported: 0, skipped: 2 });

    // Fresh store: real restore.
    const { store: store2 } = await tempStore();
    const svc2 = new MemoryService(store2, { embeddingProvider: "none" });
    const second = await startServer(svc2, "k1");
    try {
      const r = await req(second.base, "POST", "/import", { key: "k1", body: snap });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { imported: 2, skipped: 0 });
      assert.equal((await svc2.list({})).memories.length, 2);
    } finally {
      second.server.close();
    }

    // Invalid snapshot: rejected whole-file, nothing written.
    const bad = await req(base, "POST", "/import", {
      key: "k1",
      body: { format: "remembra-export", version: 1, exportedAt: "x", memories: [{ bad: true }] },
    });
    assert.equal(bad.status, 400, "SNAPSHOT_INVALID → 400");
    assert.equal((await store.all(true)).length, 2, "atomic: nothing half-imported");
  } finally {
    server.close();
  }
});
