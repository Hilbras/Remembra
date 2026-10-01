import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryType,
  V6_SCHEMA_VERSION,
  V6_COMPATIBILITY,
  LifecycleState,
  V6RecordSchema,
  V6MemorySchema,
  classifyV5Record,
  parseV6Record,
  v6ToV5Projection,
  lifecycleStateOf,
} from "../v6-schema.js";
import { SENSITIVITY_ORDER } from "../v6-policy.js";

/**
 * V6-T03 contract fixtures.
 *
 * Two properties this file exists to pin, because both are ways a "compatible"
 * migration silently corrupts data:
 *
 *  1. **Round-trip fidelity across all eleven memory types.** A field dropped in
 *     one direction is a field lost, and a schema that only round-trips `fact`
 *     looks fine until the eleventh type turns up in production.
 *  2. **V5 records are classified, never reinterpreted.** A V5 record has no
 *     sensitivity, and inventing one on read would silently promote unclassified
 *     content. Every V5 record classifies as `legacy`, and the absence stays
 *     visible.
 */

const ALL_TYPES = MemoryType.options;

/**
 * The smallest record the schema accepts.
 *
 * Four of these tests originally hand-wrote a partial record and failed on missing
 * fields rather than on the property under test — the same class of mistake as
 * asserting a float is "close enough". One helper keeps each test's *delta*
 * visible.
 */
function minimalRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: V6_SCHEMA_VERSION,
    id: "m1",
    type: "fact",
    scope: "s",
    organizationId: "org-a",
    content: "c",
    importance: 3,
    confidence: 0.5,
    trust: "trusted",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A *parsed* record, for the functions that take `V6Memory` rather than raw input.
 *
 * `lifecycleStateOf` reads defaulted fields (`sensitivity`, `legalHold`, `retention`),
 * so a hand-built object is not the same type the schema produces. Parsing here is
 * what keeps the two apart — the first version of this helper returned the raw
 * object and every call failed to typecheck for missing defaults.
 */
function parsedRecord(over: Record<string, unknown> = {}) {
  const result = V6MemorySchema.parse(minimalRecord(over));
  assert.ok(result, "fixture must parse");
  return result;
}


test("V6-SCH-001: the type vocabulary is exactly V5's eleven, unchanged", () => {
  assert.equal(ALL_TYPES.length, 11, "V6 adds no memory type; the count is a contract with T03's fixtures");
  assert.deepEqual(ALL_TYPES, [
    "fact", "preference", "decision", "constraint", "instruction", "role",
    "entity", "relationship", "event", "history", "observation",
  ]);
});

