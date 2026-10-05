import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { defaultManifestFor, type ProviderManifest } from "../provider-boundary.js";
import type { EmbeddingAdapter } from "../provider-adapters.js";

/**
 * W-05 — the transmission gate on the embedding path.
 *
 * Seven call sites reach an embedding provider, and every one of them goes through
 * `maybeEmbed`, which is **deliberately fail-open**: it swallows an error, logs a
 * warning, and returns `undefined` so a store still succeeds without a vector.
 *
 * That is right for a *provider failure* and wrong for a *policy refusal*, and the
 * distinction is the whole task:
 *
 *   - Provider down → degrade. Keyword fallback still answers. No data left the host,
 *     because nothing was sent.
 *   - Policy forbids → refuse. Silently skipping the embedding would store the memory
 *     with no vector and report success, so the caller believes content was sent to a
 *     policy-approved provider when in fact it was not, and the memory is invisible to
 *     semantic search for a reason nobody was told about.
 *
 * So a refusal must PROPAGATE out of `maybeEmbed` rather than being absorbed. The
 * fixtures below count provider calls and assert the store outcome for each case.
 */

function countingEmbedding(id = "counting-embed"): EmbeddingAdapter & { calls: number } {
  const adapter = {
    id,
    calls: 0,
    embed: async () => {
      adapter.calls++;
      return [0.1, 0.2, 0.3];
    },
  } as EmbeddingAdapter & { calls: number };
  return adapter;
}

async function service(deps: Record<string, unknown>): Promise<MemoryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-w05-"));
  return new MemoryService(new MemoryStore(dir), deps as never);
}

const setManifest = (s: MemoryService, over: Partial<ProviderManifest>): void => {
  (s as unknown as { providerManifest: ProviderManifest }).providerManifest = {
    ...defaultManifestFor({ id: "embed", capabilities: ["embedding"], privacy: "local" }),
    ...over,
  };
};

// --- a refusal refuses; it does not degrade -----------------------------------

test("V6-W05-001: a forbidden embedding never reaches the provider", async () => {
  const embed = countingEmbedding();
  const s = await service({ embeddingAdapter: embed, tenantAllowsExternal: true });
  try {
    // Ceiling of `public`, so an `internal`-band write is refused.
    setManifest(s, { maxSensitivity: "public" });
    await assert.rejects(
      () => s.store({ type: "fact", content: "an internal fact" } as never),
      /provider|sensitivity|transmission|denied|refus/i,
      "the store must be refused, not silently degraded",
    );
    assert.equal(embed.calls, 0, "and the provider must never have been called");
  } finally {
    // no close()
  }
});

test("V6-W05-002: a refused store writes nothing", async () => {
  // The consequence that matters: a degraded store would return success and leave a
  // memory with no vector, indistinguishable from one that was never sent.
  const embed = countingEmbedding();
  const s = await service({ embeddingAdapter: embed, tenantAllowsExternal: true });
  try {
    setManifest(s, { maxSensitivity: "public" });
    // The gate sits BEFORE the write, so a refusal throws and the memory is never
    // created. My first version used `.catch(() => undefined)` and asserted on the
    // search, which reported the gate's own error as the failure -- the assertion never
    // ran.
    await assert.rejects(() => s.store({ type: "fact", content: "w05 refused fact" } as never));
    // Use `list`, not `search`: search embeds the QUERY through the same gate, so my
    // first version failed on the gate rather than on the count it meant to check.
    const page = await s.list({ limit: 100 } as never);
    const memories = (page as unknown as { memories?: unknown[] }).memories ?? [];
    assert.equal(memories.length, 0, "a refused store left nothing behind");
  } finally {
    // no close()
  }
});

test("V6-W05-003: an allowed embedding still happens", async () => {
  const embed = countingEmbedding();
  const s = await service({ embeddingAdapter: embed, tenantAllowsExternal: true });
  try {
    // A derived local manifest accepts any band, so nothing is refused.
    await s.store({ type: "fact", content: "w05 allowed fact" } as never);
    assert.equal(embed.calls, 1, "an allowed store calls the provider exactly once");
  } finally {
    // no close()
  }
});

test("V6-W05-004: the tenant's external rule gates embedding too", async () => {
  const embed = countingEmbedding();
  const manifest = defaultManifestFor({ id: "remote-embed", capabilities: ["embedding"], privacy: "external" });
  const s = await service({
    embeddingAdapter: embed,
    providerManifest: manifest,
    tenantAllowsExternal: false,
  });
  try {
    await assert.rejects(
      () => s.store({ type: "fact", content: "w05 external rule" } as never),
      /provider|transmission|denied|refus/i,
    );
    assert.equal(embed.calls, 0, "an external provider is refused when the tenant forbids it");
  } finally {
    // no close()
  }
});

// --- a provider failure still degrades ---------------------------------------

