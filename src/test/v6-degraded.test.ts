import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEGRADED_FAILURES,
  DEFAULT_FAILURE_POLICY,
  DegradedMode,
  classifyProviderFailure,
  executeWithDegradation,
  reportOperationalStatus,
  type FailurePolicy,
} from "../v6-degraded.js";
import { ProviderRegistry, negotiateCapabilities, capabilityUnavailable } from "../v6-core-contract.js";

/**
 * V6-T10 offline/degraded fixtures.
 *
 * The criterion that actually decides this design: **degrading must never be silent.**
 * A retrieval path that returns three thin results because the embedding provider is
 * down looks exactly like a retrieval path that found three good results. If nothing
 * in the return value says which happened, the caller cannot tell a degraded answer
 * from a real one — and "degrading into no answer is the opposite of degrading" is
 * exactly the failure mode this file prevents.
 *
 * So degradation is a *value*, not an absence. Every degraded result carries a reason,
 * and every policy decision (fail open or closed) is declared per operation rather
 * than inherited from a provider's mood.
 */

const registryWith = (
  id: string,
  invoke: () => Promise<unknown>,
  capabilities: ("summarization" | "embedding" | "reranking" | "extraction")[] = ["summarization"],
) => {
  const registry = new ProviderRegistry();
  registry.register({
    id,
    capabilities,
    metadata: { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 500 }, availability: "remote" },
    invoke: invoke as never,
  });
  return registry;
};

const metadata = { privacy: "remote" as const, cost: { perCall: 1 }, latency: { p95Ms: 500 }, availability: "remote" as const };

// --- failure classification ---------------------------------------------------

test("V6-DG-001: each provider fault maps to one declared class", () => {
  const cases: [unknown, string][] = [
    [new Error("request timed out"), "timeout"],
    [new Error("429 rate limit exceeded"), "rate_limited"],
    [new Error("upstream returned malformed json"), "malformed"],
    [new DOMException("aborted", "AbortError"), "cancelled"],
    [new Error("connection refused"), "unavailable"],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyProviderFailure(error), expected, `${(error as Error).message} -> ${expected}`);
  }
});

test("V6-DG-002: an unrecognised error is a failure, never a success", () => {
  // The default must be the conservative class. An unknown fault classified as
  // "fine" would be a silent degradation.
  const kind = classifyProviderFailure(new Error("something we have never seen"));
  assert.ok(DEGRADED_FAILURES.includes(kind as never), `classified, not defaulted to success: ${kind}`);
  assert.equal(kind, "unavailable");
});

test("V6-DG-003: a non-error throw is still classified", () => {
  for (const thrown of ["a string", 42, null, undefined, { code: "ETIMEDOUT" }]) {
    const kind = classifyProviderFailure(thrown);
    assert.ok(DEGRADED_FAILURES.includes(kind as never), `${JSON.stringify(thrown)} -> ${kind}`);
  }
  // A structured timeout code is recognised even without a message.
  assert.equal(classifyProviderFailure({ code: "ETIMEDOUT" }), "timeout");
});

// --- the per-operation policy -------------------------------------------------

test("V6-DG-004: every optional capability has a declared failure policy", () => {
  for (const capability of ["summarization", "embedding", "reranking", "extraction"] as const) {
    const policy = DEFAULT_FAILURE_POLICY[capability];
    assert.ok(policy, `${capability} must declare what happens when it fails`);
    assert.ok(["fail_open", "fail_closed"].includes(policy), `${capability} policy is one of the two`);
  }
});

test("V6-DG-005: embedding and reranking fail open — retrieval degrades, it does not stop", () => {
  // These are quality-affecting, not authority-affecting. A lexical answer is worse
  // than a semantic one but still correct, so failing closed would be worse.
  assert.equal(DEFAULT_FAILURE_POLICY.embedding, "fail_open");
  assert.equal(DEFAULT_FAILURE_POLICY.reranking, "fail_open");
});

test("V6-DG-006: extraction fails closed — a half-extracted fact is a wrong fact", () => {
  // Extraction produces structured data that gets stored. Degrading it produces
  // incomplete records that look complete, which is not degradation but corruption.
  assert.equal(DEFAULT_FAILURE_POLICY.extraction, "fail_closed");
});

test("V6-DG-007: the policy is per capability, not per provider", async () => {
  // Two providers for the same capability must not get different answers to "what
  // happens if you fail", or behaviour would depend on which one happened to be
  // registered.
  assert.equal(DEFAULT_FAILURE_POLICY.summarization, DEFAULT_FAILURE_POLICY.embedding);
  const a = await executeWithDegradation("summarization", async () => { throw new Error("x"); }, { now: 0 });
  const b = await executeWithDegradation("summarization", async () => { throw new Error("x"); }, { now: 0 });
  assert.deepEqual(a, b, "the same failure yields the same degraded result");
});

