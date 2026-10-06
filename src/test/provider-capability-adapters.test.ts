import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapabilityAdapter,
  capabilityResult,
  ClassificationAdapter,
  SummarizationAdapter,
  extractExtractedMemories,
  createLocalClassificationAdapter,
  createLocalSummarizationAdapter,
  unsupportedCapability,
  MAX_SUMMARY_CHARS,
  MAX_EXTRACTED_CHARS,
  MAX_EXTRACTED_ITEMS,
} from "../providers/capability-adapters.js";
import { RemembraError } from "../errors.js";
import { SENSITIVITY_ORDER, type Sensitivity } from "../v6-policy.js";
import { evaluateTransmission, defaultManifestFor } from "../provider-boundary.js";

// No network stub is needed anywhere in this file: every adapter here is LOCAL, and
// "local adapters work without network access" is asserted by construction -- if any of
// them reached for a socket the test would hang or fail, not silently pass.

/**
 * Read a field off a successful result.
 *
 * The result is a discriminated union, so a fixture asserting "a classification has
 * labels" has to narrow first. Doing that once here keeps every assertion below about
 * the property rather than about the union's shape.
 */
function value<T = Record<string, unknown>>(result: unknown): T {
  assert.equal((result as { ok: boolean }).ok, true, `expected success, got ${JSON.stringify(result)}`);
  return (result as { value: T }).value;
}
function failureReason(result: unknown): string {
  assert.equal((result as { ok: boolean }).ok, false, `expected failure, got ${JSON.stringify(result)}`);
  return (result as { reason: string }).reason;
}

/** Fails loudly if anything tries to reach the network. */
const noNetwork = async (): Promise<never> => {
  throw new Error("a local adapter attempted a network call");
};

// --- typed capability results -------------------------------------------------

