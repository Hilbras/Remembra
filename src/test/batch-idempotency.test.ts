import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBatchIdempotencyStore } from "../batch-idempotency-store.js";
import { createHttpServer } from "../http.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";

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
    const input = { scope: "tenant:alpha", key: "batch-001", fingerprint: "fingerprint-a" };
    assert.deepEqual(await firstStore.claim(input), { status: "fresh" });
    await firstStore.complete({ ...input, response: { operation: "store", ids: ["m1"] } });
    const claimFiles = await fs.readdir(path.join(root, "claims"));
    assert.equal(claimFiles.length, 1);
    assert.doesNotMatch(claimFiles[0]!, /batch-001|tenant:alpha/);
    const claimText = await fs.readFile(path.join(root, "claims", claimFiles[0]!), "utf8");
    assert.doesNotMatch(claimText, /batch-001|tenant:alpha/);

    const restartedStore = new FileBatchIdempotencyStore(path.join(root, "claims"));
    assert.deepEqual(await restartedStore.claim({ ...input, fingerprint: "fingerprint-a" }), {
      status: "replay",
      response: { operation: "store", ids: ["m1"] },
    });
    await assert.rejects(
      () => restartedStore.claim({ ...input, fingerprint: "fingerprint-b" }),
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
    const input = { scope: "tenant:alpha", key: "batch-002", fingerprint: "fingerprint-a" };
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    await assert.rejects(() => store.claim(input), expectCode("SERVICE_UNAVAILABLE"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch idempotency refuses a symlinked claim directory", async () => {
  const root = await temporaryRoot("remembra-idempotency-symlink-");
  const outside = await temporaryRoot("remembra-idempotency-outside-");
  try {
    await fs.symlink(outside, path.join(root, "claims"));
    const store = new FileBatchIdempotencyStore(path.join(root, "claims"));
    await assert.rejects(
      () => store.claim({ scope: "tenant:alpha", key: "batch-link", fingerprint: "fingerprint-a" }),
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
    const store = new FileBatchIdempotencyStore(claimRoot, { maxAgeMs: 60_000 });
    const input = { scope: "tenant:alpha", key: "batch-stuck", fingerprint: "fingerprint-a" };
    assert.deepEqual(await store.claim(input), { status: "fresh" });
    const [claimFile] = await fs.readdir(claimRoot);
    assert.ok(claimFile);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(path.join(claimRoot, claimFile), old, old);

    const restarted = new FileBatchIdempotencyStore(claimRoot, { maxAgeMs: 60_000 });
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

test("MemoryService replays a durable batch without creating duplicate memories", async () => {
  const root = await temporaryRoot("remembra-idempotency-service-");
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(root, "claims")),
  });
  const options = { idempotencyKey: "batch-003", idempotencyScope: "test-client" };
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
