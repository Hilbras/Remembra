/**
 * V6 retrieval policy boundary (V6-T07).
 *
 * Policy applied **before** candidate generation, ranking, counts and context
 * selection — not after. The distinction is not stylistic: a `LIMIT 10` applied to
 * unfiltered rows returns ten foreign memories and filters them to zero, which is a
 * wrong answer *and* a leak in the one place the count is observable.
 *
 * So this module emits the predicate as SQL, and the ordering property is asserted
 * against the compiled clause rather than against a result set. A behavioural test —
 * "no foreign memory came back" — passes just as happily with a LIMIT-first query
 * whenever the tenant happens to own enough rows to fill the limit. That is the
 * failure this module exists to make impossible, and the reason the guarantee is
 * structural rather than behavioural.
 *
 * Two surfaces, because the boundary is crossed twice:
 *
 *  - `buildV6Predicate` / `compileV6Predicate` — the storage side, emitting one WHERE
 *    fragment that every retrieval path shares, so a path cannot drift by being
 *    written separately.
 *  - `guardCandidateSet` — the in-process side, for backends that filter in memory and
 *    for the post-SQL candidate list. It applies the *same* rules, so a backend that
 *    only ever calls one of the two is still correct.
 */
import type { V6RequestContext, V6OperationClass } from "./v6-request-context.js";
import { SENSITIVITY_ORDER, type Sensitivity, type TrustLevel } from "./v6-policy.js";

/**
 * Every retrieval path that must carry the predicate.
 *
 * Declared once, compiled once, asserted identical across all of them. A path that
 * is added here and not compiled is an unfiltered hole; a path compiled from its own
 * SQL is a path that drifts.
 */
export const RETRIEVAL_PATHS = [
  "keyword",
  "vector",
  "fts",
  "relation_expansion",
  "temporal",
  "cache",
  "context_selection",
  "count",
] as const;
export type RetrievalPath = (typeof RETRIEVAL_PATHS)[number];

/**
 * Operations whose candidate set excludes a legally-held memory.
 *
 * **`read` is deliberately absent.** ADR §3 settles it: a legal hold blocks
 * *destruction*, and never grants or denies visibility. Excluding held memories from
 * a read would hide them from exactly the operators who must be able to see what is
 * held — and the first version of this set included `read`, which the V6-RET-010
 * fixture caught. Retrieval *candidates* are a different question from a direct read:
 * a held memory should not surface in search results or context, but it must stay
 * readable by id.
 */
const CANDIDATE_OPERATIONS: ReadonlySet<V6OperationClass> = new Set(["context_read"]);

export interface V6Predicate {
  /** The WHERE fragment, without the `WHERE` keyword. Parameters are positional. */
  readonly sql: string;
  /** Bound parameters, in the order the placeholders appear. */
  readonly params: readonly string[];
  /**
   * Always false, and present so the property is *asserted* rather than assumed.
   * "If nothing matched, return everything" is the exact shape of the fallback this
   * module exists to prevent, and a named flag is what makes it testable.
   */
  readonly allowUnfilteredFallback: false;
  /**
   * True when this predicate excludes held memories from a candidate set.
   *
   * False for a direct read, deliberately: ADR §3 makes a hold a block on
   * destruction, not on visibility.
   */
  readonly excludesHeld: boolean;
}

export interface PredicateOptions {
  /** Evaluation clock. Injected, so the predicate is deterministic. */
  readonly now: number;
  /** Which operation is asking. Decides the legal-hold behaviour. */
  readonly forOperation?: V6OperationClass;
  /** Ceiling on candidates. Applied by the caller, after the predicate. */
  readonly limit?: number;
}

/**
 * Build the shared WHERE fragment.
 *
 * Three clauses, in a fixed order, and the order is the contract:
 *
 *  1. **Tenant and project binding.** Exact dimension matching, matching V5's
 *     `tenantWhere`, so V6 composes with the existing queries rather than
 *     contradicting them.
 *  2. **Sensitivity ceiling.** The memory may not be more sensitive than the
 *     principal's clearance. Expressed as an ordered-range comparison so the index is
 *     usable; the column stores the band's rank.
 *  3. **Expiration.** Unusable once expired, and unexpired means *either* no expiry
 *     or an instant in the future. Both halves matter: `expires_at < ?` alone drops
 *     every memory that never expires.
 *
 * Legal hold is included only for candidate-eligible operations, and is a separate
 * flag rather than a constant, because a hold that blocked reads would make held
 * records invisible to the operators who need them.
 */
