/**
 * V5.1.0 health routes (roadmap §20): liveness, readiness, storage, and
 * provider, with the compatibility of `/health` preserved.
 *
 * The properties that matter most here are the ones an operator cannot see: that
 * liveness stays truthful and cheap when storage is broken, that the
 * authenticated routes really do require the key, and that no health response
 * ever carries memory content, a path, or a provider diagnostic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { RemembraError } from "../errors.js";
import { VERSION } from "../version.js";
import type { MemoryBackend } from "../backend.js";

async function tempService(): Promise<{ svc: MemoryService; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-health-"));
  return { svc: new MemoryService(new MemoryStore(root), { embeddingProvider: "none" }), root };
}

function withEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Wrap a backend so a test can count how often a readiness scan runs. */
function countingBackend(inner: MemoryBackend, counter: { all: number }): MemoryBackend {
  return {
    ...inner,
    all: async (...args: Parameters<MemoryBackend["all"]>) => {
      counter.all++;
      return inner.all(...args);
    },
  } as MemoryBackend;
}

/** A backend whose reads fail, with a message that must never be disclosed. */
function brokenBackend(message: string): MemoryBackend {
  return {
    store: async () => {
      throw new RemembraError("IO_ERROR", message);
    },
    all: async () => {
      throw new RemembraError("IO_ERROR", message);
    },
    get: async () => null,
    update: async () => {
      throw new RemembraError("IO_ERROR", message);
    },
    touch: async () => {},
    archive: async () => {},
    forget: async () => false,
    walkIds: async () => [],
    lock: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as MemoryBackend;
}

async function start(
  svc: MemoryService,
  options: Parameters<typeof createHttpServer>[1] = {},
): Promise<{ server: ReturnType<typeof createHttpServer>; base: string }> {
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

test("HEALTH-001: /health keeps its compatibility shape", async (t) => {
  const { svc, root } = await tempService();
  await svc.store({ type: "fact", content: "a memory that must not appear in health output" });
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, root, server));

  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.state, "Healthy");
  assert.equal(body.version, VERSION);
  assert.equal(body.storage, "ok");
  assert.equal(typeof body.uptime_s, "number");
  const cache = body.cache as { size: number; capacity: number } | undefined;
  assert.ok(cache && typeof cache.size === "number" && cache.capacity > 0, "cache stats still exposed");
  assert.equal(JSON.stringify(body).includes("must not appear"), false, "no memory content in health output");
});

test("HEALTH-002: /health still reports 503 with the classified label when storage is broken", async (t) => {
  const svc = new MemoryService(brokenBackend("/srv/secret/path is on fire"), { embeddingProvider: "none" });
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, undefined, server));

  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 503, "readiness must fail, not lie");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, "unready");
  assert.equal(body.storage, "IO_ERROR", "the classified label, not the message");
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("on fire"), false, "the error message is not disclosed");
  assert.equal(serialised.includes("/srv/secret/path"), false, "nor is the storage path");
});

test("HEALTH-003: liveness stays 200 when readiness is 503, and touches no storage", async (t) => {
  // This is the property that makes liveness worth having: a probe on an
  // untrusted path must not be reporting the same thing as readiness.
  const svc = new MemoryService(brokenBackend("disk gone"), { embeddingProvider: "none" });
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, undefined, server));

  const ready = await fetch(`${base}/health`);
  assert.equal(ready.status, 503);
  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200, "the process is alive even when storage is not");
  const body = (await live.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.version, VERSION);
  assert.equal(body.storage, undefined, "liveness reports no dependency state");
  assert.equal(body.state, undefined, "and no recovery state");
});

test("HEALTH-004: liveness reports draining once shutdown begins", async (t) => {
  const { svc, root } = await tempService();
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, root, server));

  const before = (await (await fetch(`${base}/health/live`)).json()) as Record<string, unknown>;
  assert.equal(before.draining, false);
  svc.beginShutdown();
  const after = (await (await fetch(`${base}/health/live`)).json()) as Record<string, unknown>;
  assert.equal(after.draining, true, "an orchestrator can drain the instance before it exits");
});

test("HEALTH-005: the dependency routes require the API key when one is configured", async (t) => {
  const { svc, root } = await tempService();
  const { server, base } = await start(svc, { apiKey: "health-secret" });
  t.after(() => cleanup(svc, root, server));

  for (const route of ["/health/ready", "/health/storage", "/health/provider"]) {
    const anonymous = await fetch(`${base}${route}`);
    assert.equal(anonymous.status, 401, `${route} must not be public`);
    const authorised = await fetch(`${base}${route}`, { headers: { "x-api-key": "health-secret" } });
    assert.equal(authorised.status, 200, `${route} answers an authenticated caller`);
  }
  // Liveness stays public: a probe cannot be expected to hold a credential.
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("HEALTH-006: the dependency routes are open when no key is configured", async (t) => {
  const { svc, root } = await tempService();
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, root, server));

  for (const route of ["/health/ready", "/health/storage", "/health/provider"]) {
    assert.equal((await fetch(`${base}${route}`)).status, 200, `${route} on a local install`);
  }
});

test("HEALTH-007: /health/storage reports backend detail and no content", async (t) => {
  const { svc, root } = await tempService();
  await svc.store({ type: "fact", content: "confidential content that must stay out of health output" });
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, root, server));

  const body = (await (await fetch(`${base}/health/storage`)).json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.storage, "ok");
  assert.equal(body.state, "Healthy");
  assert.equal(JSON.stringify(body).includes("confidential"), false, "no memory content");
  assert.equal(JSON.stringify(body).includes(root), false, "no storage path");
});

