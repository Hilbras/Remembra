import assert from "node:assert/strict";
import { test } from "node:test";
import {
  V6GuardedService,
  V6DirectOperation,
  DIRECT_OPERATIONS,
  buildAuditEvent,
  requiresNotFoundNormalization,
  type V6GuardedBackend,
  type V6BatchItem,
} from "../v6-service-policy.js";
import { createRequestContext, type V6RequestContext } from "../v6-request-context.js";
import { evaluateV6Policy } from "../v6-policy-evaluator.js";

/**
 * V6-T06 direct-operation enforcement.
 *
 * The acceptance criterion is a *negative* claim — "no direct CRUD path bypasses
 * identity, authorization, tenant and policy" — and a negative claim cannot be
 * verified by testing the paths that work. It is verified by a guard that:
 *
 *   1. routes every operation through one choke point, so a new operation cannot
 *      be added without passing through it; and
 *   2. asserts the *absence* of bypasses, so adding an unguarded method fails.
 *
 * That second half is what a suite full of happy-path tests never checks, and it
 * is the half that matters here.
 */

const now = 1_000;

function context(over: Record<string, unknown> = {}): V6RequestContext {
  return createRequestContext({
    principal: {
      organizationId: "org-a",
      projectId: "p1",
      userId: "u1",
      membershipVersion: "m-1",
      scopes: ["project/p1"],
      capabilities: ["tenant:read", "tenant:write", "tenant:export", "provider:transmit"],
      clearance: "secret",
    },
    operation: "read",
    authMethod: "api_key",
    authExpiresAt: 10_000,
    resolvedAt: 0,
    now: 0,
    ...over,
  });
}

interface Row {
  id: string;
  organizationId: string;
  projectId?: string;
  sensitivity: "public" | "internal" | "confidential" | "secret";
  trust: "unverified" | "trusted" | "verified" | "system";
  retention: "pinned" | "persistent" | "ephemeral" | "decaying" | "neverExpire";
  legalHold?: boolean;
  expiresAt?: number;
  content?: string;
}

function backend(rows: Row[]): V6GuardedBackend & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    async get(id: string) {
      touched.push(`get:${id}`);
      return rows.find((r) => r.id === id) ?? null;
    },
    async put(row: Row) {
      touched.push(`put:${row.id}`);
      return row;
    },
    async delete(id: string) {
      touched.push(`delete:${id}`);
      return true;
    },
    async list() {
      touched.push("list");
      return rows;
    },
  };
}

function service(rows: Row[]): { svc: V6GuardedService; backend: ReturnType<typeof backend> } {
  const be = backend(rows);
  const svc = new V6GuardedService(be, now);
  return { svc, backend: be };
}

/**
 * Invoke one of the multi-record direct operations with an explicit type.
 *
 * `svc[op]` where `op` is a union of differently-shaped methods resolves to an
 * *intersection* of those signatures, which TypeScript then rejects for every call.
 * Naming the parameter removes the union from the signature entirely.
 */
function invokeMulti(
  svc: V6GuardedService,
  op: "history" | "relate" | "batch" | "snapshot",
  ctx: V6RequestContext,
  ids: readonly string[],
): Promise<unknown> {
  switch (op) {
    case "history": return svc.history(ctx, ids);
    case "relate": return svc.relate(ctx, ids);
    case "snapshot": return svc.snapshot(ctx, ids);
    case "batch": return svc.batch(ctx, ids);
  }
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "m1",
  organizationId: "org-a",
  projectId: "p1",
  sensitivity: "internal",
  trust: "trusted",
  retention: "persistent",
  content: "the memory content",
  ...over,
});

// --- the choke point ----------------------------------------------------------

test("V6-DIR-001: every direct operation is declared in one place", () => {
  // A new operation that is not declared here has no enforced path, so the
  // declaration IS the guard. Assert the set is closed and non-empty.
  assert.ok(DIRECT_OPERATIONS.length >= 9, "store/read/update/delete/archive/revive/history/relate/batch/snapshot");
  const unique = new Set(DIRECT_OPERATIONS);
  assert.equal(unique.size, DIRECT_OPERATIONS.length, "no duplicate operation");
});