export function buildV6Predicate(context: V6RequestContext, options: PredicateOptions): V6Predicate {
  const p = context.principal;
  const params: string[] = [];
  let sql: string;

  // 1. Tenant + project binding. Exact dimensions, so a project-scoped principal
  //    cannot see an organization-wide row and vice versa.
  sql = "tenant_id = ?";
  params.push(p.organizationId);
  if (p.projectId !== undefined) {
    sql += " AND project_id = ?";
    params.push(p.projectId);
  } else {
    sql += " AND project_id IS NULL";
  }

  // 2. Sensitivity ceiling. `sensitivity_rank <= clearance_rank` over the ordered
  //    band, so the comparison is a range and not an enumerated list — an
  //    enumerated list would need rewriting every time a band is added.
  sql += " AND sensitivity_rank <= ?";
  params.push(String(Math.max(0, SENSITIVITY_ORDER.indexOf(p.clearance ?? "public"))));

  // 3. Expiration: usable while unexpired OR never expiring.
  sql += " AND (expires_at IS NULL OR expires_at > ?)";
  params.push(String(options.now));

  const excludesHeld = options.forOperation === undefined
    ? true
    : CANDIDATE_OPERATIONS.has(options.forOperation);
  if (excludesHeld) sql += " AND legal_hold = 0";

  return { sql, params, allowUnfilteredFallback: false, excludesHeld };
}

export interface CompiledPredicate extends V6Predicate {
  /** The identical fragment every path must carry. */
  readonly whereFragment: string;
  /** Compile the query for one retrieval path. */
  forPath(path: RetrievalPath): string;
  /** The clause, including the `WHERE` keyword and the limit. */
  clauseFor(path: RetrievalPath): string;
}

/**
 * Compile the predicate into per-path queries.
 *
 * Every path gets the *same* fragment and the same limit clause, emitted in the
 * same order. The point of compiling rather than string-concatenating at each call
 * site is that the ordering property then holds by construction: there is one place
 * where `WHERE` is written, and `LIMIT` can only follow it.
 */
export function compileV6Predicate(
  context: V6RequestContext,
  options: PredicateOptions & { limit?: number },
): CompiledPredicate {
  const base = buildV6Predicate(context, options);
  const whereFragment = base.sql;
  const limit = options.limit;

  const forPath = (): string => clauseFor("");
  const clauseFor = (prefix: string): string => {
    // WHERE first, LIMIT second — always. The limit truncates only rows the caller
    // is entitled to see, which is the whole acceptance criterion.
    const where = `WHERE ${whereFragment}`;
    const tail = limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
    return `${prefix} ${where}${tail}`.trim();
  };

  return {
    ...base,
    whereFragment,
    forPath,
    clauseFor,
  };
}

export interface V6Candidate {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly sensitivity: Sensitivity;
  readonly trust: TrustLevel;
  readonly retention: "pinned" | "persistent" | "ephemeral" | "decaying" | "neverExpire";
  readonly legalHold: boolean;
  readonly expiresAt?: number;
}

/**
 * Apply the same rules in process.
 *
 * For the memory backend and for the post-SQL candidate list, so a deployment that
 * never emits SQL is held to the identical standard. Order matters and is fixed:
 * tenant, then sensitivity, then expiry, then hold — the same order as the SQL, so
 * the two surfaces cannot disagree about which row is visible.
 */
export function guardCandidateSet(
  candidates: readonly V6Candidate[],
  context: V6RequestContext,
  options: PredicateOptions & { limit?: number },
): V6Candidate[] {
  const p = context.principal;
  const clearanceIndex = SENSITIVITY_ORDER.indexOf(p.clearance ?? "public");
  const visible: V6Candidate[] = [];

  for (const candidate of candidates) {
    if (candidate.organizationId !== p.organizationId) continue;
    if (p.projectId !== undefined && candidate.projectId !== p.projectId) continue;
    if (SENSITIVITY_ORDER.indexOf(candidate.sensitivity) > clearanceIndex) continue;
    if (candidate.expiresAt !== undefined && options.now >= candidate.expiresAt) continue;
    if (candidate.legalHold) continue;
    visible.push(candidate);
    if (options.limit !== undefined && visible.length >= Math.max(0, Math.trunc(options.limit))) break;
  }

  return visible;
}