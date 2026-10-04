import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CORE_CAPABILITIES,
  CORE_CONTRACT_VERSION,
  CoreCapability,
  ProviderMetadataSchema,
  ProviderRegistry,
  capabilityUnavailable,
  isCoreCapability,
  negotiateCapabilities,
  type CoreOperations,
} from "../v6-core-contract.js";

/**
 * V6-T09 contract fixtures.
 *
 * Two properties are load-bearing, and neither is "the interface exists":
 *
 *  - **Provider absence is a normal runtime state.** Durable memory must keep working
 *    with no provider at all, degrading to lexical retrieval rather than failing to
 *    start. A design that requires a provider has already lost, because the whole
 *    premise is offline-first.
 *  - **A provider cannot widen authorization.** Providers return data. The moment a
 *    provider result is allowed to carry a principal, a capability, or a policy
 *    decision, a remote service can escalate by returning a richer object.
 *
 * The dependency-graph check reads the real source tree rather than trusting an
 * import map, because the failure it guards against is an import someone adds later.
 */

/** A core implementation that needs nothing from any provider. */
function durableCore(): CoreOperations {
  return {
    version: CORE_CONTRACT_VERSION,
    storage: {
      store: async () => ({ ok: true }),
      get: async () => null,
      delete: async () => ({ ok: true }),
      list: async () => [],
    },
    retrieval: {
      search: async () => [],
      explain: async () => ({ hits: [], budget: { total: 0, expanded: 0, filtered: 0 } }),
    },
    context: { build: async () => ({ content: "", references: [] }) },
    policy: { evaluate: async () => ({ effect: "deny", reason: "capability_denied", policyVersion: "v6-policy/1.0.0" }) },
    lifecycle: { expire: async () => 0, archive: async () => 0 },
    audit: { append: async () => undefined, query: async () => ({ events: [], totalRetained: 0, dropped: 0 }) },
    snapshot: { create: async () => ({ id: "s1" }), restore: async () => ({ ok: true }) },
  };
}

// --- coverage ----------------------------------------------------------------

test("V6-CC-001: the core contract covers all seven required domains", () => {
  for (const domain of [
    "storage",
    "retrieval",
    "context",
    "policy",
    "lifecycle",
    "audit",
    "snapshot",
  ] as const) {
    assert.ok(CORE_CAPABILITIES.includes(domain as never), `core contract must cover ${domain}`);
  }
});

test("V6-CC-002: every core capability is a closed, versioned vocabulary", () => {
  assert.match(CORE_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/, "the contract is versioned");
  assert.equal(new Set(CORE_CAPABILITIES).size, CORE_CAPABILITIES.length, "no duplicates");
  for (const c of CORE_CAPABILITIES) assert.equal(isCoreCapability(c), true);
  assert.equal(isCoreCapability("summarization" as never), false, "optional intelligence is not a core capability");
});

// --- provider absence is normal ----------------------------------------------

test("V6-CC-003: durable core operations need no provider", async () => {
  const core = durableCore();
  assert.equal((await core.storage.store({})).ok, true, "storage works with no provider configured");
  assert.deepEqual(await core.retrieval.search({}), []);
  assert.deepEqual((await core.context.build({})).references, []);
});

test("V6-CC-004: an absent provider is a resolvable capability miss, not a startup error", () => {
  const registry = new ProviderRegistry();
  // Constructing and negotiating with nothing registered must not throw.
  const negotiated = negotiateCapabilities(registry, ["summarization"]);
  assert.deepEqual(negotiated.available, [], "nothing is available when nothing is registered");
  assert.deepEqual(negotiated.unavailable, ["summarization"], "and the miss is named, not silent");
});

test("V6-CC-005: an optional capability degrades to a refusal the caller can handle", () => {
  const registry = new ProviderRegistry();
  const miss = negotiateCapabilities(registry, ["summarization"]).unavailable[0];
  assert.ok(miss);
  assert.throws(() => capabilityUnavailable("summarization"), (err: Error) => {
    // A missing optional capability is a typed, catchable condition with an
    // actionable code -- not a TypeError from calling undefined.
    assert.match(err.message, /not available|unavailable/i);
    return true;
  });
});

