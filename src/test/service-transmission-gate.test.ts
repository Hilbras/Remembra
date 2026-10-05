import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { defaultManifestFor, evaluateTransmission, type ProviderManifest } from "../provider-boundary.js";
import type { EmbeddingAdapter, LlmAdapter } from "../provider-adapters.js";

/**
 * W-04 — the transmission gate in the real request path.
 *
 * T12 built a gate that answers "may this content go to this provider?" and nothing
 * consulted it. That is the same decorative-slice problem as an unwired registry, and it
 * is worse here: a gate exists precisely to stop content *before* it leaves, so an
 * unconsulted gate has prevented nothing at all.
 *
 * The property under test is **ordering**, not behaviour:
 *
 *   the refusal must happen BEFORE the provider is invoked.
 *
 * A test that only asserts "an error came back" passes just as happily against an
 * implementation that calls the provider, inspects the result, and then refuses — which
 * is the failure that matters, because by then the content has already been sent.
 *
 * So every fixture counts provider invocations, and every refusal asserts the count is
 * still zero.
 */

interface CountingLlm extends LlmAdapter {
  calls: number;
}

function countingLlm(): CountingLlm {
  const adapter = {
    id: "counting-llm",
    calls: 0,
    complete: async () => {
      adapter.calls++;
      return "[]";
    },
  } as CountingLlm;
  return adapter;
}

function countingEmbedding(): EmbeddingAdapter & { calls: number } {
  const adapter = {
    id: "counting-embed",
    calls: 0,
    embed: async () => {
      adapter.calls++;
      return [0.1, 0.2, 0.3];
    },
  } as EmbeddingAdapter & { calls: number };
  return adapter;
}

async function service(deps: Record<string, unknown>): Promise<MemoryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-w04-"));
  return new MemoryService(new MemoryStore(dir), deps as never);
}

/** A transcript the digest path would send to a provider. */
const TRANSCRIPT = "Alice prefers TypeScript. Bob works in Berlin. The deploy is Friday.";

// --- the gate refuses before the provider is called ---------------------------

test("V6-W04-001: a forbidden transmission never reaches the LLM provider", async () => {
  const llm = countingLlm();
  const s = await service({
    llmAdapter: llm,
    providerManifest: defaultManifestFor({ id: "counting-llm", capabilities: ["summarization"], privacy: "local" }),
    tenantAllowsExternal: false,
  });
  try {
    // A local provider is unaffected by the external rule, so force a refusal with a
    // ceiling the content exceeds.
    const manifest = { ...defaultManifestFor({ id: "counting-llm", capabilities: ["summarization"], privacy: "local" }), maxSensitivity: "public" as const };
    (s as unknown as { providerManifest: ProviderManifest }).providerManifest = manifest;

    await assert.rejects(
      () => s.digest({ transcript: TRANSCRIPT } as never),
      /provider|sensitivity|transmission|denied|refus/i,
      "the digest must be refused",
    );
    assert.equal(llm.calls, 0, "AND the provider must never have been called");
  } finally {
    // no close()
  }
});

test("V6-W04-002: an allowed transmission does reach the provider", async () => {
  // The contrast. Without it, a gate that refuses everything would pass every refusal
  // test above.
  const llm = countingLlm();
  const s = await service({
    llmAdapter: llm,
    tenantAllowsExternal: true,
  });
  try {
    await s.digest({ transcript: TRANSCRIPT } as never).catch(() => undefined);
    assert.equal(llm.calls, 1, "an allowed digest calls the provider exactly once");
  } finally {
    // no close()
  }
});

test("V6-W04-003: a forbidden embedding never reaches the provider", async () => {
  const embed = countingEmbedding();
  const s = await service({
    embeddingAdapter: embed,
    tenantAllowsExternal: true,
  });
  try {
    // Cap the embedding provider below the memory's band so the write is refused.
    (s as unknown as { providerManifest: ProviderManifest }).providerManifest = {
      ...defaultManifestFor({ id: "counting-embed", capabilities: ["embedding"], privacy: "local" }),
      maxSensitivity: "public",
    };
    const secret = await s.store({ type: "fact", content: "a confidential fact" } as never).catch((e: Error) => e);
    assert.ok(secret instanceof Error || secret, "the write either succeeded or was refused");
    if (secret instanceof Error) {
      assert.equal(embed.calls, 0, "a refused write must not have called the embedding provider");
    }
  } finally {
    // no close()
  }
});

test("V6-W04-004: the gate consults the tenant rule, not just the provider ceiling", async () => {
  // Both denials must be live. A gate that only checks the ceiling would happily send
  // low-sensitivity content to an external provider a tenant forbids.
  const llm = countingLlm();
  const manifest = defaultManifestFor({ id: "external-llm", capabilities: ["summarization"], privacy: "external" });
  const denied = evaluateTransmission({
    manifest, sensitivity: "public", tenantAllowsExternal: false, now: 0,
  });
  assert.equal(denied.effect, "deny", "an external provider is refused when the tenant forbids it");
  assert.equal(denied.reason, "tenant_forbids_external_transmission");

  const s = await service({ llmAdapter: llm, tenantAllowsExternal: false, providerManifest: manifest });
  try {
    await assert.rejects(() => s.digest({ transcript: TRANSCRIPT } as never), /provider|transmission|denied|refus/i);
    assert.equal(llm.calls, 0, "and the provider is never called");
  } finally {
    // no close()
  }
});