test("V6-SCH-002: every one of the eleven types round-trips without loss", () => {
  for (const type of ALL_TYPES) {
    const record = {
      schemaVersion: V6_SCHEMA_VERSION,
      id: `m-${type}`,
      type,
      scope: "project/p1",
      organizationId: "org-a",
      projectId: "p1",
      content: `content for ${type}`,
      importance: 3,
      confidence: 0.5,
      trust: "trusted" as const,
      source: "manual",
      sourceType: "manual" as const,
      retention: "persistent" as const,
      sensitivity: "internal" as const,
      legalHold: false,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const parsed = V6RecordSchema.parse(record);
    const reparsed = V6RecordSchema.parse(JSON.parse(JSON.stringify(parsed)));
    assert.deepEqual(reparsed, parsed, `${type} must round-trip through serialization unchanged`);
    assert.equal(reparsed.type, type);
  }
});

test("V6-SCH-003: expiration, archive, deletion and supersession are distinct states", () => {
  // The four are conflatable and the conflation is destructive: "expired" means
  // unusable but retained, "archived" means inactive but retained, "deleted" is
  // gone, "superseded" is replaced. Only `deleted` implies absence.
  const states = LifecycleState.options;
  // Sorted, because the enum's declaration order is not the contract — the set of
  // states is. (The first version of this line listed them unsorted and failed on
  // `deleted` sorting before `expired`, which is the assertion being wrong rather
  // than the enum.)
  assert.deepEqual([...states].sort(), ["active", "archived", "deleted", "expired", "superseded"]);

  const base = {
    schemaVersion: V6_SCHEMA_VERSION, id: "m1", type: "fact" as const, scope: "s",
    organizationId: "org-a", content: "c", importance: 3, confidence: 0.5,
    trust: "trusted" as const, retention: "persistent" as const, sensitivity: "internal" as const,
    legalHold: false, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(lifecycleStateOf({ ...base }), "active", "no expiry and no supersession is active");

  const expired = { ...base, expiresAt: 1_000 };
  assert.equal(lifecycleStateOf(expired, 5_000), "expired");
  assert.equal(lifecycleStateOf(expired, 500), "active", "a future expiry is not yet expired");

  assert.equal(lifecycleStateOf({ ...base, archivedAt: "2026-02-01T00:00:00.000Z" }), "archived");
  assert.equal(lifecycleStateOf({ ...base, supersededBy: "m2" }), "superseded");
  assert.equal(lifecycleStateOf({ ...base, deletedAt: "2026-02-01T00:00:00.000Z" }), "deleted");

  // Expiry and supersession are independent: a superseded memory can also be
  // expired, and picking one over the other would be arbitrary.
  assert.equal(lifecycleStateOf({ ...base, expiresAt: 1_000, supersededBy: "m2" }, 5_000), "expired");
});

test("V6-SCH-004: deleted outranks every other lifecycle state", () => {
  // A deleted memory stays deleted regardless of an expiry date or a superseder.
  // If `deleted` were not terminal, a re-read could resurrect a tombstone.
  const base = {
    schemaVersion: V6_SCHEMA_VERSION, id: "m1", type: "fact" as const, scope: "s",
    organizationId: "org-a", content: "c", importance: 3, confidence: 0.5,
    trust: "trusted" as const, retention: "persistent" as const, sensitivity: "internal" as const,
    legalHold: false, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: 1_000, supersededBy: "m2", archivedAt: "2026-02-01T00:00:00.000Z",
    deletedAt: "2026-03-01T00:00:00.000Z",
  };
  assert.equal(lifecycleStateOf(base, 5_000), "deleted");
});

test("V6-SCH-005: a V5 record classifies as legacy, with no sensitivity invented", () => {
  // V5 has no sensitivity field. Defaulting one on read would silently promote
  // unclassified content into a decided classification.
  const v5 = {
    version: 4, id: "legacy-1", type: "fact", scope: "s", content: "c",
    importance: 3, confidence: 0.5, trust: "trusted", version_: undefined,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const classified = classifyV5Record(v5);
  assert.equal(classified.compatibility, "legacy");
  assert.equal(classified.sensitivityKnown, false, "a V5 record's sensitivity is unknown, not default");
  assert.equal(classified.requiresClassification, true);
  assert.equal(classified.sensitivity, undefined, "no sensitivity is manufactured");
});

test("V6-SCH-006: a V5 record never classifies as migrated without evidence", () => {
  // `migrated` is a claim about provenance that only the migration tool may make.
  const classified = classifyV5Record({ version: 4, id: "x", type: "fact", content: "c" });
  assert.equal(classified.compatibility, "legacy");
  assert.notEqual(classified.compatibility, "migrated");
});

test("V6-SCH-007: the V5 projection is lossy in the declared direction only", () => {
  // Downgrading must refuse rather than silently drop the fields V5 cannot hold.
  const v6 = {
    schemaVersion: V6_SCHEMA_VERSION, id: "m1", type: "fact" as const, scope: "s",
    organizationId: "org-a", content: "c", importance: 3, confidence: 0.5,
    trust: "trusted" as const, retention: "persistent" as const, sensitivity: "confidential" as const,
    legalHold: false, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const projected = v6ToV5Projection(v6);
  assert.equal(projected.ok, false, "a confidential memory cannot be represented in V5, which has no sensitivity");
  assert.match(projected.error ?? "", /sensitivity/i);
});

test("V6-SCH-008: an internal memory does project to V5, and V5 fields are all present", () => {
  const v6 = {
    schemaVersion: V6_SCHEMA_VERSION, id: "m1", type: "fact" as const, scope: "s",
    organizationId: "org-a", content: "c", importance: 3, confidence: 0.5,
    trust: "trusted" as const, retention: "persistent" as const, sensitivity: "internal" as const,
    legalHold: false, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const projected = v6ToV5Projection(v6);
  assert.equal(projected.ok, true);
  if (projected.ok) {
    // V5 has no sensitivity field, so the projection must not invent one. Asserted
    // via the key set rather than by reading a property the type deliberately
    // lacks — `projected.memory.sensitivity` would not even typecheck, which is
    // itself part of the guarantee.
    assert.equal(Object.keys(projected.memory).includes("sensitivity"), false, "V5 has no sensitivity field to write");
    assert.equal(projected.memory.content, "c");
    assert.equal(projected.memory.trust, "trusted");
    assert.equal(projected.memory.retention, "persistent");
    assert.equal(projected.memory.version, 1);
  }
});

test("V6-SCH-009: a newer schema version is refused, not guessed at", () => {
  const parsed = parseV6Record({
    schemaVersion: V6_SCHEMA_VERSION + 1,
    id: "m1", type: "fact", content: "c",
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.error ?? "", /version/i);
  assert.equal(parsed.quarantine, false, "a newer version is refused outright, not quarantined");
});

test("V6-SCH-010: an unknown field on a record is refused, not stripped", () => {
  const parsed = parseV6Record({
    schemaVersion: V6_SCHEMA_VERSION, id: "m1", type: "fact", content: "c",
    surpriseField: "value",
  });
  assert.equal(parsed.ok, false, "an unknown field must fail, since stripping it hides a future field's loss");
});

test("V6-SCH-011: an unknown sensitivity label is refused", () => {
  const parsed = parseV6Record({
    schemaVersion: V6_SCHEMA_VERSION, id: "m1", type: "fact", content: "c",
    sensitivity: "restricted",
  });
  assert.equal(parsed.ok, false, "the retired band must not be accepted as an alias");
});

test("V6-SCH-012: a record without a schemaVersion is not silently upgraded", () => {
  const parsed = parseV6Record({ id: "m1", type: "fact", content: "c" });
  assert.equal(parsed.ok, false, "an absent version is ambiguous, not v6");
});

test("V6-SCH-013: tenant binding is required on every V6 record", () => {
  const parsed = parseV6Record({
    schemaVersion: V6_SCHEMA_VERSION, id: "m1", type: "fact", content: "c",
  });
  assert.equal(parsed.ok, false, "a V6 record without an organizationId cannot be authorized");
});

test("V6-SCH-014: the compatibility table is closed and total", () => {
  // Every version either reads as legacy, reads as V6, or is refused. No value
  // may fall through unclassified, because an unclassified version is read by
  // whatever code happens to run.
  for (const version of [1, 2, 3, 4, 5, 6]) {
    assert.ok(V6_COMPATIBILITY[version as keyof typeof V6_COMPATIBILITY] !== undefined,
      `version ${version} must be classified`);
  }
  assert.equal(V6_COMPATIBILITY[4], "legacy");
  assert.equal(V6_COMPATIBILITY[V6_SCHEMA_VERSION], "v6");
});

test("V6-SCH-015: a supersededBy reference must name a memory, and self-reference is refused", () => {
  const base = minimalRecord();
  assert.equal(V6MemorySchema.safeParse({ ...base, supersededBy: "m2" }).success, true);
  const selfRef = V6MemorySchema.safeParse({ ...base, supersededBy: "m1" });
  assert.equal(selfRef.success, false, "a memory cannot supersede itself");
});

test("V6-SCH-016: an expiresAt in the past is data, not a validation error", () => {
  // Expiry is evaluated at read time against an injected clock, so a past value is
  // valid input. Refusing it would make it impossible to persist an already-expired
  // memory, which is exactly the state a migration needs to write.
  const parsed = V6MemorySchema.safeParse({ ...minimalRecord(), expiresAt: 1 });
  assert.equal(parsed.success, true);
});

test("V6-SCH-017: a negative or non-finite expiresAt is refused", () => {
  const base = minimalRecord();
  assert.equal(V6MemorySchema.safeParse({ ...base, expiresAt: -1 }).success, false);
  assert.equal(V6MemorySchema.safeParse({ ...base, expiresAt: Number.NaN }).success, false);
  assert.equal(V6MemorySchema.safeParse({ ...base, expiresAt: Number.POSITIVE_INFINITY }).success, false);
});

test("V6-SCH-018: sensitivity on the record is bounded by the approved vocabulary", () => {
  for (const sensitivity of SENSITIVITY_ORDER) {
    const parsed = V6MemorySchema.safeParse({ ...minimalRecord(), sensitivity });
    assert.equal(parsed.success, true, `${sensitivity} must be accepted`);
  }
});

test("V6-SCH-019: content is bounded so a record cannot smuggle an unbounded payload", () => {
  const huge = "x".repeat(200_000);
  assert.equal(V6MemorySchema.safeParse({ ...minimalRecord(), content: huge }).success, false,
    "a 200KB content field must be refused");
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Nine of seventeen mutations survived the first
// pass; these close them. Grouped by the failure they share, because four of them
// were the same mistake: asserting "it was refused" without asserting *what the
// refusal said*, so a refusal for the wrong reason counted.
// ---------------------------------------------------------------------------

test("V6-SCH-020: a record with no version at all classifies as incompatible", () => {
  // S4 survived: defaulting an unversioned record to `legacy` changed nothing,
  // because every existing case carried a version. An absent version is the most
  // dangerous case of all — it is a record this reader cannot reason about.
  assert.equal(classifyV5Record({ id: "x", type: "fact", content: "c" }).compatibility, "incompatible");
  assert.equal(classifyV5Record(null).compatibility, "incompatible");
  assert.equal(classifyV5Record("a string").compatibility, "incompatible");
  assert.equal(classifyV5Record({}).compatibility, "incompatible");
});

test("V6-SCH-021: expiry is inclusive at the boundary", () => {
  // S8 survived: the test only probed 500 and 5,000 around an expiry of 1,000, so
  // `now > expiresAt` and `now >= expiresAt` agreed on both. The instant named by
  // expiresAt is the first expired one — that is what makes the field a usable
  // deadline rather than an approximate one.
  const base = minimalRecord();
  assert.equal(lifecycleStateOf(parsedRecord({ expiresAt: 1_000 }), 999), "active");
  assert.equal(lifecycleStateOf(parsedRecord({ expiresAt: 1_000 }), 1_000), "expired", "the boundary instant is expired");
  assert.equal(lifecycleStateOf(parsedRecord({ expiresAt: 1_000 }), 1_001), "expired");
});

test("V6-SCH-022: a newer version is refused AS A VERSION, before schema validation", () => {
  // S9 survived because the record was also invalid in other ways, so the schema
  // refused it too and the assertion passed for the wrong reason. A version
  // mismatch and a malformed record need different responses — upgrade the reader
  // versus fix the writer — so the message must distinguish them.
  const parsed = parseV6Record({
    ...minimalRecord(),
    schemaVersion: V6_SCHEMA_VERSION + 1,
  });
  assert.equal(parsed.ok, false);
  assert.match(
    parsed.ok === false ? parsed.error : "",
    /is not supported by this reader/,
    "a version mismatch must be reported as such, not as a list of field errors",
  );
});

test("V6-SCH-023: an absent version is refused AS A MISSING VERSION", () => {
  // S10 survived for the same reason as S9. The two refusals are distinct
  // failures: a wrong version and no version at all.
  const { schemaVersion: _dropped, ...withoutVersion } = minimalRecord();
  const parsed = parseV6Record(withoutVersion);
  assert.equal(parsed.ok, false);
  assert.match(
    parsed.ok === false ? parsed.error : "",
    /no schemaVersion/,
    "an absent version is its own failure, distinct from an unsupported one",
  );
});

test("V6-SCH-024: a newer writer's unknown field is REFUSED, not stripped", () => {
  // S11 survived: `parseV6Record` refused the record for an unrelated reason
  // (no organizationId in the fixture), so the strip went unnoticed. This fixture
  // is otherwise valid, so the unknown field is the only possible cause of refusal
  // — which is what makes it a real assertion about strictness.
  const record = { ...minimalRecord(), futureField: "written by a newer version" };
  const parsed = parseV6Record(record);
  assert.equal(parsed.ok, false, "a valid record plus one unknown field must fail on the field alone");
  assert.match(
    parsed.ok === false ? parsed.error : "",
    /futureField/,
    "and the refusal must name the offending field, so the operator knows which version wrote it",
  );
});

test("V6-SCH-025: the tenant binding is required, and its absence is named", () => {
  // S13 was unmeasurable as written (making organizationId optional breaks the
  // inferred type). Asserted behaviourally instead, and the error is checked so a
  // refusal for any other cause cannot pass.
  const { organizationId: _dropped, ...unbound } = minimalRecord();
  const parsed = parseV6Record(unbound);
  assert.equal(parsed.ok, false, "a record with no organization cannot be authorized");
  assert.match(parsed.ok === false ? parsed.error : "", /organizationId/);
});

test("V6-SCH-025b: an empty tenant id is refused even when the field is present", () => {
  // Distinct from SCH-025, which covers an *absent* organizationId. A record that
  // carries `organizationId: ""` is present-but-invalid, and the tenant grammar
  // must reject it — otherwise a defaulting layer could fill the field with an
  // empty string and produce a record that looks bound to something.
  assert.equal(V6MemorySchema.safeParse({ ...minimalRecord(), organizationId: "" }).success, false);
  assert.equal(V6MemorySchema.safeParse({ ...minimalRecord(), organizationId: "." }).success, false);
  assert.equal(V6MemorySchema.safeParse({ ...minimalRecord(), organizationId: ".." }).success, false);
  assert.equal(V6MemorySchema.safeParse({ ...minimalRecord(), organizationId: "a".repeat(129) }).success, false);
});

test("V6-SCH-026: sensitivity defaults to internal, never to public", () => {
  // S16 survived: every test supplied an explicit sensitivity, so the default was
  // never observed. The default is the whole point — an unlabelled memory must not
  // be *more* visible than a labelled one.
  const parsed = V6MemorySchema.parse(minimalRecord());
  assert.equal(parsed.sensitivity, "internal", "an unlabelled V6 record is internal, not public");
  assert.equal(parsed.legalHold, false);
  assert.equal(parsed.retention, "persistent");
});

test("V6-SCH-027: the type vocabulary is not extensible from outside", () => {
  // S17 was a no-op mutation (it added an unrelated type alias). The real property
  // is that the vocabulary is closed: an eleventh-plus type is refused, so a future
  // type cannot be persisted by a writer that does not understand what it means.
  const parsed = V6MemorySchema.safeParse({ ...minimalRecord(), type: "sensitivity_label" });
  assert.equal(parsed.success, false, "an unknown memory type must be refused, not stored");
});
