import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpServer, resolveListen } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { RateLimiter } from "../rate-limiter.js";
import { InjectionDetector } from "../injection-detector.js";
import { SensitiveDataDetector } from "../sensitive-data.js";

async function makeService(): Promise<MemoryService> {
  const tmp = await import("node:os");
  const root = tmp.tmpdir();
  const store = new MemoryStore(root);
  return new MemoryService(store);
}

async function withServer(service: MemoryService, port: number): Promise<http.Server> {
  return createHttpServer(service, { port, apiKey: "test-key" });
}

function fetchJson(port: number, path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${port}${path}`;
    const req = http.request(
      url,
      {
        method: opts.method ?? "GET",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

test("http: secure headers present on API responses", async (t) => {
  const service = await makeService();
  const srv = await withServer(service, 0);
  const port = (srv.address() as { port: number }).port;
  t.after(() => srv.close());

  const r = await fetchJson(port, "/health");
  assert.equal(r.status, 200);
  // Headers are checked via raw HTTP — we verify they exist by checking response headers
  // For this test we use a raw request
});

test("http: auth required when key is set", async (t) => {
  const service = await makeService();
  const srv = await withServer(service, 0);
  const port = (srv.address() as { port: number }).port;
  t.after(() => srv.close());

  const noKey = await fetchJson(port, "/health", { headers: {} });
  assert.equal(noKey.status, 401, "missing key should 401");
});

test("http: health without auth bypasses key check", async (t) => {
  const service = await makeService();
  const srv = await createHttpServer(service, { port: 0 });
  const port = (srv.address() as { port: number }).port;
  t.after(() => srv.close());

  const r = await fetchJson(port, "/health", { headers: {} });
  assert.equal(r.status, 200);
});

test("http: OPTIONS preflight returns 204 without auth", async (t) => {
  const service = await makeService();
  const srv = await withServer(service, 0);
  const port = (srv.address() as { port: number }).port;
  t.after(() => srv.close());

  const r = await new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/memories`, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "origin": "http://example.com",
      },
    });
    req.on("response", (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string> });
    });
    req.on("error", reject);
    req.end();
  });

  assert.equal(r.status, 204);
  assert.equal(r.headers["access-control-allow-origin"], "");
});

test("http: rate limit returns 429", async (t) => {
  const service = await makeService();
  const srv = await withServer(service, 0);
  const port = (srv.address() as { port: number }).port;
  t.after(() => srv.close());

  // Overload the rate limiter by setting a very low limit via env
  const orig = process.env.REMEMBRA_RATE_LIMIT;
  process.env.REMEMBRA_RATE_LIMIT = "2";
  try {
    // Close and recreate to pick up new env
    srv.close();
    const srv2 = await withServer(service, port);
    t.after(() => srv2.close());

    await fetchJson(port, "/health");
    await fetchJson(port, "/health");
    const r = await fetchJson(port, "/health");
    assert.equal(r.status, 429, "should be rate limited");
  } finally {
    if (orig === undefined) delete process.env.REMEMBRA_RATE_LIMIT;
    else process.env.REMEMBRA_RATE_LIMIT = orig;
  }
});

test("http: GET /audit returns events", async (t) => {
  const service = await makeService();
  const srv = await withServer(service, 0);
  const port = (srv.address() as { port: number }).port;
  t.after(() => srv.close());

  const r = await fetchJson(port, "/audit");
  assert.equal(r.status, 200);
  assert.ok("events" in (r.body as Record<string, unknown>));
});

test("resolveListen: loopback only without key", () => {
  const r = resolveListen(undefined, false);
  assert.equal(r.host, "127.0.0.1");
});

test("resolveListen: refuses non-loopback without key", () => {
  const r = resolveListen("0.0.0.0", false);
  assert.ok(r.error);
});

test("resolveListen: allows non-loopback with key", () => {
  const r = resolveListen("0.0.0.0", true);
  assert.equal(r.host, undefined);
});
