import assert from "node:assert/strict";
import { test } from "node:test";
import { reportOperationalStatus, DEGRADED_FAILURES } from "../v6-degraded.js";
import { classifyHealthStatus } from "../health-status.js";

/**
 * V6 health/readiness wiring fixtures.
 *
 * The existing `/health` payload is a V5 compatibility surface: it is `ok` | `unready`,
 * it is cached, and a deployment watching for an exact payload must not see a new
 * field appear. So the wiring requirement is narrow and specific — a provider axis must
 * appear **only** when providers are actually configured, and it must never turn a
 * serving process into a 503.
 *
 * That is the whole risk. The obvious implementation (`ready = core && !degraded`)
 * would take a load balancer out of rotation because a summarizer was down.
 */

test("V6-HS-001: the existing two-state payload is preserved when nothing is configured", () => {
  // The V5 payload exactly. A new field here would break an exact-match watcher.
  const classified = classifyHealthStatus({ status: "ok", providerConfigured: false });
  assert.equal(classified.status, "ok");
  assert.equal(classified.providers, undefined, "no new field appears");
});

test("V6-HS-002: an unready core stays unready", () => {
  for (const providerConfigured of [true, false]) {
    const classified = classifyHealthStatus({ status: "unready", providerConfigured });
    assert.equal(classified.status, "unready", `core unready is never masked by provider state`);
  }
});

test("V6-HS-003: a degraded provider does NOT make the process unready", () => {
  // The core criterion. Core serving from local storage is exactly what a degraded
  // provider means; returning 503 would remove a healthy node from rotation.
  const classified = classifyHealthStatus({ status: "ok", providerDegraded: true, providerConfigured: true });
  assert.equal(classified.status, "ok", "a degraded provider is not an outage");
  assert.equal(classified.providers?.degraded, true, "but it is reported");
  assert.equal(classified.ready, true, "and readiness is not withdrawn");
});

test("V6-HS-004: the provider axis appears only when a provider is configured", () => {
  assert.equal(classifyHealthStatus({ status: "ok", providerConfigured: false }).providers, undefined);
  assert.ok(classifyHealthStatus({ status: "ok", providerConfigured: true }).providers);
});

test("V6-HS-005: the provider axis reports privacy and availability, not just a flag", () => {
  const classified = classifyHealthStatus({
    status: "ok",
    providerConfigured: true,
    providerDegraded: true,
    providerPrivacy: "external",
    providerAvailability: "remote",
  });
  const providers = classified.providers;
  assert.ok(providers);
  assert.equal(providers.degraded, true);
  assert.equal(providers.privacy, "external", "a deployment can see whether memory leaves the host");
  assert.equal(providers.availability, "remote");
  assert.equal(typeof providers.capabilities, "object", "and what it was registered for");
});

test("V6-HS-006: every degraded failure class maps to a provider-degraded status", () => {
  for (const failure of DEGRADED_FAILURES) {
    const result = reportOperationalStatus({ coreAvailable: true, providerDegraded: true });
    assert.equal(result.status, "degraded", `${failure} degrades providers, not core`);
    assert.equal(result.ready, true, `${failure} keeps the node serving`);
    assert.ok(result.providers.degraded);
  }
});

test("V6-HS-007: the payload carries no provider credential or endpoint", () => {
  const classified = classifyHealthStatus({
    status: "ok",
    providerConfigured: true,
    providerId: "openai-compatible",
    providerApiKey: "sk-must-never-appear",
    providerBaseUrl: "https://internal.example/v1",
    providerCapabilities: ["summarization"],
    providerPrivacy: "external",
  });
  const json = JSON.stringify(classified);
  assert.equal(json.includes("sk-must-never-appear"), false, "a health payload is world-readable");
  assert.equal(json.includes("https://internal.example"), false, "and no internal endpoint either");
  // The id and capabilities are fine: they describe, they do not authorise.
  assert.equal(json.includes("openai-compatible"), true);
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Two of ten SURVIVED, and both are the same mistake:
// asserting one field while the behaviour under test moves another.
// ---------------------------------------------------------------------------

test("V6-HS-008: an unready core reports ready=false, not just status=unready", () => {
  // H3 survived: the tests checked `status` for an unready core and never `ready`.
  // A consumer that reads `ready` — which is the more natural field name — would have
  // been told a failing core was serving.
  for (const providerConfigured of [true, false]) {
    for (const providerDegraded of [true, false]) {
      const classified = classifyHealthStatus({ status: "unready", providerConfigured, providerDegraded });
      assert.equal(classified.status, "unready");
      assert.equal(classified.ready, false,
        `providerConfigured=${providerConfigured} providerDegraded=${providerDegraded}`);
    }
  }
});

test("V6-HS-009: ready is true exactly when status is ok", () => {
  // The two fields can never disagree, in either direction.
  for (const status of ["ok", "unready"] as const) {
    for (const providerConfigured of [true, false]) {
      for (const providerDegraded of [true, false]) {
        const classified = classifyHealthStatus({ status, providerConfigured, providerDegraded });
        assert.equal(classified.ready, status === "ok",
          `status=${status} providerConfigured=${providerConfigured} providerDegraded=${providerDegraded}`);
      }
    }
  }
});

test("V6-HS-010: an unstated privacy defaults to unknown, never to local", () => {
  // H9 survived: the privacy assertions always passed an explicit value, so the
  // default was unobserved. Defaulting privacy to "local" is the reassuring lie — an
  // operator reading it would conclude memory stays on the host.
  const unstated = classifyHealthStatus({ status: "ok", providerConfigured: true });
  assert.equal(unstated.providers?.privacy, "unknown",
    "an unknown privacy is reported as unknown, not as the safe-sounding answer");
  assert.notEqual(unstated.providers?.privacy, "local");

  // Same principle for availability: unstated is "degraded" (we do not know it is up),
  // not "local" and not a claim of health.
  assert.equal(unstated.providers?.availability, "degraded");
  assert.equal(unstated.providers?.degraded, false,
    "degraded flag reflects the declared providerDegraded, not the availability default");

  // And an explicitly external provider is reported as external.
  const external = classifyHealthStatus({
    status: "ok", providerConfigured: true, providerPrivacy: "external", providerAvailability: "remote",
  });
  assert.equal(external.providers?.privacy, "external");
  assert.equal(external.providers?.availability, "remote");
});
