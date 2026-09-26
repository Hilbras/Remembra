/**
 * Webhook receiver example: verify the signature, reject a replay, then act.
 *
 * This is the other half of the delivery contract. A receiver must do three
 * things before trusting a body:
 *
 *   1. read the raw body (verification is over the exact bytes sent),
 *   2. verify `x-remembra-signature` with your shared secret, and
 *   3. reject a delivery id it has already handled.
 *
 * Skipping step 1 is the classic mistake: re-serializing the JSON changes the
 * bytes and the signature will never match.
 *
 * Run a receiver:   REMEMBRA_WEBHOOK_SECRET=<hex> node examples/webhook-receiver/node.mjs
 * Then a sender:    REMEMBRA_WEBHOOKS='[{"id":"sub-1","url":"http://127.0.0.1:9099/hook",
 *                     "secret":"<hex>","events":["memory.created"]}]' npx remembra --http
 */
import { createServer } from "node:http";
import { WebhookReplayCache, verifyWebhookSignature } from "@hilbras/remembra/webhooks";

const PORT = Number(process.env.WEBHOOK_PORT ?? 9099);
const SECRET = Buffer.from(process.env.REMEMBRA_WEBHOOK_SECRET ?? "", "hex");
if (SECRET.length < 32) {
  console.error("set REMEMBRA_WEBHOOK_SECRET to at least 32 bytes of hex");
  process.exit(1);
}

// Bounded, TTL-based dedupe. `evictions` above zero means the guard was full
// and you should alert: a full guard can accept a replay.
const seen = new WebhookReplayCache(5 * 60_000, 10_000);

/** Decide what to do with one delivery. Exported so it can be unit tested. */
export function handleDelivery(headers, rawBody) {
  const signature = headers["x-remembra-signature"];
  const deliveryId = headers["x-remembra-delivery"];
  const eventType = headers["x-remembra-event"];

  if (typeof signature !== "string" || typeof deliveryId !== "string") {
    return { status: 400, body: { error: "missing signature or delivery id" } };
  }
  // 1. Verify the signature over the exact bytes received.
  const verified = verifyWebhookSignature(SECRET, signature, rawBody, { toleranceMs: 5 * 60_000 });
  if (!verified.ok) {
    // "timestamp" means the delivery is outside the window; "signature" means
    // the body was altered or the secret is wrong. Neither is trustworthy.
    return { status: 401, body: { error: `signature ${verified.reason}` } };
  }
  // 2. Reject a replay of a delivery already handled.
  if (!seen.accept(deliveryId)) {
    return { status: 409, body: { error: "replayed delivery" } };
  }
  // 3. Only now is the body trustworthy.
  const event = JSON.parse(rawBody);
  if (eventType && event.type !== eventType) {
    return { status: 400, body: { error: "event type header does not match the body" } };
  }
  return { status: 204, event };
}

export const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const result = handleDelivery(request.headers, rawBody);
    if (result.status === 204) {
      console.log(`delivered ${result.event.type} ${result.event.id}`);
      response.writeHead(204).end();
      return;
    }
    // A 4xx tells the sender the delivery is permanent, so it stops retrying.
    response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
  });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`webhook receiver listening on http://127.0.0.1:${PORT}/hook`);
    if (seen.evictions > 0) console.warn(`replay guard evicted ${seen.evictions} entries`);
  });
}