test("HEALTH-007b: backend identity and fallback are reported when the service knows them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-health-backend-"));
  const svc = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    backend: "file",
    backendFallback: true,
  });
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, root, server));

  const body = (await (await fetch(`${base}/health/storage`)).json()) as Record<string, unknown>;
  assert.equal(body.backend, "file");
  assert.equal(body.fallback, true, "a fallback deployment says so");
  const cache = body.cache as { size: number; capacity: number } | undefined;
  assert.ok(cache && cache.capacity > 0, "cache occupancy is bounded state, not content");
});

test("HEALTH-008: /health/provider reports configuration and never a key or diagnostic", async (t) => {
  const restore = withEnv({
    REMEMBRA_EMBEDDINGS: "none",
    REMEMBRA_LLM: "openai",
    OPENAI_API_KEY: "sk-live-must-never-appear-anywhere",
  });
  const { svc, root } = await tempService();
  const { server, base } = await start(svc);
  t.after(async () => {
    restore();
    await cleanup(svc, root, server);
  });

  const body = (await (await fetch(`${base}/health/provider`)).json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.embeddings, "none", "the resolved provider name is reported");
  assert.equal(body.embeddingsAvailable, false, "keyword-only is a capability fact, not a failure");
  assert.equal(body.optional, true, "providers are never required for local readiness");
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("sk-live"), false, "no provider key");
  assert.equal(serialised.includes("must-never-appear"), false, "nor any part of it");
});

test("HEALTH-009: provider health reports the injected provider, not the environment", async (t) => {
  const restore = withEnv({ REMEMBRA_EMBEDDINGS: "none" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-health-provider-"));
  const svc = new MemoryService(new MemoryStore(root), { embeddingProvider: "ollama" });
  const { server, base } = await start(svc);
  t.after(async () => {
    restore();
    await cleanup(svc, root, server);
  });

  const body = (await (await fetch(`${base}/health/provider`)).json()) as Record<string, unknown>;
  assert.equal(body.embeddings, "ollama", "reports the provider actually in use");
  assert.equal(body.embeddingsAvailable, true);
});

test("HEALTH-010: repeated readiness probes within the cache window cost one scan", async (t) => {
  const restore = withEnv({ REMEMBRA_HEALTH_CACHE_MS: "5000" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-health-cache-"));
  const counter = { all: 0 };
  const svc = new MemoryService(countingBackend(new MemoryStore(root) as unknown as MemoryBackend, counter), {
    embeddingProvider: "none",
  });
  const { server, base } = await start(svc);
  t.after(async () => {
    restore();
    await cleanup(svc, root, server);
  });

  for (let i = 0; i < 25; i++) assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal(counter.all, 1, "an unauthenticated caller cannot drive a storage scan per request");
});

test("HEALTH-011: concurrent probes share a single check", async (t) => {
  const restore = withEnv({ REMEMBRA_HEALTH_CACHE_MS: "5000" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-health-flight-"));
  const counter = { all: 0 };
  const svc = new MemoryService(countingBackend(new MemoryStore(root) as unknown as MemoryBackend, counter), {
    embeddingProvider: "none",
  });
  const { server, base } = await start(svc);
  t.after(async () => {
    restore();
    await cleanup(svc, root, server);
  });

  const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/health`)));
  for (const res of responses) assert.equal(res.status, 200);
  assert.equal(counter.all, 1, "a burst of probes costs one check, not twenty");
});

test("HEALTH-012: the cache can be disabled for a deployment that needs live answers", async (t) => {
  const restore = withEnv({ REMEMBRA_HEALTH_CACHE_MS: "0" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-health-nocache-"));
  const counter = { all: 0 };
  const svc = new MemoryService(countingBackend(new MemoryStore(root) as unknown as MemoryBackend, counter), {
    embeddingProvider: "none",
  });
  const { server, base } = await start(svc);
  t.after(async () => {
    restore();
    await cleanup(svc, root, server);
  });

  await fetch(`${base}/health`);
  await fetch(`${base}/health`);
  await fetch(`${base}/health`);
  assert.equal(counter.all, 3, "REMEMBRA_HEALTH_CACHE_MS=0 means every probe checks");
});

test("HEALTH-013: a readiness failure is still cached, so a broken disk is not hammered", async (t) => {
  const restore = withEnv({ REMEMBRA_HEALTH_CACHE_MS: "5000" });
  const svc = new MemoryService(brokenBackend("disk gone"), { embeddingProvider: "none" });
  const { server, base } = await start(svc);
  t.after(async () => {
    restore();
    await cleanup(svc, undefined, server);
  });

  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503, "the cached failure is still reported as a failure");
  }
});

test("HEALTH-014: the versioned routes behave identically to the unversioned ones", async (t) => {
  const { svc, root } = await tempService();
  const { server, base } = await start(svc);
  t.after(() => cleanup(svc, root, server));

  for (const route of ["/health", "/health/live", "/health/ready", "/health/storage", "/health/provider"]) {
    const res = await fetch(`${base}/api/v1${route}`);
    assert.equal(res.status, 200, `/api/v1${route}`);
    assert.equal(res.headers.get("x-remembra-api-version"), "v1", "the contract header is set");
  }
});
