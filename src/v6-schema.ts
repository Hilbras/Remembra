/**
 * V6 memory metadata and schema contract (V6-T03).
 *
 * The persisted V6 record, and the compatibility rules for reading anything else.
 * Two decisions in [`docs/v6-decisions.md`](../docs/v6-decisions.md) shape
 * everything here: expiration is absolute and independent of retention (§2), and a
 * V5 record is never silently reinterpreted (§10).
 *
 * **Every field below has a stated owner.** That is the acceptance criterion, and
 * it is the part most easily lost: a field nobody owns is a field nobody migrates,
 * validates, or bounds.
 */
import { z } from "zod";
import {
  MemoryType,
  SourceType,
  TrustLevel,
  RetentionMode,
  TENANT_ID_RE,
  isValidTenantId,
} from "./types.js";
import { SensitivitySchema, type Sensitivity } from "./v6-policy.js";

/**
 * Re-exported so the V6 schema is one import surface. A consumer that reaches
 * into `types.ts` for the type vocabulary has coupled itself to a file this module
 * is meant to be able to evolve independently of.
 */
export { MemoryType, SourceType, TrustLevel, RetentionMode };

/**
 * V6 schema version. Deliberately *not* `MAX_SCHEMA_VERSION` from types.ts:
 * that constant means "the highest version a V5 reader accepts", which is a
 * different question from "what this writer produces".
 */
export const V6_SCHEMA_VERSION = 6 as const;

/**
 * Per-version compatibility, and total by construction.
 *
 * A version absent from this table would be read by whatever code happened to run,
 * which is the same reason unknown *fields* are refused below. Versions 1–3 are V4
 * shapes, 4 is the V5 tenant shape, 5 is unallocated.
 */
export const V6_COMPATIBILITY = {
  1: "incompatible",
  2: "incompatible",
  3: "legacy",
  4: "legacy",
  5: "incompatible",
  6: "v6",
} as const satisfies Readonly<Record<number, "v6" | "legacy" | "incompatible">>;

export type CompatibilityClass = (typeof V6_COMPATIBILITY)[keyof typeof V6_COMPATIBILITY];

/** ISO-8601 instant. Validated, not merely typed: a bad date is a sort hazard. */
const IsoInstant = z.string().datetime({ offset: true });

/**
 * Lifecycle states are *distinct*, not a lifecycle *stage*. All four of expired,
 * archived, superseded and deleted can be true of one record simultaneously, and
 * collapsing them into an enum on the record would force a choice between truths.
 * `lifecycleStateOf` derives the single reported state, with an explicit precedence.
 */
export const LifecycleState = z.enum(["active", "expired", "archived", "superseded", "deleted"]);
export type LifecycleState = z.infer<typeof LifecycleState>;

/** Content is bounded. An unbounded record body is an unbounded write primitive. */
const ContentField = z.string().min(1).max(64 * 1024);

/**
 * A tenant identifier.
 *
 * Reuses V5's *predicate*, not just its regex. `TENANT_ID_RE` alone accepts `"."`
 * and `".."` — it bounds the character set and length, and V5's
 * `isValidTenantId` adds the traversal check on top. Using the regex alone would
 * have accepted a record whose organization was `.`, which is a path segment, not a
 * tenant. Found by mutation testing, and the compiler could not have caught it:
 * the type is still `string`.
 */
const TenantIdField = z
  .string()
  .regex(TENANT_ID_RE, "tenant identifier is outside the allowed grammar")
  .refine(isValidTenantId, "tenant identifier must not be a path segment");

/**
 * The V6 record.
 *
 * `.strict()` throughout: an unknown field is refused rather than stripped, because
 * stripping a field written by a newer version is exactly the silent data loss
 * this module exists to prevent. A newer writer's field would vanish on the first
 * round-trip through an older reader, and the record would look fine.
 */
