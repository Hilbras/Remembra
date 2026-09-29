/**
 * Shared-state configuration and honest degradation (V5.6.0, roadmap §26).
 *
 * ## The one thing that must never happen
 *
 * A deployment configured `REMEMBRA_REDIS_URL` and then, for any reason, ends up
 * enforcing **per-instance** limits. Two instances each allow 60/min, so the
 * fleet allows 120/min and every instance reports a limit it is not enforcing.
 * Nothing in the logs would look wrong. That is why T05 made an unreachable
 * Redis a startup failure, and why this module makes one that *drops* after
 * startup **fail closed** rather than fall back: the limiter refuses the request
 * instead of granting it, and readiness reports the truth so a load balancer
 * stops sending traffic.
 *
 * ## Why failing closed rather than staying available
 *
 * Refusing is an availability cost; serving on local state is a correctness cost
 * nobody asked for. A quota is a stated limit on a tenant's spend, so quietly
 * exceeding it is worse than refusing a request during a Redis blip. Liveness
 * stays up throughout, so an operator can still reach the process to diagnose it,
 * and the limiter recovers by itself the moment a call succeeds — no restart.
 *
 * ## A single-process deployment is untouched
 *
 * With no `REMEMBRA_REDIS_URL` there is no client, no connection, and no import
 * of the optional package. The health report is `undefined` in that case, so the
 * readiness payload is byte-identical to the previous release rather than
 * carrying a new field that says "absent".
 */
import { RemembraError, errorLabel, isRemembraError } from "./errors.js";
import { logEvent } from "./log.js";
import { metrics } from "./metrics.js";
import { assertPolicy, type QuotaPolicies, type QuotaPolicy } from "./quota.js";
import {
  REDIS_DISTRIBUTED_URL,
  RedisLockProvider,
  RedisQuotaRateLimiter,
  connectSharedState,
  parseRedisUrl,
  type RedisConnection,
  type RedisLike,
} from "./redis.js";
import type { LockProvider } from "./lock.js";
import type { RateLimiter } from "./rate-limiter.js";

/**
 * `absent`        — no `REMEMBRA_REDIS_URL`; single-host, no shared state at all.
 * `connected`     — configured and the last operation succeeded.
 * `unreachable`   — configured but the last operation failed; limiting is failing closed.
 */
export type SharedStateMode = "absent" | "connected" | "unreachable";

/**
 * The health-facing view. Deliberately has no URL, host, port, or credentials —
 * a Redis URL routinely embeds a password, and `/health/ready` sits behind
 * authentication but is still the endpoint most likely to be logged, cached, or
 * exposed through a proxy.
 */
export interface SharedStateReport {
  readonly mode: SharedStateMode;
  /** A classified label only, never a message that could carry connection detail. */
  readonly error?: string;
}

export interface SharedStateConfig {
  base: QuotaPolicy;
  policies?: QuotaPolicies;
  /** Key prefix, so several deployments can share one Redis. */
  prefix?: string;
}

/**
 * Read and validate the shared-state configuration.
 *
 * Synchronous and total apart from a bad value: an absent variable yields
 * `undefined` and a malformed one throws `INVALID_INPUT`, so a typo is a startup
 * error rather than a surprising connection attempt.
 */
export function resolveSharedStateConfig(
  env: NodeJS.ProcessEnv = process.env,
): { url: string } | undefined {
  const url = parseRedisUrl(env[REDIS_DISTRIBUTED_URL]);
  return url === undefined ? undefined : { url };
}

export class SharedState {
  readonly configured: boolean;
  private connection: RedisConnection | undefined;
  private mode: SharedStateMode;
  private lastError: string | undefined;

  private constructor(options: { configured: boolean; connection?: RedisConnection }) {
    this.configured = options.configured;
    this.connection = options.connection;
    this.mode = options.connection ? "connected" : "absent";
  }

  /** An explicitly absent shared state, for tests and for callers that opt out. */
  static absent(): SharedState {
    return new SharedState({ configured: false });
  }

  /**
   * Connect if configured. An absent variable performs no Redis work and imports
   * no Redis code; a configured one that cannot connect throws, so the process
   * does not start rather than running on per-instance state.
   */
  static async open(
    env: NodeJS.ProcessEnv = process.env,
    importer?: (specifier: string) => Promise<Record<string, unknown>>,
  ): Promise<SharedState> {
    const config = resolveSharedStateConfig(env);
    if (!config) {
      return new SharedState({ configured: false });
    }
    const connection = await connectSharedState(env, importer);
    if (!connection) {
      // Unreachable in practice: the URL parsed a moment ago.
      throw new RemembraError("SERVICE_UNAVAILABLE", `${REDIS_DISTRIBUTED_URL} is required for shared state`);
    }
    return new SharedState({ configured: true, connection });
  }

