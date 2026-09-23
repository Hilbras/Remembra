/**
 * Provider request policy (Master Plan §3.7 — Provider Reliability).
 *
 * Every external provider call (LLM chat, embeddings) goes through
 * providerFetch(), which guarantees:
 *
 *   - per-attempt timeout           REMEMBRA_PROVIDER_TIMEOUT_MS  (default 60000)
 *   - bounded retries               REMEMBRA_PROVIDER_RETRIES     (default 2, after the first attempt)
 *   - overall wall-clock budget     REMEMBRA_PROVIDER_BUDGET_MS   (default 180000)
 *   - cancellation                  optional AbortSignal (HTTP disconnects, tests)
 *   - error normalization           RemembraError: PROVIDER_TIMEOUT | LLM_ERROR
 *
 * Retry policy: network failures, HTTP 408/429 and 5xx are retried with
 * capped exponential backoff (base REMEMBRA_PROVIDER_BACKOFF_MS, default
 * 250ms); other 4xx are caller errors and fail immediately. Sleeps, attempts
 * and per-attempt timeouts are all clipped to the remaining budget, so a
 * hanging provider can never block the memory service indefinitely.
 *
 * Log hygiene (Phase 2 rule): events carry label/attempt/status/reason only —
 * never URLs, headers, keys, or bodies.
 */
import { RemembraError } from "./errors.js";
import { logEvent } from "./log.js";

export interface ProviderPolicy {
  /** Per-attempt timeout (ms). */
  timeoutMs: number;
  /** Retries AFTER the first attempt (0 = single attempt). */
  retries: number;
  /** Wall-clock cap across all attempts (ms). */
  budgetMs: number;
  /** Backoff base (ms); doubles per retry, capped at 2s. */
  backoffMs: number;
}

export function providerPolicy(): ProviderPolicy {
  return {
    timeoutMs: envNum("REMEMBRA_PROVIDER_TIMEOUT_MS", 60_000),
    retries: envNum("REMEMBRA_PROVIDER_RETRIES", 2),
    budgetMs: envNum("REMEMBRA_PROVIDER_BUDGET_MS", 180_000),
    backoffMs: envNum("REMEMBRA_PROVIDER_BACKOFF_MS", 250),
  };
}

function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/** Statuses worth another attempt. Everything else non-2xx is fatal. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface ProviderFetchOptions {
  /** Low-cardinality label for events/errors: "llm" | "embeddings". */
  label: string;
  headers?: Record<string, string>;
  /** JSON body (serialized once). */
  body?: unknown;
  /** Caller cancellation — aborts the in-flight attempt and stops retrying. */
  signal?: AbortSignal;
}

/**
 * POST JSON with the provider policy applied. Returns the parsed JSON body.
 * Throws normalized RemembraErrors:
 *   PROVIDER_TIMEOUT  — per-attempt timeout or budget exhausted
 *   LLM_ERROR         — non-retryable status, retries exhausted, cancelled,
 *                       or a malformed (non-JSON) response body
 */
export async function providerFetch(url: string, opts: ProviderFetchOptions): Promise<any> {
  const p = providerPolicy();
  const deadline = Date.now() + p.budgetMs;
  const attempts = Math.max(1, p.retries + 1);
  const { label } = opts;

  if (opts.signal?.aborted) throw cancelledError(label);

  let lastReason = "unknown";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      const backoff = Math.min(2_000, p.backoffMs * 2 ** (attempt - 2));
      await abortableSleep(backoff, deadline, opts.signal, label);
      logEvent(
        "warn",
        "provider_retry",
        { provider: label, attempt: attempt - 1, retries_left: attempts - attempt, reason: lastReason },
        `Remembra: ${label} request failed (${lastReason}); retrying (attempt ${attempt - 1}/${attempts})`,
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw budgetError(label, attempts, lastReason);
    const attemptTimeout = Math.max(1, Math.min(p.timeoutMs, remaining));

    // Per-attempt controller bridging caller cancellation + timeout.
    const ac = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, attemptTimeout);
    const onAbort = () => {
      cancelled = true;
      ac.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: ac.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        lastReason = `http_${res.status}`;
        if (retryableStatus(res.status) && attempt < attempts && Date.now() < deadline) continue;
        const err =
          retryableStatus(res.status) && attempt > 1
            ? new RemembraError("LLM_ERROR", `${label} request failed after ${attempt} attempt(s) (${res.status}): ${detail}`)
            : new RemembraError("LLM_ERROR", `${label} request failed (${res.status}): ${detail}`);
        logEvent(
          "error",
          "provider_failed",
          { provider: label, attempts: attempt, status: res.status, reason: lastReason },
          `Remembra: ${label} request failed (${res.status})`,
        );
        throw err;
      }

      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        logEvent(
          "error",
          "provider_failed",
          { provider: label, attempts: attempt, reason: "malformed_body" },
          `Remembra: ${label} returned a malformed (non-JSON) response body`,
        );
        throw new RemembraError("LLM_ERROR", `${label} returned a malformed (non-JSON) response body`);
      }
    } catch (err) {
      if (err instanceof RemembraError) throw err; // already classified above
      if (cancelled) {
        logEvent(
          "warn",
          "provider_cancelled",
          { provider: label, attempts: attempt },
          `Remembra: ${label} request cancelled by caller`,
        );
        throw cancelledError(label);
      }
      lastReason = timedOut ? "timeout" : `network: ${err instanceof Error ? err.message : String(err)}`;
      if (timedOut) {
        if (attempt >= attempts || Date.now() >= deadline) {
          logEvent(
            "error",
            "provider_failed",
            { provider: label, attempts: attempt, reason: "timeout" },
            `Remembra: ${label} request timed out after ${attempt} attempt(s)`,
          );
          throw new RemembraError(
            "PROVIDER_TIMEOUT",
            `${label} request timed out after ${attempt} attempt(s) (${attemptTimeout}ms per attempt)`,
            { cause: err },
          );
        }
        continue; // retry the timeout
      }
      // Network-level failure (DNS, refused, reset): retry if budget remains.
      if (attempt >= attempts || Date.now() >= deadline) {
        logEvent(
          "error",
          "provider_failed",
          { provider: label, attempts: attempt, reason: "network" },
          `Remembra: ${label} request failed after ${attempt} attempt(s) (network error)`,
        );
        throw new RemembraError(
          "LLM_ERROR",
          `${label} request failed after ${attempt} attempt(s): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  /* c8 ignore next */
  throw new RemembraError("LLM_ERROR", `${label} request failed: retries exhausted`);
}

function cancelledError(label: string): RemembraError {
  return new RemembraError("LLM_ERROR", `${label} request cancelled`);
}

function budgetError(label: string, attempts: number, reason: string): RemembraError {
  logEvent(
    "error",
    "provider_failed",
    { provider: label, attempts, reason: "budget_exhausted" },
    `Remembra: ${label} request exceeded the provider budget`,
  );
  return new RemembraError("PROVIDER_TIMEOUT", `${label} request exceeded the provider budget`);
}

/** Sleep `ms`, but stop early (throwing) on cancellation or budget expiry. */
async function abortableSleep(
  ms: number,
  deadline: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  const capped = Math.min(ms, Math.max(0, deadline - Date.now()));
  if (capped <= 0) {
    if (signal?.aborted) throw cancelledError(label);
    if (Date.now() >= deadline) throw budgetError(label, 0, "budget_exhausted");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, capped);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(cancelledError(label));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