export const V6MemorySchema = z
  .object({
    /** Explicit on every record. An absent version is ambiguous, not v6. */
    schemaVersion: z.literal(V6_SCHEMA_VERSION),

    // --- identity and binding. Owner: the request-security layer (V6-T04). ---
    id: z.string().min(1).max(256),
    type: MemoryType,
    scope: z.string().min(1).max(512),
    /** Required. A V6 record without an organization cannot be authorized. */
    organizationId: TenantIdField,
    projectId: TenantIdField.optional(),

    content: ContentField,

    // --- V5-preserved scoring metadata. Owner: the retrieval engine. ---
    importance: z.number().int().min(1).max(5),
    confidence: z.number().min(0).max(1),
    trust: TrustLevel,
    source: z.string().max(1024).optional(),
    sourceType: SourceType.optional(),

    // --- V6 policy axes. Owner: the policy model (V6-T02). ---
    /**
     * Defaulted to `internal` rather than `public`. The write path sets this
     * explicitly in normal operation; the default exists for hand-authored
     * records and is deliberately the *restrictive* one, so an unlabelled memory is
     * never more visible than a labelled one.
     */
    sensitivity: SensitivitySchema.default("internal"),
    /** V5's vocabulary, carried forward unchanged. Owner: lifecycle (V6-T11). */
    retention: RetentionMode.default("persistent"),
    /** Absolute expiry, independent of `retention` (ADR §2). */
    expiresAt: z.number().int().positive().optional(),
    /**
     * Operator-set only (ADR §3). A record may *carry* the flag; the request path
     * may never *set* it. Enforced at the write boundary, not here — this schema
     * cannot tell a trusted write from an untrusted one.
     */
    legalHold: z.boolean().default(false),

    // --- lifecycle markers. Distinct flags, not a single enum. ---
    archivedAt: IsoInstant.optional(),
    deletedAt: IsoInstant.optional(),
    /** Must not equal `id`; a self-reference would be an unresolvable cycle. */
    supersededBy: z.string().min(1).max(256).optional(),

    // --- provenance and concurrency ---
    version: z.number().int().positive(),
    createdAt: IsoInstant,
    updatedAt: IsoInstant,
    lastSeen: IsoInstant.optional(),
    lastValidated: IsoInstant.optional(),
  })
  .strict()
  // Self-supersession is impossible to resolve and would make the memory both
  // suppressed and its own successor.
  .refine((r) => r.supersededBy === undefined || r.supersededBy !== r.id, {
    message: "a memory cannot supersede itself",
    path: ["supersededBy"],
  });

export type V6Memory = z.infer<typeof V6MemorySchema>;

/** Alias kept for the acceptance wording; identical shape. */
export const V6RecordSchema = V6MemorySchema;

/**
 * Derive the single reported lifecycle state.
 *
 * Precedence is explicit and deliberately *not* chronological, because the states
 * answer different questions and a reader needs the most consequential one:
 *
 *   deleted > expired > superseded > archived > active
 *
 * `deleted` is terminal — a tombstone that reports itself as expired can be
 * resurrected by a reader that treats expiry as "still retained". `expired` outranks
 * `superseded` because an expired memory is unusable for a different reason than a
 * superseded one, and conflating them would misattribute why.
 */
export function lifecycleStateOf(record: V6Memory, now = 0): LifecycleState {
  if (record.deletedAt !== undefined) return "deleted";
  if (record.expiresAt !== undefined && now >= record.expiresAt) return "expired";
  if (record.supersededBy !== undefined) return "superseded";
  if (record.archivedAt !== undefined) return "archived";
  return "active";
}

export interface V5Classification {
  /** How this record relates to V6. */
  readonly compatibility: CompatibilityClass;
  /**
   * Whether the record's sensitivity is *known*. False for every V5 record: V5 has
   * no such field, so the honest answer is "unknown", not a default.
   */
  readonly sensitivityKnown: boolean;
  /** Whether a classification decision is outstanding before this record is used. */
  readonly requiresClassification: boolean;
  /** Only ever set when `sensitivityKnown` is true. */
  readonly sensitivity?: Sensitivity;
}

/**
 * Classify a record read from a non-V6 store.
 *
 * Never returns `migrated`: that is a claim about provenance only the migration
 * tool (V6-T19+) may make, and a reader inferring it would be asserting that a
 * transformation happened when none did. This function classifies; it does not
 * convert.
 */
