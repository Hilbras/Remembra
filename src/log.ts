/**
 * Structured logging (audit Phase 7).
 *
 * One call site for every server-side event. Format:
 *   - `json` — one object per line on **stderr**:
 *     {"ts","level","event","msg",...fields}
 *   - `text` — the human message verbatim (legacy-compatible; tests and
 *     humans grepping the console see exactly what they saw before).
 *
 * Selection: `REMEMBRA_LOG=json|text` wins; unset → auto — JSON when stderr
 * is piped/redirected (containers, CI, log shippers), text on a TTY.
 *
 * stdout stays reserved: MCP stdio framing and CLI output live there.
 * Query text and storage paths are only included under REMEMBRA_DEBUG
 * (log-hygiene rule from Phase 2).
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Request-scoped metadata (V5.1.0, roadmap §22).
 *
 * `logEvent` is called from ~50 sites across the codebase, and threading a
 * request id and operation through every one of them would be both invasive and
 * easy to forget. Instead the context is carried in an AsyncLocalStorage store,
 * so anything running inside a request picks it up automatically — including
 * code that has no idea a request exists.
 *
 * Everything here passes through the same centralized redactor as any other
 * field. `tenantId` is hashed at the boundary rather than logged raw, so a
 * tenant identifier never appears in a log line even if a caller passes one in
 * by mistake.
 */
export interface LogContext {
  /** Correlation id, already validated by the HTTP layer. */
  requestId?: string;
  /** Coarse operation name, e.g. `http.request`, `job.run`, `webhook.drain`. */
  operation?: string;
  /** Opaque, hashed tenant correlation. Never a raw tenant identifier. */
  tenantId?: string;
  /** Opaque, hashed agent correlation. Never a raw agent identifier. */
  agentId?: string;
  /** Elapsed milliseconds for the operation, when known. */
  durationMs?: number;
}

const context = new AsyncLocalStorage<LogContext>();

/** Run `fn` with additional request context merged over the current one. */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

/** The context in effect, if any. Used by the exporter and by tests. */
export function currentLogContext(): LogContext | undefined {
  return context.getStore();
}

/**
 * A short, opaque correlation value for a tenant or agent.
 *
 * Log lines are long-lived and widely readable, so a raw tenant id would be a
 * disclosure in every backup and log aggregator. The digest is stable, so the
 * same tenant correlates across lines, and short, so a log stays readable.
 */
export function opaqueLogId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Build the request context for an HTTP request. The request id is already
 * validated by the HTTP layer, and the tenant/agent identities are hashed here
 * rather than logged.
 */