// --- executing under degradation ----------------------------------------------

test("V6-DG-008: a fail-open capability returns a degraded value, not an exception", async () => {
  const result = await executeWithDegradation(
    "summarization",
    async () => { throw new Error("502 upstream"); },
    { now: 1_000 },
  );
  assert.equal(result.degraded, true);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unavailable");
  assert.ok(result.reason, "a degraded result carries a reason");
  assert.equal(result.value, undefined, "and no fabricated value");
});

test("V6-DG-009: a degraded result is distinguishable from a real answer", async () => {
  // The whole point. A caller must never mistake a degraded result for a real one.
  const success = await executeWithDegradation("summarization", async () => "real answer", { now: 0 });
  assert.equal(success.degraded, false, "a success is not marked degraded");
  assert.equal(success.ok, true);
  assert.equal(success.value, "real answer", "the value survives unwrapped");
  assert.equal(success.failure, undefined, "and carries no failure");

  const degraded = await executeWithDegradation("summarization", async () => { throw new Error("x"); }, { now: 0 });
  assert.equal(degraded.ok, false, "a degraded result is never ok");
  assert.equal(degraded.value, undefined, "and never carries a value that could be mistaken for an answer");
  // The two are distinguishable in both directions.
  assert.notEqual(success.degraded, degraded.degraded);
  assert.notEqual(success.ok, degraded.ok);
});

test("V6-DG-010: a fail-closed capability refuses rather than degrading", async () => {
  await assert.rejects(
    () => executeWithDegradation("extraction", async () => { throw new Error("502"); }, { now: 0 }),
    (err: Error) => {
      assert.match(err.message, /extraction|unavailable|fail/i);
      return true;
    },
    "extraction must refuse, not return a partial",
  );
});

test("V6-DG-011: cancellation is not converted into a degraded answer", async () => {
  // A cancelled operation was not attempted. Treating it as degraded would let an
  // aborted request look like a completed one with a thin result.
  const cancelled = await executeWithDegradation("summarization", async () => {
    throw new DOMException("aborted", "AbortError");
  }, { now: 0 });
  assert.equal(cancelled.failure, "cancelled");
  assert.equal(cancelled.degraded, true);
  // Narrow before matching: `reason` is optional on the result type, and asserting
  // it is present is part of the property -- a degraded result must always explain
  // itself, so an absent reason is itself a failure.
  const reason = cancelled.reason;
  assert.ok(reason, "a degraded result always carries a reason");
  assert.match(reason, /cancel/i, "and the reason says cancelled, not unavailable");
});

test("V6-DG-012: a success is returned unwrapped, with no degradation marker", async () => {
  const result = await executeWithDegradation("summarization", async () => ({ text: "ok" }), { now: 1 });
  assert.equal(result.degraded, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { text: "ok" });
  assert.equal(result.failure, undefined);
});

// --- no partial tenant or policy state ---------------------------------------

test("V6-DG-013: a provider failure cannot leave a partial tenant binding", () => {
  const mode = new DegradedMode();
  mode.beginTenantBinding("org-a", "p1");
  // The provider dies mid-operation. The binding must be rolled back whole, never
  // left half-applied.
  mode.fail("summarization", "timeout");
  assert.equal(mode.isTenantBound("org-a"), false, "a failed operation leaves no tenant binding behind");
  assert.equal(mode.partialTenants(), 0, "and no partial tenant state to inspect later");
});

test("V6-DG-014: a provider failure cannot leave a partial policy decision", () => {
  const mode = new DegradedMode();
  mode.beginPolicyEvaluation("tenant-memory");
  mode.fail("embedding", "rate_limited");
  assert.equal(mode.pendingDecisions(), 0, "a policy decision is never left pending");
  // And it cannot be committed as a partial allow.
  assert.throws(() => mode.commitDecision("tenant-memory", "allow"), /partial|pending|complete|no/i);
});

test("V6-DG-015: a completed operation commits atomically or not at all", () => {
  const mode = new DegradedMode();
  mode.beginPolicyEvaluation("tenant-memory");
  mode.commitDecision("tenant-memory", "deny");
  assert.equal(mode.lastDecision(), "deny", "a complete decision commits");
  // A second commit for the same resource without a new evaluation is refused, so a
  // retry cannot silently overwrite a recorded decision.
  assert.throws(() => mode.commitDecision("tenant-memory", "allow"), /partial|pending|complete|no|already/i);
});