export function classifyV5Record(raw: unknown): V5Classification {
  const version =
    typeof raw === "object" && raw !== null && typeof (raw as { schemaVersion?: unknown }).schemaVersion === "number"
      ? Number((raw as { schemaVersion: number }).schemaVersion)
      : typeof raw === "object" && raw !== null && typeof (raw as { version?: unknown }).version === "number"
        ? Number((raw as { version: number }).version)
        : undefined;

  const compatibility: CompatibilityClass =
    version !== undefined && version in V6_COMPATIBILITY
      ? V6_COMPATIBILITY[version as keyof typeof V6_COMPATIBILITY]
      : "incompatible";

  if (compatibility === "v6") {
    return { compatibility: "v6", sensitivityKnown: true, requiresClassification: false };
  }
  // V5 and V4 have no sensitivity field. The absence is the finding: a reader that
  // defaulted one would be silently promoting unclassified content into a decided
  // classification, which is the failure this whole module is shaped to prevent.
  return { compatibility, sensitivityKnown: false, requiresClassification: true };
}

export type ParseResult<T> =
  | { ok: true; value: T; quarantine: false }
  | { ok: false; error: string; quarantine: boolean };

/**
 * Parse an untrusted V6 record.
 *
 * The version check runs *before* schema parsing and on its own, so "this is a
 * newer format" is reported as a version error rather than as a list of missing
 * fields — a much more actionable failure, and the distinction matters because the
 * two need different responses (upgrade the reader versus fix the writer).
 *
 * Nothing here quarantines. A record that fails validation is refused, because
 * quarantine is a *policy decision* about an untrusted memory's content (T05) and
 * not a schema outcome; a malformed record has no policy decision to make.
 */
export function parseV6Record(raw: unknown): ParseResult<V6Memory> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "record is not an object", quarantine: false };
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== "number") {
    return { ok: false, error: "record has no schemaVersion; it cannot be assumed to be V6", quarantine: false };
  }
  if (version !== V6_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `schema version ${version} is not supported by this reader (${V6_SCHEMA_VERSION})`,
      quarantine: false,
    };
  }
  const parsed = V6MemorySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; "),
      quarantine: false,
    };
  }
  return { ok: true, value: parsed.data, quarantine: false };
}

/** The V5 fields a projection can represent. */
export interface V5ProjectedMemory {
  readonly version: number;
  readonly id: string;
  readonly type: (typeof MemoryType)["options"][number];
  readonly scope: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly content: string;
  readonly importance: number;
  readonly confidence: number;
  readonly trust: TrustLevel;
  readonly source?: string;
  readonly retention: RetentionMode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProjectionResult =
  | { ok: true; memory: V5ProjectedMemory }
  | { ok: false; error: string };

/**
 * Project a V6 record down to what a V5 reader can hold.
 *
 * **Refuses rather than drops.** The one field V5 cannot represent is
 * `sensitivity`, and a projection that discarded it would write a `confidential`
 * memory into a store whose readers have no idea it is confidential — the exact
 * silent-visibility-loss failure the compatibility policy exists to prevent.
 *
 * `internal` and below are projectable *and* still carry no sensitivity in the
 * output, which is why this is a deliberate asymmetry rather than an oversight: V5
 * treats everything as `internal`-or-below, so projecting those down loses nothing
 * that V5 could have enforced. Anything above must not be projected.
 */
export function v6ToV5Projection(record: V6Memory): ProjectionResult {
  const order = ["public", "internal", "confidential", "secret"] as const;
  const rank = order.indexOf(record.sensitivity);
  if (rank > order.indexOf("internal")) {
    return {
      ok: false,
      error: `sensitivity "${record.sensitivity}" has no V5 representation; refusing to project rather than dropping the classification`,
    };
  }
  return {
    ok: true,
    memory: {
      version: record.version,
      id: record.id,
      type: record.type,
      scope: record.scope,
      organizationId: record.organizationId,
      ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
      content: record.content,
      importance: record.importance,
      confidence: record.confidence,
      trust: record.trust,
      ...(record.source !== undefined ? { source: record.source } : {}),
      retention: record.retention,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}