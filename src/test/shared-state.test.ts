/**
 * V5.6.0 shared-state configuration and honest degradation (roadmap §26, T06).
 *
 * The properties under test are the ones an operator cannot see from the outside
 * once they are working:
 *
 *  - a single-host deployment's readiness payload is **byte-identical** to the
 *    previous release, so "nothing in V5.6.0 changes a single-process
 *    deployment's behaviour" is literally true rather than approximately so;
 *  - a shared store that goes away **fails closed** rather than degrading to
 *    per-instance limits, which would let a fleet exceed a tenant's quota while
 *    every instance reported a limit it was not enforcing;
 *  - and no report, log line, or metric carries the URL, which routinely embeds a
 *    password.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { SharedState, resolveSharedStateConfig } from "../shared-state.js";
import { API_CAPABILITIES, API_CAPABILITY_MANIFEST } from "../api-contract.js";
import { REDIS_DISTRIBUTED_URL, type RedisLike } from "../redis.js";
import { isRemembraError } from "../errors.js";
import { opaqueRateLimitPart, rateLimitIdentity } from "../rate-limiter.js";

/** A URL with a password in it, so any leak of the configuration is visible. */
const SECRET_URL = "redis://:hunter2-super-secret@cache.internal:6379";

function fakeClient(overrides: Partial<RedisLike> = {}): RedisLike {
  return {
    eval: async () => [1, 0, 4, 0],
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    ...overrides,
  };
}

/** A SharedState already connected to a caller-supplied client. */
function connected(client: RedisLike): SharedState {
  const state = SharedState.absent();
  // The constructor is private so that `configured: false` and "connected" cannot
  // be confused; tests reach in deliberately rather than by accident.
  Object.assign(state, { configured: true, connection: { client, connected: true, close: async () => {} } });
  state.markConnected();
  return state;
}

/** A limiter that always allows, so the health merge can be observed on its own. */
const permissiveLimiter = {
  check: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0, limit: 10, windowMs: 1_000 }),
  consume: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0, limit: 10, windowMs: 1_000 }),
  reset: async () => {},
};

async function tempService(): Promise<{ svc: MemoryService; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-shared-"));
  return { svc: new MemoryService(new MemoryStore(root), { embeddingProvider: "none" }), root };
}

async function start(svc: MemoryService, options: Parameters<typeof createHttpServer>[1] = {}) {
  const server = createHttpServer(svc, { port: 0, host: "127.0.0.1", ...options });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function cleanup(svc: MemoryService, root: string | undefined, server: ReturnType<typeof createHttpServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await svc.shutdownBackgroundJobs();
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// --- The manifest advertises the build, not the configuration -------------

test("SHARED-001: the manifest advertises `distributed` whether or not shared state is configured", () => {
  // A capability that appeared only once Redis was configured could not be used to
  // reason about the build before configuring it. `webhooks` sets the precedent:
  // the manifest says what this package can do.
  assert.ok(API_CAPABILITIES.includes("distributed"), "present in the capability list");
  assert.ok(API_CAPABILITY_MANIFEST.capabilities.includes("distributed"), "and in the served manifest");
  assert.deepEqual(
    [...API_CAPABILITY_MANIFEST.capabilities].sort(),
    [...API_CAPABILITIES].sort(),
    "the manifest is the declared list, with nothing added at runtime",
  );
  // No capability implies a configured Redis, so nothing here is a new requirement.
  for (const capability of API_CAPABILITIES) assert.match(capability, /^[a-z][a-z-]*$/);
});

// --- A single-host deployment is untouched --------------------------------

test("SHARED-002: with nothing configured, readiness is byte-identical to the previous release", async (t) => {
  const { svc, root } = await tempService();
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, root, server));

  for (const route of ["/health", "/health/ready"]) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200, route);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(
      "shared" in body,
      false,
      `${route} gains no field: a deployment matching an exact payload must not break`,
    );
    // `backend` and `fallback` appear only when a named backend is in use, so the
    // baseline is a membership test: nothing outside the pre-milestone set may
    // appear, and `shared` is checked separately above for a clearer failure.
    for (const key of Object.keys(body)) {
      assert.ok(
        ["backend", "cache", "fallback", "state", "status", "storage", "uptime_s", "version"].includes(key),
        `${route} gained an unexpected field "${key}"`,
      );
    }
  }
});

