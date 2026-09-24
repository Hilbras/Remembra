/**
 * Structured error classification (audit: Phase 2 — structured error
 * classification for store operations).
 *
 * Every failure that callers should react to carries a stable `code`.
 * HTTP maps codes to statuses; MCP tools surface them as `[CODE] message`.
 */
import { metrics } from "./metrics.js";

export type ErrorCode =
  | "INVALID_INPUT" // Zod validation failed on a service boundary
  | "SNAPSHOT_INVALID" // export/import file failed validation (nothing written)
  | "SCOPE_ESCAPES_ROOT" // P0 defense: scope resolves outside the storage root
  | "NOT_FOUND" // memory id does not exist
  | "CONFLICT" // id collision / resource state conflict
  | "LOCK_TIMEOUT" // cross-process storage lock not acquired in time
  | "IO_ERROR" // filesystem failure during a store operation
  | "LLM_ERROR" // external provider failure (LLM/embeddings) after retries, cancellation, or malformed response
  | "PROVIDER_TIMEOUT" // provider did not answer within the per-attempt timeout or overall budget
  | "ENCRYPTED_NO_KEY" // memory file is encrypted but REMEMBRA_ENCRYPT_KEY is missing/wrong
  | "RATE_LIMITED" // V4.4: request rate exceeded the per-key window
  | "REQUEST_TIMEOUT" // V4.4: handler exceeded REMEMBRA_REQUEST_TIMEOUT_MS
  | "SERVICE_UNAVAILABLE" // V4.4: concurrency limit reached
  | "QUEUE_FULL" // V4.8: bounded background queue is full
  | "QUEUE_CLOSED" // V4.8: background queue is shutting down
  | "SENSITIVE_DATA" // V4.4: sensitive data detected under reject policy
  | "INJECTION_DETECTED" // V4.4: prompt injection pattern flagged
  | "TENANT_REQUIRED"; // V5: strict mode requires a trusted tenant context

export class RemembraError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RemembraError";
  }
}

export function isRemembraError(err: unknown): err is RemembraError {
  return err instanceof RemembraError;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  SNAPSHOT_INVALID: 400,
  SCOPE_ESCAPES_ROOT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LOCK_TIMEOUT: 423, // Locked
  IO_ERROR: 500,
  LLM_ERROR: 502,
  PROVIDER_TIMEOUT: 504, // Gateway Timeout — bounded by the provider policy (§3.7)
  ENCRYPTED_NO_KEY: 503, // Service Unavailable — storage unreadable without the key
  RATE_LIMITED: 429, // V4.4: Too Many Requests
  REQUEST_TIMEOUT: 504, // V4.4: Gateway Timeout
  SERVICE_UNAVAILABLE: 503, // V4.4: Server overloaded
  QUEUE_FULL: 429, // Background work capacity reached
  QUEUE_CLOSED: 503, // Background worker is shutting down
  SENSITIVE_DATA: 400, // V4.4: Bad Request — sensitive data under reject policy
  INJECTION_DETECTED: 400, // V4.4: Bad Request — injection detected under strict policy
  TENANT_REQUIRED: 403, // V5: trusted tenant context is required
};

export function statusFor(err: RemembraError): number {
  return HTTP_STATUS[err.code] ?? 500;
}

function zodSummary(err: { issues?: { path: (string | number)[]; message: string }[] }): string {
  const issues = err.issues ?? [];
  const first = issues[0];
  const where = first ? first.path.join(".") || "(root)" : "input";
  const what = first ? first.message : "invalid input";
  return issues.length > 1 ? `${where}: ${what} (+${issues.length - 1} more)` : `${where}: ${what}`;
}

function isZodLike(err: unknown): err is { name: string; issues?: { path: (string | number)[]; message: string }[] } {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ZodError";
}

/** Re-throw Zod failures as a classified error; pass anything else through. */
export function inputError(err: unknown, code: "INVALID_INPUT" | "SNAPSHOT_INVALID"): unknown {
  if (isZodLike(err)) return new RemembraError(code, zodSummary(err), { cause: err });
  return err;
}

/** Uniform single-line rendering for MCP tool failures. */
export function formatToolError(err: unknown): string {
  if (isRemembraError(err)) return `[${err.code}] ${err.message}`;
  if (isZodLike(err)) return `[INVALID_INPUT] ${zodSummary(err)}`;
  return `[INTERNAL] ${err instanceof Error ? err.message : String(err)}`;
}

/** Stable low-cardinality label for metrics (`remembra_errors_total{code}`). */
export function errorLabel(err: unknown): ErrorCode | "INVALID_INPUT" | "INTERNAL" {
  if (isRemembraError(err)) return err.code;
  if (isZodLike(err)) return "INVALID_INPUT";
  return "INTERNAL";
}

/** MCP tool error result shape (structural — no SDK import needed). */
export function toolFail(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  metrics.inc("remembra_errors_total", { code: errorLabel(err), transport: "mcp" });
  return { content: [{ type: "text", text: formatToolError(err) }], isError: true };
}