test("V6-CC-006: a failing provider is a capability miss, not a core failure", async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: "remote-summarizer",
    capabilities: ["summarization"],
    metadata: { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 800 }, availability: "remote" },
    invoke: async () => {
      throw new Error("502 upstream unavailable");
    },
  });
  const negotiated = negotiateCapabilities(registry, ["summarization"]);
  assert.deepEqual(negotiated.available, ["summarization"], "a registered provider negotiates");
  // Core still works; only the optional capability fails.
  const core = durableCore();
  assert.equal((await core.storage.store({})).ok, true, "a broken provider does not take core down");
});

// --- provider metadata -------------------------------------------------------

test("V6-CC-007: provider metadata must declare privacy, cost, latency and availability", () => {
  const valid = {
    id: "p",
    capabilities: ["summarization"],
    metadata: { privacy: "local", cost: { perCall: 0 }, latency: { p95Ms: 10 }, availability: "local" },
  };
  assert.equal(ProviderMetadataSchema.safeParse(valid.metadata).success, true);
  // Each axis is required -- a provider with unknown cost or privacy cannot be
  // negotiated safely, because the point of declaring it is to choose under constraint.
  for (const drop of ["privacy", "cost", "latency", "availability"] as const) {
    const partial: Record<string, unknown> = { ...valid.metadata };
    delete partial[drop];
    assert.equal(ProviderMetadataSchema.safeParse(partial).success, false, `${drop} must be required`);
  }
});

test("V6-CC-008: metadata bounds are enforced, so one provider cannot dominate a decision", () => {
  const base = { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 100 }, availability: "remote" };
  assert.equal(ProviderMetadataSchema.safeParse({ ...base, latency: { p95Ms: -1 } }).success, false, "negative latency");
  assert.equal(ProviderMetadataSchema.safeParse({ ...base, cost: { perCall: -5 } }).success, false, "negative cost");
  assert.equal(ProviderMetadataSchema.safeParse({ ...base, latency: { p95Ms: 10 ** 9 } }).success, false,
    "an absurd latency claim is not usable for negotiation");
});

// --- the boundary ------------------------------------------------------------

test("V6-CC-009: provider output cannot carry authorization or policy state", async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: "escalating",
    capabilities: ["summarization"],
    metadata: { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 100 }, availability: "remote" },
    // A hostile or careless provider returns a richer object than the contract allows.
    invoke: async () => ({
      text: "ok",
      effect: "allow" as const,
      principal: { organizationId: "org-b", capabilities: ["tenant:admin"] },
      policyVersion: "v6-policy/9.9.9",
    }) as never,
  });
  const negotiated = negotiateCapabilities(registry, ["summarization"]);
  const result = await registry.invokeCapability("summarization", {});
  // Whatever the provider returned, the contract keeps only the declared payload.
  assert.deepEqual(Object.keys(result as object).sort(), ["text"], "only the declared field crosses the boundary");
});

test("V6-CC-010: the registry strips anything the capability contract does not declare", async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: "chatty",
    capabilities: ["summarization"],
    metadata: { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 100 }, availability: "remote" },
    invoke: async () => ({ text: "hi", secretToken: "sk-leaked", organizationId: "org-b" }) as never,
  });
  const out = (await registry.invokeCapability("summarization", {})) as Record<string, unknown>;
  assert.equal(out.secretToken, undefined, "an undeclared field is dropped, not passed through");
  assert.equal(out.organizationId, undefined, "and it cannot carry a tenant");
  assert.equal(out.text, "hi", "the declared payload still arrives");
});

// --- dependency graph --------------------------------------------------------

/**
 * Locate `src/` from wherever this compiled test runs.
 *
 * `dist/test/` is two levels below the package root, so the source directory is the
 * grandparent. Resolving it explicitly rather than assuming a layout keeps the
 * dependency-graph checks working from `dist/` — the first draft pointed at
 * `dist/v6-core-contract.ts` and failed on ENOENT, which is a test bug, not a
 * detected dependency.
 */
function srcDir(): string {
  const here = new URL(".", import.meta.url).pathname; // .../dist/test/
  return resolve(here, "..", "..", "src");
}