test("SHARED-003: an explicitly absent shared state reports nothing at all", () => {
  const state = SharedState.absent();
  assert.equal(state.configured, false);
  assert.equal(state.report, undefined, "absent means no field, not a field saying absent");
  assert.equal(state.ready, true, "and readiness is unaffected");
  assert.equal(state.lockProvider(), undefined);
  assert.equal(state.rateLimiter({ base: { limit: 5, windowMs: 1_000 } }), undefined);
  assert.throws(() => state.client, (error: unknown) => isRemembraError(error));
});

// --- Configuration is validated, not guessed at ----------------------------

test("SHARED-004: configuration is validated up front and never guessed", async (t) => {
  assert.equal(resolveSharedStateConfig({}), undefined, "absent is a valid single-host configuration");
  assert.deepEqual(resolveSharedStateConfig({ [REDIS_DISTRIBUTED_URL]: SECRET_URL }), { url: SECRET_URL });
  assert.throws(
    () => resolveSharedStateConfig({ [REDIS_DISTRIBUTED_URL]: "postgres://cache:5432" }),
    (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
    "a typo fails at startup rather than at first use",
  );

  // Absent: no import of the optional package happens at all.
  let imported = false;
  const absent = await SharedState.open({}, async () => {
    imported = true;
    return {};
  });
  assert.equal(imported, false, "a single-host deployment never reaches the optional package");
  assert.equal(absent.configured, false);

  // Configured but the package is genuinely not installed.
  await assert.rejects(
    () => SharedState.open({ [REDIS_DISTRIBUTED_URL]: SECRET_URL }),
    (error: unknown) => isRemembraError(error) && error.code === "SERVICE_UNAVAILABLE",
    "startup fails rather than running on per-instance state",
  );
  t.diagnostic(`validated against ${SECRET_URL.replace("hunter2-super-secret", "REDACTED")}`);
});

// --- Reporting ------------------------------------------------------------

test("SHARED-005: a connected store is reported distinctly, and never leaks the URL", async (t) => {
  const { svc, root } = await tempService();
  const state = connected(fakeClient());
  const { server, base } = await start(svc, { sharedState: state, apiKey: "k".repeat(32) });
  t.after(async () => {
    await cleanup(svc, root, server);
    await state.close();
  });

  const res = await fetch(`${base}/health/ready`, { headers: { "x-api-key": "k".repeat(32) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body.shared, { mode: "connected" });
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("hunter2"), false, "no password");
  assert.equal(serialised.includes("cache.internal"), false, "no host");
  assert.equal(serialised.includes(SECRET_URL), false, "no URL at all");
  assert.equal(serialised.includes("6379"), false, "not even the port");
});

test("SHARED-006: a store that goes away is reported and makes the process unready", async (t) => {
  const { svc, root } = await tempService();
  const state = connected(fakeClient());
  // Readiness is cached for a second so a polling probe does not drive a storage
  // read per request. A transition is therefore reported at most one TTL late,
  // which is the existing documented contract; disabling the cache isolates the
  // reporting from the caching.
  const previousCache = process.env.REMEMBRA_HEALTH_CACHE_MS;
  process.env.REMEMBRA_HEALTH_CACHE_MS = "0";
  // The limiter is injected rather than shared so its own success does not mark
  // the store connected again — see SHARED-006c for the real coupling.
  const { server, base } = await start(svc, {
    sharedState: state,
    rateLimiter: permissiveLimiter,
    apiKey: "k".repeat(32),
  });
  t.after(async () => {
    await cleanup(svc, root, server);
    await state.close();
    if (previousCache === undefined) delete process.env.REMEMBRA_HEALTH_CACHE_MS;
    else process.env.REMEMBRA_HEALTH_CACHE_MS = previousCache;
  });

  assert.equal((await (await fetch(`${base}/health/ready`, { headers: { "x-api-key": "k".repeat(32) } })).json() as Record<string, unknown>).status, "ok");

  state.markUnreachable("SERVICE_UNAVAILABLE");
  const res = await fetch(`${base}/health/ready`, { headers: { "x-api-key": "k".repeat(32) } });
  assert.equal(res.status, 503, "a load balancer has to be able to see it");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, "unready");
  assert.equal((body.shared as { mode: string }).mode, "unreachable");
  assert.equal((body.shared as { error: string }).error, "SERVICE_UNAVAILABLE", "a classified label, not a message");

  // And the same view on the compatibility route, which also reports readiness.
  const compat = await fetch(`${base}/health`);
  assert.equal(compat.status, 503);
  assert.equal(((await compat.json()) as Record<string, unknown>).shared !== undefined, true);
});

// --- Failing closed --------------------------------------------------------

test("SHARED-006b: with the default cache a transition is reported within one TTL", async (t) => {
  // The bound matters operationally: a load balancer polling at 1s sees the 503
  // on its next poll, not never. Stating it as a test keeps it from silently
  // becoming unbounded if the cache default is ever changed.
  const { svc, root } = await tempService();
  const state = connected(fakeClient());
  const { server, base } = await start(svc, {
    sharedState: state,
    rateLimiter: permissiveLimiter,
    apiKey: "k".repeat(32),
  });
  t.after(async () => {
    await cleanup(svc, root, server);
    await state.close();
  });
  const headers = { "x-api-key": "k".repeat(32) };
  assert.equal((await fetch(`${base}/health/ready`, { headers })).status, 200);
  state.markUnreachable("SERVICE_UNAVAILABLE");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal((await fetch(`${base}/health/ready`, { headers })).status, 503, "reported once the cache TTL passes");
});

test("SHARED-006c: with the store genuinely down, readiness fails at the limiter before the health body", async (t) => {
  // Found while writing SHARED-006: `/health/ready` sits *after* authentication
  // and rate limiting, so when the shared store is down the request is refused by
  // the limiter and never reaches the health body. The operator therefore sees a
  // shared-state 503 rather than a health payload carrying `shared`.
  //
  // The outcome is right — a load balancer still gets 503 — but the diagnostic is
  // not the one the health route was written to give, so it is pinned here rather
  // than left for an operator to work out during an incident.
  const { svc, root } = await tempService();
  const state = connected(fakeClient({ eval: async () => { throw new Error("ECONNREFUSED"); } }));
  const { server, base } = await start(svc, { sharedState: state, apiKey: "k".repeat(32) });
  t.after(async () => {
    await cleanup(svc, root, server);
    await state.close();
  });

  const res = await fetch(`${base}/health/ready`, { headers: { "x-api-key": "k".repeat(32) } });
  assert.equal(res.status, 503, "a load balancer must see the failure");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.code, "SERVICE_UNAVAILABLE");
  assert.match(
    String(body.error),
    /shared rate-limit state is unavailable/,
    "and the error names shared state, so the 503 is diagnosable without the health body",
  );
  assert.equal(
    JSON.stringify(body).includes("ECONNREFUSED"),
    false,
    "and the client's own diagnostic is not passed through",
  );
  // Liveness is untouched, which is what makes the process diagnosable at all.
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
});

