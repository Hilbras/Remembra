/**
 * Multi-dimensional quota policy (V5.1.0, roadmap §19).
 *
 * Rate *limiting* decides whether one identity may proceed. Quota *policy*
 * decides how many identities there are and what each one is allowed, so a
 * deployment can charge an organization, a project, a user, an agent, an API
 * key, an address, an endpoint, and a provider independently instead of one
 * undifferentiated per-key window.
 *
 * The compatibility rule that shapes everything here: **a request is always
 * charged its base per-identity budget**, exactly as before this module
 * existed. Dimension policies are additional constraints layered on top, never
 * a replacement. So adding a policy can only make a deployment stricter, and an
 * identity that lacks a configured dimension cannot end up with a larger budget
 * than it had before — it is still charged the base budget, which is what
 * covers it. A dimension is only charged when the request actually carries a
 * trusted value for it.
 *
 * Configuration:
 *
 *   REMEMBRA_RATE_LIMIT=60            # base requests per window per identity
 *   REMEMBRA_RATE_WINDOW_MS=60000     # base window
 *   REMEMBRA_QUOTAS='{"organization":{"limit":1000000,"windowMs":2592000000},
 *                     "user":{"limit":10000,"windowMs":86400000}}'
 *
 * Values are configurable, and an invalid policy fails startup naming the
 * variable and the offending dimension rather than silently not enforcing.
 */
import { RemembraError } from "./errors.js";
import {
  InProcessRateLimiter,
  RATE_LIMIT_DIMENSIONS,
  type RateLimitDimension,
  type RateLimitIdentity,
  type RateLimitResult,
  type RateLimiter,
} from "./rate-limiter.js";

export interface QuotaPolicy {
  /** Max requests per window for this dimension. */
  limit: number;
  /** Window size in ms. */
  windowMs: number;
}

export type QuotaPolicies = Partial<Record<RateLimitDimension, QuotaPolicy>>;

export interface QuotaOptions {
  /**
   * The base per-identity budget. Every request is charged this, so the
   * pre-V5.1 behaviour is preserved when no dimension policies are set.
   * Default: 60 per 60s, matching REMEMBRA_RATE_LIMIT's default.
   */
  base?: QuotaPolicy;
  /** Per-dimension constraints. Omitted dimensions are not charged. */
  policies?: QuotaPolicies;
  /** Ceiling on tracked identities per limiter. Default: 10_000. */
  maxIdentities?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

const DEFAULT_BASE: QuotaPolicy = { limit: 60, windowMs: 60_000 };
const MAX_CONFIG_LENGTH = 16 * 1024;

function assertPolicy(dimension: string, policy: QuotaPolicy, source: string): QuotaPolicy {
  const { limit, windowMs } = policy ?? {};
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RemembraError("INVALID_INPUT", `${source} dimension "${dimension}" needs a positive integer limit`);
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RemembraError("INVALID_INPUT", `${source} dimension "${dimension}" needs a positive integer windowMs`);
  }
  return { limit, windowMs };
}

/**
 * Parse `REMEMBRA_QUOTAS`. An absent or empty variable yields no dimension
 * policies, which leaves the base per-identity budget as the only limit.
 */
export function parseQuotaPolicies(raw: string | undefined): QuotaPolicies {
  if (raw === undefined || raw.trim() === "") return {};
  if (raw.length > MAX_CONFIG_LENGTH) {
    throw new RemembraError("INVALID_INPUT", "REMEMBRA_QUOTAS exceeds the supported configuration size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RemembraError("INVALID_INPUT", "REMEMBRA_QUOTAS must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RemembraError("INVALID_INPUT", 'REMEMBRA_QUOTAS must be a JSON object like {"user":{"limit":10000,"windowMs":86400000}}');
  }
  const out: QuotaPolicies = {};
  for (const [dimension, policy] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(RATE_LIMIT_DIMENSIONS as readonly string[]).includes(dimension)) {
      throw new RemembraError(
        "INVALID_INPUT",
        `REMEMBRA_QUOTAS has unknown dimension "${dimension}"; supported: ${RATE_LIMIT_DIMENSIONS.join(", ")}`,
      );
    }
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
      throw new RemembraError(
        "INVALID_INPUT",
        `REMEMBRA_QUOTAS dimension "${dimension}" must be an object with limit and windowMs`,
      );
    }
    const { limit, windowMs } = policy as Record<string, unknown>;
    if (limit !== undefined && typeof limit !== "number") {
      throw new RemembraError("INVALID_INPUT", `REMEMBRA_QUOTAS dimension "${dimension}" has a non-numeric limit`);
    }
    if (windowMs !== undefined && typeof windowMs !== "number") {
      throw new RemembraError("INVALID_INPUT", `REMEMBRA_QUOTAS dimension "${dimension}" has a non-numeric windowMs`);
    }
    out[dimension as RateLimitDimension] = assertPolicy(dimension, { limit, windowMs } as QuotaPolicy, "REMEMBRA_QUOTAS");
  }
  return out;
}