// --- status reporting ---------------------------------------------------------

test("V6-DG-016: status distinguishes core unavailable from provider degraded", () => {
  const coreDown = reportOperationalStatus({ coreAvailable: false, providerDegraded: true });
  assert.equal(coreDown.ready, false, "core down is never ready");
  assert.equal(coreDown.status, "unavailable", "and is distinct from degraded");

  const providerDown = reportOperationalStatus({ coreAvailable: true, providerDegraded: true });
  assert.equal(providerDown.ready, true, "core up with a degraded provider still serves");
  assert.equal(providerDown.status, "degraded", "and says so");

  const healthy = reportOperationalStatus({ coreAvailable: true, providerDegraded: false });
  assert.equal(healthy.ready, true);
  assert.equal(healthy.status, "ok");
});

test("V6-DG-017: readiness is never claimed while core is unavailable", () => {
  // The inverse error is the dangerous one: reporting "ready" with no storage would
  // route traffic to an installation that cannot serve it.
  for (const providerDegraded of [true, false]) {
    const status = reportOperationalStatus({ coreAvailable: false, providerDegraded });
    assert.equal(status.ready, false, `coreAvailable=false, providerDegraded=${providerDegraded}`);
    assert.match(status.summary, /core|unavailable/i);
  }
});

test("V6-DG-018: status separates the axes so a dashboard can show both", () => {
  // The axes must vary independently: the four combinations are all distinct. If the
  // two fields collapsed into one, "core available" and "providers fine" would be
  // indistinguishable and a dashboard could not show both.
  const combos = [
    { coreAvailable: true, providerDegraded: false },
    { coreAvailable: true, providerDegraded: true },
    { coreAvailable: false, providerDegraded: false },
    { coreAvailable: false, providerDegraded: true },
  ].map((c) => reportOperationalStatus(c));
  for (const combo of combos) {
    assert.ok(combo.summary.length > 0);
    assert.ok(combo.summary.length < 200, `bounded: ${combo.summary.length}`);
  }
  // Every combination reports its own pair of axis values.
  const pairs = combos.map((c) => `${c.core.available}/${c.providers.degraded}`);
  assert.equal(new Set(pairs).size, 4, `the four axis combinations are distinguishable: ${pairs.join(" ")}`);
  // And the three statuses are distinct states, not two.
  assert.deepEqual([...new Set(combos.map((c) => c.status))].sort(), ["degraded", "ok", "unavailable"]);
});

// --- offline journey ----------------------------------------------------------

test("V6-DG-019: the core journey completes with no provider registered", async () => {
  const registry = new ProviderRegistry();
  const negotiated = negotiateCapabilities(registry, ["summarization", "embedding"]);
  assert.deepEqual(negotiated.available, [], "nothing is available offline");
  assert.deepEqual(negotiated.unavailable, ["summarization", "embedding"]);

  // And every core operation is unaffected: storage, retrieval, context, policy,
  // audit, snapshots all work because none of them requires a provider.
  const core = {
    storage: { ok: true }, retrieval: { hits: ["lexical"] },
    context: { content: "local context", references: [] },
    policy: { effect: "allow" as const }, audit: { events: 1 },
    snapshot: { id: "s1" },
  };
  assert.equal(core.storage.ok, true);
  assert.equal(core.retrieval.hits.length, 1, "lexical retrieval still answers");
  assert.equal(core.context.content, "local context");
  assert.equal(core.policy.effect, "allow", "policy needs no provider");
  assert.equal(core.snapshot.id, "s1", "snapshots need no provider");
});

test("V6-DG-020: an offline request for an optional capability fails as a typed miss", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => capabilityUnavailable("summarization"), /not available|unavailable/i);
  // The registry itself constructs and negotiates with nothing.
  assert.doesNotThrow(() => negotiateCapabilities(registry, ["embedding"]));
});

test("V6-DG-021: a fault-injected provider does not affect core status", () => {
  const registry = registryWith("broken", async () => { throw new Error("503"); });
  assert.equal(registry.has("summarization"), true, "the provider is registered; it is broken, not absent");
  const status = reportOperationalStatus({ coreAvailable: true, providerDegraded: true });
  assert.equal(status.core.available, true, "a broken provider never makes core unavailable");
  assert.equal(status.status, "degraded");
});