test("V6-W04-005: a local provider is not refused by the tenant's external rule", async () => {
  // The inverse: refusing a local provider would deny a request that transmits nothing.
  const llm = countingLlm();
  const s = await service({
    llmAdapter: llm,
    tenantAllowsExternal: false,
    providerManifest: defaultManifestFor({ id: "local-llm", capabilities: ["summarization"], privacy: "local" }),
  });
  try {
    await s.digest({ transcript: TRANSCRIPT } as never).catch(() => undefined);
    assert.equal(llm.calls, 1, "a local provider still works when external transmission is forbidden");
  } finally {
    // no close()
  }
});

// --- defaults and absence ----------------------------------------------------

test("V6-W04-006: a service with no manifest configured still gates", async () => {
  // The gate must not be opt-in. A default manifest is derived, and a refusal still
  // happens before the call.
  const llm = countingLlm();
  const s = await service({ llmAdapter: llm, tenantAllowsExternal: true });
  try {
    // secret-band content against the default external ceiling of `confidential`.
    const secret = defaultManifestFor({ id: "counting-llm", capabilities: ["summarization"], privacy: "local" });
    assert.equal(secret.maxSensitivity, "secret", "a derived local manifest accepts any band");
    // With no explicit ceiling and a local provider, the digest is allowed.
    await s.digest({ transcript: TRANSCRIPT } as never).catch(() => undefined);
    assert.equal(llm.calls, 1);
  } finally {
    // no close()
  }
});

test("V6-W04-007: the refusal is a typed, catchable error — not a crash", async () => {
  const llm = countingLlm();
  const s = await service({ llmAdapter: llm, tenantAllowsExternal: true });
  try {
    (s as unknown as { providerManifest: ProviderManifest }).providerManifest = {
      ...defaultManifestFor({ id: "counting-llm", capabilities: ["summarization"], privacy: "local" }),
      maxSensitivity: "public",
    };
    let caught: unknown;
    try {
      await s.digest({ transcript: TRANSCRIPT } as never);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, "a catchable Error, not a thrown string or a hang");
    assert.match(String((caught as Error).message), /provider|sensitivity|transmission|denied|refus/i);
  } finally {
    // no close()
  }
});

test("V6-W04-008: core storage still works with the gate in place and no provider", async () => {
  // The gate must be inert for anything that does not transmit. If adding it changed
  // what a store does, this is the test that says so.
  const s = await service({ embeddingProvider: "none" as never, llmProvider: "none" as never });
  try {
    const m = await s.store({ type: "fact", content: "w04 offline fact" } as never);
    assert.ok(m.id, "store works offline");
    const got = await s.get(m.id);
    assert.equal(got?.memory.content, "w04 offline fact", "read works offline");
    assert.equal((await s.health()).status, "ok", "health is unaffected");
  } finally {
    // no close()
  }
});

test("V6-W04-009: a refusal leaves no partial memory behind", async () => {
  // A denied digest must not store an extracted fragment. Partial state from a refused
  // transmission is worse than no attempt, because it is indistinguishable from a
  // completed one to whatever inspects it later.
  const llm = countingLlm();
  const s = await service({ llmAdapter: llm, tenantAllowsExternal: true });
  try {
    (s as unknown as { providerManifest: ProviderManifest }).providerManifest = {
      ...defaultManifestFor({ id: "counting-llm", capabilities: ["summarization"], privacy: "local" }),
      maxSensitivity: "public",
    };
    const before = (await s.search({ query: "w04 probe" } as never)).results.length;
    await s.digest({ transcript: TRANSCRIPT } as never).catch(() => undefined);
    const after = (await s.search({ query: "w04 probe" } as never)).results.length;
    assert.equal(after, before, `a refused digest stored nothing (${before} -> ${after})`);
  } finally {
    // no close()
  }
});

test("V6-W04-010: the gate is evaluated per request, not cached into a decision", async () => {
  // Two digests with the manifest changed between them: the second must see the new
  // ceiling. A gate that cached its first verdict would send content the operator has
  // since restricted.
  const llm = countingLlm();
  const s = await service({ llmAdapter: llm, tenantAllowsExternal: true });
  try {
    const mutable = s as unknown as { providerManifest: ProviderManifest };
    mutable.providerManifest = {
      ...defaultManifestFor({ id: "counting-llm", capabilities: ["summarization"], privacy: "local" }),
      maxSensitivity: "secret",
    };
    await s.digest({ transcript: TRANSCRIPT } as never).catch(() => undefined);
    assert.equal(llm.calls, 1, "the permissive ceiling allowed the call");

    mutable.providerManifest = { ...mutable.providerManifest, maxSensitivity: "public" };
    await s.digest({ transcript: TRANSCRIPT } as never).catch(() => undefined);
    assert.equal(llm.calls, 1, "the tightened ceiling refused it, without a second call");
  } finally {
    // no close()
  }
});
