import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import type { MemoryBackend } from "../backend.js";
import type { Memory, StoreInput } from "../types.js";
import { defaultTrust } from "../types.js";
import { RemembraError, formatToolError, statusFor } from "../errors.js";
import type http from "node:http";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "remembra-p3-"));
}

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

const hex12 = () => randomUUID().replace(/-/g, "").slice(0, 12);

// --- MemoryBackend abstraction (audit: enable future DB swap) ---

class InMemoryBackend implements MemoryBackend {
  private map = new Map<string, Memory>();
  private now = () => new Date().toISOString();

  async store(input: StoreInput, embedding?: number[]): Promise<Memory> {
    const now = this.now();
    const provenance = { sourceType: input.provenance?.sourceType ?? "manual" } as const;
    const m: Memory = {
      id: hex12(),
      type: input.type,
      content: input.content,
      scope: input.scope,
      tags: input.tags,
      importance: input.importance,
      createdAt: now,
      updatedAt: now,
      version: 1,
      source: input.source,
      confidence: input.confidence ?? 1,
      trust: input.trust ?? defaultTrust(provenance),
      provenance,
      retention: input.retention,
      embedding,
    };
    this.map.set(m.id, m);
    return m;
  }
  async get(id: string): Promise<Memory | null> {
    return this.map.get(id) ?? null;
  }
  async all(includeArchived = false): Promise<Memory[]> {
    return [...this.map.values()].filter((m) => includeArchived || !m.archivedAt);
  }
  async update(m: Memory): Promise<Memory> {
    const u = { ...m, updatedAt: this.now() };
    this.map.set(u.id, u);
    return u;
  }
  async archive(id: string): Promise<Memory | null> {
    const m = await this.get(id);
    if (!m || m.archivedAt) return null;
    const u = { ...m, archivedAt: this.now(), updatedAt: this.now() };
    this.map.set(id, u);
    return u;
  }
  async revive(id: string): Promise<Memory | null> {
    const m = await this.get(id);
    if (!m || !m.archivedAt) return null;
    const u = { ...m, archivedAt: undefined, updatedAt: this.now() };
    this.map.set(id, u);
    return u;
  }
  async touch(id: string): Promise<void> {
    const m = await this.get(id);
    if (m) this.map.set(id, { ...m, lastSeen: this.now() });
  }
  async forget(id: string): Promise<boolean> {
    return this.map.delete(id);
  }
  async importMemory(m: Memory): Promise<boolean> {
    if (this.map.has(m.id)) return false;
    this.map.set(m.id, m);
    return true;
  }
}

test("service runs unchanged against a non-file backend (swappability)", async () => {
  const svc = new MemoryService(new InMemoryBackend(), { embeddingProvider: "none" });
  const { memory } = await svc.store(storeInput("portable fact", { type: "decision" }));
  assert.equal(memory.id.length, 12);

  const listed = await svc.list({});
  assert.equal(listed.memories.length, 1);

  const found = await svc.search({ query: "portable" });
  assert.equal(found.results.length, 1);
  // forget returns a plain boolean contract from any backend
  const gone = await svc.forget(memory.id);
  assert.equal(gone.ok, true);
  assert.equal((await svc.list({})).memories.length, 0);
});

// --- advisory file lock (audit: Phase 2 leftover) ---

test("lock file does not outlive operations", async () => {
  const dir = await tempDir();
  const store = new MemoryStore(dir);
  await store.store(storeInput("one"));
  await store.store(storeInput("two"));
  await assert.rejects(() => fs.access(path.join(dir, ".remembra.lock")), "lock released");
});

test("stale lock (dead pid) is stolen, op proceeds", async () => {
  const dir = await tempDir();
  // A pid that definitely existed and is now dead:
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.ok(dead.pid && dead.status === 0, "child ran to completion");
  const deadPid = dead.pid;
  await fs.writeFile(
    path.join(dir, ".remembra.lock"),
    JSON.stringify({ pid: deadPid, at: Date.now() }),
    "utf8",
  );

  const store = new MemoryStore(dir);
  const m = await store.store(storeInput("stolen through"));
  assert.equal(m.content, "stolen through");
  await assert.rejects(() => fs.access(path.join(dir, ".remembra.lock")), "lock released after steal");
});

test("live foreign lock → LOCK_TIMEOUT (typed error)", async () => {
  const dir = await tempDir();
  // pid 1 is alive on any Unix — never considered stale.
  await fs.writeFile(path.join(dir, ".remembra.lock"), JSON.stringify({ pid: 1, at: Date.now() }), "utf8");

  const store = new MemoryStore(dir, { lockTimeoutMs: 0 });
  await assert.rejects(
    () => store.store(storeInput("blocked")),
    (err: unknown) => err instanceof RemembraError && err.code === "LOCK_TIMEOUT" && /locked by pid 1/.test(err.message),
  );
});

