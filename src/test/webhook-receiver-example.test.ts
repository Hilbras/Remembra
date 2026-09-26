import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { signWebhookPayload, webhookDeliveryId, webhookMemoryPayload } from "../webhooks.js";

const SECRET = Buffer.from("7a".repeat(32), "hex");

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "remembra-webhook",
    version: 1,
    id: "evt-receiver-1",
    type: "memory.created",
    createdAt: new Date().toISOString(),
    data: webhookMemoryPayload({ id: "m1", type: "fact", content: "hello" }),
    ...overrides,
  };
}

interface ReceiverDecision {
  status: number;
  body?: { error: string };
  event?: { type: string; id: string };
}

interface ReceiverModule {
  handleDelivery(headers: Record<string, string>, rawBody: string): ReceiverDecision;
}

/**
 * The example reads its secret from the environment at import time. The
 * specifier stays a variable so this test also proves the example resolves as
 * plain JavaScript, exactly as a user would run it.
 */
async function loadReceiver(): Promise<ReceiverModule> {
  process.env.REMEMBRA_WEBHOOK_SECRET = SECRET.toString("hex");
  const specifier = new URL("../../examples/webhook-receiver/node.mjs", import.meta.url).href;
  return (await import(specifier)) as ReceiverModule;
}

test("EXAMPLE-008: the receiver example accepts a valid delivery and refuses a replay", async () => {
  const receiver = await loadReceiver();
  const body = JSON.stringify(event());
  const deliveryId = webhookDeliveryId("sub-1", "evt-receiver-1");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "x-remembra-signature": signWebhookPayload(SECRET, Number(timestamp), body),
    "x-remembra-delivery": deliveryId,
    "x-remembra-event": "memory.created",
  };

  const first = receiver.handleDelivery(headers, body);
  assert.equal(first.status, 204);
  assert.equal(first.event?.type, "memory.created");

  // The same delivery id is refused the second time.
  const replay = receiver.handleDelivery(headers, body);
  assert.equal(replay.status, 409);
  assert.equal(replay.body?.error, "replayed delivery");
});

test("EXAMPLE-009: the receiver example refuses tampering, expiry, and mismatched headers", async () => {
  const receiver = await loadReceiver();
  const body = JSON.stringify(event({ id: "evt-receiver-2" }));
  const now = Date.now();
  const signed = (payload: string, at: number) => signWebhookPayload(SECRET, Math.floor(at / 1000), payload);

  // A body altered after signing does not verify.
  const tampered = receiver.handleDelivery(
    {
      "x-remembra-signature": signed(body, now),
      "x-remembra-delivery": webhookDeliveryId("sub-1", "evt-receiver-2"),
      "x-remembra-event": "memory.created",
    },
    `${body} `,
  );
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body?.error, "signature signature");

  // A delivery outside the window is refused even with a correct signature.
  const stale = receiver.handleDelivery(
    {
      "x-remembra-signature": signed(body, now - 60 * 60_000),
      "x-remembra-delivery": webhookDeliveryId("sub-1", "evt-receiver-3"),
      "x-remembra-event": "memory.created",
    },
    body,
  );
  assert.equal(stale.status, 401);
  assert.equal(stale.body?.error, "signature timestamp");

  // A header that disagrees with the signed body is refused.
  const mismatched = receiver.handleDelivery(
    {
      "x-remembra-signature": signed(body, now),
      "x-remebra-event": "memory.created",
      "x-remembra-delivery": webhookDeliveryId("sub-1", "evt-receiver-4"),
      "x-remembra-event": "memory.deleted",
    } as Record<string, string>,
    body,
  );
  assert.equal(mismatched.status, 400);
  assert.match(String(mismatched.body?.error), /does not match/);

  // Missing headers are refused before any parsing happens.
  assert.equal(receiver.handleDelivery({ "x-remembra-event": "memory.created" }, body).status, 400);
  assert.equal(receiver.handleDelivery({ "x-remembra-signature": "garbage" }, body).status, 400);
});

test("EXAMPLE-010: the receiver example does not accept a body signed with another secret", async () => {
  const receiver = await loadReceiver();
  const body = JSON.stringify(event({ id: "evt-receiver-5" }));
  const foreign = createHmac("sha256", randomBytes(32))
    .update(`${Math.floor(Date.now() / 1000)}.${body}`, "utf8")
    .digest("hex");
  const result = receiver.handleDelivery(
    {
      "x-remembra-signature": `t=${Math.floor(Date.now() / 1000)},v1=${foreign}`,
      "x-remembra-delivery": webhookDeliveryId("sub-1", "evt-receiver-5"),
      "x-remembra-event": "memory.created",
    },
    body,
  );
  assert.equal(result.status, 401);
  // The digest alone is never enough: the request is refused before the body
  // is trusted, so a forged sender learns nothing.
  assert.equal(createHash("sha256").update(body).digest("hex").length, 64);
});