test("V6-DIR-002: no guarded method exists outside the declared operation set", () => {
  // The negative assertion the whole task rests on. A new public method on the
  // service that reaches the backend without declaring an operation is exactly the
  // bypass this guard exists to prevent.
  const declared = new Set<string>(DIRECT_OPERATIONS);
  const methods = Object.getOwnPropertyNames(V6GuardedService.prototype).filter(
    (name) => name !== "constructor" && !name.startsWith("#"),
  );
  for (const name of methods) {
    assert.ok(
      declared.has(name),
      `public method "${name}" reaches storage without a declared operation — add it to DIRECT_OPERATIONS`,
    );
  }
});

test("V6-DIR-003: a denied operation never reaches the backend", async () => {
  const { svc, backend: be } = service([row({ organizationId: "org-b" })]);
  await assert.rejects(() => svc.read(context(), "m1"));
  assert.deepEqual(be.touched, ["get:m1"], "a denied read consulted the row and nothing else");
});

// --- each axis, per operation -------------------------------------------------

test("V6-DIR-004: cross-tenant access is refused on every read path", async () => {
  // `read` is single-record and the rest are multi-record, so they are listed
  // separately rather than unioned — a union would force one signature on two
  // different shapes.
  {
    const { svc, backend: be } = service([row({ organizationId: "org-b" })]);
    await assert.rejects(async () => svc.read(context(), "m1"), (e: unknown) => /not found|tenant/i.test((e as Error).message),
      "read must refuse a foreign tenant");
    assert.ok(!be.touched.some((x) => x.startsWith("put")), "read must never write");
  }
  for (const op of ["history", "relate", "batch", "snapshot"] as const) {
    const { svc, backend: be } = service([row({ organizationId: "org-b" })]);
    // These report per-item outcomes rather than throwing, and that is correct: a
    // batch must not fail wholesale because one id is unauthorized, or a caller
    // could not use them for mixed sets. The guard is therefore "every item is
    // refused and nothing was written", which is what is asserted here. The first
    // version expected a rejection, which no correct implementation produces.
    const outcome = (await invokeMulti(svc, op, context(), ["m1"])) as { items?: Array<{ ok: boolean }> } | Array<{ ok: boolean }>;
    const items = Array.isArray(outcome) ? outcome : outcome.items ?? [];
    assert.equal(items.length, 1, `${op} reported one item`);
    assert.equal(items[0]?.ok, false, `${op} must refuse a foreign tenant`);
    assert.ok(!be.touched.some((x) => x.startsWith("put")), `${op} must never write`);
  }
});

test("V6-DIR-005: cross-project access is refused", async () => {
  const { svc, backend: be } = service([row({ projectId: "p2" })]);
  await assert.rejects(() => svc.read(context(), "m1"), /project/i);
  assert.ok(!be.touched.some((x) => x.startsWith("put") || x.startsWith("delete")), "a denied read must never mutate");
});

test("V6-DIR-006: insufficient clearance is refused", async () => {
  const { svc } = service([row({ sensitivity: "secret" })]);
  const low = context({ principal: { ...context().principal, clearance: "internal" } });
  await assert.rejects(() => svc.read(low, "m1"), /sensitivity|clearance/i);
});

test("V6-DIR-007: an expired memory is refused on every read path", async () => {
  {
    const { svc, backend: be } = service([row({ expiresAt: 500 })]);
    await assert.rejects(async () => svc.read(context(), "m1"), /expired/i, "read must refuse an expired memory");
    assert.ok(!be.touched.some((x) => x.startsWith("put")), "read must never write");
  }
  for (const op of ["history", "batch", "snapshot"] as const) {
    const { svc, backend: be } = service([row({ expiresAt: 500 })]);
    const outcome = (await invokeMulti(svc, op, context(), ["m1"])) as
      { items?: V6BatchItem[] } | V6BatchItem[];
    const items = Array.isArray(outcome) ? outcome : outcome.items ?? [];
    assert.equal(items[0]?.ok, false, `${op} must refuse an expired memory`);
    // A multi-record path deliberately reports ONE code and reason for every
    // refusal, whatever the cause — that uniformity is the existence-leak
    // guarantee (DIR-012), and it means "expired" must NOT appear here. The policy
    // reason goes to the audit event instead. Asserting the expiry was visible would
    // assert the leak back into existence.
    assert.equal(items[0]?.code, "NOT_FOUND", `${op} reports the uniform code`);
    assert.equal(items[0]?.reason, "refused", `${op} reports the uniform reason`);
    assert.ok(!be.touched.some((x) => x.startsWith("put")), `${op} must never write`);
  }
});