test("HTTP surfaces LOCK_TIMEOUT as 423 with code", async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, ".remembra.lock"), JSON.stringify({ pid: 1, at: Date.now() }), "utf8");
  const store = new MemoryStore(dir, { lockTimeoutMs: 0 });
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const server: http.Server = createHttpServer(svc, { port: 0, apiKey: "k", host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({ type: "fact", content: "x" }),
    });
    assert.equal(res.status, 423);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "LOCK_TIMEOUT");
  } finally {
    server.close();
  }
});

test("mixed concurrent mutations never leave an id in both trees", async () => {
  const dir = await tempDir();
  const store = new MemoryStore(dir);
  const ids: string[] = [];
  for (let i = 0; i < 16; i++) ids.push((await store.store(storeInput(`mixed ${i}`))).id);

  // Interleave every mutation kind across the queue while files move trees.
  await Promise.all([
    store.archive(ids[0]),
    store.touch(ids[1]),
    store.update({ ...(await store.get(ids[2]))!, content: "updated" }),
    store.store(storeInput("new a")),
    store.archive(ids[3]),
    store.forget(ids[4]),
    store.touch(ids[5]),
    store.revive((await store.archive(ids[6])) ? ids[6] : ids[6]),
    store.store(storeInput("new b")),
    store.archive(ids[7]),
  ]);

  const active = (await fs.readdir(path.join(dir, "global")).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".md"),
  );
  const archived = await walkMd(path.join(dir, "archived"));
  const activeIds = active.map((f) => path.basename(f, ".md"));
  const archivedIds = archived.map((f) => path.basename(f, ".md"));
  for (const id of [...activeIds, ...archivedIds]) {
    const inActive = activeIds.includes(id);
    const inArchived = archivedIds.includes(id);
    assert.ok(!(inActive && inArchived), `id ${id} exists in both trees`);
  }
  // archive(ids[6]) then revive: exactly one copy, in the active tree.
  assert.ok(activeIds.includes(ids[6]) || archivedIds.includes(ids[6]));
});

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith(".md")) out.push(full);
    }
  }
  return out;
}

// --- crash recovery (audit: journal for crash recovery) ---

function frontmatter(id: string, opts: { updated: string; archivedAt?: string }): string {
  return `---\nid: ${id}\nversion: 1\ntype: fact\nscope: global\ntags: []\nimportance: 3\ncreated: ${opts.updated}\nupdated: ${opts.updated}\n${opts.archivedAt ? `archivedAt: ${opts.archivedAt}\n` : ""}---\n\ncontent for ${id}\n`;
}

test("recovery removes orphaned *.tmp files and logs once", async () => {
  const dir = await tempDir();
  const globalDir = path.join(dir, "global");
  await fs.mkdir(globalDir, { recursive: true });
  const tmpFile = path.join(globalDir, `${hex12()}.md.abc123.tmp`);
  await fs.writeFile(tmpFile, "half-written junk", "utf8");
  // Recovery's sweep is age-gated: only tmps past the stale-lock window are
  // provably abandoned — backdate to simulate an orphan from a real crash.
  const orphanAge = new Date(Date.now() - 60_000);
  await fs.utimes(tmpFile, orphanAge, orphanAge);

  const store = new MemoryStore(dir);
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(String(args[0]));
    orig(...(args as []));
  };
  try {
    await store.all();
  } finally {
    console.error = orig;
  }
  await assert.rejects(() => fs.access(tmpFile), "orphan tmp cleaned");
  assert.ok(
    lines.some((l) => l.includes("crash recovery") && l.includes("1 orphaned temp file")),
    `expected recovery log, got: ${JSON.stringify(lines)}`,
  );
  // Lock not left behind by the recovery pass either.
  await assert.rejects(() => fs.access(path.join(dir, ".remembra.lock")));
});

test("recovery: interrupted ARCHIVE keeps the archived copy (newer wins)", async () => {
  const dir = await tempDir();
  const id = hex12();
  const older = new Date(Date.now() - 60_000).toISOString();
  const newer = new Date().toISOString();
  await fs.mkdir(path.join(dir, "global"), { recursive: true });
  await fs.mkdir(path.join(dir, "archived", "global"), { recursive: true });
  // Crash between archive's write-to-archived and unlink-of-active:
  await fs.writeFile(path.join(dir, "global", `${id}.md`), frontmatter(id, { updated: older }), "utf8");
  await fs.writeFile(
    path.join(dir, "archived", "global", `${id}.md`),
    frontmatter(id, { updated: newer, archivedAt: newer }),
    "utf8",
  );

  const store = new MemoryStore(dir);
  const active = await store.all();
  const everything = await store.all(true);
  assert.equal(active.length, 0, "stale active twin removed");
  assert.equal(everything.length, 1, "exactly one copy remains");
  assert.equal(everything[0].archivedAt !== undefined, true, "archived copy won");
});

