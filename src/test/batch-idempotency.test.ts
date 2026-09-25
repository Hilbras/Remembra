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

test("legacy SQLite ledgers fail closed instead of resetting completed keys", async () => {
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
  try {
    assert.throws(() => new FileBatchIdempotencyStore(claimsRoot), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
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

test("restore gate records whether a data restore or tenant migration owns it", async () => {
  const root = await temporaryRoot("remembra-idempotency-gate-reason-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
  try {
    assert.equal(store.restoreReason, undefined);
    await store.beginRestore("migration");
    assert.equal(store.restoreReason, "migration");
    await store.completeRestore();
    assert.equal(store.restoreReason, undefined);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an unsafe restore marker cannot clear claims and reports an operator action", async () => {
  const root = await temporaryRoot("remembra-idempotency-unsafe-marker-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
  const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "unsafe-marker", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
  try {
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    await store.complete({ ...input, response: { operation: "store" } });
    await store.beginRestore();
    const marker = path.join(root, "claims", "restore.pending");
    await fs.unlink(marker);
    await fs.mkdir(marker);
    await assert.rejects(() => store.completeRestore(), /unsafe|move aside/i);
    await assert.rejects(() => store.claim({ ...input, fingerprint: batchIdempotencyFingerprint("changed") }), expectCode("SERVICE_UNAVAILABLE"));
    await fs.rmdir(marker);
    await store.completeRestore();
    assert.equal(store.restorePending, false);
  } finally {
    if (store.restorePending) {
      const marker = path.join(root, "claims", "restore.pending");
      await fs.rm(marker, { recursive: true, force: true }).catch(() => {});
      await store.completeRestore().catch(() => {});
    }
    store.close();
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

test("an older claim ledger is migrated in place without losing replay history", async () => {
  const root = await temporaryRoot("remembra-idempotency-legacy-schema-");
  const claims = path.join(root, "claims");
  const store = new FileBatchIdempotencyStore(claims);
  const databasePath = store.databasePath;
  const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "legacy-key", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
  await store.claim(input);
  await store.complete({ ...input, response: { operation: "store", ids: ["m1"] } });
  store.close();

  // Rebuild the ledger in the released-state-less shape a previous build wrote.
  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP INDEX IF EXISTS idx_batch_idempotency_state_time;
    CREATE TABLE legacy_claims (
      scope_hash TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      response TEXT,
      response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
      reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
      mac TEXT NOT NULL,
      generation INTEGER NOT NULL,
      PRIMARY KEY (scope_hash, key_hash)
    );
    INSERT INTO legacy_claims SELECT scope_hash, key_hash, fingerprint, state, created_at, completed_at, response, response_bytes, reserved_bytes, mac, generation FROM batch_idempotency_claims;
    DROP TABLE batch_idempotency_claims;
    ALTER TABLE legacy_claims RENAME TO batch_idempotency_claims;
  `);
  legacy.close();
  await fs.chmod(databasePath, 0o600);

  const migrated = new FileBatchIdempotencyStore(claims);
  try {
    // History survives the rebuild, so the original request still replays.
    assert.deepEqual(await migrated.claim(input), {
      status: "replay",
      response: { operation: "store", ids: ["m1"] },
    });
    await assert.rejects(
      () => migrated.claim({ ...input, fingerprint: batchIdempotencyFingerprint("changed") }),
      expectCode("CONFLICT"),
    );
    // The migrated ledger also supports the released-state binding.
    const released = { scope: batchIdempotencyScope("tenant:beta"), key: "legacy-release", fingerprint: batchIdempotencyFingerprint("body") };
    assert.deepEqual(await migrated.claim(released), { status: "fresh" });
    await migrated.abandon({ ...released, operation: "delete" });
    await assert.rejects(
      () => migrated.claim({ ...released, operation: "store" }),
      expectCode("CONFLICT"),
    );
  } finally {
    migrated.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a tampered legacy claim row fails the ledger closed before migration", async () => {
  const root = await temporaryRoot("remembra-idempotency-legacy-tampered-");
  const claims = path.join(root, "claims");
  const store = new FileBatchIdempotencyStore(claims);
  const databasePath = store.databasePath;
  await store.claim({ scope: batchIdempotencyScope("tenant:alpha"), key: "forged", fingerprint: batchIdempotencyFingerprint("fingerprint-a") });
  store.close();
  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP INDEX IF EXISTS idx_batch_idempotency_state_time;
    CREATE TABLE legacy_claims (
      scope_hash TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      response TEXT,
      response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
      reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
      mac TEXT NOT NULL,
      generation INTEGER NOT NULL,
      PRIMARY KEY (scope_hash, key_hash)
    );
    INSERT INTO legacy_claims SELECT scope_hash, key_hash, fingerprint, state, created_at, completed_at, response, response_bytes, reserved_bytes, mac, generation FROM batch_idempotency_claims;
    DROP TABLE batch_idempotency_claims;
    ALTER TABLE legacy_claims RENAME TO batch_idempotency_claims;
  `);
  legacy.prepare("UPDATE batch_idempotency_claims SET fingerprint = ?").run(batchIdempotencyFingerprint("forged-body"));
  legacy.close();
  await fs.chmod(databasePath, 0o600);
  try {
    assert.throws(() => new FileBatchIdempotencyStore(claims), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
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

test("batch options cannot mint a trusted tenant context from a tenant-shaped object", async () => {
  const root = await temporaryRoot("remembra-idempotency-forged-tenant-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    tenantMode: "strict",
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  const forged = {
    principal: {
      organizationId: "org-forged",
      membershipVersion: "membership-1",
      scopes: ["global"],
      capabilities: ["tenant:read", "tenant:write"],
    },
  };
  try {
    await assert.rejects(
      () => service.batch(
        { operation: "store", items: [{ type: "fact", content: "forged tenant" }] },
        { tenant: forged as never },
      ),
      expectCode("TENANT_REQUIRED"),
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a configured credential resolver must return an isolated scope", async () => {
  const root = await temporaryRoot("remembra-idempotency-missing-scope-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const server = createHttpServer(service, { port: 0, resolveCredentialScope: () => undefined });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/memories/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "missing-scope" },
      body: JSON.stringify({ operation: "store", items: [{ type: "fact", content: "must not share local scope" }] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code?: string }).code, "INVALID_INPUT");
    assert.equal((await service.list({})).memories.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ordinary writes recheck durable recovery state before any mutation", async () => {
  const root = await temporaryRoot("remembra-idempotency-write-refresh-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const statePath = path.join(root, ".recovery-state.json");
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    recoveryStateStore: new FileRecoveryStateStore(statePath),
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  try {
    await service.initializeRecovery();
    assert.equal((await service.health()).status, "ok");
    await new FileRecoveryStateStore(statePath).write("ReadOnly", "read_only");
    await assert.rejects(
      () => service.store({ type: "fact", content: "must remain blocked" }),
      expectCode("SERVICE_UNAVAILABLE"),
    );
    assert.equal((await service.list({})).memories.length, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a transient recovery-state read error fails one write closed without poisoning later work", async () => {
  const root = await temporaryRoot("remembra-idempotency-transient-recovery-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  let reads = 0;
  let failNextRead = false;
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    recoveryStateStore: {
      read: async () => {
        reads++;
        if (failNextRead) {
          failNextRead = false;
          throw new Error("transient state read failure");
        }
        return "Healthy";
      },
      write: async () => {},
    },
  });
  try {
    await service.initializeRecovery();
    assert.equal((await service.health()).status, "ok");
    await svc_store(service);
    assert.equal((await service.list({})).memories.length, 1);

    // Writability cannot be confirmed, so the write fails closed and stores
    // nothing; the failure must not latch a durable Failed state.
    failNextRead = true;
    await assert.rejects(() => svc_store(service), expectCode("SERVICE_UNAVAILABLE"));
    assert.equal(reads > 1, true);
    assert.equal((await service.list({})).memories.length, 1);

    // The channel recovers on the next attempt, so writes work again.
    await svc_store(service);
    assert.equal((await service.list({})).memories.length, 2);
    assert.equal((await service.health()).state, "Healthy");

    // Reads never depend on the durable channel and stay available.
    failNextRead = true;
    assert.equal((await service.search({ query: "transient" })).results.length, 2);
    assert.equal((await service.batch({ operation: "search", items: [{ query: "transient" }] })).summary.succeeded, 1);
  } finally {
    await service.shutdownBackgroundJobs();
    // The store releases its advisory lock file asynchronously; retry so a
    // teardown race cannot mask a real assertion failure.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function svc_store(service: MemoryService): Promise<void> {
  await service.store({ type: "fact", content: `transient recovery ${Math.random()}` });
}

test("a pending restore gate blocks reads and reports unready", async () => {
  const root = await temporaryRoot("remembra-idempotency-read-gate-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const ledger = new FileBatchIdempotencyStore(path.join(root, "claims"));
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: ledger,
  });
  try {
    await service.store({ type: "fact", content: "before restore" });
    await ledger.beginRestore();
    await assert.rejects(() => service.search({ query: "restore" }), expectCode("SERVICE_UNAVAILABLE"));
    await assert.rejects(() => service.list({}), expectCode("SERVICE_UNAVAILABLE"));
    assert.equal((await service.health()).status, "unready");
  } finally {
    await ledger.completeRestore();
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restore fencing refuses to start while a mutation claim is in flight", async () => {
  const root = await temporaryRoot("remembra-idempotency-restore-fence-");
  const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
  const input = { scope: batchIdempotencyScope("tenant:alpha"), key: "in-flight", fingerprint: batchIdempotencyFingerprint("fingerprint-a") };
  try {
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    await assert.rejects(() => store.beginRestore(), expectCode("SERVICE_UNAVAILABLE"));
    assert.equal(store.restorePending, false);
    await store.complete({ ...input, response: { operation: "store" } });
    await store.beginRestore();
    assert.equal(store.restorePending, true);
  } finally {
    if (store.restorePending) await store.completeRestore();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a ledger database with unrelated tables cannot replace the claim namespace", async () => {
  const root = await temporaryRoot("remembra-idempotency-unrelated-");
  const claimsRoot = path.join(root, "claims");
  const store = new FileBatchIdempotencyStore(claimsRoot);
  const databasePath = store.databasePath;
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) await fs.rm(`${databasePath}${suffix}`, { force: true });
  const replacement = new Database(databasePath);
  replacement.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
  replacement.close();
  await fs.chmod(databasePath, 0o600);
  try {
    assert.throws(() => new FileBatchIdempotencyStore(claimsRoot), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a deterministically failed keyed batch releases its reserved claim", async () => {
  const root = await temporaryRoot("remembra-idempotency-release-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const ledger = new FileBatchIdempotencyStore(path.join(root, "claims"), { maxEntries: 1 });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: ledger,
  });
  const scope = batchIdempotencyScope("release-client");
  try {
    await assert.rejects(
      () => service.batch(
        { operation: "delete", ids: ["missing-memory"] },
        { idempotencyKey: "deterministic-failure", idempotencyScope: scope },
      ),
      expectCode("SERVICE_UNAVAILABLE"),
    );
    assert.deepEqual(
      await ledger.claim({ scope, key: "next-request", fingerprint: batchIdempotencyFingerprint("next") }),
      { status: "fresh" },
    );
    await ledger.abandon({ scope, key: "next-request", fingerprint: batchIdempotencyFingerprint("next") });
    await assert.rejects(
      () => service.batch(
        { operation: "store", items: [{ type: "fact", content: "different body under released key" }] },
        { idempotencyKey: "deterministic-failure", idempotencyScope: scope },
      ),
      expectCode("CONFLICT"),
    );
    await assert.rejects(
      () => service.batch(
        { operation: "delete", ids: ["still-missing"] },
        { idempotencyKey: "deterministic-failure", idempotencyScope: scope },
      ),
      expectCode("SERVICE_UNAVAILABLE"),
    );
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partially successful keyed batch keeps its claim reserved", async () => {
  const root = await temporaryRoot("remembra-idempotency-retain-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const ledger = new FileBatchIdempotencyStore(path.join(root, "claims"), { maxEntries: 1 });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: ledger,
  });
  const scope = batchIdempotencyScope("retain-client");
  try {
    const stored = await service.store({ type: "fact", content: "before partial update" });
    await assert.rejects(
      () => service.batch(
        {
          operation: "update",
          items: [
            { id: stored.id, content: "after partial update", expectedVersion: stored.memory.version },
            { id: "missing-memory", content: "cannot apply" },
          ],
        },
        { idempotencyKey: "partial-update", idempotencyScope: scope },
      ),
      expectCode("SERVICE_UNAVAILABLE"),
    );
    await assert.rejects(
      () => ledger.claim({ scope, key: "must-not-fit", fingerprint: batchIdempotencyFingerprint("next") }),
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
