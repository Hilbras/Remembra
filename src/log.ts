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
  if (logFormat() === "json") {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...(msg !== undefined ? { msg } : {}),
        ...fields, // undefined values are dropped by JSON.stringify
      }),
    );
    return;
  }
  if (msg !== undefined) {
    console.error(msg);
    return;
  }
  const extra = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.error(`Remembra: ${event}${extra ? " " + extra : ""}`);
}