  /**
   * The health view, or `undefined` when shared state is not configured so the
   * payload stays exactly what it was before this milestone.
   */
  get report(): SharedStateReport | undefined {
    if (!this.configured) return undefined;
    return this.lastError === undefined ? { mode: this.mode } : { mode: this.mode, error: this.lastError };
  }

  /**
   * Readiness: a configured-but-unreachable shared store makes the process
   * unready, because it is currently refusing requests it is meant to admit.
   */
  get ready(): boolean {
    return this.mode !== "unreachable";
  }

  /** The connected client. Throws if shared state was never configured. */
  get client(): RedisLike {
    if (!this.connection) {
      throw new RemembraError("SERVICE_UNAVAILABLE", "shared state is not configured");
    }
    return this.connection.client;
  }

  /** A `LockProvider` over the shared store, or `undefined` when absent. */
  lockProvider(options: { prefix?: string } = {}): LockProvider | undefined {
    if (!this.connection) return undefined;
    return new RedisLockProvider(this.connection.client, options);
  }

  /**
   * A rate limiter over the shared store, failing closed.
   *
   * The policies are the *same* object the in-process limiter would have been
   * built from, validated by the same function, so a deployment cannot get one
   * set of limits in single-host mode and a different one in shared mode.
   */
  rateLimiter(config: SharedStateConfig): RateLimiter | undefined {
    if (!this.connection) return undefined;
    return new FailingClosedRateLimiter(
      new RedisQuotaRateLimiter({
        client: this.connection.client,
        base: assertPolicy("base", config.base, "quota"),
        ...(config.policies ? { policies: config.policies } : {}),
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
      }),
      () => this.markUnreachable("SERVICE_UNAVAILABLE"),
      () => this.markConnected(),
    );
  }

  markUnreachable(label: string): void {
    const wasConnected = this.mode === "connected";
    this.mode = "unreachable";
    this.lastError = label;
    if (wasConnected) {
      // Logged only on the transition. A blip that flaps every second would
      // otherwise fill the log with identical lines and hide the first one.
      logEvent("error", "shared_state.unreachable", { error: label });
      metrics.inc("remembra_shared_state_transitions_total", { to: "unreachable" });
    }
  }

  markConnected(): void {
    if (this.mode === "unreachable") {
      logEvent("info", "shared_state.recovered", {});
      metrics.inc("remembra_shared_state_transitions_total", { to: "connected" });
    }
    this.mode = "connected";
    this.lastError = undefined;
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = undefined;
  }
}

/**
 * Wraps a shared-store limiter so a client failure refuses the request.
 *
 * Every call is attempted, and every failure is a classified
 * `SERVICE_UNAVAILABLE` — the same code `statusFor` already maps to 503. The
 * original error is carried as `cause` and logged as a label, never as text: a
 * Redis error string routinely contains the host and sometimes the URL.
 */
class FailingClosedRateLimiter implements RateLimiter {
  private readonly inner: RateLimiter;
  private readonly onFailure: (label: string) => void;
  private readonly onSuccess: () => void;

  constructor(inner: RateLimiter, onFailure: (label: string) => void, onSuccess: () => void) {
    this.inner = inner;
    this.onFailure = onFailure;
    this.onSuccess = onSuccess;
  }

  private async attempt<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      // A success is what recovers the process, so recovery needs no restart and
      // no operator action.
      this.onSuccess();
      return result;
    } catch (error) {
      const label = isRemembraError(error) ? error.code : errorLabel(error);
      this.onFailure(label);
      // The label is already a bounded classified token; the guard is only there
      // so a future code that widens `errorLabel` cannot blow up the label set.
      metrics.inc("remembra_shared_state_failures_total", {
        operation: /^[A-Z_]{1,32}$/.test(label) ? label : "OTHER",
      });
      logEvent("error", "shared_state.limiter_failed", { error: label });
      throw new RemembraError("SERVICE_UNAVAILABLE", "shared rate-limit state is unavailable", { cause: error });
    }
  }

  check(identity: Parameters<RateLimiter["check"]>[0]): ReturnType<RateLimiter["check"]> {
    return this.attempt(() => this.inner.check(identity));
  }

  consume(identity: Parameters<RateLimiter["consume"]>[0]): ReturnType<RateLimiter["consume"]> {
    return this.attempt(() => this.inner.consume(identity));
  }

  async reset(identity: Parameters<RateLimiter["reset"]>[0]): Promise<void> {
    await this.attempt(() => this.inner.reset(identity));
  }
}
