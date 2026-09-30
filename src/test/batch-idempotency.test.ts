import Database from "better-sqlite3";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, default as fsSync } from "node:fs";
import { spawn } from "node:child_process";
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

/**
 * The fourth manifestation of this store's cold-start race.
 *
 * The first three were file mode, ledger generation metadata, and the zero-byte
 * integrity key. This one is subtler: `link()` needs its source to exist, so
 * publishing the key necessarily has a window in which a
 * `.claims.key.<pid>.<hex>.tmp` file is visible in the claim directory — and the
 * constructor's allowlist check rejected that name outright. A peer starting inside
 * another peer's publication window therefore failed with "claim directory contains
 * unrelated files".
 *
 * It surfaced as a single MATRIX-02 failure in one full-suite run and passed on every
 * rerun, which is the hardest shape of defect to catch: load-dependent, and in a suite
 * where a rerun is the normal response. Reproduced deliberately by cold-starting a
 * store from 12 concurrent processes against a fresh claim directory, 25 rounds:
 *
 *   before the fix: 24 of 300 processes failed
 *   after the fix:   0 of 300
 *
 * The regression test below is the deterministic version — it plants the staging file
 * from a *separate process*, because a `setTimeout` on this thread would never fire:
 * the constructor blocks in `Atomics.wait`, which is exactly why a real peer has to be
 * a real process.
 */
const claimDir = async (): Promise<{ dir: string; claim: string }> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-staging-race-"));
  const claim = path.join(dir, "claims");
  await fs.mkdir(claim, { recursive: true, mode: 0o700 });
  return { dir, claim };
};

