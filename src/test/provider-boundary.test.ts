import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderManifestSchema,
  MANIFEST_VERSION,
  DataClass,
  defaultManifestFor,
  evaluateTransmission,
  mayReceive,
  assertNoCredentials,
  redactManifest,
  type ProviderManifest,
} from "../provider-boundary.js";
import { ProviderRegistry } from "../v6-core-contract.js";
import { SENSITIVITY_ORDER, type Sensitivity } from "../v6-policy.js";
import { buildProviderRegistry } from "../provider-registry-wiring.js";

/**
 * V6-T12 provider manifests.
 *
 * The criterion that decides this design: **policy must be able to deny transmission
 * before network work begins.** Not after, not by inspecting what came back — before.
 * Once a request is on the wire the content has left the host, and a refusal that
 * arrives afterwards is a disclosure with extra steps.
 *
 * So the manifest answers three questions that have to be answerable *statically*, from
 * configuration, with no call to the provider:
 *
 *   1. What data classes may this provider receive at all?
 *   2. Where does it process them, and how long does it keep them?
 *   3. May it receive content at or below a given sensitivity band?
 *
 * The fourth criterion — credentials never entering records, audit events or logs — is
 * the one most easily believed and most easily lost, so it is asserted structurally
 * rather than by scanning output.
 */

const validManifest = (over: Partial<ProviderManifest> = {}): ProviderManifest =>
  ({
    id: "acme-llm",
    version: MANIFEST_VERSION,
    capabilities: ["summarization"],
    privacy: "external",
    regions: ["eu-west-1"],
    dataClasses: ["prompt"],
    retention: { training: false, logDays: 30 },
    maxSensitivity: "internal",
    cost: { perCall: 0.002 },
    latency: { p95Ms: 800 },
    availability: "remote",
    ...over,
  }) as ProviderManifest;

// --- the manifest shape -------------------------------------------------------

test("V6-PB-001: a complete manifest validates", () => {
  const parsed = ProviderManifestSchema.safeParse(validManifest());
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
});

test("V6-PB-002: every declared axis is required, not optional", () => {
  // A manifest missing an axis is a manifest whose constraint nobody chose, which is
  // the same failure as T09's `unknown` privacy.
  for (const axis of [
    "regions", "dataClasses", "retention", "maxSensitivity", "cost", "latency", "availability",
  ] as const) {
    const partial = { ...validManifest() } as Record<string, unknown>;
    delete partial[axis];
    assert.equal(ProviderManifestSchema.safeParse(partial).success, false,
      `${axis} must be required`);
  }
});

test("V6-PB-003: the manifest is versioned and the version is checked", () => {
  // A manifest from an unknown future version must be refused, not half-understood:
  // the axes we enforce today may not be the axes it declares.
  assert.equal(ProviderManifestSchema.safeParse(validManifest()).success, true);
  assert.equal(
    ProviderManifestSchema.safeParse(validManifest({ version: "99.0.0" as never })).success,
    false,
    "an unrecognised manifest version is refused rather than partially honoured",
  );
  assert.equal(
    ProviderManifestSchema.safeParse(validManifest({ version: "not-a-version" as never })).success,
    false,
  );
});

test("V6-PB-004: the schema is strict, so a `apiKey` field cannot be added", () => {
  // The structural half of "credentials never enter records": a manifest with a
  // credential field does not validate, so it cannot be stored or logged.
  assert.equal(
    ProviderManifestSchema.safeParse({ ...validManifest(), apiKey: "sk-leak" }).success,
    false,
    "a credential field is refused by the schema itself",
  );
  assert.equal(
    ProviderManifestSchema.safeParse({ ...validManifest(), baseUrl: "https://x.example" }).success,
    false,
  );
});