export function requestLogContext(input: {
  requestId: string;
  operation?: string;
  tenantOrganizationId?: string;
  agentId?: string;
}): LogContext {
  const tenantId = opaqueLogId(input.tenantOrganizationId);
  const agentId = opaqueLogId(input.agentId);
  return {
    requestId: input.requestId,
    ...(input.operation ? { operation: input.operation } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

const REDACTED = "[REDACTED]";
const MAX_LOG_DEPTH = 8;
const MAX_LOG_ITEMS = 100;

function isSensitiveField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized.includes("apikey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("clientsecret") ||
    normalized.includes("privatekey") ||
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("credential") ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized === "cookie" ||
    normalized === "setcookie";
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, REDACTED)
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, REDACTED)
    .replace(/-----BEGIN [^-\\r\\n]*PRIVATE KEY-----[\\s\\S]*?-----END [^-\\r\\n]*PRIVATE KEY-----/gi, REDACTED)
    .replace(/((?:api[_ -]?key|password|secret|token)\\s*[:=]\\s*)[^\\s,;]+/gi, `$1${REDACTED}`);
}

function sanitizeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (depth >= MAX_LOG_DEPTH) return "[TRUNCATED]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_LOG_ITEMS).map((item) => sanitizeLogValue(item, depth + 1, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_LOG_ITEMS)) {
      if (isSensitiveField(key)) {
        output[key] = REDACTED;
        continue;
      }
      // The content/identity/filename policy is enforced at *every* depth, not
      // just the top level. Applying it only to top-level keys let
      // `{ details: { path: "/home/someone/..." } }` through untouched, which is
      // exactly the disclosure the policy exists to prevent. Top-level fields
      // have already been through `applyLogFieldPolicy`, so it is not re-run
      // here — that would double-hash an identity.
      const allowed = depth === 0 ? { [key]: item } : applyLogFieldPolicy({ [key]: item });
      if (!Object.prototype.hasOwnProperty.call(allowed, key)) continue;
      output[key] = sanitizeLogValue(allowed[key], depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function logFormat(): "json" | "text" {
  const pref = process.env.REMEMBRA_LOG;
  if (pref === "json" || pref === "text") return pref;
  return process.stderr.isTTY ? "text" : "json";
}

/**
 * Field policy for roadmap §22: no raw queries, no secrets, and no unbounded
 * tenant values.
 *
 * `sanitizeLogValue` redacts by field *name*, which handles secrets well but
 * cannot know that `query` holds user text or that `root` is a filesystem path.
 * So two structural rules are applied to caller fields first:
 *
 *  - **Content and path fields** (`query`, `root`, `path`, `content`, `text`,
 *    …) are dropped unless `REMEMBRA_DEBUG` is set, which is the long-standing
 *    opt-in this module's header documents. A debug flag that is not the
 *    documented one therefore cannot turn a log into a data dump.
 *  - **Identity fields** are replaced by a short stable digest rather than
 *    dropped. Correlation across lines is what makes a log useful, and a raw
 *    tenant id would be a disclosure in every backup and log aggregator.
 *
 * Request context is merged *after* this policy, so the context's own already
 * hashed `tenantId` is never hashed twice.
 */
const CONTENT_LOG_FIELDS = new Set([
  "query",
  "q",
  "text",
  "content",
  "path",
  "root",
  "dir",
  "storagepath",
]);

/**
 * Filename fields are treated separately from path fields.
 *
 * A bare basename (`bad.md`) is the entire diagnostic value of events like
 * `memory_parse_skipped`, and it discloses nothing. A path
 * (`/home/someone/.remembra/bad.md`) is a disclosure. Blanket-dropping `file`
 * silently removed a documented field operators parse for, so a filename is
 * allowed through when — and only when — it is genuinely a bare, bounded,
 * separator-free name.
 */
const FILENAME_LOG_FIELDS = new Set(["file", "filename"]);

/** Longest filename logged before it is treated as a path and dropped. */
const MAX_LOG_FILENAME_LENGTH = 128;

function isBareFilename(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_LOG_FILENAME_LENGTH) return false;
  // No separators, no parent references, no NUL — a name, not a location.
  return !/[\\/]/.test(value) && !value.includes("..") && !value.includes("\0");
}

const IDENTITY_LOG_FIELDS = new Set([
  "tenantid",
  "organizationid",
  "projectid",
  "userid",
  "agentid",
  "apikey",
]);

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/** Apply the content and identity field policy to caller-supplied fields. */
export function applyLogFieldPolicy(fields: Record<string, unknown>): Record<string, unknown> {
  const debug = process.env.REMEMBRA_DEBUG !== undefined && process.env.REMEMBRA_DEBUG !== "";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalized = normalizeFieldName(key);
    if (IDENTITY_LOG_FIELDS.has(normalized)) {
      // Keep the correlation, drop the disclosure.
      const hashed = opaqueLogId(typeof value === "string" ? value : undefined);
      if (hashed !== undefined) out[key] = hashed;
      continue;
    }
    if (CONTENT_LOG_FIELDS.has(normalized) && !debug) continue;
    if (FILENAME_LOG_FIELDS.has(normalized) && !debug && !isBareFilename(value)) {
      // A path in a filename field is still a path. Drop it.
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * True when a field is dropped, hashed, or narrowed to a basename rather than
 * logged verbatim. A `file` field is "restricted" because it is only allowed
 * through when the value is a bare name.
 */
export function isRestrictedLogField(key: string): boolean {
  const normalized = normalizeFieldName(key);
  return (
    CONTENT_LOG_FIELDS.has(normalized) ||
    IDENTITY_LOG_FIELDS.has(normalized) ||
    FILENAME_LOG_FIELDS.has(normalized)
  );
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  msg?: string,
): void {
  // Caller fields go through the policy first, then the request context, so an
  // explicit field still wins over the context for the same key.
  const store = context.getStore();
  const safe = applyLogFieldPolicy(fields);
  const merged: Record<string, unknown> = store ? { ...store, ...safe } : safe;
  const safeFields = sanitizeLogValue(merged) as Record<string, unknown>;
  const safeMsg = msg === undefined ? undefined : redactString(msg);
  if (logFormat() === "json") {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...(safeMsg !== undefined ? { msg: safeMsg } : {}),
        ...safeFields, // undefined values are dropped by JSON.stringify
      }),
    );
    return;
  }
  if (safeMsg !== undefined) {
    console.error(safeMsg);
    return;
  }
  const extra = Object.entries(safeFields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.error(`Remembra: ${event}${extra ? " " + extra : ""}`);
}