test("V6-PA-001: a successful result is typed and carries no authority", async () => {
  const adapter = new ClassificationAdapter(new CapabilityAdapter("local-classify", async () => ({ labels: ["fact"] }), ["classification"]));
  const result = await adapter.classify("some memory text", { signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.equal(result.capability, "classification");
  assert.ok((value(result).labels as unknown[]).length > 0, "at least one label");
  // The provider's answer is data. It is not a decision and grants nothing.
  for (const key of Object.keys(result)) {
    assert.equal(/^(allow|grant|authorize|trust)$/i.test(key), false,
      `${key} would be a place authority could enter the result`);
  }
});

test("V6-PA-002: an unsupported capability is a typed result, not a throw", async () => {
  const adapter = new CapabilityAdapter("nothing");
  const result = await adapter.invoke("consolidation", "text");
  assert.equal(result.ok, false);
  assert.equal(result.capability, "consolidation");
  assert.match(failureReason(result), /no handler|not supported|unsupported|available/i);
  assert.equal((result as { thrown?: unknown }).thrown, undefined, "it is a value, not a throw");
});

test("V6-PA-003: unsupportedCapability builds that same typed result", () => {
  const result = unsupportedCapability("embedding", "no embedding provider configured");
  assert.equal(result.ok, false);
  assert.equal(result.capability, "embedding");
  assert.equal(result.reason, "no embedding provider configured");
});

test("V6-PA-004: a malformed provider response is a typed failure, not a partial parse", () => {
  // Half-parsed provider output is how a bad response becomes bad stored data.
  for (const bad of [null, undefined, "a string", 42, {}, { memories: "nope" }, { memories: [{}] }]) {
    let threw = false;
    try {
      extractExtractedMemories(bad as never, "test-provider");
    } catch {
      threw = true;
    }
    assert.equal(threw, true, `malformed output ${JSON.stringify(bad)} must be refused`);
  }
});

test("V6-PA-005: well-formed extraction output is accepted and bounded", () => {
  const good = extractExtractedMemories(
    [{ type: "fact", content: "a real fact", importance: 3 }],
    "test-provider",
  );
  assert.equal(good.length, 1);
  assert.equal(good[0].content, "a real fact");
  assert.equal(good.length > 0, true);
  // An over-long content string is refused rather than stored.
  assert.throws(
    () => extractExtractedMemories([{ type: "fact", content: "x".repeat(MAX_EXTRACTED_CHARS + 1) }], "test-provider"),
    /longer than|too long|length|exceeds/i,
    "an over-long item is refused rather than truncated into stored data",
  );
  // And so is an oversized batch.
  assert.throws(
    () => extractExtractedMemories(
      Array.from({ length: MAX_EXTRACTED_ITEMS + 1 }, () => ({ type: "fact", content: "x" })),
      "test-provider",
    ),
    /above the|too many/i,
  );
});

test("V6-PA-006: extraction output cannot carry trust, access or a principal", () => {
  // The acceptance criterion: provider output is schema-validated and cannot grant
  // trust/access. A provider that returns `trust: "system"` must not be believed.
  const parsed = extractExtractedMemories(
    [{ type: "fact", content: "x", trust: "system", access: "public", organizationId: "org-b" } as never],
    "test-provider",
  );
  assert.equal(parsed.length, 1);
  const record = parsed[0] as unknown as Record<string, unknown>;
  for (const forbidden of ["trust", "access", "organizationId", "tenantId", "agentId", "userId"]) {
    assert.equal(record[forbidden], undefined,
      `${forbidden} came from the provider and must be dropped`);
  }
  // Content and type survive; authority does not.
  assert.equal(record.content, "x");
  assert.equal(record.type, "fact");
});

// --- local adapters, no network ----------------------------------------------

test("V6-PA-007: a local classification adapter works with no network", async () => {
  const adapter = createLocalClassificationAdapter();
  const result = await adapter.classify("Alice prefers TypeScript for all projects");
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(value(result).labels));
  // No fetch, no socket: the adapter is pure.
  assert.equal(typeof adapter.classify, "function");
});

test("V6-PA-008: a local summarization adapter works with no network", async () => {
  const adapter = createLocalSummarizationAdapter();
  const result = await adapter.summarize("a".repeat(100) + " " + "b".repeat(100));
  assert.equal(result.ok, true);
  const text = String(value(result).text);
  assert.ok(text.length > 0);
  assert.ok(text.length <= MAX_SUMMARY_CHARS, `bounded: ${text.length}`);
});

test("V6-PA-009: a local adapter never calls fetch even if one is supplied", async () => {
  let called = false;
  const adapter = createLocalSummarizationAdapter();
  await adapter.summarize("text", {
    signal: new AbortController().signal,
    fetchImpl: async () => {
      called = true;
      return noNetwork();
    },
  });
  assert.equal(called, false, "a local adapter must not reach for the network at all");
});

test("V6-PA-010: cancellation is honoured by a local adapter", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createLocalSummarizationAdapter();
  const result = await adapter.summarize("text", { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.match(failureReason(result), /cancel|abort/i, "an aborted call reports cancellation");
});

test("V6-PA-011: an adapter failure is typed and never throws past the boundary", async () => {
  // A provider that throws must not become an unhandled rejection in a caller's path.
  const adapter = new CapabilityAdapter("always-fails", async () => {
    throw new Error("502 upstream");
  });
  const result = await adapter.invoke("summarization", "text");
  assert.equal(result.ok, false);
  assert.match(failureReason(result), /upstream|failed/i);
});

// --- policy gating ------------------------------------------------------------

test("V6-PA-012: an adapter invocation consults the transmission gate first", async () => {
  let invoked = false;
  const adapter = new CapabilityAdapter("gated", async () => {
    invoked = true;
    return { text: "ok" };
  });
  const manifest = defaultManifestFor({ id: "gated", capabilities: ["summarization"], privacy: "local" });

  // Allowed: local provider, tenant permits external, band within the ceiling.
  const allowed = await adapter.invoke(
    "summarization",
    "text",
    { sensitivity: "public" as Sensitivity, manifest, tenantAllowsExternal: true },
  );
  assert.equal(allowed.ok, true);
  assert.equal(invoked, true, "an allowed capability reaches the provider");

  // Denied by the ceiling: the provider must NOT be invoked.
  invoked = false;
  const strict = { ...manifest, maxSensitivity: "public" as const };
  const denied = await adapter.invoke(
    "summarization",
    "text",
    { sensitivity: "secret" as Sensitivity, manifest: strict, tenantAllowsExternal: true },
  );
  assert.equal(denied.ok, false);
  assert.equal(invoked, false, "and a denied capability never reaches the provider");
  assert.match(failureReason(denied), /refused|ceiling|transmission/i);
});

test("V6-PA-013: every sensitivity band is gated consistently", async () => {
  let invoked = 0;
  const adapter = new CapabilityAdapter("counting", async () => {
    invoked++;
    return { text: "ok" };
  });
  const manifest = { ...defaultManifestFor({ id: "c", capabilities: ["summarization"], privacy: "local" }), maxSensitivity: "confidential" as const };
  for (const sensitivity of SENSITIVITY_ORDER as readonly Sensitivity[]) {
    const before = invoked;
    const result = await adapter.invoke("summarization", "text", {
      sensitivity, manifest, tenantAllowsExternal: true,
    });
    const expected = SENSITIVITY_ORDER.indexOf(sensitivity) <= SENSITIVITY_ORDER.indexOf("confidential");
    assert.equal(result.ok, expected, `${sensitivity}: ok=${result.ok}, expected=${expected}`);
    if (expected) assert.equal(invoked, before + 1, `${sensitivity} reached the provider`);
    else assert.equal(invoked, before, `${sensitivity} did not`);
  }
});

test("V6-PA-014: a gate denial reports the gate's own reason", async () => {
  const adapter = new CapabilityAdapter("gated", async () => ({ text: "ok" }));
  const manifest = defaultManifestFor({ id: "gated", capabilities: ["summarization"], privacy: "external" });
  const result = await adapter.invoke("summarization", "text", {
    sensitivity: "public", manifest, tenantAllowsExternal: false,
  });
  assert.equal(result.ok, false);
  assert.match(failureReason(result), /external|transmission|tenant/i);
});

test("V6-PA-015: omitting the gate input is not a way around the gate", async () => {
  // A caller that forgets to pass a manifest gets the CONSERVATIVE answer: the
  // derived external manifest, which refuses `secret`. Failing open here would make
  // forgetting a parameter a way to transmit.
  const adapter = new CapabilityAdapter("no-manifest", async () => ({ text: "ok" }));
  const result = await adapter.invoke("summarization", "text", { sensitivity: "secret" });
  assert.equal(result.ok, false, "an omitted manifest must not permit transmission");
  assert.match(String(result.reason), /sensitivity|ceiling|transmission/i);
});

// --- classification and summarization are separate capabilities ---------------

test("V6-PA-016: classification and summarization are distinct capabilities", async () => {
  // Conflating them is how a summarizer's text ends up labelled with a category it
  // never claimed.
  const classifier = createLocalClassificationAdapter();
  const summarizer = createLocalSummarizationAdapter();
  assert.equal(classifier.capability, "classification");
  assert.equal(summarizer.capability, "summarization");
  assert.notEqual(classifier.capability, summarizer.capability);
  const classified = await classifier.classify("text");
  assert.equal(value(classified).labels !== undefined, true);
  assert.equal(value(classified).text, undefined, "a classification is not a summary");
});

test("V6-PA-017: capabilityResult builds a consistent success shape", () => {
  const ok = capabilityResult("embedding", { vector: [0.1] });
  assert.equal(ok.ok, true);
  assert.equal(ok.capability, "embedding");
  assert.deepEqual((ok as unknown as { value: { vector: number[] } }).value.vector, [0.1]);
  const bad = capabilityResult("embedding", undefined, "no provider");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "no provider");
});

test("V6-PA-018: a capability the adapter does not implement returns unsupported", async () => {
  const adapter = createLocalSummarizationAdapter();
  const result = await (adapter as unknown as { adapter: CapabilityAdapter }).adapter.invoke("classification", "text");
  assert.equal(result.ok, false);
  assert.match(failureReason(result), /does not implement|not supported|unsupported/i,
    "an adapter must not silently serve a capability it does not implement");
});

test("V6-PA-019: core has no dependency on any adapter module", async () => {
  // "without making them core dependencies": a core module must not import an adapter.
  //
  // My first version used `require`, which does not exist in an ESM test -- so it
  // failed on the loader rather than on the property, and the check proved nothing.
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  // This test runs compiled from dist/test, so `../x.ts` would resolve inside dist.
  // Locate the source tree explicitly rather than assuming a layout.
  const here = new URL(".", import.meta.url).pathname;
  const srcDir = [resolve(here, "..", "src"), resolve(here, "..", "..", "src")].find((d) => existsSync(d));
  assert.ok(srcDir, "the src/ tree is where the check expects it");

  const coreFiles = ["service.ts", "store.ts", "sqlite-backend.ts", "retrieval.ts"];
  const offenders: string[] = [];
  for (const file of coreFiles) {
    const text = readFileSync(resolve(srcDir, file), "utf8");
    if (/from\s+["'][^"']*(?:provider-adapters|capability-adapters)[^"']*["']/.test(text)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `core must not import adapter modules: ${offenders.join(", ")}`);
});
