/**
 * Public, dependency-free API compatibility contract.
 *
 * The established namespace is `/api/v1`; the roadmap's `/v1/...` spelling is
 * illustrative and is intentionally not added as a second alias.
 */
export const API_VERSION = "v1" as const;
export const API_PREFIX = "/api/v1" as const;
export const API_VERSION_HEADER = "X-Remembra-API-Version" as const;
export const REQUEST_ID_HEADER = "X-Remembra-Request-Id" as const;
export const REQUEST_ID_MAX_LENGTH = 128;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key" as const;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:+/=-]{0,127}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= REQUEST_ID_MAX_LENGTH
    && REQUEST_ID_PATTERN.test(value);
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= IDEMPOTENCY_KEY_MAX_LENGTH
    && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export const API_CAPABILITIES = [
  "memory",
  "context",
  "snapshot",
  "batch",
  "batch-idempotency",
  "tenant-entities",
  "health",
  "metrics",
  "audit",
  "quality",
  "agents",
] as const;

export type ApiCapability = (typeof API_CAPABILITIES)[number];

export interface ApiCapabilitiesResponse {
  apiVersion: typeof API_VERSION;
  basePath: typeof API_PREFIX;
  capabilities: readonly ApiCapability[];
  compatibility: {
    legacyRoutes: true;
    versionHeader: typeof API_VERSION_HEADER;
  };
}

export const API_CAPABILITY_MANIFEST: ApiCapabilitiesResponse = Object.freeze({
  apiVersion: API_VERSION,
  basePath: API_PREFIX,
  capabilities: Object.freeze([...API_CAPABILITIES]),
  compatibility: Object.freeze({
    legacyRoutes: true,
    versionHeader: API_VERSION_HEADER,
  }),
});