test("V6-PB-005: data classes and regions are closed vocabularies", () => {
  assert.ok(DataClass.length >= 5, "the data classes a provider might receive are enumerated");
  for (const dc of DataClass) {
    assert.equal(ProviderManifestSchema.safeParse(validManifest({ dataClasses: [dc] })).success, true,
      `${dc} is a declared data class`);
  }
  assert.equal(
    ProviderManifestSchema.safeParse(validManifest({ dataClasses: ["biometric-data" as never] })).success,
    false,
    "an undeclared data class is refused",
  );
});

// --- the transmission gate ----------------------------------------------------

test("V6-PB-006: transmission is denied before any network work", () => {
  // The acceptance criterion. A decision needs no provider call and no input beyond
  // what is already known: the manifest, the sensitivity, and the tenant's rule.
  const manifest = validManifest({ maxSensitivity: "internal" });

  const allowed = evaluateTransmission({ manifest, sensitivity: "public", tenantAllowsExternal: true, now: 1_000 });
  assert.equal(allowed.effect, "allow");

  const denied = evaluateTransmission({ manifest, sensitivity: "secret", tenantAllowsExternal: true, now: 1_000 });
  assert.equal(denied.effect, "deny");
  assert.ok(denied.reason, "a denial names its reason");
});

test("V6-PB-007: sensitivity is compared by band order, not lexically", () => {
  // "internal" > "confidential" as strings is false; as bands it is true. A lexical
  // comparison silently permits the wrong direction for most pairs.
  const manifest = validManifest({ maxSensitivity: "confidential" });
  for (const [sensitivity, expected] of [
    ["public", "allow"],
    ["internal", "allow"],
    ["confidential", "allow"],
    ["secret", "deny"],
  ] as const) {
    const r = evaluateTransmission({ manifest, sensitivity, tenantAllowsExternal: true, now: 1_000 });
    assert.equal(r.effect, expected, `${sensitivity} vs max=confidential -> ${expected}`);
  }
});

test("V6-PB-008: a local provider is not subject to the tenant's external rule", () => {
  // The rule is about content leaving the host. A local provider never sends it, so
  // denying a local provider because "external transmission is disallowed" would refuse
  // a request that involves no transmission at all.
  const local = validManifest({ privacy: "local", maxSensitivity: "secret" });
  const r = evaluateTransmission({ manifest: local, sensitivity: "secret", tenantAllowsExternal: false, now: 1_000 });
  assert.equal(r.effect, "allow", "a local provider transmits nothing, so the rule does not apply");
});

test("V6-PB-009: an external provider is denied when the tenant forbids external", () => {
  const external = validManifest({ privacy: "external" });
  for (const sensitivity of SENSITIVITY_ORDER as readonly Sensitivity[]) {
    const r = evaluateTransmission({ manifest: external, sensitivity, tenantAllowsExternal: false, now: 1_000 });
    assert.equal(r.effect, "deny", `${sensitivity} must be denied when external is forbidden`);
  }
});

test("V6-PB-010: training retention is a separate question from the transmission decision", () => {
  // A provider may be permitted to process content and forbidden to train on it. Those
  // are different consents, so the decision reports both rather than collapsing them.
  const manifest = validManifest({ retention: { training: true, logDays: 0 } });
  const r = evaluateTransmission({ manifest, sensitivity: "public", tenantAllowsExternal: true, now: 1_000 });
  assert.equal(r.effect, "allow");
  assert.equal(r.warnings?.includes("provider_trains_on_data"), true,
    "but the caller is told the content may be used for training");
});

test("V6-PB-011: a deny is never downgraded to a warning", () => {
  const manifest = validManifest({ maxSensitivity: "public" });
  const r = evaluateTransmission({ manifest, sensitivity: "secret", tenantAllowsExternal: true, now: 1_000 });
  assert.equal(r.effect, "deny");
  assert.equal(r.warnings?.length, undefined, "a denial carries no warnings that might soften it");
});

// --- the helper the service will use -----------------------------------------

test("V6-PB-012: mayReceive answers the same question", () => {
  const manifest = validManifest({ maxSensitivity: "internal" });
  assert.equal(mayReceive(manifest, "public"), true);
  assert.equal(mayReceive(manifest, "secret"), false);
});

