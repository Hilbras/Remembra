import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import {
  FileWebhookDeliveryStore,
  WebhookDispatcher,
  verifyWebhookSignature,
  webhookMemoryPayload,
  type WebhookSubscription,
  type WebhookTransport,
  type WebhookTransportResult,
} from "../webhooks.js";

const SECRET = Buffer.from("9f".repeat(32), "hex");

class CollectingTransport implements WebhookTransport {
  readonly bodies: string[] = [];
  readonly headers: Array<Record<string, string>> = [];

  constructor(private readonly outcome: WebhookTransportResult = { status: "delivered", statusCode: 200 }) {}

  async deliver(request: { headers: Record<string, string>; body: string }) {
    this.bodies.push(request.body);
    this.headers.push(request.headers);
    return this.outcome;
  }
}

async function serviceWithWebhooks(prefix: string, transport: WebhookTransport, events: WebhookSubscription["events"] = ["memory.created", "memory.updated", "memory.deleted"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const store = new FileWebhookDeliveryStore(path.join(root, "webhooks"));
  const dispatcher = new WebhookDispatcher(store, transport, { maxAttempts: 1, now: () => Date.now() });
  dispatcher.register({ id: "sub-1", url: "https://hooks.example.test/remembra", secret: SECRET, events });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
    webhooks: dispatcher,
  });
  return { root, store, dispatcher, service };
}

test("WEBHOOK-SVC-001: memory writes emit signed events that a receiver can verify", async () => {
  const transport = new CollectingTransport();
  const { root, store, service } = await serviceWithWebhooks("remembra-webhook-service-", transport);
  try {
    const stored = await service.store({ type: "fact", content: "the release train leaves at 09:00" });
    await service.update(stored.id, { content: "the release train leaves at 09:30" });
    await service.forget(stored.id);
    await service.drainWebhooks();

    assert.equal(transport.bodies.length, 3);
    const types = transport.bodies.map((body) => (JSON.parse(body) as { type: string }).type);
    assert.deepEqual(types, ["memory.created", "memory.updated", "memory.deleted"]);

    const created = JSON.parse(transport.bodies[0]) as { format: string; id: string; data: Record<string, unknown> };
    assert.equal(created.format, "remembra-webhook");
    assert.equal(created.data.id, stored.id);
    assert.equal(created.data.content, "the release train leaves at 09:00");
    assert.equal(created.data.embedding, undefined);
    assert.equal(created.data.provenance, undefined);

    for (const [index, headers] of transport.headers.entries()) {
      const verified = verifyWebhookSignature(SECRET, headers["x-remembra-signature"], transport.bodies[index]);
      assert.deepEqual(verified, { ok: true });
      assert.equal(headers["x-remembra-delivery"].length, 32);
    }
    // Each event is delivered once; the queue holds nothing afterwards.
    assert.deepEqual(store.counts(), { pending: 0, delivered: 3, failed: 0, dead: 0 });
  } finally {
    await service.shutdownBackgroundJobs();
    store.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("WEBHOOK-SVC-002: an unsubscribed event is never queued and a failing dispatcher never fails a write", async () => {
  const failing: WebhookTransport = {
    async deliver() {
      throw new Error("subscriber offline");
    },
  };
  const { root, store, dispatcher, service } = await serviceWithWebhooks("remembra-webhook-service-fail-", failing, ["memory.created"]);
  try {
    const stored = await service.store({ type: "fact", content: "written regardless" });
    assert.equal(stored.id.length > 0, true);
    await service.update(stored.id, { content: "still written" });
    assert.equal(store.counts().pending, 1, "only the subscribed event was queued");

    // The dispatcher itself is broken; the write path is unaffected.
    const broken = new WebhookDispatcher(store, failing, { maxAttempts: 1, now: () => Date.now() });
    broken.publish = () => {
      throw new Error("dispatcher unavailable");
    };
    await fs.mkdir(path.join(root, "memories-2"), { recursive: true });
    const resilient = new MemoryService(new MemoryStore(path.join(root, "memories-2")), {
      embeddingProvider: "none",
      decayIntervalMs: Number.MAX_SAFE_INTEGER,
      webhooks: broken,
    });
    try {
      const written = await resilient.store({ type: "fact", content: "unaffected by webhook failure" });
      assert.equal(written.message.includes(written.id), true);
    } finally {
      await resilient.shutdownBackgroundJobs();
    }

    dispatcher.unregister("sub-1");
    assert.equal(dispatcher.subscriptionCount, 0);
  } finally {
    await service.shutdownBackgroundJobs();
    store.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("WEBHOOK-SVC-003: a service without a dispatcher behaves exactly as before", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-webhook-service-none-"));
  await fs.mkdir(path.join(root, "memories"), { recursive: true });
  const service = new MemoryService(new MemoryStore(path.join(root, "memories")), {
    embeddingProvider: "none",
    decayIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  try {
    const stored = await service.store({ type: "fact", content: "no webhooks configured" });
    assert.equal(await service.drainWebhooks(), 0);
    assert.equal((await service.list({})).memories.length, 1);
    assert.equal(stored.id.length > 0, true);
    assert.equal(webhookMemoryPayload({ id: stored.id, type: "fact", content: stored.memory.content }).id, stored.id);
  } finally {
    await service.shutdownBackgroundJobs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
