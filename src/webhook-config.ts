/**
 * Host configuration for signed webhook delivery (V5.4).
 *
 * Configuration is opt-in and comes from a single environment variable so a
 * deployment can enable delivery without a code change:
 *
 *   REMEMBRA_WEBHOOKS=[{"id":"tenant-a","url":"https://hooks.example.com/x",
 *                       "secret":"<hex>","events":["memory.created"]}]
 *
 * Secrets are accepted as hex or base64 and are never logged, echoed, or
 * written to the delivery state. Invalid configuration fails startup rather
 * than silently delivering nothing.
 */
import { RemembraError } from "./errors.js";
import { assertValidSubscription, type WebhookEventType, type WebhookSubscription } from "./webhooks.js";

const MAX_CONFIG_LENGTH = 16 * 1024;
const MAX_SUBSCRIPTIONS = 32;

function decodeSecret(value: string): Buffer | undefined {
  if (typeof value !== "string" || value.length < 32 || value.length > 256) return undefined;
  if (/^[a-f0-9]+$/i.test(value) && value.length % 2 === 0) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length >= 32) return decoded;
  }
  // A raw passphrase is accepted so a deployment is not forced into hex.
  return Buffer.from(value, "utf8");
}

/** Parse and validate `REMEMBRA_WEBHOOKS`; an absent variable yields no subscriptions. */
export function parseWebhookSubscriptions(raw: string | undefined): WebhookSubscription[] {
  if (raw === undefined || raw.trim() === "") return [];
  if (raw.length > MAX_CONFIG_LENGTH) {
    throw new RemembraError("INVALID_INPUT", "REMEMBRA_WEBHOOKS exceeds the supported configuration size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RemembraError("INVALID_INPUT", "REMEMBRA_WEBHOOKS must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new RemembraError("INVALID_INPUT", "REMEMBRA_WEBHOOKS must be a JSON array of subscriptions");
  }
  if (parsed.length > MAX_SUBSCRIPTIONS) {
    throw new RemembraError("INVALID_INPUT", `REMEMBRA_WEBHOOKS accepts at most ${MAX_SUBSCRIPTIONS} subscriptions`);
  }
  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RemembraError("INVALID_INPUT", "each webhook subscription must be an object");
    }
    const value = entry as Record<string, unknown>;
    const secret = decodeSecret(String(value.secret ?? ""));
    if (!secret) throw new RemembraError("INVALID_INPUT", "webhook secret must decode to 32-128 bytes");
    const events = Array.isArray(value.events) ? (value.events as WebhookEventType[]) : [];
    const subscription: WebhookSubscription = {
      id: String(value.id ?? ""),
      url: String(value.url ?? ""),
      secret,
      events,
    };
    assertValidSubscription(subscription);
    if (seen.has(subscription.id)) {
      throw new RemembraError("INVALID_INPUT", `duplicate webhook subscription id: ${subscription.id}`);
    }
    seen.add(subscription.id);
    return subscription;
  });
}

/** Bounded drain interval; delivery never blocks the write path. */
export function webhookDrainIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 5_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new RemembraError("INVALID_INPUT", "REMEMBRA_WEBHOOK_INTERVAL_MS must be 1000-3600000");
  }
  return value;
}