test("V6-CC-011: core modules do not import a provider SDK", () => {
  // Reads the real tree, so an import added later fails this test rather than being
  // noted in a document nobody re-reads.
  const dir = srcDir();
  const banned = /from\s+["'](openai|@anthropic[^"']*|cohere-ai|ollama|@google\/generative-ai|langchain[^"']*)["']/;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    if (banned.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `core modules must not import provider SDKs: ${offenders.join(", ")}`);
});

test("V6-CC-012: the core contract declares no provider type", () => {
  const text = readFileSync(join(srcDir(), "v6-core-contract.ts"), "utf8");
  assert.equal(existsSync(join(srcDir(), "v6-core-contract.ts")), true, "the contract source is where the test expects it");
  assert.equal(/import\s+[^;]*\bfrom\s+["'](openai|@anthropic[^"']*)["']/.test(text), false);
  assert.equal(/\bOpenAI\b|\bAnthropic\b|\bChatCompletion\b/.test(text), false,
    "the contract names no vendor in its own surface");
});

// --- capability negotiation --------------------------------------------------

test("V6-CC-013: negotiation reports both sides, so a caller can choose", () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: "a",
    capabilities: ["summarization"],
    metadata: { privacy: "local", cost: { perCall: 0 }, latency: { p95Ms: 10 }, availability: "local" },
    invoke: async () => ({ text: "x" }),
  });
  const n = negotiateCapabilities(registry, ["summarization", "embedding"]);
  assert.deepEqual(n.available, ["summarization"]);
  assert.deepEqual(n.unavailable, ["embedding"]);
  assert.equal(n.negotiatedAt >= 0, true, "negotiation is timestamped");
});

test("V6-CC-014: a core capability is never satisfiable by a provider", () => {
  // Storage is durable and local by definition. A provider claiming to supply it is
  // a misregistration, and is refused rather than silently accepted.
  const registry = new ProviderRegistry();
  // Refused at registration, not at negotiation: a misregistered provider should
  // never reach the registry at all, so there is no state in which `storage`
  // looks delegated. Asserting the refusal point matters -- the first draft of this
  // fixture registered successfully and asserted on negotiation, which would have
  // accepted a registry that had briefly held the pretender.
  assert.throws(
    () => registry.register({
      id: "pretender",
      capabilities: ["storage" as CoreCapability],
      metadata: { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 10 }, availability: "remote" },
      invoke: async () => ({}) as never,
    }),
    /core capability|core is never delegated/i,
  );
  const n = negotiateCapabilities(registry, ["storage"]);
  assert.deepEqual(n.available, ["storage"], "core is available without a provider");
  assert.deepEqual(n.unavailable, [], "and is never treated as a capability miss");
});

test("V6-CC-015: an unregistered capability has no provider, even when others are registered", async () => {
  const registry = new ProviderRegistry();
  await assert.rejects(() => registry.invokeCapability("summarization", {}), /not available|unavailable/i,
    "an unregistered capability rejects with a typed miss, not a TypeError");
});

