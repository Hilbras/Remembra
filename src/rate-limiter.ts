/**
 * Sliding-window rate limiter (V4.4.0, plan §7.1).
 *
 * Per-key request accounting: each key gets its own window of timestamps.
 * When the count exceeds the limit within the window, requests are rejected.
 *
 * Exempt routes (/health, /metrics unkeyed, UI shell) bypass the check.
 */

interface WindowEntry {
  key: string;
  timestamps: number[];
}

export interface RateLimiterOptions {
  /** Max requests per window per key. Default: 60. */
  limit?: number;
  /** Window size in ms. Default: 60_000. */
  windowMs?: number;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, WindowEntry>();

  constructor(opts: RateLimiterOptions = {}) {
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Check whether a request from `key` is allowed.
   * Returns `{ allowed, remaining, retryAfterMs }`.
   */
  check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now();
    let entry = this.windows.get(key);

    if (!entry || now - entry.timestamps[0] >= this.windowMs) {
      // Fresh window.
      entry = { key, timestamps: [] };
    }

    // Evict expired timestamps.
    entry.timestamps = entry.timestamps.filter((t) => now - t < this.windowMs);

    const remaining = Math.max(0, this.limit - entry.timestamps.length);
    const allowed = entry.timestamps.length < this.limit;

    let retryAfterMs = 0;
    if (!allowed && entry.timestamps.length > 0) {
      // Time until the oldest timestamp expires.
      retryAfterMs = Math.max(0, entry.timestamps[0] + this.windowMs - now);
    }

    if (allowed) {
      entry.timestamps.push(now);
    }

    this.windows.set(key, entry);

    // Prune empty windows periodically (every 1000th call).
    if (this.windows.size > 100 && Math.random() < 0.001) {
      for (const [k, e] of this.windows) {
        if (e.timestamps.length === 0) this.windows.delete(k);
      }
    }

    return { allowed, remaining: allowed ? remaining - 1 : 0, retryAfterMs };
  }

  /** Reset all windows (for tests). */
  clear(): void {
    this.windows.clear();
  }
}
