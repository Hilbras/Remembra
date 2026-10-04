/**
 * V6 offline and degraded operation (V6-T10).
 *
 * The design turns on one sentence: **degrading must never be silent.**
 *
 * A retrieval path that returns three thin results because the embedding provider is
 * down looks exactly like a path that found three good results. If nothing in the
 * return value says which happened, the caller cannot tell a degraded answer from a
 * real one — and "degrading into no answer is the opposite of degrading" is precisely
 * the failure this module exists to prevent.
 *
 * So degradation is a *value*, not an absence. Every degraded result carries a reason
 * and a marker, and the open/closed decision is declared **per operation** rather than
 * inherited from whatever a provider happened to throw:
 *
 *  - `embedding`, `reranking`, `summarization` — **fail open.** Quality-affecting, not
 *    authority-affecting. A lexical answer is worse than a semantic one but still
 *    correct, so failing closed would be the more dangerous choice.
 *  - `extraction` — **fail closed.** Extraction produces structured data that gets
 *    stored. Degrading it yields incomplete records that look complete, which is not
 *    degradation but corruption.
 *
 * Two further properties:
 *
 *  - **No partial tenant or policy state.** An operation that fails mid-flight leaves
 *    nothing behind: no half-applied tenant binding, no pending decision that could be
 *    committed as a partial allow.
 *  - **Core unavailable is not provider degraded.** They are separate axes, and
 *    readiness is never claimed while core is down.
 */
import { RemembraError } from "./errors.js";
import type { OptionalCapability } from "./v6-core-contract.js";

/** Every provider fault the boundary can classify. Closed, so nothing is "other". */
export const DEGRADED_FAILURES = [
  "timeout",
  "rate_limited",
  "malformed",
  "cancelled",
  "unavailable",
] as const;
export type DegradedFailure = (typeof DEGRADED_FAILURES)[number];

/** Whether an operation degrades to a partial answer or refuses outright. */
export type FailurePolicy = "fail_open" | "fail_closed";

/**
 * Per-capability failure behaviour.
 *
 * Attached to the *capability*, not the provider: two providers for the same
 * capability must not get different answers to "what happens if you fail", or
 * behaviour would depend on which one happened to be registered.
 */
export const DEFAULT_FAILURE_POLICY: Readonly<Record<OptionalCapability, FailurePolicy>> = {
  // Quality-affecting, not authority-affecting. A lexical answer is worse than a
  // semantic one but still correct, so failing closed would be worse.
  embedding: "fail_open",
  reranking: "fail_open",
  summarization: "fail_open",
  // Extraction writes structured data. A partial extraction is a wrong record, not a
  // thinner one, so it refuses.
  extraction: "fail_closed",
};

function failClosed(capability: OptionalCapability, failure: DegradedFailure): never {
  // SERVICE_UNAVAILABLE (503), not a new code: the capability is genuinely
  // unavailable and the caller may retry, which is exactly what 503 means.
  throw new RemembraError(
    "SERVICE_UNAVAILABLE",
    `capability ${capability} failed (${failure}) and its policy is fail_closed`,
  );
}

/**
 * Classify a provider fault.
 *
 * The default is `unavailable` — never "fine". An unrecognised error classified as
 * success is exactly a silent degradation, so an unknown fault is treated as the
 * conservative class and still has to pass the capability's policy.
 */
export function classifyProviderFailure(error: unknown): DegradedFailure {
  if (error === null || error === undefined) return "unavailable";

  // A cancelled operation was not attempted. Distinguishing it matters: reporting a
  // cancelled request as "degraded" would let an aborted call look like a completed
  // one with a thin result.
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return "cancelled";
  }

  const candidate = error as { name?: string; code?: string | number; message?: string };
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const code = typeof candidate?.code === "string" || typeof candidate?.code === "number" ? String(candidate.code) : "";
  const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";

  if (name === "AbortError" || code === "ABORT_ERR" || /abort|cancell?ed/.test(message)) return "cancelled";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || /timed? ?out|timeout|deadline exceeded/.test(message)) {
    return "timeout";
  }
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EAI_AGAIN" || /connection|socket hang up|network/.test(message)) {
    return "unavailable";
  }
  if (code === "429" || /rate.?limit|too many requests|quota/.test(message)) return "rate_limited";
  if (/malformed|invalid json|unexpected token|parse error|not json/.test(message)) return "malformed";

  // Unrecognised: the conservative class, never success.
  return "unavailable";
}

export interface DegradedResult<T> {
  /** True when the capability failed and the caller is receiving less than it asked for. */
  readonly degraded: boolean;
  /** False whenever the capability did not produce its declared payload. */
  readonly ok: boolean;
  /** The value, present only when `ok`. Never fabricated on the degraded path. */
  readonly value?: T;
  /** The classified fault, present only when the operation failed. */
  readonly failure?: DegradedFailure;
  /** Always present on the degraded path, so the caller can act on it. */
  readonly reason?: string;
  /** Which capability degraded, so a caller handling several can tell them apart. */
  readonly capability?: OptionalCapability;
}

