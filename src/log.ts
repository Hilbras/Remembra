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
export type LogLevel = "debug" | "info" | "warn" | "error";

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
      output[key] = isSensitiveField(key) ? REDACTED : sanitizeLogValue(item, depth + 1, seen);
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

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  msg?: string,
): void {
  const safeFields = sanitizeLogValue(fields) as Record<string, unknown>;
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
