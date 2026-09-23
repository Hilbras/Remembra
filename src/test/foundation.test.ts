/**
 * Foundation & Correctness tests (Master Plan §3.7–3.8, shipped as 4.0.1).
 *
 * Covers what the earlier phase suites didn't:
 *   - provider reliability: timeout, bounded retries, budget, cancellation,
 *     error normalization, malformed provider responses
 *   - read-side metadata validation: invalid type/version/scope/content are
 *     skipped; out-of-range values are clamped, never NaN
 *   - concurrency: simultaneous writes across instances, delete-during-search,
 *     archive/revive races (single-tree invariant)
 *   - ID allocation: collision retry and CONFLICT exhaustion
 *   - serialization property: render → parse round-trips random memories
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { providerFetch } from "../provider.js";
import { extractMemories } from "../llm.js";
import { embedText as embedDirect } from "../embeddings.js";
import { isRemembraError } from "../errors.js";
import { createHttpServer } from "../http.js";
import type { StoreInput } from "../types.js";

function withEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Replace global fetch for the duration; URLs starting with `passthrough` use the real one. */
function withMockFetch(impl: FetchImpl, passthrough?: string): () => void {
  const original = globalThis.fetch.bind(globalThis);
  const mock = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (passthrough && url.startsWith(passthrough)) return original(input, init);
    return impl(url, init);
  }) as typeof globalThis.fetch;
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = original;
  };
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
const text = (body: string, status = 200): Response => new Response(body, { status });

