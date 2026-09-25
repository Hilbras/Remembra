import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWebhookSubscriptions, webhookDrainIntervalMs } from "../webhook-config.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { FileWebhookDeliveryStore, WebhookDispatcher, type WebhookTransport, type WebhookTransportResult } from "../webhooks.js";
import { RemembraError } from "../errors.js";

const SECRET_HEX = "3b".repeat(32);

test("WEBHOOK-CONFIG-002: webhook configuration is opt-in, validated, and deduplicated", () => {
  assert.deepEqual(parseWebhookSubscriptions(undefined), []);
  assert.deepEqual(parseWebhookSubscriptions("  "), []);

  const [subscription] = parseWebhookSubscriptions(
    JSON.stringify([{ id: "tenant-a", url: "https://hooks.example.test/x", secret: SECRET_HEX, events: ["memory.created"] }]),
  );
  assert.equal(subscription.id, "tenant-a");
  assert.equal(subscription.events.length, 1);
  assert.equal(subscription.secret.toString("hex"), SECRET_HEX);

  // Base64 and raw passphrases are both accepted; the decoded key is 32+ bytes.
  const base64 = parseWebhookSubscriptions(
    JSON.stringify([{ id: "b", url: "https://h.test/x", secret: Buffer.from("k".repeat(32)).toString("base64"), events: ["job.failed"] }]),
  )[0];
  assert.equal(base64.secret.length, 32);

  for (const raw of [
    "not json",
    JSON.stringify({ id: "x" }),
    JSON.stringify([{ id: "x", url: "http://hooks.example.test/x", secret: SECRET_HEX, events: ["memory.created"] }]),
    JSON.stringify([{ id: "x", url: "https://h.test/x", secret: "short", events: ["memory.created"] }]),
    JSON.stringify([{ id: "x", url: "https://h.test/x", secret: SECRET_HEX, events: ["nope"] }]),
    JSON.stringify([{ id: "x", url: "https://h.test/x", secret: SECRET_HEX, events: ["memory.created"] }, { id: "x", url: "https://h.test/y", secret: SECRET_HEX, events: ["job.failed"] }]),
    JSON.stringify([{ id: "x", url: "https://h.test/x", secret: SECRET_HEX, events: ["memory.created"] }, null]),
    `x`.repeat(20_000),
  ]) {
    assert.throws(
      () => parseWebhookSubscriptions(raw),
      (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
    );
  }

  assert.equal(webhookDrainIntervalMs(undefined), 5_000);
  assert.equal(webhookDrainIntervalMs("1500"), 1_500);
  for (const raw of ["0", "999", "3600001", "1.5", "abc"]) {
    assert.throws(
      () => webhookDrainIntervalMs(raw),
      (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
    );
  }
});

test("WEBHOOK-SVC-004: snapshot, job, and consolidation events are emitted with counts only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-webhook-events-"));
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const store = new FileWebhookDeliveryStore(path.join(root, "webhooks"));
  const delivered: string[] = [];
  const deliveredBodies: Array<{ type: string; data: Record<string, unknown> }> = [];
  const transport: WebhookTransport = {
    async deliver(request) {
      const body = JSON.parse(request.body) as { type: string; data: Record<string, unknown> };
      delivered.push(body.type);
      deliveredBodies.push(body);
      return { status: "delivered", statusCode: 200 } as WebhookTransportResult;
    },
  };
  const dispatcher = new WebhookDispatcher(store, transport, { maxAttempts: 1 });
  dispatcher.register({
    id: "sub-1",
    url: "https://hooks.example.test/x",
    secret: Buffer.from(SECRET_HEX, "hex"),
    events: ["snapshot.created", "snapshot.restored", "job.completed", "job.failed", "memory.consolidated", "memory.created"],
  });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    webhooks: dispatcher,
    extractFn: async () => [{ type: "fact", content: "the release train leaves at 09:30", tags: [], importance: 3 }],
    mergeFn: async (incoming) => ({ action: "merge", content: `${incoming} (confirmed)` }),
  });
  try {
    // A memory close to the extracted one so the digest reaches the merge path.
    const first = await service.store({ type: "fact", content: "the release train leaves at 09:00 from platform bay three" });
    await service.exportSnapshot({});
    await service.importSnapshot(await service.exportSnapshot({}), {});
    // A queued background job settles and reports its outcome.
    const job = await service.enqueueMaintenance({}).done;
    assert.equal(job.state, "completed");
    // A digest merge supersedes the existing memory and reports the merge.
    const digest = await service.digest({ transcript: "The release train leaves at 09:30" });
    assert.equal(digest.merged, 1);
    await service.drainWebhooks();

    const seen = new Set(delivered);
    for (const type of ["memory.created", "snapshot.created", "snapshot.restored", "memory.consolidated", "job.completed"]) {
      assert.equal(seen.has(type), true, `expected a ${type} delivery`);
    }
    assert.deepEqual(store.counts().pending, 0);
    assert.equal(first.id.length > 0, true);

    // Snapshot notifications carry counts only: no memory content is duplicated.
    const snapshotBodies = deliveredBodies.filter((body) => body.type === "snapshot.created");
    assert.equal(snapshotBodies.length > 0, true);
    for (const body of snapshotBodies) {
      assert.equal(Object.keys(body.data).sort().join(","), "count,exportedAt,organizationId");
      assert.equal(JSON.stringify(body).includes("platform bay three"), false);
    }
  } finally {
    await service.shutdownBackgroundJobs();
    store.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