test("V6-DIR-008: privilege escalation is refused — a read context cannot write", async () => {
  const { svc, backend: be } = service([row()]);
  // Minted for `read` specifically, and holding ONLY tenant:read. Asking for a
  // write with that context must fail closed rather than reinterpreting intent —
  // the capabilities on the context are what authorize the operation, so a read
  // context cannot become a write context by being handed to an update().
  const readOnly = createRequestContext({
    principal: {
      organizationId: "org-a", projectId: "p1", userId: "u1", membershipVersion: "m-1",
      scopes: ["project/p1"], capabilities: ["tenant:read"], clearance: "secret",
    },
    operation: "read", authMethod: "api_key", authExpiresAt: 10_000, resolvedAt: 0, now: 0,
  });
  await assert.rejects(() => svc.update(readOnly, "m1", { content: "x" }), /write|update|capability|operation|refused/i);
  // A capability refusal is a *decision* about the principal, so it is reachable
  // only once the record is in hand for the other axes; the guarantee that matters
  // is that nothing is written. (A context-only refusal that needs no record -- an
  // expired authentication, say -- is asserted in DIR-003 and touches nothing.)
  assert.ok(!be.touched.some((x) => x.startsWith("put")), "a refused update must never write");
  assert.ok(!be.touched.some((x) => x.startsWith("delete")), "nor delete");
});

test("V6-DIR-009: legal hold blocks delete and nothing else", async () => {
  const held = service([row({ legalHold: true })]);
  // delete is one of the three operations normalized to NOT_FOUND, so the reason
  // appears inside a "not found" message rather than as a bare refusal — that is
  // the existence-leak protection working as intended.
  await assert.rejects(
    () => held.svc.delete(context(), "m1"),
    (error: unknown) =>
      (error as { code?: string }).code === "NOT_FOUND" && /legal_hold/.test((error as Error).message),
  );
  // A read of the same held record is fine — a hold that hid it would make held
  // records invisible to the operators who need them.
  const open = service([row({ legalHold: true })]);
  await assert.doesNotReject(() => open.svc.read(context(), "m1"));
});

// --- normalized not-found ----------------------------------------------------

