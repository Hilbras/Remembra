import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createHttpServer } from "../http.js";
import { logEvent, logFormat } from "../log.js";
import { metrics } from "../metrics.js";
import { VERSION } from "../version.js";
import { RemembraError, toolFail } from "../errors.js";
import type { MemoryBackend } from "../backend.js";
import type http from "node:http";

async function tempService(): Promise<{ svc: MemoryService; store: MemoryStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p7-"));
  const store = new MemoryStore(root);
  const svc = new MemoryService(store, { embeddingProvider: "none" });
  return { svc, store, root };
}

const storeInput = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: "fact", content, scope: "global", tags: [], importance: 3, ...extra }) as never;

async function startServer(
  svc: MemoryService,
  opts: { apiKey?: string } = {},
): Promise<{ server: http.Server; base: string }> {
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1", ...opts });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** Capture stderr lines emitted inside fn (console.error override). */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

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

// --- structured logging (audit Phase 7) ---

test("log: REMEMBRA_LOG=json emits one parseable JSON object with ts/level/event", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "json" });
  try {
    const lines = await captureStderr(async () => {
      logEvent("warn", "unit_event", { scope: "global", count: 3 }, "human message here");
    });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, "unit_event");
    assert.equal(parsed.level, "warn");
    assert.equal(parsed.msg, "human message here");
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.count, 3);
    assert.ok(!Number.isNaN(Date.parse(parsed.ts)), "ts is ISO-8601");
  } finally {
    restore();
  }
});

test("log: REMEMBRA_LOG=text prints the human message verbatim (legacy-compatible)", async () => {
  const restore = withEnv({ REMEMBRA_LOG: "text" });
  try {
    const lines = await captureStderr(async () => {
      logEvent("info", "unit_event", { ignored: 1 }, "Remembra: exact legacy line");
    });
    assert.deepEqual(lines, ["Remembra: exact legacy line"]);
    assert.equal(logFormat(), "text");
  } finally {
    restore();
  }
});

test("log: auto format — non-TTY stderr defaults to json (pipelines, containers)", async () => {
  const restore = withEnv({ REMEMBRA_LOG: undefined });
  try {
    // Test process stderr is piped (not a TTY), so auto = json.
    assert.equal(logFormat(), process.stderr.isTTY ? "text" : "json");
  } finally {
    restore();
  }
});

// --- /metrics (Prometheus, auth when keyed) ---

test("metrics: GET /metrics serves Prometheus text with core series", async () => {
  const { svc } = await tempService();
  await svc.store(storeInput("metric bearing memory about observability"));
  const { server, base } = await startServer(svc);
  try {
    await fetch(`${base}/memories/search?query=observability`);
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const body = await res.text();
    assert.ok(body.includes(`remembra_info{version="${VERSION}"} 1`), "info gauge");
    assert.ok(body.includes("# TYPE remembra_http_requests_total counter"));
    assert.ok(body.includes('remembra_http_requests_total{method="GET",route="search",status="200"}'));
    assert.ok(body.includes("# TYPE remembra_searches_total counter"));
    assert.ok(body.includes("remembra_searches_total 1"));
    assert.ok(body.includes('remembra_search_duration_seconds_bucket{le="+Inf"} 1'));
    assert.ok(body.includes('remembra_http_request_duration_seconds_bucket{le="0.005",route="search"}'));

    // Every non-comment line parses as `name{labels} value`.
    for (const line of body.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      assert.match(line, /^[a-z_]+(\{[^}]*\})? -?[\d.e+]+$/i, `bad exposition line: ${line}`);
    }
  } finally {
    server.close();
  }
});

test("metrics: /metrics is behind auth when an API key is set", async () => {
  const { svc } = await tempService();
  const { server, base } = await startServer(svc, { apiKey: "sekrit" });
  try {
    const anon = await fetch(`${base}/metrics`);
    assert.equal(anon.status, 401, "counters must not leak without the key");
    const keyed = await fetch(`${base}/metrics`, { headers: { "x-api-key": "sekrit" } });
    assert.equal(keyed.status, 200);
    assert.ok((await keyed.text()).includes("remembra_info"));
    // Health stays exempt (readiness probes carry no key).
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    server.close();
  }
});