test("a peer's integrity-key staging file does not make the next start fail", async () => {
  const { dir, claim } = await claimDir();
  try {
    // Exactly the name `loadIntegrityKeySync` creates, and exactly the permissions it
    // creates them with.
    const staging = path.join(claim, `.claims.key.99999.deadbeef.tmp`);
    await fs.writeFile(staging, "x".repeat(32), { mode: 0o600 });

    // A slow peer, deliberately. With a 150ms peer this test also passed against the
    // *wrong* fix — permanently widening `allowedEntries` exempts the staging name, so
    // the constructor refuses nothing and returns in about a millisecond, which
    // satisfied a bare `waited > 0`. The wait is the thing being asserted, so the peer
    // has to be slow enough that "did not wait" is unambiguous.
    const peer = spawn(
      process.execPath,
      ["-e", `setTimeout(() => require("fs").rmSync(process.argv[1], { force: true }), 400)`, staging],
    );
    // Deliberately *not* unref'd, and not awaited on `exit`: awaiting the child's exit
    // raced the event loop, because the constructor blocks this thread in
    // `Atomics.wait` and the child can exit while nothing is listening. Poll the file
    // instead, which is the thing actually being asserted.

    const started = Date.now();
    const store = new FileBatchIdempotencyStore(claim);
    const waited = Date.now() - started;
    store.close();

    // Proves it waited for the publisher rather than either refusing (M1) or simply
    // treating the name as allowed (M2).
    assert.ok(waited >= 250, `the constructor waited for the publisher (${waited}ms)`);
    assert.ok(waited < 2_000, `and gave up well before the full budget (${waited}ms)`);
    let stillThere = true;
    for (let i = 0; i < 100 && stillThere; i++) {
      stillThere = (await fs.readdir(claim)).includes(path.basename(staging));
      if (stillThere) await new Promise<void>((r) => setTimeout(r, 20));
    }
    assert.equal(stillThere, false, "and the peer's staging file is gone");
    await new Promise<void>((r) => {
      if (peer.exitCode !== null || peer.signalCode !== null) r();
      else peer.once("exit", r);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});

test("a claim directory that is not the one we expect is still refused", async () => {
  const { dir, claim } = await claimDir();
  try {
    // The gate must not be weakened into uselessness. An unrelated file is refused
    // immediately, not waited on — waiting is only ever appropriate for the one
    // transient name this code itself creates.
    await fs.writeFile(path.join(claim, "stray.txt"), "x", { mode: 0o600 });
    const started = Date.now();
    assert.throws(
      () => new FileBatchIdempotencyStore(claim),
      (error: unknown) =>
        error instanceof RemembraError && /unrelated files/.test(error.message) && !/outlived/.test(error.message),
    );
    assert.ok(Date.now() - started < 500, "refused immediately, not after the staging budget");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});

test("a staging file that outlives its publisher fails closed", async () => {
  const { dir, claim } = await claimDir();
  try {
    // Nobody is going to remove this one. After the bounded wait the constructor must
    // still refuse, with a message that says *why* it waited rather than reporting the
    // generic symptom a peer would have reported.
    await fs.writeFile(path.join(claim, `.claims.key.88888.cafe1234.tmp`), "x".repeat(32), { mode: 0o600 });
    assert.throws(
      () => new FileBatchIdempotencyStore(claim),
      (error: unknown) =>
        error instanceof RemembraError && /outlived its publisher/.test(error.message),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});

/**
 * `stagingEntry` must exempt *both* publication artifacts.
 *
 * The integrity key got this treatment in 5.7.1; the ledger identity, published by
 * `link()` the same way, must be exempt too. Narrowing the pattern back to
 * `.claims.key.*` is the exact regression the 5.6.0 fix had, one file over — the fix
 * covered `claims.key` and its sibling `claims.identity` was left out.
 *
 * This test exists because neither the unit suite nor 15 rounds of 16 concurrent cold
 * starts detect that narrowing: a single process never sees its own identity staging
 * file at scan time (the scan runs before the ledger identity is published), and 16
 * processes essentially never interleave that publication window. The defect is
 * reachable only when a peer is *already inside* its window, which is what the plant
 * below simulates — the same trick the key-staging test uses, applied to the file
 * whose exemption was actually at risk.
 *
 * The discriminator is the error message. Under the correct pattern the constructor
 * waits out its budget and reports "a staging file outlived its publisher"; under a
 * key-only pattern it refuses on sight with the generic "unrelated files". Asserting
 * the message therefore distinguishes the two, where asserting only that it throws
 * would not.
 */
test("an identity staging file is tolerated and waited on, not refused as unrelated", async () => {
  const { dir, claim } = await claimDir();
  try {
    // Exactly the name `ledgerIdentitySync` creates, with exactly the content length
    // it writes.
    await fs.writeFile(path.join(claim, `.claims.identity.77777.beef1234.tmp`), `${"a".repeat(64)}\n`, { mode: 0o600 });

    const started = Date.now();
    assert.throws(
      () => new FileBatchIdempotencyStore(claim),
      // The discriminator is the parenthetical. Under the correct pattern the message
      // is "claim directory contains unrelated files (a staging file outlived its
      // publisher)"; under a key-only pattern it is the bare "claim directory contains
      // unrelated files", refused on sight with no wait. Note both contain "unrelated
      // files", so that substring alone cannot tell them apart.
      (error: unknown) =>
        error instanceof RemembraError && /outlived its publisher/.test(error.message),
    );
    const waited = Date.now() - started;
    assert.ok(waited >= 1_900, `and waited out the bounded budget (${waited}ms)`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});

/**
 * The fifth manifestation: the ledger identity was published empty.
 *
 * `open(O_CREAT|O_EXCL)` then write created the file *at its final path* and filled it
 * afterwards, so a peer reading in between saw `""`, failed `/^[a-f0-9]{64}$/`, and
 * refused to start with "ledger identity is invalid". This is the same defect as the
 * zero-byte `claims.key` fixed in 5.6.0, which survived there because the fix was
 * applied to `claims.key` and not to `claims.identity`.
 *
 * This cannot be asserted the way the staging race is. There, the defect was a
 * *visible* extra file, so the test could plant one. Here the defect is a window in
 * which a file is visible and *empty*, so a test that plants an empty `claims.identity`
 * would pass against the broken code — planting it is exactly what the broken code
 * produces, and the correct behaviour is to reject it. Waiting for the window to
 * reopen is the flaky shape this suite has been bitten by repeatedly.
 *
 * So the assertion is on the *publication mechanism* instead: the final path must never
 * be created by an O_CREAT open. Under `link()` it appears atomically via `linkSync`,
 * and the content is written to a staging file that is not yet the identity. That is a
 * property of the code, not of a timing window, and it is deterministic.
 *
 * The spy is installed on the `fs` default export — the same object the compiled store
 * closes over (`import fs from "node:fs"`), verified to observe the real calls.
 */
test("the ledger identity is published atomically, never created empty at its final path", async () => {
  const { dir, claim } = await claimDir();
  const identityPath = path.join(claim, "claims.identity");
  // The default export's members are typed read-only; go through a mutable view.
  const target = fsSync as unknown as Record<string, unknown>;
  const realOpen = fsSync.openSync;
  const realLink = fsSync.linkSync;
  const createdAtFinalPath: string[] = [];
  const linkedIntoFinalPath: string[] = [];
  try {
    target.openSync = (p: Parameters<typeof fsSync.openSync>[0], flags: number | string, ...rest: unknown[]) => {
      // O_CREAT is bit 0o100. Watching for it on the *final* path is the whole test:
      // the pre-fix code passed exactly this path to openSync with O_CREAT|O_EXCL.
      if (typeof p === "string" && p === identityPath && typeof flags === "number" && (flags & 0o100) !== 0) {
        createdAtFinalPath.push(p);
      }
      return (realOpen as (...a: unknown[]) => unknown)(p, flags, ...rest);
    };
    target.linkSync = (from: string, to: string) => {
      if (to === identityPath) linkedIntoFinalPath.push(to);
      return realLink(from, to);
    };

    const store = new FileBatchIdempotencyStore(claim);
    store.close();

    assert.deepEqual(createdAtFinalPath, [], "claims.identity was never created empty at its final path");
    // Guard the guard: if linkSync were never observed, the assertion above would be
    // vacuous — a store that never published an identity at all would satisfy it.
    assert.deepEqual(linkedIntoFinalPath, [identityPath], "and it did appear, via an atomic link");
  } finally {
    target.openSync = realOpen;
    target.linkSync = realLink;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});