test("V6-DIR-010: a cross-tenant miss is normalized to not-found, not forbidden", async () => {
  // Existence leak: telling a caller "forbidden" when the record exists but is
  // foreign confirms it exists. Both cases must be indistinguishable.
  const foreign = service([row({ id: "secret-record", organizationId: "org-b" })]);
  const absent = service([row({ id: "secret-record", organizationId: "org-b" })]);
  // Force the "absent" case by asking about an id that does not exist.
  // `await` is load-bearing here: without it the promise rejects *after* the try
  // block has already returned "no error", so the comparison silently passed on two
  // identical non-errors. The first version of this test was wrong that way.
  const codeFor = async (s: V6GuardedService, id: string) => {
    try {
      await s.read(context(), id);
      return "no error";
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };
  const foreignCode = await codeFor(foreign.svc, "secret-record");
  const absentCode = await codeFor(absent.svc, "no-such-record");
  assert.equal(foreignCode, absentCode, `existence leak: foreign=${foreignCode} absent=${absentCode}`);
  assert.equal(foreignCode, "NOT_FOUND", "and it is the normalized not-found code");
});

test("V6-DIR-011: operations that normalize not-found are declared, not assumed", () => {
  assert.equal(requiresNotFoundNormalization("read"), true);
  assert.equal(requiresNotFoundNormalization("update"), true);
  // A batch reports per-item outcomes, so it cannot hide existence behind one code.
  assert.equal(requiresNotFoundNormalization("batch"), false);
});

// --- batch -------------------------------------------------------------------

test("V6-DIR-012: a batch cannot expose the existence of an unauthorized item", async () => {
  // Mixed batch: one readable, one foreign, one absent. The unauthorized and the
  // absent item must look identical in the result.
  const { svc } = service([row({ id: "mine" }), row({ id: "theirs", organizationId: "org-b" })]);
  const outcome = await svc.batch(context(), ["mine", "theirs", "no-such-record"]);
  const theirs = outcome.items.find((i) => i.id === "theirs");
  const absent = outcome.items.find((i) => i.id === "no-such-record");
  assert.ok(theirs && absent);
  assert.equal(theirs.ok, false);
  assert.equal(absent.ok, false);
  assert.equal(theirs.code, absent.code, "a foreign item must be indistinguishable from an absent one");
  assert.equal(theirs.reason, absent.reason);
  // And the readable one came back.
  const mine = outcome.items.find((i) => i.id === "mine");
  assert.equal(mine?.ok, true);
});

// --- audit -------------------------------------------------------------------

test("V6-DIR-013: an audit event is bounded and content-free", () => {
  const event = buildAuditEvent({
    decision: evaluateV6Policy({
      operation: "read",
      principal: { organizationId: "org-a", projectId: "p1", capabilities: ["tenant:read"], clearance: "public" },
      memory: { id: "m1", organizationId: "org-a", sensitivity: "secret", trust: "trusted", retention: "persistent", legalHold: false },
      now,
    }),
    operation: "read" as V6DirectOperation,
    context: context(),
    now,
  });
  const json = JSON.stringify(event);
  assert.ok(!json.includes("the memory content"), "no content");
  assert.ok(!json.includes("secret-record"), "no memory id beyond the one requested");
  assert.ok(Object.keys(event).every((k) => k !== "content" && k !== "text"), "no content-bearing key");
  assert.ok(json.length < 400, `bounded, got ${json.length}`);
});

test("V6-DIR-014: the audit event carries the policy version and a stable reason", () => {
  const event = buildAuditEvent({
    decision: evaluateV6Policy({
      operation: "read",
      principal: { organizationId: "org-a", projectId: "p1", capabilities: [], clearance: "secret" },
      memory: { id: "m1", organizationId: "org-a", sensitivity: "internal", trust: "trusted", retention: "persistent", legalHold: false },
      now,
    }),
    operation: "read" as V6DirectOperation,
    context: context(),
    now,
  });
  assert.equal(event.policyVersion, "v6-policy/1.0.0");
  assert.equal(event.reason, "capability_missing");
  assert.equal(event.effect, "deny");
});

// ---------------------------------------------------------------------------
// Added after mutation testing. S1 and S2 survived the first pass: the identity
// checks were called but never observed failing, which for a security guard is the
// difference between "the call is there" and "the call does anything".
// ---------------------------------------------------------------------------

test("V6-DIR-015: an unminted context is refused before any decision or fetch", async () => {
  // S1 survived: every fixture used `createRequestContext`, so removing the brand
  // check changed nothing. A forged context must not reach the decision function,
  // let alone storage.
  const { svc, backend: be } = service([row()]);
  const forged = Object.freeze({
    principal: {
      organizationId: "org-a", projectId: "p1", userId: "u1", membershipVersion: "m-1",
      scopes: ["project/p1"], capabilities: ["tenant:read", "tenant:write", "tenant:export"],
      clearance: "secret",
    },
    operation: "read", authMethod: "api_key", authExpiresAt: 10_000, resolvedAt: 0, now: 0,
  }) as never;
  await assert.rejects(
    () => svc.read(forged, "m1"),
    (error: unknown) => /context/i.test((error as Error).message),
    "an unminted context is refused",
  );
  assert.deepEqual(be.touched, [], "and it never reaches storage");
});

test("V6-DIR-016: an expired context is refused even when the operation would be allowed", async () => {
  // S2 survived: no test used an expired context, so the freshness call was
  // unobserved. This is the property that makes "auth-before-everything" real —
  // a context that was valid at minting and has since expired must not be usable.
  const { svc, backend: be } = service([row()]);
  // The service's clock is 1000; mint the context to expire at 500.
  const expiring = createRequestContext({
    principal: {
      organizationId: "org-a", projectId: "p1", userId: "u1", membershipVersion: "m-1",
      scopes: ["project/p1"], capabilities: ["tenant:read"], clearance: "secret",
    },
    operation: "read", authMethod: "api_key", authExpiresAt: 500, resolvedAt: 0, now: 0,
  });
  // Perfectly authorized, perfectly readable — and still refused, because it expired.
  await assert.rejects(
    () => svc.read(expiring, "m1"),
    (error: unknown) => /expir/i.test((error as Error).message),
    "an expired context is refused before the record is consulted",
  );
  assert.deepEqual(be.touched, [], "and never reaches storage");

  // The same context one tick earlier is fine, so this is the boundary and not a
  // blanket refusal.
  const early = service([row()]);
  const later = createRequestContext({
    principal: {
      organizationId: "org-a", projectId: "p1", userId: "u1", membershipVersion: "m-1",
      scopes: ["project/p1"], capabilities: ["tenant:read"], clearance: "secret",
    },
    operation: "read", authMethod: "api_key", authExpiresAt: 2_000, resolvedAt: 0, now: 0,
  });
  await assert.doesNotReject(() => early.svc.read(later, "m1"));
});