test("V6-PB-013: a default manifest is derived, never guessed per call", () => {
  const local = defaultManifestFor({ id: "injected", capabilities: ["embedding"], privacy: "local" });
  assert.equal(local.privacy, "local");
  assert.equal(ProviderManifestSchema.safeParse(local).success, true, "a derived manifest still validates");
  const remote = defaultManifestFor({ id: "acme", capabilities: ["summarization"], privacy: "external" });
  assert.equal(remote.privacy, "external");
  assert.notEqual(remote.maxSensitivity, "secret",
    "a derived default is not the most permissive possible band");
});

// --- credentials --------------------------------------------------------------

test("V6-PB-014: a manifest carrying credential-shaped keys is rejected", () => {
  assert.throws(
    () => assertNoCredentials({ apiKey: "sk-abc123def456ghi789" } as never),
    /credential|api ?key|secret/i,
    "a credential in manifest-adjacent data is refused, not passed through",
  );
  // And the redactor removes it rather than leaking it into a log line.
  // redactManifest returns the (redacted) value, not a string.
  const redacted = redactManifest({ note: "key sk-abc123def456ghi789" });
  assert.equal(String(redacted.note).includes("sk-abc123"), false, "the credential is gone");
  assert.match(String(redacted.note), /REDACTED/);
});

test("V6-PB-015: redactManifest leaves a legitimate manifest untouched", () => {
  const manifest = validManifest();
  const redacted = redactManifest(manifest);
  assert.equal(redacted.id, manifest.id);
  assert.equal(redacted.maxSensitivity, manifest.maxSensitivity);
  assert.equal(redacted.regions.length, 1);
});

// --- registry integration -----------------------------------------------------

test("V6-PB-016: the service's providers have manifests derived from their wiring", () => {
  // The end-to-end property: a provider the service actually uses has a manifest, so a
  // caller can ask the transmission question without configuring anything separately.
  const registry: ProviderRegistry = buildProviderRegistry({
    embeddingAdapter: { id: "local-embed" },
    embeddingName: "local-embed",
    llmAdapter: { id: "local-llm" },
    llmName: "local-llm",
  });
  const declared = registry.metadataFor("embedding")!.privacy;
  assert.equal(declared, "local", "an injected adapter is local, so the seed can declare that");
  const manifest = defaultManifestFor({
    id: "local-embed",
    capabilities: ["embedding"],
    privacy: declared as "local" | "external",
  });
  assert.equal(ProviderManifestSchema.safeParse(manifest).success, true);
  assert.equal(mayReceive(manifest, "secret"), true,
    "a local provider may see anything: it never leaves the host");
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Five of twenty-two SURVIVED, and they share two
// causes: an unknown band was never exercised (B3/B4), and the schema tests checked
// that axes were PRESENT without checking what VALUES they accept (B16/B17/B20).
// ---------------------------------------------------------------------------

test("V6-PB-017: an unrecognised band is treated as the most sensitive", () => {
  // B3 survived: every fixture passed a declared band, so `bandIndex` returning -1 was
  // never observed. An unknown band reading as `public` (index 0) would be the most
  // dangerous possible failure here -- content at an unrecognised sensitivity would be
  // sent to every provider.
  const manifest = validManifest({ maxSensitivity: "secret" });
  for (const unknown of ["", "top-secret", "PUBLIC", "3", "confidential "] as unknown as Sensitivity[]) {
    const r = evaluateTransmission({
      manifest, sensitivity: unknown, tenantAllowsExternal: true, now: 1_000,
    });
    assert.equal(r.effect, "deny", `unknown band ${JSON.stringify(unknown)} must not be sent`);
  }
  // Even a permissive manifest refuses an unknown band: the ceiling cannot be compared,
  // so the conservative answer is the only safe one.
  const strict = validManifest({ maxSensitivity: "public" });
  assert.equal(
    evaluateTransmission({ manifest: strict, sensitivity: "nonsense" as never, tenantAllowsExternal: true, now: 0 }).effect,
    "deny",
  );
});

test("V6-PB-018: an unrecognised ceiling denies rather than allowing everything", () => {
  // B4 survived for the same reason. A ceiling the reader cannot understand must not be
  // read as "no ceiling" -- that would let any content through to a provider whose
  // actual limit nobody knows.
  const manifest = validManifest({ maxSensitivity: "not-a-band" as never });
  // The manifest schema refuses an undeclared band, so this reaches evaluateTransmission
  // only from a manifest built outside the schema -- which is precisely the case the
  // guard exists for.
  const r = evaluateTransmission({ manifest, sensitivity: "secret", tenantAllowsExternal: true, now: 0 });
  assert.equal(r.effect, "deny", "an unreadable ceiling denies");
  assert.equal(r.reason, "provider_sensitivity_ceiling");
});

test("V6-PB-019: the retention bounds are enforced, not merely declared", () => {
  // B16/B17 survived: the axis-presence tests only deleted `retention` wholesale, so
  // nothing constrained the values inside it.
  // A negative retention is nonsense and must be refused, as must one that would keep
  // content for a decade.
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ retention: { training: false, logDays: -1 } })).success, false,
    "a negative retention is refused");
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ retention: { training: false, logDays: 100_000 } })).success, false,
    "an unbounded retention is refused");
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ retention: { training: "yes" as never, logDays: 0 } })).success, false,
    "a non-boolean training consent is refused -- it must be an explicit decision");
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ retention: { logDays: 0 } as never })).success, false,
    "and the training consent cannot be omitted");
  // The boundaries themselves are valid.
  for (const days of [0, 1, 3650]) {
    assert.equal(ProviderManifestSchema.safeParse(validManifest({ retention: { training: true, logDays: days } })).success, true,
      `logDays=${days} is within bounds`);
  }
});

