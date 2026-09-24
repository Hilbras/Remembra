import Database from "better-sqlite3";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBatchIdempotencyStore, batchIdempotencyFingerprint, batchIdempotencyScope } from "../batch-idempotency-store.js";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { createTenantContext } from "../tenant.js";
import { RemembraError } from "../errors.js";
import { FileRecoveryStateStore } from "../recovery-state-store.js";

async function temporaryRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function expectCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

test("batch idempotency records replay durably and rejects a changed request", async () => {
  const root = await temporaryRoot("remembra-idempotency-store-");
  try {
    const firstStore = new FileBatchIdempotencyStore(path.join(root, "claims"));
    const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-001", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
    assert.deepEqual(await firstStore.claim(input), { status: "fresh" });
    await firstStore.complete({ ...input, response: { operation: "store", ids: ["m1"] } });
    const claimFiles = await fs.readdir(path.join(root, "claims"));
    assert.ok(claimFiles.includes("claims.sqlite"));
    assert.ok(claimFiles.includes("claims.key"));
    assert.ok(claimFiles.every((file) => !/batch-001|tenant:alpha/.test(file)));
    const claimText = await fs.readFile(firstStore.databasePath, "utf8");
    assert.doesNotMatch(claimText, /batch-001|tenant:alpha/);

    const restartedStore = new FileBatchIdempotencyStore(path.join(root, "claims"));
    assert.deepEqual(await restartedStore.claim({ ...input, fingerprint: batchIdempotencyFingerprint("fingerprint-a") }), {
      status: "replay",
      response: { operation: "store", ids: ["m1"] },
    });
    await assert.rejects(
      () => restartedStore.claim({ ...input, fingerprint: batchIdempotencyFingerprint("fingerprint-b") }),
      expectCode("CONFLICT"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch idempotency fails closed while a claim is in progress", async () => {
  const root = await temporaryRoot("remembra-idempotency-progress-");
  try {
    const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
    const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-002", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    await assert.rejects(() => store.claim(input), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch idempotency rejects tampered claim records", async () => {
  const root = await temporaryRoot("remembra-idempotency-tamper-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
  const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-tamper", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
  try {
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    const database = new Database(store.databasePath);
    database.prepare("UPDATE batch_idempotency_claims SET mac = ?").run("tampered");
    database.close();
    await assert.rejects(() => store.claim(input), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an empty replacement database cannot reset the ledger identity", async () => {
  const root = await temporaryRoot("remembra-idempotency-replaced-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
  try {
    await store.claim({ scope: batchIdempotencyScope("tenant:alpha"), key: "batch-replaced", fingerprint: batchIdempotencyFingerprint("fingerprint-a") });
    store.close();
    await fs.rm(store.databasePath, { force: true });
    const replacement = new Database(store.databasePath);
    replacement.close();
    assert.throws(() => new FileBatchIdempotencyStore(path.join(root, "claims")), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy SQLite ledgers migrate by invalidating old claims", async () => {
  const root = await temporaryRoot("remembra-idempotency-migrate-");
  const claimsRoot = path.join(root, "claims");
  await fs.mkdir(claimsRoot, { recursive: true, mode: 0o700 });
  const databasePath = path.join(claimsRoot, "claims.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE batch_idempotency_meta (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
    INSERT INTO batch_idempotency_meta (id, generation) VALUES (1, 7);
    CREATE TABLE batch_idempotency_claims (
      scope_hash TEXT NOT NULL, key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER,
      response TEXT, response_bytes INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL,
      mac TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(scope_hash, key_hash)
    );
  `);
  legacy.close();
  await fs.chmod(databasePath, 0o600);
  const store = new FileBatchIdempotencyStore(claimsRoot);
  try {
    assert.deepEqual(await store.claim({ scope: batchIdempotencyScope("tenant:alpha"), key: "batch-migrated", fingerprint: batchIdempotencyFingerprint("fingerprint-a") }), { status: "fresh" });
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch idempotency authenticates generation metadata", async () => {
  const root = await temporaryRoot("remembra-idempotency-generation-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
  const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-generation", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
  try {
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    const database = new Database(store.databasePath);
    database.prepare("UPDATE batch_idempotency_meta SET generation = 0 WHERE id = 1").run();
    database.close();
    await assert.rejects(() => store.claim(input), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch idempotency refuses to strand a completed mutation on oversized responses", async () => {
  const root = await temporaryRoot("remembra-idempotency-oversized-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"), { maxBytes: 1024 });
  const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-oversized", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
  try {
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    await assert.rejects(
      () => store.complete({ ...input, response: { text: "x".repeat(2000) } }),
      expectCode("SERVICE_UNAVAILABLE"),
    );
    await assert.rejects(() => store.claim(input), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch idempotency coordinates capacity across concurrent claims", async () => {
  const root = await temporaryRoot("remembra-idempotency-capacity-");
  try {
    const store = new FileBatchIdempotencyStore(path.join(root, "claims"), { maxEntries: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        store.claim({ scope: batchIdempotencyScope("tenant:alpha"), key: `batch-${index}`, fingerprint: batchIdempotencyFingerprint(`fingerprint-${index}`) }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.status === "fresh").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 7);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("completed idempotency claims never expire into fresh mutations", async () => {
  const root = await temporaryRoot("remembra-idempotency-no-expiry-");
  let now = Date.now();
  try {
    const store = new FileBatchIdempotencyStore(path.join(root, "claims"), { now: () => now });
    const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-never-expires", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    await store.complete({ ...input, response: { operation: "store" } });
    store.close();
    now += 365 * 24 * 60 * 60 * 1000;
    const restarted = new FileBatchIdempotencyStore(path.join(root, "claims"), { now: () => now });
    assert.deepEqual(await restarted.claim(input), { status: "replay", response: { operation: "store" } });
    restarted.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restore gate blocks claims until successful completion", async () => {
  const root = await temporaryRoot("remembra-idempotency-gate-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
  const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-gate", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
  try {
    await store.beginRestore();
    await assert.rejects(() => store.beginRestore(), expectCode("SERVICE_UNAVAILABLE"));
    assert.equal(store.restorePending, true);
    await assert.rejects(() => store.claim(input), expectCode("SERVICE_UNAVAILABLE"));
    await store.completeRestore();
    assert.equal(store.restorePending, false);
    assert.deepEqual(await store.claim(input), { status: "fresh" });
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalidating idempotency state prevents replay after a data restore", async () => {
  const root = await temporaryRoot("remembra-idempotency-invalidate-");
  try {
    const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
    const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-invalidate", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    await store.complete({ ...input, response: { operation: "store" } });
    await store.invalidate();
    assert.deepEqual(await store.claim(input), { status: "fresh" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch idempotency refuses a symlinked claim directory", async () => {
  const root = await temporaryRoot("remembra-idempotency-symlink-");
  const outside = await temporaryRoot("remembra-idempotency-outside-");
  try {
    await fs.symlink(outside, path.join(root, "claims"));
    assert.throws(
      () => new FileBatchIdempotencyStore(path.join(root, "claims")),
      expectCode("SERVICE_UNAVAILABLE"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("batch idempotency never expires an in-progress claim into a duplicate write", async () => {
  const root = await temporaryRoot("remembra-idempotency-expiry-");
  const claimRoot = path.join(root, "claims");
  try {
    let now = Date.now();
    const store = new FileBatchIdempotencyStore(claimRoot, { now: () => now });
    const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "batch-stuck", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    now += 120_000;

    const restarted = new FileBatchIdempotencyStore(claimRoot, { now: () => now });
    await assert.rejects(() => restarted.claim(input), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP batch idempotency is scoped after authentication", async () => {
  const root = await temporaryRoot("remembra-idempotency-http-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const server = createHttpServer(service, { port: 0, apiKey: "http-idempotency-key" });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/memories/batch`;
    const headers = {
      "content-type": "application/json",
      "x-api-key": "http-idempotency-key",
      "idempotency-key": "http-batch-001",
    };
    const body = JSON.stringify({ operation: "store", items: [{ type: "fact", content: "http once" }] });
    const first = await fetch(endpoint, { method: "POST", headers, body });
    const replay = await fetch(endpoint, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    const firstBody = await first.json() as { results: Array<{ id?: string }>; execution: { idempotency: string } };
    const replayBody = await replay.json() as { results: Array<{ id?: string }>; execution: { idempotency: string } };
    assert.equal(firstBody.results[0]?.id, replayBody.results[0]?.id);
    assert.equal(replayBody.execution.idempotency, "replayed");
    assert.equal((await service.list({})).memories.length, 1);

    const invalid = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "bad key" },
      body,
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch replay rechecks current tenant membership before returning a result", async () => {
  const root = await temporaryRoot("remembra-idempotency-reauth-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  let valid = true;
  const tenant = createTenantContext({
    organizationId: "org-alpha",
    userId: "user-alpha",
    membershipVersion: "1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write"],
  });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    verifyTenantContext: async () => valid,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const options = { idempotencyKey: "batch-reauth", idempotencyScope: "a".repeat(64), tenant };
  try {
    await service.batch({ operation: "store", items: [{ type: "fact", content: "authorized once" }] }, options);
    valid = false;
    await assert.rejects(
      () => service.batch({ operation: "store", items: [{ type: "fact", content: "authorized once" }] }, options),
      expectCode("TENANT_REQUIRED"),
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ambiguous batch outcomes remain fail-closed instead of becoming replayable failures", async () => {
  const root = await temporaryRoot("remembra-idempotency-ambiguous-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const backend = new MemoryStore(path.join(root, "memories"));
  const originalStore = backend.store.bind(backend);
  (backend as unknown as { store: typeof backend.store }).store = async (input, embedding, tenant) => {
    await originalStore(input, embedding, tenant);
    throw new RemembraError("IO_ERROR", "write outcome is unknown");
  };
  const service = new MemoryService(backend, {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const options = { idempotencyKey: "batch-ambiguous", idempotencyScope: batchIdempotencyScope("test-client") };
  const request = { operation: "store" as const, items: [{ type: "fact" as const, content: "possibly written" }] };
  try {
    await assert.rejects(() => service.batch(request, options), expectCode("SERVICE_UNAVAILABLE"));
    assert.equal((await service.list({})).memories.length, 1);
    await assert.rejects(() => service.batch(request, options), expectCode("SERVICE_UNAVAILABLE"));
    assert.equal((await service.list({})).memories.length, 1);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host credential scopes isolate idempotency keys without using IP addresses", async () => {
  const root = await temporaryRoot("remembra-idempotency-credential-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const server = createHttpServer(service, {
    port: 0,
    resolveCredentialScope: (req) => String(req.headers["x-credential-id"] ?? "unknown"),
  });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/memories/batch`;
    const body = JSON.stringify({ operation: "store", items: [{ type: "fact", content: "credential isolated" }] });
    const first = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "same-key", "x-credential-id": "credential-a" }, body });
    const second = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "same-key", "x-credential-id": "credential-b" }, body });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await service.list({})).memories.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keyed local HTTP batches require an isolated credential scope", async () => {
  const root = await temporaryRoot("remembra-idempotency-local-scope-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const server = createHttpServer(service, { port: 0 });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/memories/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "local-key" },
      body: JSON.stringify({ operation: "store", items: [{ type: "fact", content: "no credential scope" }] }),
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keyed batches refresh durable recovery state before claiming", async () => {
  const root = await temporaryRoot("remembra-idempotency-recovery-refresh-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const statePath = path.join(root, ".recovery-state.json");
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    recoveryStateStore: new FileRecoveryStateStore(statePath),
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  try {
    await service.initializeRecovery();
    const operatorState = new FileRecoveryStateStore(statePath);
    await operatorState.write("ReadOnly", "read_only");
    await assert.rejects(
      () => service.batch(
        { operation: "store", items: [{ type: "fact", content: "must be blocked" }] },
        { idempotencyKey: "batch-recovery-refresh", idempotencyScope: batchIdempotencyScope("test-client") },
      ),
      expectCode("SERVICE_UNAVAILABLE"),
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an unavailable optional ledger preserves unkeyed batches and fails keyed calls closed", async () => {
  const root = await temporaryRoot("remembra-idempotency-optional-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), { embeddingProvider: "none" });
  try {
    const unkeyed = await service.batch({ operation: "store", items: [{ type: "fact", content: "still available" }] });
    assert.equal(unkeyed.summary.succeeded, 1);
    await assert.rejects(
      () => service.batch(
        { operation: "store", items: [{ type: "fact", content: "keyed unavailable" }] },
        { idempotencyKey: "optional-key", idempotencyScope: batchIdempotencyScope("optional") },
      ),
      expectCode("SERVICE_UNAVAILABLE"),
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MemoryService replays a durable batch without creating duplicate memories", async () => {
  const root = await temporaryRoot("remembra-idempotency-service-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const options = { idempotencyKey: "batch-003", idempotencyScope: batchIdempotencyScope("test-client") };
  try {
    const first = await service.batch({
      operation: "store",
      items: [{ type: "fact", content: "written once" }],
    }, options);
    const replay = await service.batch({
      operation: "store",
      items: [{ type: "fact", content: "written once" }],
    }, options);

    assert.equal(first.summary.succeeded, 1);
    assert.equal(replay.summary.succeeded, 1);
    assert.equal(replay.results[0]?.id, first.results[0]?.id);
    assert.equal((replay.execution as { idempotency: string }).idempotency, "replayed");
    assert.equal((await service.list({})).memories.length, 1);

    const deleteKey = { idempotencyKey: "batch-delete", idempotencyScope: batchIdempotencyScope("test-client") };
    const deleted = await service.batch({ operation: "delete", ids: [first.results[0]?.id ?? ""] }, deleteKey);
    const deletedReplay = await service.batch({ operation: "delete", ids: [first.results[0]?.id ?? ""] }, deleteKey);
    assert.equal(deletedReplay.results[0]?.id, deleted.results[0]?.id);
    assert.equal((deletedReplay.execution as { idempotency: string }).idempotency, "replayed");

    await assert.rejects(
      () => service.batch({
        operation: "store",
        items: [{ type: "fact", content: "different request" }],
      }, options),
      expectCode("CONFLICT"),
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