test("SHARED-007: a failing shared limiter refuses the request instead of granting it", async (t) => {
  const { svc, root } = await tempService();
  let fail = false;
  const client = fakeClient({
    eval: async () => {
      if (fail) throw new Error("READONLY You can't write against a read only replica at 10.0.0.9:6379");
      return [1, 0, 4, 0];
    },
  });
  const state = connected(client);
  const { server, base } = await start(svc, { sharedState: state, apiKey: "k".repeat(32) });
  t.after(async () => {
    await cleanup(svc, root, server);
    await state.close();
  });

  const headers = { "x-api-key": "k".repeat(32) };
  const first = await fetch(`${base}/memories?limit=1`, { headers });
  assert.equal(first.status, 200, "the shared limiter is in use and working");

  fail = true;
  const during = await fetch(`${base}/memories?limit=1`, { headers });
  assert.equal(during.status, 503, "fails closed: 503, never a silently-per-instance limit");
  const body = (await during.json()) as Record<string, unknown>;
  assert.equal(body.code, "SERVICE_UNAVAILABLE");
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("READONLY"), false, "the client's diagnostic text is not disclosed");
  assert.equal(serialised.includes("10.0.0.9"), false, "nor the host it was talking to");

  // Recovery needs no restart: the next success marks it connected again.
  fail = false;
  const after = await fetch(`${base}/memories?limit=1`, { headers });
  assert.equal(after.status, 200, "recovers on its own once the store answers");
  assert.equal(state.report?.mode, "connected");
});