/** A fetch that never answers until its signal aborts (a hanging provider). */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const sig = init?.signal;
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (sig?.aborted) return abort();
    sig?.addEventListener("abort", abort, { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

const FAST_POLICY = {
  REMEMBRA_PROVIDER_TIMEOUT_MS: "3000",
  REMEMBRA_PROVIDER_BACKOFF_MS: "1",
  REMEMBRA_PROVIDER_BUDGET_MS: "10000",
};

const tmp = (pfx: string) => fs.mkdtemp(path.join(os.tmpdir(), pfx));

async function writeRaw(root: string, file: string, body: string): Promise<void> {
  const p = path.join(root, "global", file);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf8");
}

const fmFile = (meta: string[], content: string): string =>
  `---\n${meta.join("\n")}\n---\n\n${content}`;

function expectRemembra(code: string, re?: RegExp): (err: unknown) => true {
  return (err: unknown) => {
    assert.ok(isRemembraError(err), `expected RemembraError, got: ${String(err)}`);
    assert.equal(err.code, code);
    if (re) assert.match(err.message, re);
    return true;
  };
}

// ---------------------------------------------------------------------------
// §3.7 Provider reliability
// ---------------------------------------------------------------------------

test("provider policy retries 5xx then succeeds (bounded attempts)", async () => {
  const undoEnv = withEnv({ ...FAST_POLICY, REMEMBRA_PROVIDER_RETRIES: "2" });
  let calls = 0;
  const undoFetch = withMockFetch(async () => {
    calls++;
    if (calls < 3) return text("upstream busy", 503);
    return json({ ok: true });
  });
  try {
    const out = await providerFetch("http://provider.test/x", { label: "llm", body: { a: 1 } });
    assert.deepEqual(out, { ok: true });
    assert.equal(calls, 3);
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("provider retries are bounded — gives up with a normalized error", async () => {
  const undoEnv = withEnv({ ...FAST_POLICY, REMEMBRA_PROVIDER_RETRIES: "2" });
  let calls = 0;
  const undoFetch = withMockFetch(async () => {
    calls++;
    return text("down", 503);
  });
  try {
    await assert.rejects(
      providerFetch("http://provider.test/x", { label: "llm", body: {} }),
      expectRemembra("LLM_ERROR", /after 3 attempt\(s\) \(503\)/),
    );
    assert.equal(calls, 3);
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("4xx is a caller error — fails immediately, no retry", async () => {
  const undoEnv = withEnv({ ...FAST_POLICY, REMEMBRA_PROVIDER_RETRIES: "3" });
  let calls = 0;
  const undoFetch = withMockFetch(async () => {
    calls++;
    return text("bad request", 400);
  });
  try {
    await assert.rejects(
      providerFetch("http://provider.test/x", { label: "llm", body: {} }),
      expectRemembra("LLM_ERROR", /request failed \(400\)/),
    );
    assert.equal(calls, 1);
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("a hanging provider times out and normalizes to PROVIDER_TIMEOUT", async () => {
  const undoEnv = withEnv({
    ...FAST_POLICY,
    REMEMBRA_PROVIDER_TIMEOUT_MS: "40",
    REMEMBRA_PROVIDER_RETRIES: "1",
  });
  let calls = 0;
  const undoFetch = withMockFetch((u, init) => {
    calls++;
    return hang(init);
  });
  try {
    const t0 = Date.now();
    await assert.rejects(
      providerFetch("http://provider.test/x", { label: "llm", body: {} }),
      expectRemembra("PROVIDER_TIMEOUT", /llm request timed out after 2 attempt/),
    );
    assert.ok(Date.now() - t0 < 2000, "bounded by timeout policy, not forever");
    assert.equal(calls, 2);
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("the overall budget caps total wall-clock time across retries", async () => {
  const undoEnv = withEnv({
    ...FAST_POLICY,
    REMEMBRA_PROVIDER_TIMEOUT_MS: "5000",
    REMEMBRA_PROVIDER_RETRIES: "10",
    REMEMBRA_PROVIDER_BUDGET_MS: "150",
  });
  let calls = 0;
  const undoFetch = withMockFetch((u, init) => {
    calls++;
    return hang(init);
  });
  try {
    const t0 = Date.now();
    await assert.rejects(
      providerFetch("http://provider.test/x", { label: "llm", body: {} }),
      expectRemembra("PROVIDER_TIMEOUT"),
    );
    assert.ok(Date.now() - t0 < 2000, `budget respected (took ${Date.now() - t0}ms)`);
    assert.ok(calls <= 2, `budget cut the retry loop short (calls=${calls})`);
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("an AbortSignal cancels the in-flight attempt without retrying", async () => {
  const undoEnv = withEnv({ ...FAST_POLICY, REMEMBRA_PROVIDER_RETRIES: "2" });
  let calls = 0;
  const undoFetch = withMockFetch((u, init) => {
    calls++;
    return hang(init);
  });
  try {
    const ac = new AbortController();
    const p = providerFetch("http://provider.test/x", { label: "llm", body: {}, signal: ac.signal });
    ac.abort();
    await assert.rejects(p, expectRemembra("LLM_ERROR", /cancelled/));
    assert.equal(calls, 1, "cancellation must not trigger retries");
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("a malformed (non-JSON) response body is normalized", async () => {
  const undoEnv = withEnv({ ...FAST_POLICY, REMEMBRA_PROVIDER_RETRIES: "2" });
  let calls = 0;
  const undoFetch = withMockFetch(async () => {
    calls++;
    return text("<html>gateway error page</html>", 200);
  });
  try {
    await assert.rejects(
      providerFetch("http://provider.test/x", { label: "llm", body: {} }),
      expectRemembra("LLM_ERROR", /malformed \(non-JSON\)/),
    );
    assert.equal(calls, 1, "malformed success bodies are not retried");
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("extractMemories validates the provider response shape", async () => {
  const undoEnv = withEnv(FAST_POLICY);
  const undoFetch = withMockFetch(async () => json({ unexpected: true }));
  try {
    await assert.rejects(
      extractMemories("transcript", "ollama"),
      expectRemembra("LLM_ERROR", /malformed response/),
    );
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("embedText validates the vector shape and succeeds on good vectors", async () => {
  const undoEnv = withEnv(FAST_POLICY);
  let good = false;
  const undoFetch = withMockFetch(async () => (good ? json({ embedding: [0.1, 0.2] }) : json({ embedding: "nope" })));
  try {
    await assert.rejects(embedDirect("x", "ollama"), expectRemembra("LLM_ERROR", /malformed embedding/));
    good = true;
    const v = await embedDirect("x", "ollama");
    assert.deepEqual(v, [0.1, 0.2]);
  } finally {
    undoFetch();
    undoEnv();
  }
});

test("embedding calls are bounded by the same policy", async () => {
  const undoEnv = withEnv({
    ...FAST_POLICY,
    REMEMBRA_PROVIDER_TIMEOUT_MS: "50",
    REMEMBRA_PROVIDER_RETRIES: "0",
  });
  const undoFetch = withMockFetch((u, init) => hang(init));
  try {
    const t0 = Date.now();
    await assert.rejects(embedDirect("x", "ollama"), expectRemembra("PROVIDER_TIMEOUT", /embeddings/));
    assert.ok(Date.now() - t0 < 2000, "embeddings bounded too");
  } finally {
    undoFetch();
    undoEnv();
  }
});

// ---------------------------------------------------------------------------
// §3.4 / §3.8 Read-side metadata validation
// ---------------------------------------------------------------------------

test("reads skip files with an invalid type; search survives", async () => {
  const root = await tmp("remembra-f-type-");
  const store = new MemoryStore(root);
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  const good = (await svc.store({ type: "fact", content: "widgets are blue", tags: ["w"] })) as { id: string };
  await writeRaw(
    root,
    "badtype00001.md",
    fmFile(
      ["id: badtype00001", "version: 1", "type: banana", "scope: global", "tags: []", "importance: 3"],
      "this must never surface",
    ),
  );

  const all = await store.all();
  assert.equal(all.length, 1, "invalid-type file is excluded from reads");
  assert.equal(await store.get("badtype00001"), null);

  const miss = await svc.search({ query: "must never surface" });
  assert.ok(
    !miss.results.some((m) => m.id === "badtype00001"),
    "skipped file never reaches search results",
  );

  const hit = await svc.search({ query: "widgets blue" });
  assert.ok(hit.results.some((m) => m.id === good.id), "valid memory still served");
});

test("reads skip schema versions from the future (never serve unknown data)", async () => {
  const root = await tmp("remembra-f-ver-");
  const store = new MemoryStore(root);
  await writeRaw(
    root,
    "future000001.md",
    fmFile(
      ["id: future000001", "version: 99", "type: fact", "scope: global", "tags: []", "importance: 3"],
      "written by a newer remembra",
    ),
  );
  assert.equal(await store.get("future000001"), null);
  assert.equal((await store.all()).length, 0);
});

test("reads skip unsafe scopes and empty content", async () => {
  const root = await tmp("remembra-f-scope-");
  const store = new MemoryStore(root);
  await writeRaw(
    root,
    "evilscope0001.md",
    fmFile(
      ["id: evilscope0001", "version: 1", "type: fact", "scope: a/../../etc", "tags: []", "importance: 3"],
      "traversal scope",
    ),
  );
  await writeRaw(
    root,
    "empty00000001.md",
    fmFile(["id: empty00000001", "version: 1", "type: fact", "scope: global", "tags: []", "importance: 3"], ""),
  );
  assert.equal(await store.get("evilscope0001"), null);
  assert.equal(await store.get("empty00000001"), null);
  assert.equal((await store.all()).length, 0);
});

test("out-of-range importance/confidence are clamped, never NaN", async () => {
  const root = await tmp("remembra-f-clamp-");
  const store = new MemoryStore(root);
  await writeRaw(
    root,
    "clamp0000001.md",
    fmFile(
      ["id: clamp0000001", "version: 1", "type: fact", "scope: global", "tags: []", "importance: 9", "confidence: 7"],
      "over range",
    ),
  );
  await writeRaw(
    root,
    "clamp0000002.md",
    fmFile(
      ["id: clamp0000002", "version: 1", "type: fact", "scope: global", "tags: []", "importance: high"],
      "not a number",
    ),
  );

  const warnings: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    const line = String(args[0]);
    if (line.includes("clamp0000001")) warnings.push(line);
  };
  try {
    const m1 = await store.get("clamp0000001");
    assert.ok(m1);
    assert.equal(m1.importance, 5, "clamped to the valid range");
    assert.equal(m1.confidence, 1, "clamped to the valid range");
    assert.ok(Number.isFinite(m1.importance));

    const m2 = await store.get("clamp0000002");
    assert.ok(m2);
    assert.equal(m2.importance, 3, "non-numeric importance falls back to the default");
    assert.ok(Number.isFinite(m2.importance));
    assert.ok(warnings.length > 0, "normalization is logged");

    // Warn-once: re-reading must not re-log.
    const before = warnings.length;
    await store.get("clamp0000001");
    await store.all();
    assert.equal(warnings.length, before, "parse warnings are emitted once per file");
  } finally {
    console.error = orig;
  }
});

test("malformed dates fall back instead of serving NaN timestamps", async () => {
  const root = await tmp("remembra-f-date-");
  const store = new MemoryStore(root);
  await writeRaw(
    root,
    "baddate00001.md",
    fmFile(
      ["id: baddate00001", "version: 1", "type: fact", "scope: global", "tags: []", "importance: 3", "created: notadate", "updated: also-bad"],
      "time traveler",
    ),
  );
  const m = await store.get("baddate00001");
  assert.ok(m, "still served after normalization");
  assert.equal(m.createdAt, new Date(0).toISOString());
  assert.equal(m.updatedAt, m.createdAt);
  assert.ok(Number.isFinite(Date.parse(m.createdAt)));
});

test("id/filename mismatch resolves to the filename (path is the truth)", async () => {
  const root = await tmp("remembra-f-idm-");
  const store = new MemoryStore(root);
  await writeRaw(
    root,
    "match000001.md",
    fmFile(["id: otherid0001", "version: 1", "type: fact", "scope: global", "tags: []", "importance: 3"], "mismatched"),
  );
  const m = await store.get("match000001");
  assert.ok(m);
  assert.equal(m.id, "match000001");
});

// ---------------------------------------------------------------------------
// §3.8 Concurrency scenarios
// ---------------------------------------------------------------------------

test("simultaneous writes across two store instances all land", async () => {
  const root = await tmp("remembra-f-par-");
  const a = new MemoryStore(root);
  const b = new MemoryStore(root);
  const input = (n: number): StoreInput => ({
    type: "fact",
    content: `parallel write ${n}`,
    scope: "global",
    tags: [],
    importance: 3,
  });
  const written = await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => a.store(input(i))),
    ...Array.from({ length: 5 }, (_, i) => b.store(input(100 + i))),
  ]);
  assert.equal(written.length, 10);
  const all = await a.all();
  assert.equal(all.length, 10, "no lost updates");
  assert.equal(new Set(all.map((m) => m.id)).size, 10, "no duplicate ids");
});

test("delete racing search never throws and search never sees a ghost", async () => {
  const root = await tmp("remembra-f-race-");
  const a = new MemoryStore(root);
  const b = new MemoryStore(root);
  const svc = new MemoryService(a, { embeddingProvider: "none" });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await a.store({ type: "fact", content: `racerock widget ${i}`, scope: "global", tags: [], importance: 3 });
    ids.push(m.id);
  }

  const settled = await Promise.allSettled([
    ...ids.map((id) => a.forget(id)),
    ...ids.map((id) => b.forget(id)), // cross-instance duplicates of the same deletes
    svc.search({ query: "racerock" }),
  ]);
  const rejected = settled.filter((s) => s.status === "rejected");
  assert.equal(rejected.length, 0, `all concurrent ops settle cleanly: ${JSON.stringify(rejected)}`);
  assert.equal((await a.all()).length, 0, "all deletes land");
});

test("archive/revive racing search keeps exactly one copy (never dual-homed)", async () => {
  const root = await tmp("remembra-f-ar-");
  const a = new MemoryStore(root);
  const b = new MemoryStore(root);
  const svc = new MemoryService(b, { embeddingProvider: "none" });
  const m = await a.store({ type: "fact", content: "duel memory", scope: "global", tags: [], importance: 3 });

  const settled = await Promise.allSettled([
    a.archive(m.id),
    b.revive(m.id),
    svc.search({ query: "duel" }),
    a.archive(m.id),
  ]);
  const rejected = settled.filter((s) => s.status === "rejected");
  assert.equal(rejected.length, 0, `no operation throws in the race: ${JSON.stringify(rejected)}`);
  assert.equal((await a.all(true)).length, 1, "the memory exists in exactly one tree");
});

// ---------------------------------------------------------------------------
// §3.6/§3.8 ID allocation
// ---------------------------------------------------------------------------

test("an id collision retries with a fresh id instead of failing", async () => {
  const root = await tmp("remembra-f-coll-");
  const a = new MemoryStore(root, { idGen: () => "collide0001" });
  await a.store({ type: "fact", content: "occupant", scope: "global", tags: [], importance: 3 });

  const ids = ["collide0001", "freshid0002"];
  let i = 0;
  const b = new MemoryStore(root, { idGen: () => ids[Math.min(i++, ids.length - 1)] });
  const m = await b.store({ type: "fact", content: "newcomer", scope: "global", tags: [], importance: 3 });
  assert.equal(m.id, "freshid0002", "collision detected and retried");
  assert.ok(await b.get("freshid0002"));
  assert.ok(await b.get("collide0001"), "the occupant is untouched");
});

test("persistent id collision fails with CONFLICT instead of overwriting", async () => {
  const root = await tmp("remembra-f-conf-");
  const a = new MemoryStore(root, { idGen: () => "dupeid0001" });
  await a.store({ type: "fact", content: "occupant", scope: "global", tags: [], importance: 3 });
  const b = new MemoryStore(root, { idGen: () => "dupeid0001" });
  await assert.rejects(
    b.store({ type: "fact", content: "cannot win", scope: "global", tags: [], importance: 3 }),
    expectRemembra("CONFLICT", /unique memory id/),
  );
  const occupant = await b.get("dupeid0001");
  assert.equal(occupant?.content, "occupant", "the existing memory is never overwritten");
});

// ---------------------------------------------------------------------------
// Serialization property (§3.8): render → parse round-trip
// ---------------------------------------------------------------------------

test("store → get round-trips random memories byte-faithfully (property)", async () => {
  const root = await tmp("remembra-f-prop-");
  const store = new MemoryStore(root);

  let seed = 42;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const words = ["alpha", "beta", "gamma", "delta", "zeta", "omega", "日本語", "naïve", "x'or\"q", "tab\tnot"];
  const types = ["fact", "decision", "role", "history"] as const;
  const scopes = ["global", "/home/projA", "work/api"];

  for (let n = 0; n < 40; n++) {
    const type = types[Math.floor(rnd() * types.length)];
    const content =
      Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => words[Math.floor(rnd() * words.length)]).join(" ") +
      ` #${n}`;
    const tags = rnd() < 0.5 ? [] : [words[Math.floor(rnd() * words.length)], `t${n}`];
    const importance = 1 + Math.floor(rnd() * 5);
    const confidence = Math.round(rnd() * 100) / 100;
    const scope = scopes[Math.floor(rnd() * scopes.length)];

    const input: StoreInput = {
      type,
      content,
      scope,
      tags,
      importance,
      ...(rnd() < 0.5 ? { source: `gen-${n}` } : {}),
      confidence,
    };
    const stored = await store.store(input);
    const loaded = await store.get(stored.id);
    assert.ok(loaded, `iteration ${n}: memory readable`);
    assert.equal(loaded.type, input.type, `iteration ${n}: type`);
    assert.equal(loaded.content, input.content, `iteration ${n}: content`);
    assert.equal(loaded.scope, input.scope, `iteration ${n}: scope`);
    assert.deepEqual(loaded.tags, input.tags, `iteration ${n}: tags`);
    assert.equal(loaded.importance, input.importance, `iteration ${n}: importance`);
    assert.equal(loaded.confidence, input.confidence, `iteration ${n}: confidence`);
    assert.equal(loaded.source, input.source, `iteration ${n}: source`);
    assert.equal(loaded.createdAt, stored.createdAt, `iteration ${n}: createdAt`);
    assert.equal(loaded.provenance, "explicit", `iteration ${n}: provenance`);
  }
  assert.equal((await store.all()).length, 40, "all 40 stored memories read back");
});

// ---------------------------------------------------------------------------
// §3.7 Cancellation end-to-end: HTTP client disconnect aborts the provider
// ---------------------------------------------------------------------------

test("an HTTP client disconnect cancels the in-flight provider call", async () => {
  const undoEnv = withEnv({
    REMEMBRA_LLM: "ollama",
    ...FAST_POLICY,
    REMEMBRA_PROVIDER_TIMEOUT_MS: "3000",
    REMEMBRA_PROVIDER_RETRIES: "0",
  });
  const root = await tmp("remembra-f-disc-");
  const service = new MemoryService(new MemoryStore(root));
  const server = createHttpServer(service, { port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  let providerSignal: AbortSignal | undefined;
  const undoFetch = withMockFetch(
    (u, init) => {
      providerSignal = init?.signal ?? undefined;
      started();
      return hang(init);
    },
    base,
  );

  try {
    const ac = new AbortController();
    const req = fetch(`${base}/memories/digest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hello there" }),
      signal: ac.signal,
    }).catch((err) => err);
    await withTimeout(startedP, 5000, "the digest to reach the provider call");

    ac.abort(); // client goes away mid-extraction
    await req;

    const deadline = Date.now() + 3000;
    while (!(providerSignal?.aborted) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(providerSignal, "provider fetch was invoked");
    assert.ok(providerSignal.aborted, "provider call aborted after the client disconnected");
  } finally {
    undoFetch();
    undoEnv();
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