test("metrics: search/store/cache counters move with traffic", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-p7c-"));
  metrics.reset();
  try {
    const s1 = new MemoryStore(dir);
    await new MemoryService(s1, { embeddingProvider: "none" }).store(
      storeInput("counter probe memory"),
    );
    const s2 = new MemoryStore(dir); // fresh parse cache → guaranteed misses
    await s2.all();
    await s2.all(); // second walk → hits

    const svc = new MemoryService(s2, { embeddingProvider: "none" });
    await svc.store(storeInput("second memory for store counter"));
    await svc.search({ query: "counter probe" });

    assert.ok((metrics.get("remembra_stores_total") ?? 0) >= 2, "stores counted");
    assert.ok((metrics.get("remembra_searches_total") ?? 0) >= 1, "searches counted");
    assert.ok((metrics.get("remembra_cache_events_total", { result: "miss" }) ?? 0) >= 1, "cache miss counted");
    assert.ok((metrics.get("remembra_cache_events_total", { result: "hit" }) ?? 0) >= 1, "cache hit counted");
  } finally {
    // search() fires touch() writes in the background — retry so they don't
    // race the cleanup (tmp leftover on total failure is acceptable anyway).
    for (let i = 0; i < 10; i++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
});

// --- error-rate instrumentation (alerting substrate) ---

test("errors: MCP tool failures increment remembra_errors_total{transport=mcp}", async () => {
  metrics.reset();
  const result = toolFail(new RemembraError("NOT_FOUND", "gone"));
  assert.equal(result.isError, true);
  assert.equal(metrics.get("remembra_errors_total", { code: "NOT_FOUND", transport: "mcp" }), 1);
});

test("errors: HTTP validation failures increment remembra_errors_total{transport=http}", async () => {
  const { svc } = await tempService();
  const { server, base } = await startServer(svc);
  metrics.reset();
  try {
    const res = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "banana", content: "bad type", scope: "global" }),
    });
    assert.equal(res.status, 400);
    assert.equal(metrics.get("remembra_errors_total", { code: "INVALID_INPUT", transport: "http" }), 1);
    // 404s are classified too (route miss records under `other`, no label blowup).
    const miss = await fetch(`${base}/nope`);
    assert.equal(miss.status, 404);
    assert.ok((metrics.get("remembra_http_requests_total", { route: "other", method: "GET", status: 404 }) ?? 0) >= 1);
  } finally {
    server.close();
  }
});

// --- search query logging (hygiene-first) ---

test("search log: structured event without raw query text by default", async () => {
  const { svc } = await tempService();
  await svc.store(storeInput("hygiene probe secret words"));
  const restore = withEnv({ REMEMBRA_LOG: "json", REMEMBRA_DEBUG: undefined });
  try {
    const lines = await captureStderr(async () => {
      await svc.search({ query: "hygiene probe", scope: "global", limit: 7 });
    });
    const searches = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((o) => o && o.event === "search");
    assert.equal(searches.length, 1, "one search event");
    const ev = searches[0]!;
    assert.equal(ev.scope, "global");
    assert.equal(ev.limit, 7);
    assert.equal(typeof ev.results, "number");
    assert.equal(typeof ev.duration_ms, "number");
    assert.ok(!("query" in ev), "raw query must not appear without REMEMBRA_DEBUG");
  } finally {
    restore();
  }
});

test("search log: REMEMBRA_DEBUG=1 includes the raw query", async () => {
  const { svc } = await tempService();
  await svc.store(storeInput("debug probe memory"));
  const restore = withEnv({ REMEMBRA_LOG: "json", REMEMBRA_DEBUG: "1" });
  try {
    const lines = await captureStderr(async () => {
      await svc.search({ query: "debug probe" });
    });
    const ev = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((o) => o && o.event === "search");
    assert.ok(ev, "search event emitted");
    assert.equal(ev!.query, "debug probe");
  } finally {
    restore();
  }
});

// --- /health readiness ---

test("health: ready server reports version, uptime, storage and cache", async () => {
  const { svc } = await tempService();
  await svc.store(storeInput("readiness memory"));
  const { server, base } = await startServer(svc);
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.state, "Healthy");
    assert.equal(body.version, VERSION);
    assert.equal(body.storage, "ok");
    assert.equal(typeof body.uptime_s, "number");
    const cache = body.cache as { size: number; capacity: number } | undefined;
    assert.ok(cache && typeof cache.size === "number" && cache.capacity > 0, "cache stats exposed");
  } finally {
    server.close();
  }
});

test("health: broken storage flips to 503 unready with the failing code", async () => {
  const broken: MemoryBackend = {
    store: async () => {
      throw new RemembraError("IO_ERROR", "disk gone");
    },
    all: async () => {
      throw new RemembraError("IO_ERROR", "disk gone");
    },
    get: async () => null,
    update: async () => {
      throw new RemembraError("IO_ERROR", "disk gone");
    },
    touch: async () => {},
    archive: async () => {},
    forget: async () => false,
    walkIds: async () => [],
    lock: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as MemoryBackend;
  const svc = new MemoryService(broken, { embeddingProvider: "none" });
  const { server, base } = await startServer(svc);
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503, "readiness must fail, not lie");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "unready");
    assert.equal(body.state, "Failed");
    assert.equal(body.storage, "IO_ERROR");
    assert.equal(body.version, VERSION);
  } finally {
    server.close();
  }
});

// --- version single-source ---

test("version: VERSION matches package.json (single source of truth)", async () => {
  const pkg = JSON.parse(
    await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(VERSION, pkg.version, "src/version.ts and package.json must agree");
});