/**
 * Enforces the base budget plus every configured dimension policy.
 *
 * Decision order is `RATE_LIMIT_DIMENSIONS` — global, organization, project,
 * user, agent, apikey, ip, endpoint, provider — and the base budget is
 * considered last. So when several dimensions are exhausted at once, the
 * reported `dimension` is always the same one for the same state, and a
 * tenant-level cap is reported as tenant-level rather than as a generic 429.
 *
 * Charging is all-or-nothing. A request denied by any dimension is not charged
 * to the others, so a rejected request cannot silently drain a budget that a
 * later request would otherwise be allowed to use.
 */
export class QuotaRateLimiter implements RateLimiter {
  private readonly base: QuotaPolicy;
  private readonly policies: QuotaPolicies;
  private readonly order: RateLimitDimension[];
  private readonly windows: Record<string, InProcessRateLimiter>;
  private readonly maxIdentities: number;
  private readonly now: (() => number) | undefined;

  constructor(opts: QuotaOptions = {}) {
    this.base = assertPolicy("base", opts.base ?? DEFAULT_BASE, "quota");
    this.policies = {};
    for (const dimension of RATE_LIMIT_DIMENSIONS) {
      const policy = opts.policies?.[dimension];
      if (policy === undefined) continue;
      this.policies[dimension] = assertPolicy(dimension, policy, "quota");
    }
    // Deterministic precedence: the declared order, base last.
    this.order = RATE_LIMIT_DIMENSIONS.filter((dimension) => this.policies[dimension] !== undefined);
    this.maxIdentities = opts.maxIdentities ?? 10_000;
    this.now = opts.now;
    this.windows = {
      base: this.limiterFor(this.base),
    };
    for (const dimension of this.order) {
      this.windows[dimension] = this.limiterFor(this.policies[dimension]!);
    }
  }

  /** The effective policy set, for reporting and tests. */
  get configured(): { base: QuotaPolicy; dimensions: RateLimitDimension[] } {
    return { base: this.base, dimensions: [...this.order] };
  }

  private limiterFor(policy: QuotaPolicy): InProcessRateLimiter {
    return new InProcessRateLimiter({
      limit: policy.limit,
      windowMs: policy.windowMs,
      maxIdentities: this.maxIdentities,
      ...(this.now ? { now: this.now } : {}),
    });
  }

  /**
   * The key charged for a dimension. Only dimensions the request actually
   * carries are evaluated: a dimension the host did not resolve cannot be
   * charged, and the base budget already covers that request, so evaluating it
   * per absent dimension would multiply a single request's charge by the number
   * of configured dimensions it happens to be missing.
   */
  private charged(identity: RateLimitIdentity, dimension: RateLimitDimension): RateLimitIdentity[] {
    const value = identity.dimensions[dimension];
    return value === undefined ? [] : [{ dimensions: { [dimension]: value }, key: `${dimension}=${value}` }];
  }

  async check(identity: RateLimitIdentity): Promise<RateLimitResult> {
    return this.evaluate(identity, false);
  }

  async consume(identity: RateLimitIdentity): Promise<RateLimitResult> {
    return this.evaluate(identity, true);
  }

  async reset(identity: RateLimitIdentity): Promise<void> {
    await this.windows.base!.reset(identity);
    for (const dimension of this.order) {
      for (const target of this.charged(identity, dimension)) {
        await this.windows[dimension]!.reset(target);
      }
    }
  }

  private async evaluate(identity: RateLimitIdentity, charge: boolean): Promise<RateLimitResult> {
    // Evaluate every charged dimension before touching any of them.
    const decisions: { dimension: RateLimitDimension; result: RateLimitResult }[] = [];
    for (const dimension of this.order) {
      for (const target of this.charged(identity, dimension)) {
        const result = await this.windows[dimension]!.check(target);
        decisions.push({ dimension, result: { ...result, dimension } });
      }
    }
    const baseResult = await this.windows.base!.check(identity);
    decisions.push({ dimension: "global", result: { ...baseResult, dimension: "global" } });

    // Precedence order: the first dimension that denies decides.
    const denial = decisions.find((decision) => !decision.result.allowed);
    if (denial) {
      // A denied request charges nothing anywhere.
      return denial.result;
    }

    if (charge) {
      for (const dimension of this.order) {
        for (const target of this.charged(identity, dimension)) {
          await this.windows[dimension]!.consume(target);
        }
      }
      await this.windows.base!.consume(identity);
    }

    // Report the tightest budget, breaking ties by precedence so the answer is
    // stable rather than whichever Map happened to be iterated first. Every
    // evaluated budget was charged exactly once, so an allowed charge lowers
    // each of them by one.
    let tightest = decisions[0]!;
    for (const decision of decisions) {
      if (decision.result.remaining < tightest.result.remaining) tightest = decision;
    }
    const spent = charge ? 1 : 0;
    return {
      ...tightest.result,
      remaining: Math.max(0, tightest.result.remaining - spent),
    };
  }
}