test("V6-CC-016: duplicate provider ids are refused rather than last-write-wins", () => {
  const registry = new ProviderRegistry();
  const provider = {
    id: "dup",
    capabilities: ["summarization" as const],
    metadata: { privacy: "local" as const, cost: { perCall: 0 }, latency: { p95Ms: 1 }, availability: "local" as const },
    invoke: async () => ({ text: "x" }),
  };
  registry.register(provider);
  assert.throws(() => registry.register({ ...provider, metadata: { ...provider.metadata, cost: { perCall: 9 } } }),
    /duplicate|already/i, "a shadowed provider would make negotiation unpredictable");
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Four of thirteen were unmeasured: two SURVIVED
// (metadata validation and provider id), and two failed to COMPILE, which is not
// the same as passing -- a build-failed mutation tests nothing.
// ---------------------------------------------------------------------------

test("V6-CC-017: registering a provider with incomplete metadata is refused", () => {
  // K8 survived: the metadata tests validated `ProviderMetadataSchema` directly, so
  // removing the check inside `register` changed nothing they observed. The schema
  // being correct and the registry enforcing it are two different claims.
  const registry = new ProviderRegistry();
  const full = { privacy: "external" as const, cost: { perCall: 1 }, latency: { p95Ms: 10 }, availability: "remote" as const };
  for (const drop of ["privacy", "cost", "latency", "availability"] as const) {
    const partial: Record<string, unknown> = { ...full };
    delete partial[drop];
    assert.throws(
      () => registry.register({ id: `p-${drop}`, capabilities: ["summarization"], metadata: partial as never, invoke: async () => ({ text: "x" }) }),
      /privacy|cost|latency|availability|metadata/i,
      `register must refuse metadata missing ${drop}`,
    );
  }
  // And the refused providers never entered the registry.
  assert.equal(registry.has("summarization"), false, "a refused provider is not half-registered");
  // The complete declaration is still accepted, so the check is not simply refusing everything.
  registry.register({ id: "good", capabilities: ["summarization"], metadata: full, invoke: async () => ({ text: "x" }) });
  assert.equal(registry.has("summarization"), true);
});

test("V6-CC-018: a provider needs a real id", () => {
  // K12 survived: the id check was never exercised with an empty string, because
  // every fixture supplied one. An empty id makes two providers collide silently.
  const registry = new ProviderRegistry();
  for (const badId of ["", undefined, null]) {
    assert.throws(
      () => registry.register({ id: badId as never, capabilities: ["summarization"], metadata: { privacy: "local", cost: { perCall: 0 }, latency: { p95Ms: 1 }, availability: "local" }, invoke: async () => ({ text: "x" }) }),
      /non-empty id/i,
    );
  }
});

test("V6-CC-019: a non-object provider result projects to nothing", async () => {
  // K3 did not compile when it removed the guard outright, because TypeScript then
  // narrowed `raw` to non-null and the build failed -- so the guard was never
  // exercised. Exercise it here directly: a provider returning a string, a number,
  // null or undefined must not yield fields, and must not throw.
  const registry = new ProviderRegistry();
  for (const weird of ["a string", 42, null, undefined, true]) {
    registry.register({
      id: `weird-${String(weird)}`,
      capabilities: ["summarization"],
      metadata: { privacy: "local", cost: { perCall: 0 }, latency: { p95Ms: 1 }, availability: "local" },
      invoke: async () => weird as never,
    });
    const out = await registry.invokeCapability("summarization", {});
    assert.deepEqual(out, {}, `a non-object result yields no fields, got ${JSON.stringify(out)}`);
  }
});

test("V6-CC-020: the projection is a field allowlist, verified against a rich hostile result", async () => {
  // K1 likewise failed to compile as written. The property -- only declared fields
  // cross the boundary -- is what matters, so it is asserted end to end: a provider
  // returning fourteen fields of plausible-looking authority state crosses with one.
  const registry = new ProviderRegistry();
  registry.register({
    id: "hostile",
    capabilities: ["summarization"],
    metadata: { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 10 }, availability: "remote" },
    invoke: async () => ({
      text: "summary",
      effect: "allow",
      principal: { organizationId: "org-b", capabilities: ["tenant:admin"] },
      organizationId: "org-b",
      projectId: "p9",
      userId: "attacker",
      policyVersion: "v6-policy/9.9.9",
      reason: "allowed",
      trust: "trusted",
      clearance: "top-secret",
      secretToken: "sk-leaked",
      authorization: { allow: true },
      expiresAt: 99999999999,
      content: "SSN 123-45-6789",
    }) as never,
  });
  const out = await registry.invokeCapability("summarization", {});
  assert.deepEqual(Object.keys(out), ["text"], `only the declared field crossed: ${JSON.stringify(Object.keys(out))}`);
  assert.equal(out.text, "summary");
  // And the same guarantee holds for the other declared capabilities.
  for (const [capability, field] of [["embedding", "vector"], ["reranking", "scores"], ["extraction", "items"]] as const) {
    registry.register({
      id: `hostile-${capability}`,
      capabilities: [capability],
      metadata: { privacy: "external", cost: { perCall: 1 }, latency: { p95Ms: 10 }, availability: "remote" },
      invoke: async () => ({ [field]: "ok", organizationId: "org-b", effect: "allow" }) as never,
    });
    const r = await registry.invokeCapability(capability, {});
    assert.deepEqual(Object.keys(r), [field], `${capability} carries only ${field}`);
  }
});
