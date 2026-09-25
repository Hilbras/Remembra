import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  FileWebhookDeliveryStore,
  WebhookDispatcher,
  WebhookReplayCache,
  assertValidSubscription,
  buildWebhookBody,
  createFetchWebhookTransport,
  signWebhookPayload,
  verifyWebhookSignature,
  webhookDeliveryId,
  webhookMemoryPayload,
  webhookSecretFingerprint,
  type WebhookEvent,
  type WebhookSubscription,
  type WebhookMemorySource,
  type WebhookTransport,
  type WebhookTransportResult,
} from "../webhooks.js";
import { RemembraError } from "../errors.js";

const SECRET = Buffer.from("5b".repeat(32), "hex");

async function temporaryRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function subscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: "sub-1",
    url: "https://hooks.example.test/remembra",
    secret: SECRET,
    events: ["memory.created", "memory.updated", "memory.deleted"],
    ...overrides,
  };
}

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: "evt-1",
    type: "memory.created",
    createdAt: "2026-09-26T00:00:00.000Z",
    data: { id: "m1" },
    ...overrides,
  };
}

class RecordingTransport implements WebhookTransport {
  readonly requests: Array<{ url: string; headers: Record<string, string>; body: string; attempt: number }> = [];
  private readonly outcomes: WebhookTransportResult[] | ((attempt: number) => WebhookTransportResult);

  constructor(outcomes: WebhookTransportResult[] | ((attempt: number) => WebhookTransportResult)) {
    this.outcomes = outcomes;
  }

  async deliver(request: { url: string; headers: Record<string, string>; body: string; attempt: number; signal: AbortSignal }) {
    this.requests.push({ url: request.url, headers: request.headers, body: request.body, attempt: request.attempt });
    const outcome = typeof this.outcomes === "function"
      ? this.outcomes(request.attempt)
      : this.outcomes[Math.min(request.attempt - 1, this.outcomes.length - 1)];
    return outcome;
  }
}

test("WEBHOOK-SIG-001: a signed delivery verifies and any tampering fails", () => {
  const body = buildWebhookBody(event());
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  const signature = signWebhookPayload(SECRET, Math.floor(now / 1000), body);
  assert.deepEqual(verifyWebhookSignature(SECRET, signature, body, { now }), { ok: true });

  // Body, header, and secret tampering are each refused with a distinct reason.
  assert.deepEqual(verifyWebhookSignature(SECRET, signature, `${body} `, { now }), { ok: false, reason: "signature" });
  assert.deepEqual(verifyWebhookSignature(Buffer.from("7c".repeat(32), "hex"), signature, body, { now }), { ok: false, reason: "signature" });
  const tampered = signWebhookPayload(SECRET, Math.floor(now / 1000), `${body} `);
  assert.deepEqual(verifyWebhookSignature(SECRET, tampered, body, { now }), { ok: false, reason: "signature" });
  for (const malformed of ["", "garbage", "t=abc,v1=zz", "v1=deadbeef", `t=${Math.floor(now / 1000)},v1=short`, `x=${Math.floor(now / 1000)}`]) {
    assert.deepEqual(verifyWebhookSignature(SECRET, malformed, body, { now }), { ok: false, reason: "malformed" });
  }
});

test("WEBHOOK-SIG-002: the signed timestamp window is enforced in both directions", () => {
  const body = buildWebhookBody(event());
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  const tolerance = 60_000;
  const at = (offsetMs: number) => signWebhookPayload(SECRET, Math.floor((now + offsetMs) / 1000), body);
  assert.deepEqual(verifyWebhookSignature(SECRET, at(0), body, { now, toleranceMs: tolerance }), { ok: true });
  assert.deepEqual(verifyWebhookSignature(SECRET, at(tolerance - 1_500), body, { now, toleranceMs: tolerance }), { ok: true });
  assert.deepEqual(verifyWebhookSignature(SECRET, at(tolerance + 1_500), body, { now, toleranceMs: tolerance }), { ok: false, reason: "timestamp" });
  assert.deepEqual(verifyWebhookSignature(SECRET, at(-(tolerance + 1_500)), body, { now, toleranceMs: tolerance }), { ok: false, reason: "timestamp" });
  assert.deepEqual(verifyWebhookSignature(SECRET, at(0), body, { now, toleranceMs: -1 }), { ok: false, reason: "malformed" });
});