test("V6-PB-020: a derived manifest never assumes training consent or retention", () => {
  // B20 survived: the derived-defaults tests checked `maxSensitivity` but never the
  // retention axes. Assuming `training: true` would be assuming consent nobody gave.
  for (const privacy of ["local", "external"] as const) {
    const manifest = defaultManifestFor({ id: `p-${privacy}`, capabilities: ["summarization"], privacy });
    assert.equal(manifest.retention.training, false,
      `a derived ${privacy} manifest must not assume training consent`);
    assert.equal(manifest.retention.logDays, 0,
      `a derived ${privacy} manifest must not assume retention beyond the request`);

    // And the consequence is visible: no training warning on a normal allow.
    const r = evaluateTransmission({ manifest, sensitivity: "public", tenantAllowsExternal: true, now: 0 });
    assert.equal(r.effect, "allow");
    assert.equal(r.warnings, undefined, `no warnings on a derived ${privacy} manifest`);
  }
});

test("V6-PB-021: the bounds on every numeric axis are enforced", () => {
  // The same class as B16: presence without bounds. Each numeric axis is checked at
  // both ends.
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ cost: { perCall: -1 } })).success, false, "negative cost");
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ cost: { perCall: 10 ** 9 } })).success, false, "unbounded cost");
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ latency: { p95Ms: -5 } })).success, false, "negative latency");
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ latency: { p95Ms: 10 ** 9 } })).success, false, "unbounded latency");
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ latency: { p95Ms: 1.5 } })).success, false,
    "a fractional latency is not a millisecond count");
  // Regions are pattern-checked, so a typo cannot become a silent pass.
  assert.equal(ProviderManifestSchema.safeParse(validManifest({ regions: ["us-east-1"] })).success, true);
  for (const bad of ["useast1", "US-EAST-1", "us-east", "eu_west_1"]) {
    assert.equal(ProviderManifestSchema.safeParse(validManifest({ regions: [bad] })).success, false,
      `region ${bad} is refused`);
  }
});