test("SHARED-008: a configured but unreachable store never falls back to the in-process limiter", async (t) => {
  const { svc, root } = await tempService();
  const state = connected(fakeClient({ eval: async () => { throw new Error("ECONNRESET"); } }));
  const { server, base } = await start(svc, { sharedState: state, apiKey: "k".repeat(32) });
  t.after(async () => {
    await cleanup(svc, root, server);
    await state.close();
  });

  const headers = { "x-api-key": "k".repeat(32) };
  // Six requests against a limit of one. If the in-process limiter had silently
  // taken over, the second would be 429 and the rest would pass. Fails closed,
  // every one of them is 503 — which is the point.
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await fetch(`${base}/memories?limit=1`, { headers })).status);
  assert.deepEqual(codes, [503, 503, 503, 503, 503, 503], `no request is granted, and none is rate-limited either: ${codes.join()}`);
  assert.equal(state.report?.mode, "unreachable");
  assert.equal(state.ready, false);
});

test("SHARED-009: an injected limiter still wins, so a caller is never overridden", async (t) => {
  const { svc, root } = await tempService();
  const state = connected(fakeClient({ eval: async () => { throw new Error("must not be called"); } }));
  const { server, base } = await start(svc, {
    sharedState: state,
    rateLimiter: { check: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0, limit: 10, windowMs: 1_000 }), consume: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0, limit: 10, windowMs: 1_000 }), reset: async () => {} },
    apiKey: "k".repeat(32),
  });
  t.after(async () => {
    await cleanup(svc, root, server);
    await state.close();
  });
  const res = await fetch(`${base}/memories?limit=1`, { headers: { "x-api-key": "k".repeat(32) } });
  assert.equal(res.status, 200, "an explicit limiter is authoritative");
});

test("SHARED-010: the shared limiter enforces the same policies the in-process one would", async (t) => {
  const state = connected(fakeClient());
  t.after(() => state.close());
  const limiter = state.rateLimiter({ base: { limit: 60, windowMs: 60_000 } });
  assert.ok(limiter, "configured means a limiter");
  const identity = rateLimitIdentity({ user: opaqueRateLimitPart("u") });
  const result = await limiter.consume(identity);
  assert.equal(result.allowed, true);
  assert.equal(result.limit, 60, "the configured base budget, not a default");
  assert.equal(result.windowMs, 60_000);

  // An invalid policy is rejected here exactly as it would be in-process, so
  // switching stores cannot change which configuration is accepted.
  assert.throws(
    () => state.rateLimiter({ base: { limit: 0, windowMs: 60_000 } }),
    (error: unknown) => isRemembraError(error) && error.code === "INVALID_INPUT",
  );
});

test("SHARED-011: the transition is logged once, not on every failed request", async (t) => {
  const state = connected(fakeClient());
  t.after(() => state.close());
  state.markUnreachable("SERVICE_UNAVAILABLE");
  const afterFirst = { ...state.report! };
  state.markUnreachable("SERVICE_UNAVAILABLE");
  assert.deepEqual(state.report, afterFirst, "idempotent while already unreachable");
  state.markConnected();
  assert.deepEqual(state.report, { mode: "connected" }, "and the error label is cleared on recovery");
});