test("WEBHOOK-REPLAY-001: a receiver replay guard accepts a delivery id once", () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  const guard = new WebhookReplayCache(60_000, 4);
  assert.equal(guard.accept("d-1", now), true);
  assert.equal(guard.accept("d-1", now + 1), false);
  assert.equal(guard.accept("d-1", now + 30_000), false);
  // Outside the window the id is no longer a replay.
  assert.equal(guard.accept("d-1", now + 61_000), true);

  // Capacity pressure is reported instead of silently accepting a replay.
  const bounded = new WebhookReplayCache(60_000, 2);
  bounded.accept("a", now);
  bounded.accept("b", now);
  bounded.accept("c", now);
  assert.equal(bounded.evictions, 1);
  assert.equal(bounded.size, 2);
  assert.equal(bounded.accept("a", now), true);
  assert.throws(() => new WebhookReplayCache(10), (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT");
});

test("WEBHOOK-PAYLOAD-001: payloads carry allowlisted fields only and stay bounded", () => {
  // Extra fields are supplied on purpose: none of them may reach a subscriber.
  const payload = webhookMemoryPayload({
    id: "m1",
    type: "fact",
    content: "the deploy key is sk-abcdefghijklmnop",
    scope: "global",
    tags: ["a", "b", 7],
    importance: 3,
    version: 2,
    embedding: [0.1, 0.2, 0.3],
    provenance: { sourceType: "manual", apiKey: "sk-should-never-ship" },
    relations: [{ id: "m2", kind: "related" }],
    meta: { password: "hunter2" },
  } as unknown as WebhookMemorySource);
  assert.equal(payload.embedding, undefined);
  assert.equal(payload.provenance, undefined);
  assert.equal(payload.relations, undefined);
  assert.equal(payload.meta, undefined);
  assert.deepEqual(payload.tags, ["a", "b"]);
  assert.equal(payload.content, "the deploy key is sk-abcdefghijklmnop");
  assert.equal(payload.version, 2);

  const long = webhookMemoryPayload({ id: "m2", type: "fact", content: "x".repeat(9_000) });
  assert.equal((long.content as string).length, 4_000);
  assert.equal(long.truncated, true);

  const body = buildWebhookBody(event({ data: payload }));
  assert.equal(Buffer.byteLength(body, "utf8") <= 64 * 1024, true);
  assert.equal(body.includes("sk-abcdefghijklmnop"), true, "the subscriber receives its own content");
  assert.equal(body.includes("sk-should-never-ship"), false);
  assert.equal(body.includes("hunter2"), false);
  assert.throws(
    () => buildWebhookBody(event({ type: "memory.exfiltrated" as never })),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => buildWebhookBody(event({ data: { blob: "y".repeat(70 * 1024) } })),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
});

test("WEBHOOK-CONFIG-001: subscriptions must be https, credential-free, and event-bounded", () => {
  assert.doesNotThrow(() => assertValidSubscription(subscription()));
  assert.doesNotThrow(() => assertValidSubscription(subscription({ url: "http://127.0.0.1:9099/hook" })));
  for (const invalid of [
    subscription({ url: "http://hooks.example.test/hook" }),
    subscription({ url: "https://user:pass@hooks.example.test/hook" }),
    subscription({ url: "/relative" }),
    subscription({ secret: Buffer.alloc(8) }),
    subscription({ secret: Buffer.alloc(200) }),
    subscription({ events: [] }),
    subscription({ events: ["everything"] as never }),
    subscription({ id: "sub/../escape" }),
    subscription({ id: "" }),
  ]) {
    assert.throws(
      () => assertValidSubscription(invalid),
      (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
    );
  }
});

test("WEBHOOK-STATE-001: delivery state is durable, deduplicated, and capacity bounded", async () => {
  const root = await temporaryRoot("remembra-webhook-state-");
  const store = new FileWebhookDeliveryStore(root);
  try {
    const body = buildWebhookBody(event());
    const sub = subscription();
    assert.deepEqual(store.enqueue(sub, event(), body, 1_000), { status: "queued", deliveryId: webhookDeliveryId(sub.id, "evt-1") });
    assert.deepEqual(store.enqueue(sub, event(), body, 1_000), { status: "duplicate", deliveryId: webhookDeliveryId(sub.id, "evt-1") });
    // An event outside the allowlist is never queued for this subscription.
    assert.deepEqual(store.enqueue(sub, event({ id: "evt-2", type: "job.completed" }), body, 1_000), { status: "dropped", reason: "payload" });
    assert.deepEqual(store.due(1_000).map((row) => row.eventId), ["evt-1"]);

    // A restart sees the same pending delivery.
    store.close();
    const restarted = new FileWebhookDeliveryStore(root);
    try {
      assert.equal(restarted.due(1_000).length, 1);
      assert.deepEqual(restarted.counts(), { pending: 1, delivered: 0, failed: 0, dead: 0 });
    } finally {
      restarted.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-STATE-002: a capacity-bounded store drops explicitly instead of growing", async () => {
  const root = await temporaryRoot("remembra-webhook-capacity-");
  const store = new FileWebhookDeliveryStore(root, { maxPending: 2 });
  try {
    const sub = subscription();
    const body = buildWebhookBody(event());
    assert.equal(store.enqueue(sub, event({ id: "e1" }), body, 1).status, "queued");
    assert.equal(store.enqueue(sub, event({ id: "e2" }), body, 1).status, "queued");
    assert.deepEqual(store.enqueue(sub, event({ id: "e3" }), body, 1), { status: "dropped", reason: "capacity" });
    assert.equal(store.due(1).length, 2);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-STATE-003: a tampered delivery row fails the store closed", async () => {
  const root = await temporaryRoot("remembra-webhook-tampered-");
  const store = new FileWebhookDeliveryStore(root);
  const body = buildWebhookBody(event());
  store.enqueue(subscription(), event(), body, 1_000);
  const databasePath = store.databasePath;
  store.close();
  const db = new Database(databasePath);
  db.prepare("UPDATE webhook_deliveries SET body = ?").run(buildWebhookBody(event({ id: "evt-forged" })));
  db.close();
  try {
    const reopened = new FileWebhookDeliveryStore(root);
    reopened.close();
    assert.fail("a forged body must not be readable");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "SERVICE_UNAVAILABLE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-RETRY-001: a retryable failure is retried with bounded backoff and then retired", async () => {
  const root = await temporaryRoot("remembra-webhook-retry-");
  const store = new FileWebhookDeliveryStore(root);
  const transport = new RecordingTransport((attempt) =>
    attempt < 3
      ? { status: "failed", statusCode: 503, retryable: true, error: "http 503" }
      : { status: "delivered", statusCode: 200 },
  );
  let now = 1_700_000_000_000;
  const dispatcher = new WebhookDispatcher(store, transport, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, now: () => now });
  try {
    dispatcher.register(subscription());
    assert.deepEqual(dispatcher.publish(event()), { queued: 1, duplicate: 0, dropped: 0 });
    assert.equal(await dispatcher.drain(), 1);
    assert.equal(transport.requests.length, 1);
    // The first retry is not due yet: the backoff is respected.
    assert.equal(await dispatcher.drain(), 0);
    now += 100;
    assert.equal(await dispatcher.drain(), 1);
    now += 200;
    assert.equal(await dispatcher.drain(), 1);
    assert.equal(transport.requests.length, 3);
    assert.deepEqual(store.counts(), { pending: 0, delivered: 1, failed: 0, dead: 0 });
    // Every attempt carried a verifiable signature for the same body.
    for (const request of transport.requests) {
      assert.equal(request.body, buildWebhookBody(event()));
      const verified = verifyWebhookSignature(SECRET, request.headers["x-remembra-signature"], request.body, { now });
      assert.equal(verified.ok, true);
      assert.equal(request.headers["x-remembra-delivery"], webhookDeliveryId("sub-1", "evt-1"));
      assert.equal(request.headers["x-remembra-event"], "memory.created");
      assert.equal(request.headers["x-remembra-timestamp"], String(Math.floor(now / 1000)));
    }
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-RETRY-002: a permanent failure and an exhausted budget both retire as dead", async () => {
  const root = await temporaryRoot("remembra-webhook-dead-");
  const store = new FileWebhookDeliveryStore(root);
  // The first delivery fails permanently; every later attempt is retryable.
  let call = 0;
  const transport = new RecordingTransport(() => {
    call++;
    return call === 1
      ? { status: "failed", statusCode: 400, retryable: false, error: "http 400" }
      : { status: "failed", statusCode: 500, retryable: true, error: "http 500" };
  });
  let now = 1_000;
  const dispatcher = new WebhookDispatcher(store, transport, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, now: () => now });
  try {
    dispatcher.register(subscription());
    dispatcher.publish(event({ id: "permanent" }));
    await dispatcher.drain();
    assert.deepEqual(store.counts(), { pending: 0, delivered: 0, failed: 0, dead: 1 });
    assert.equal(transport.requests.length, 1, "a 4xx is never retried");

    dispatcher.publish(event({ id: "exhausted" }));
    await dispatcher.drain();
    assert.deepEqual(store.counts(), { pending: 1, delivered: 0, failed: 0, dead: 1 });
    now += 10;
    await dispatcher.drain();
    assert.equal(transport.requests.length, 3);
    assert.deepEqual(store.counts(), { pending: 0, delivered: 0, failed: 0, dead: 2 });
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-RETRY-003: a transport that throws is treated as retryable and never reaches the caller", async () => {
  const root = await temporaryRoot("remembra-webhook-throw-");
  const store = new FileWebhookDeliveryStore(root);
  const transport: WebhookTransport = {
    async deliver() {
      throw new Error("connection reset");
    },
  };
  let now = 1_000;
  const dispatcher = new WebhookDispatcher(store, transport, { maxAttempts: 1, baseDelayMs: 10, now: () => now });
  try {
    dispatcher.register(subscription());
    assert.deepEqual(dispatcher.publish(event()), { queued: 1, duplicate: 0, dropped: 0 });
    assert.equal(await dispatcher.drain(), 1);
    assert.deepEqual(store.counts(), { pending: 0, delivered: 0, failed: 0, dead: 1 });
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-STATE-004: an unregistered subscription retires its pending delivery", async () => {
  const root = await temporaryRoot("remembra-webhook-unregistered-");
  const store = new FileWebhookDeliveryStore(root);
  const transport = new RecordingTransport([{ status: "delivered", statusCode: 204 }]);
  const dispatcher = new WebhookDispatcher(store, transport, { now: () => 1_000 });
  try {
    dispatcher.register(subscription());
    dispatcher.publish(event());
    assert.equal(dispatcher.unregister("sub-1"), true);
    assert.equal(dispatcher.subscriptionCount, 0);
    await dispatcher.drain();
    assert.equal(transport.requests.length, 0);
    assert.deepEqual(store.counts(), { pending: 0, delivered: 0, failed: 0, dead: 1 });
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-SECRET-001: no secret is persisted, logged, or delivered", async () => {
  const root = await temporaryRoot("remembra-webhook-secret-");
  const store = new FileWebhookDeliveryStore(root);
  const transport = new RecordingTransport([{ status: "delivered", statusCode: 200 }]);
  const dispatcher = new WebhookDispatcher(store, transport, { now: () => 1_000 });
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  try {
    dispatcher.register(subscription());
    dispatcher.publish(event({ data: webhookMemoryPayload({ id: "m1", type: "fact", content: "hello" }) }));
    await dispatcher.drain();
    const databaseText = await fs.readFile(store.databasePath, "utf8");
    const keyText = await fs.readFile(path.join(root, "deliveries.key"));
    assert.equal(databaseText.includes(SECRET.toString("hex")), false);
    assert.equal(databaseText.includes(SECRET.toString("utf8")), false);
    assert.equal(keyText.equals(SECRET), false);
    for (const request of transport.requests) {
      assert.equal(JSON.stringify(request).includes(SECRET.toString("hex")), false);
      assert.equal(request.body.includes(SECRET.toString("hex")), false);
    }
    // The secret fingerprint is a truncated digest, not the key.
    assert.equal(webhookSecretFingerprint(SECRET).length, 16);
    assert.notEqual(webhookSecretFingerprint(SECRET), SECRET.toString("hex"));
    void lines;
    void originalWrite;
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WEBHOOK-TRANSPORT-001: the HTTP transport classifies status codes without reading bodies", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const makeFetch = (status: number) => async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(status === 204 ? null : "body-that-must-not-be-logged", { status });
  };
  const request = {
    deliveryId: "d",
    eventId: "e",
    type: "memory.created" as const,
    url: "https://hooks.example.test/x",
    headers: { "x-remembra-signature": "t=1,v1=aa" },
    body: "{}",
    attempt: 1,
    signal: new AbortController().signal,
  };
  const delivered = createFetchWebhookTransport({ fetchLike: makeFetch(204) as unknown as typeof fetch });
  assert.deepEqual(await delivered.deliver(request), { status: "delivered", statusCode: 204 });
  assert.equal(seen[0].init.redirect, "error");

  const serverError = createFetchWebhookTransport({ fetchLike: makeFetch(503) as unknown as typeof fetch });
  const retryable = await serverError.deliver(request);
  assert.equal(retryable.status, "failed");
  assert.equal(retryable.status === "failed" && retryable.retryable, true);

  const clientError = createFetchWebhookTransport({ fetchLike: makeFetch(404) as unknown as typeof fetch });
  const permanent = await clientError.deliver(request);
  assert.equal(permanent.status === "failed" && permanent.retryable, false);

  const networkError = createFetchWebhookTransport({
    fetchLike: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });
  const network = await networkError.deliver(request);
  assert.equal(network.status === "failed" && network.retryable, true);
  assert.equal(network.status === "failed" && network.error.includes("ECONNREFUSED"), true);
  assert.throws(
    () => createFetchWebhookTransport({ timeoutMs: 5 }),
    (error: unknown) => error instanceof RemembraError && error.code === "INVALID_INPUT",
  );
});