test("V6-W05-005: a provider FAILURE still degrades rather than refusing", async () => {
  // The distinction the whole task turns on. A provider that is down has sent nothing,
  // so keyword fallback is correct and the store should succeed.
  const embed = {
    id: "broken-embed",
    calls: 0,
    embed: async () => {
      embed.calls++;
      throw new Error("502 upstream unavailable");
    },
  } as unknown as EmbeddingAdapter & { calls: number };
  const s = await service({ embeddingAdapter: embed, tenantAllowsExternal: true });
  try {
    const m = await s.store({ type: "fact", content: "w05 degraded fact" } as never);
    assert.ok(m.id, "the store succeeds despite the provider being down");
    assert.equal(embed.calls, 1, "the provider was tried");
    assert.equal(m.memory?.embedding ?? (m as unknown as { embedding?: number[] }).embedding, undefined,
      "and no vector was stored");
  } finally {
    // no close()
  }
});

test("V6-W05-006: a refusal is distinguishable from a provider failure", async () => {
  // Both involve an absent vector, but only one is a policy decision. A caller must be
  // able to tell them apart, so the refusal surfaces and the failure does not.
  const failing = { id: "f", embed: async () => { throw new Error("down"); } } as unknown as EmbeddingAdapter;
  const degradeService = await service({ embeddingAdapter: failing, tenantAllowsExternal: true });
  let degradeError: unknown;
  try {
    await degradeService.store({ type: "fact", content: "w05 distinguish" } as never);
  } catch (error) {
    degradeError = error;
  }
  assert.equal(degradeError, undefined, "a provider failure does NOT refuse the store");

  const embed = countingEmbedding();
  const refuseService = await service({ embeddingAdapter: embed, tenantAllowsExternal: true });
  setManifest(refuseService, { maxSensitivity: "public" });
  let refuseError: unknown;
  try {
    await refuseService.store({ type: "fact", content: "w05 distinguish" } as never);
  } catch (error) {
    refuseError = error;
  }
  assert.ok(refuseError instanceof Error, "a policy refusal DOES");
});

// --- the gate is per-request and inert without a provider --------------------

test("V6-W05-007: a tightened ceiling takes effect on the next store", async () => {
  const embed = countingEmbedding();
  const s = await service({ embeddingAdapter: embed, tenantAllowsExternal: true });
  try {
    setManifest(s, { maxSensitivity: "secret" });
    await s.store({ type: "fact", content: "w05 first" } as never);
    assert.equal(embed.calls, 1, "the permissive ceiling allowed the first store");

    setManifest(s, { maxSensitivity: "public" });
    await assert.rejects(() => s.store({ type: "fact", content: "w05 second" } as never));
    assert.equal(embed.calls, 1, "and the tightened ceiling refused the second without a call");
  } finally {
    // no close()
  }
});

test("V6-W05-008: with no embedding provider the gate is inert", async () => {
  // The gate must not change behaviour for an installation with embeddings off, which
  // is the default and the offline deployment.
  const s = await service({ embeddingProvider: "none" as never, llmProvider: "none" as never });
  try {
    setManifest(s, { maxSensitivity: "public" });
    const m = await s.store({ type: "fact", content: "w05 offline fact" } as never);
    assert.ok(m.id, "a store with no embedding provider succeeds regardless of the ceiling");
    const got = await s.get(m.id);
    assert.equal(got?.memory.content, "w05 offline fact");
    assert.equal((await s.health()).status, "ok");
  } finally {
    // no close()
  }
});

test("V6-W05-009: a local embedding provider is exempt from the external rule", async () => {
  const embed = countingEmbedding();
  const s = await service({
    embeddingAdapter: embed,
    tenantAllowsExternal: false,
    providerManifest: defaultManifestFor({ id: "local-embed", capabilities: ["embedding"], privacy: "local" }),
  });
  try {
    await s.store({ type: "fact", content: "w05 local exempt" } as never);
    assert.equal(embed.calls, 1, "a local provider transmits nothing, so the rule does not apply");
  } finally {
    // no close()
  }
});

test("V6-W05-010: an external manifest still gates a local adapter by ceiling", async () => {
  // The two axes are independent: a local adapter is exempt from the *external* rule
  // but not from the provider's own sensitivity ceiling.
  const embed = countingEmbedding();
  const s = await service({
    embeddingAdapter: embed,
    tenantAllowsExternal: false,
    providerManifest: {
      ...defaultManifestFor({ id: "mixed", capabilities: ["embedding"], privacy: "local" }),
      maxSensitivity: "public",
    },
  });
  try {
    await assert.rejects(() => s.store({ type: "fact", content: "w05 ceiling only" } as never));
    assert.equal(embed.calls, 0, "the ceiling still applies to a local provider");
  } finally {
    // no close()
  }
});