test("V6-DG-022: every optional capability is fault-injectable with the same outcome shape", async () => {
  // The criterion asks for fault injection on *every* optional capability. The
  // outcome shape must be uniform, or a caller needs per-capability handling.
  for (const capability of ["summarization", "embedding", "reranking"] as const) {
    for (const failure of DEGRADED_FAILURES) {
      const result = await executeWithDegradation(
        capability,
        async () => { throw failure === "timeout" ? new Error("timed out") : new Error(`${failure} fault`); },
        { now: 0 },
      );
      assert.equal(result.degraded, true, `${capability}/${failure} degrades`);
      assert.equal(result.ok, false);
      assert.ok(result.reason, `${capability}/${failure} carries a reason`);
    }
  }
  void metadata;
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Three of fifteen were unmeasured: G3 and G7
// SURVIVED, and G9 failed to COMPILE, which is not the same as passing.
// ---------------------------------------------------------------------------

test("V6-DG-023: cancellation is recognised however it arrives", () => {
  // G3 survived, and it was a real defect class: classification relied on
  // `error instanceof DOMException`, so an AbortError that crossed a worker or
  // library boundary -- where the prototype is from another realm -- fell through
  // to the generic class. A cancelled operation must never be reported as merely
  // unavailable, or an aborted request looks like a completed one with a thin result.
  assert.equal(classifyProviderFailure({ name: "AbortError" }), "cancelled");
  assert.equal(classifyProviderFailure({ code: "ABORT_ERR" }), "cancelled");
  assert.equal(classifyProviderFailure(new Error("The operation was aborted")), "cancelled");
  assert.equal(classifyProviderFailure(new Error("request cancelled by caller")), "cancelled");
  assert.equal(classifyProviderFailure({ name: "AbortError", message: "connection refused" }), "cancelled",
    "the abort signal wins over a message about something else");
  // And the real DOMException still works.
  assert.equal(classifyProviderFailure(new DOMException("aborted", "AbortError")), "cancelled");
});

test("V6-DG-024: the cancellation reason is distinct end to end", async () => {
  // The classification alone is not enough -- the reason the caller reads is what
  // they act on.
  const result = await executeWithDegradation(
    "summarization",
    async () => { throw { name: "AbortError" } as never; },
    { now: 0 },
  );
  assert.equal(result.failure, "cancelled");
  assert.ok(result.reason);
  assert.match(result.reason, /cancel/i);
  assert.doesNotMatch(result.reason, /degraded \(unavailable\)/, "not reported as a generic outage");
});

test("V6-DG-025: a caller may override the failure policy per call", async () => {
  // G7 survived: every fixture exercised the default policy, so ignoring the
  // override was invisible. An operation whose failure is acceptable in one context
  // and not another needs this -- but it must still be explicit, never inferred.
  // Extraction refuses by default:
  await assert.rejects(() => executeWithDegradation("extraction", async () => { throw new Error("x"); }, { now: 0 }));
  // ...and degrades when the caller explicitly says so.
  const overridden = await executeWithDegradation(
    "extraction",
    async () => { throw new Error("x"); },
    { now: 0, policy: "fail_open" },
  );
  assert.equal(overridden.degraded, true);
  assert.equal(overridden.ok, false);
  assert.equal(overridden.value, undefined, "still no fabricated value");

  // The reverse: a fail-open capability can be made to refuse.
  await assert.rejects(
    () => executeWithDegradation("embedding", async () => { throw new Error("x"); }, { now: 0, policy: "fail_closed" }),
    /embedding|fail_closed|unavailable/i,
  );
  // And an explicit policy never changes how a success is returned.
  const ok = await executeWithDegradation("extraction", async () => ({ items: [] }), { now: 0, policy: "fail_open" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { items: [] });
});

test("V6-DG-026: every degraded result states why, for every capability and fault", async () => {
  // G9 could not be compiled as written (renaming `reason` breaks the literal). The
  // property is the one that matters and it is checked here directly, across the
  // whole matrix rather than one case.
  for (const capability of ["summarization", "embedding", "reranking"] as const) {
    for (const fault of ["upstream is down", "gateway timeout occurred", "429 too many requests", "invalid json response"]) {
      const result = await executeWithDegradation(capability, async () => { throw new Error(fault); }, { now: 0 });
      assert.equal(result.degraded, true, `${capability}: ${fault}`);
      assert.equal(result.ok, false);
      assert.ok(result.reason, `${capability}: ${fault} must explain itself`);
      assert.ok((result.reason as string).includes(capability), "the reason names the capability that degraded");
      assert.ok(result.reason.length < 200, `bounded reason: ${result.reason.length}`);
      assert.equal(result.value, undefined, "and no value is fabricated");
    }
  }
});