/**
 * Run an optional capability under its declared failure policy.
 *
 * Fail open: returns a marker carrying the reason and no value. Never throws for a
 * provider fault, never returns a partial value dressed as a complete one.
 *
 * Fail closed: throws a typed, catchable error. Cancellation is treated as a failure
 * for classification purposes but never converted into a *value* — an aborted request
 * has no result.
 */
export async function executeWithDegradation<T>(
  capability: OptionalCapability,
  operation: () => Promise<T>,
  options: { now: number; policy?: FailurePolicy },
): Promise<DegradedResult<T>> {
  const policy = options.policy ?? DEFAULT_FAILURE_POLICY[capability];
  try {
    const value = await operation();
    return { degraded: false, ok: true, value };
  } catch (error) {
    const failure = classifyProviderFailure(error);
    if (policy === "fail_closed") failClosed(capability, failure);
    return {
      degraded: true,
      ok: false,
      failure,
      capability,
      reason:
        failure === "cancelled"
          ? `${capability} was cancelled before it produced a result`
          : `${capability} is degraded (${failure}); the caller is receiving less than it asked for`,
    };
  }
}

/**
 * Tracks in-flight tenant and policy work so a provider fault cannot leave partial
 * state behind.
 *
 * The rule is simple and absolute: an operation either commits whole or leaves nothing.
 * A half-applied tenant binding or a pending decision that can be committed as a
 * partial allow is worse than no attempt at all, because it is indistinguishable from
 * a completed one to whatever inspects it later.
 */
export class DegradedMode {
  readonly #pendingTenants = new Set<string>();
  readonly #pendingDecisions = new Map<string, string>();
  #lastDecision?: string;

  /** Record that a tenant binding is being applied. */
  beginTenantBinding(organizationId: string, projectId?: string): void {
    this.#pendingTenants.add(`${organizationId}:${projectId ?? ""}`);
  }

  /** Record that a policy evaluation is in flight for a resource class. */
  beginPolicyEvaluation(resourceClass: string): void {
    this.#pendingDecisions.set(resourceClass, "pending");
  }

  /**
   * Commit a decision. Refused unless an evaluation is in flight, so a retry cannot
   * silently overwrite a recorded decision and no decision can be committed that was
   * never actually made.
   */
  commitDecision(resourceClass: string, effect: string): void {
    const state = this.#pendingDecisions.get(resourceClass);
    if (state !== "pending") {
      // CONFLICT (409): the caller's state and the recorded state disagree. The
      // alternative, accepting it, would let a retry overwrite a recorded decision.
      throw new RemembraError(
        "CONFLICT",
        `no policy evaluation is in progress for ${resourceClass}; a decision cannot be committed without a complete evaluation`,
      );
    }
    this.#pendingDecisions.set(resourceClass, effect);
    this.#lastDecision = effect;
  }

  /**
   * Record a provider fault.
   *
   * Everything in flight is rolled back whole. Nothing partial is left behind to be
   * mistaken for completed work.
   */
  fail(capability: string, _failure: DegradedFailure = "unavailable"): void {
    this.#pendingTenants.clear();
    this.#pendingDecisions.clear();
    this.#lastDecision = undefined;
    void capability;
  }

  isTenantBound(key: string): boolean {
    return this.#pendingTenants.has(key);
  }

  partialTenants(): number {
    return this.#pendingTenants.size;
  }

  pendingDecisions(): number {
    return [...this.#pendingDecisions.values()].filter((v) => v === "pending").length;
  }

  lastDecision(): string | undefined {
    return this.#lastDecision;
  }
}

export interface OperationalStatus {
  /** Ready to serve. False whenever core is unavailable, whatever the providers do. */
  readonly ready: boolean;
  /** `ok` | `degraded` | `unavailable` — three distinct states, not two. */
  readonly status: "ok" | "degraded" | "unavailable";
  readonly core: { readonly available: boolean };
  readonly providers: { readonly degraded: boolean };
  readonly summary: string;
}

/**
 * Report operational status with core and providers on separate axes.
 *
 * The distinction is load-bearing. A disconnected installation with a dead provider is
 * **degraded**: it serves everything it owns, from local storage. An installation
 * without storage is **unavailable**, and must never report ready — routing traffic to
 * a node that cannot serve it is the worse failure of the two.
 */
export function reportOperationalStatus(input: { coreAvailable: boolean; providerDegraded: boolean }): OperationalStatus {
  const ready = input.coreAvailable;
  const status: OperationalStatus["status"] = !input.coreAvailable ? "unavailable" : input.providerDegraded ? "degraded" : "ok";
  const summary = !input.coreAvailable
    ? "core is unavailable: local storage or retrieval cannot serve requests"
    : input.providerDegraded
      ? "core is available; optional providers are degraded, so results may be reduced in quality"
      : "core and providers are available";
  return {
    ready,
    status,
    core: { available: input.coreAvailable },
    providers: { degraded: input.providerDegraded },
    summary,
  };
}