test("recovery: interrupted REVIVE keeps the active copy (newer wins)", async () => {
  const dir = await tempDir();
  const id = hex12();
  const older = new Date(Date.now() - 60_000).toISOString();
  const newer = new Date().toISOString();
  await fs.mkdir(path.join(dir, "global"), { recursive: true });
  await fs.mkdir(path.join(dir, "archived", "global"), { recursive: true });
  // Crash between revive's write-to-active and unlink-of-archived:
  await fs.writeFile(path.join(dir, "global", `${id}.md`), frontmatter(id, { updated: newer }), "utf8");
  await fs.writeFile(
    path.join(dir, "archived", "global", `${id}.md`),
    frontmatter(id, { updated: older, archivedAt: older }),
    "utf8",
  );

  const store = new MemoryStore(dir);
  const active = await store.all();
  const everything = await store.all(true);
  assert.equal(active.length, 1, "active copy kept");
  assert.equal(everything.length, 1, "archived twin removed");
  assert.equal(everything[0].id, id);
});

// --- structured error classification (audit: Phase 2 leftover) ---

test("traversal failure carries SCOPE_ESCAPES_ROOT", async () => {
  const store = new MemoryStore(await tempDir());
  await assert.rejects(
    () =>
      store.store({
        id: hex12(),
        type: "fact",
        content: "evil",
        scope: "../../../../etc",
        tags: [],
        importance: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never),
    (err: unknown) => err instanceof RemembraError && err.code === "SCOPE_ESCAPES_ROOT",
  );
});

test("service invalid input carries INVALID_INPUT (HTTP 400 + code)", async () => {
  const store = new MemoryStore(await tempDir());
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  await assert.rejects(
    () => svc.store({ type: "bogus", content: "x" }),
    (err: unknown) => err instanceof RemembraError && err.code === "INVALID_INPUT",
  );

  const server: http.Server = createHttpServer(svc, { port: 0, apiKey: "k", host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({ type: "bogus", content: "x" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "INVALID_INPUT");
  } finally {
    server.close();
  }
});

test("extraction failure carries LLM_ERROR and preserves the cause message", async () => {
  const store = new MemoryStore(await tempDir());
  const svc = new MemoryService(store, {
    embeddingProvider: "none",
    extractFn: async () => {
      throw new Error("LLM exploded");
    },
  });
  await assert.rejects(
    () => svc.digest({ transcript: "notes" }),
    (err: unknown) =>
      err instanceof RemembraError && err.code === "LLM_ERROR" && /LLM exploded/.test(err.message),
  );
});

test("snapshot rejection carries SNAPSHOT_INVALID", async () => {
  const store = new MemoryStore(await tempDir());
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  await assert.rejects(
    () => svc.importSnapshot({ format: "nope" }),
    (err: unknown) => err instanceof RemembraError && err.code === "SNAPSHOT_INVALID",
  );
});

test("formatToolError renders every failure class", async () => {
  assert.equal(formatToolError(new RemembraError("LOCK_TIMEOUT", "busy")), "[LOCK_TIMEOUT] busy");
  let zodErr: unknown;
  try {
    (await import("../types.js")).StoreInput.parse({ type: "bogus", content: "x" });
  } catch (e) {
    zodErr = e;
  }
  assert.match(formatToolError(zodErr), /^\[INVALID_INPUT\] /);
  assert.equal(formatToolError(new Error("boom")), "[INTERNAL] boom");
  assert.equal(formatToolError("string failure"), "[INTERNAL] string failure");
});

test("statusFor maps codes to the documented statuses", async () => {
  assert.equal(statusFor(new RemembraError("INVALID_INPUT", "x")), 400);
  assert.equal(statusFor(new RemembraError("SNAPSHOT_INVALID", "x")), 400);
  assert.equal(statusFor(new RemembraError("SCOPE_ESCAPES_ROOT", "x")), 400);
  assert.equal(statusFor(new RemembraError("NOT_FOUND", "x")), 404);
  assert.equal(statusFor(new RemembraError("CONFLICT", "x")), 409);
  assert.equal(statusFor(new RemembraError("LOCK_TIMEOUT", "x")), 423);
  assert.equal(statusFor(new RemembraError("IO_ERROR", "x")), 500);
  assert.equal(statusFor(new RemembraError("LLM_ERROR", "x")), 502);
});
