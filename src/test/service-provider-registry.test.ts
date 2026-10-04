import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { ProviderRegistry, negotiateCapabilities } from "../v6-core-contract.js";
import { classifyHealthStatus } from "../health-status.js";
import type { ProviderMetadata } from "../v6-core-contract.js";
import type { EmbeddingAdapter, LlmAdapter } from "../provider-adapters.js";

/**
 * W-03 — the provider registry in the real service.
 *
 * Until now `ProviderRegistry` (T09) was a module nothing constructed. The service
 * resolved providers as bare strings:
 *
 *   this.embeddingName = embeddingAdapter?.id ?? emb;   // "none" | "openai" | ...
 *   this.llmName        = llmAdapter?.id ?? llm;
 *
 * A name carries no capability, no privacy class, and no cost — so nothing could ask
 * "may this provider receive confidential content?" before a call. T12 needs exactly
 * that, and it needs it derived from the providers actually in use rather than from a
 * second configuration that could disagree.
 *
 * The compatibility constraint is absolute: `providerHealth()` is a shipped endpoint,
 * so its existing fields must keep exactly their meaning and shape.
 */

interface MinimalAdapter {
  id: string;
  embed?(text: string, o?: { signal?: AbortSignal }): Promise<number[]>;
  complete?(prompt: string, o?: { signal?: AbortSignal }): Promise<string>;
  close?(): void | Promise<void>;
}

async function service(deps: Record<string, unknown> = {}): Promise<MemoryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-w03-"));
  const store = new MemoryStore(dir);
  return new MemoryService(store, deps as never);
}

const open: ProviderMetadata = {
  privacy: "external",
  cost: { perCall: 0 },
  latency: { p95Ms: 500 },
  availability: "remote",
};

// --- the service builds a registry --------------------------------------------

test("V6-W03-001: the service exposes a provider registry", async () => {
  const s = await service();
  try {
    assert.ok(s.providerRegistry, "the service owns a ProviderRegistry");
    assert.ok(s.providerRegistry instanceof ProviderRegistry, "and it is the T09 type, not a lookalike");
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

test("V6-W03-002: an injected embedding adapter is registered with a full manifest", async () => {
  // The whole point: the adapter the service is actually using appears in the
  // registry, carrying capability and privacy — not just its id.
  const adapter: MinimalAdapter = { id: "local-embed", embed: async () => [0.1, 0.2] };
  const s = await service({ embeddingAdapter: adapter as unknown as EmbeddingAdapter });
  try {
    assert.equal(s.providerRegistry.has("embedding"), true,
      "the injected adapter is registered, not just named");
    // `has` is per capability, so what matters is that the registry does not credit
    // the embedding adapter with summarization: the two are registered independently.
    const embeddingEntry = s.providerRegistry.describe().find((d) => d.capabilities.includes("embedding"));
    assert.ok(embeddingEntry, "the adapter is registered");
    assert.equal(
      embeddingEntry!.capabilities.some((c) => c === "summarization"),
      false,
      "an embedding adapter is not credited with summarization",
    );
    const meta = s.providerRegistry.metadataFor("embedding");
    assert.ok(meta, "metadata is available for the registered capability");
    assert.equal(meta!.privacy, "local",
      "an in-process adapter is local, and saying otherwise would misreport where content goes");
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

test("V6-W03-003: embeddings switched off registers no embedding capability", async () => {
  // Offline-first. `REMEMBRA_EMBEDDINGS=none` is the documented way to run with no
  // embedding provider, and the registry must agree with `providerHealth()`.
  //
  // Note this is about EMBEDDINGS specifically: `resolveLlmProvider()` defaults to
  // "openai", so a service with nothing configured still has a real LLM provider. My
  // first version of this test asserted the whole registry was empty, which was a
  // fiction about how the service resolves providers.
  const s = await service({ embeddingProvider: "none" as never });
  try {
    assert.equal(s.providerRegistry.has("embedding"), false, "no embedding capability is claimed");
    const n = negotiateCapabilities(s.providerRegistry, ["embedding"]);
    assert.deepEqual(n.unavailable, ["embedding"], "and the miss is named rather than silent");
    assert.equal(s.providerHealth().embeddingsAvailable, false, "V5 reports the same fact");
  } finally {
    // as above
  }
});

test("V6-W03-004: a core capability is never registered to a provider", async () => {
  const s = await service();
  try {
    for (const core of ["storage", "retrieval", "context", "policy", "lifecycle", "audit", "snapshot"]) {
      assert.equal(s.providerRegistry.has(core), false,
        `${core} is durable core and must never be delegable`);
    }
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

// --- the shipped payload is unchanged -----------------------------------------

test("V6-W03-005: providerHealth keeps its existing fields and meanings", async () => {
  // `/health/provider` is a shipped endpoint. Its shape must not gain or lose
  // anything, because a deployment watching for it must keep working.
  const s = await service();
  try {
    const health = s.providerHealth();
    assert.deepEqual(Object.keys(health).sort(), ["embeddings", "embeddingsAvailable", "llm", "optional", "status"],
      "the payload gained or lost a field");
    assert.equal(health.status, "ok");
    assert.equal(health.optional, true, "providers are still optional");
    assert.equal(typeof health.embeddings, "string");
    assert.equal(typeof health.llm, "string");
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

test("V6-W03-006: providerHealth and the registry agree about what is configured", async () => {
  // The reason the registry is derived from the service's own providers rather than a
  // second configuration: the two must not be able to disagree. A health endpoint
  // saying "embeddings disabled" while the registry advertises embedding is the exact
  // failure.
  const adapter: MinimalAdapter = { id: "local-embed", embed: async () => [0.1] };
  const withAdapter = await service({ embeddingAdapter: adapter as unknown as EmbeddingAdapter });
  try {
    assert.equal(withAdapter.providerHealth().embeddingsAvailable, true);
    assert.equal(withAdapter.providerRegistry.has("embedding"), true, "the two agree");
  } finally {
    // as above
  }

  const without = await service({ embeddingProvider: "none" as never });
  try {
    assert.equal(without.providerHealth().embeddingsAvailable, false);
    assert.equal(without.providerRegistry.has("embedding"), false, "and they still agree");
  } finally {
    // as above
  }
});

test("V6-W03-007: the registry adds no credential to anything the service reports", async () => {
  // The registry holds metadata; the payload holds names. Neither may carry a secret,
  // and the service must not start echoing adapter configuration.
  const adapter: MinimalAdapter = { id: "local-embed", embed: async () => [0.1] };
  const s = await service({
    embeddingAdapter: adapter as unknown as EmbeddingAdapter,
    llmAdapter: { id: "llm-x", apiKey: "sk-never-report", complete: async () => "" } as unknown as LlmAdapter,
  });
  try {
    const json = JSON.stringify({ health: s.providerHealth(), registry: s.providerRegistry.describe() });
    assert.equal(json.includes("sk-never-report"), false, "a credential is not reportable state");
    assert.ok(json.includes("local-embed"), "the descriptive id is fine");
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

// --- health integration -------------------------------------------------------

test("V6-W03-008: health classifies the provider axis only when a provider exists", async () => {
  // `/health` stays a two-state contract; the provider axis appears only when a
  // provider is actually configured, so a single-process deployment's payload does not
  // change shape.
  const none = classifyHealthStatus({ status: "ok", providerConfigured: false });
  assert.equal(none.providers, undefined);

  const adapter: MinimalAdapter = { id: "local-embed", embed: async () => [0.1] };
  const s = await service({ embeddingAdapter: adapter as unknown as EmbeddingAdapter });
  try {
    const classified = classifyHealthStatus({
      status: "ok",
      providerConfigured: true,
      providerDegraded: false,
      providerPrivacy: "local",
      providerAvailability: "local",
      providerCapabilities: ["embedding"],
    });
    assert.ok(classified.providers, "the axis appears when a provider is configured");
    assert.equal(classified.providers.privacy, "local");
    assert.equal(classified.status, "ok", "and readiness is untouched");
    assert.equal(s.providerRegistry.has("embedding"), true);
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

test("V6-W03-009: a remote provider reports as external, never as local", async () => {
  // The privacy axis is what an operator reads to learn whether content leaves the
  // host. Defaulting it to `local` would be the reassuring lie, so a remote provider
  // must be visible as external.
  const s = await service();
  try {
    const registered: ProviderMetadata[] = [];
    for (const capability of ["embedding", "summarization"] as const) {
      s.providerRegistry.register({
        id: `remote-${capability}`,
        capabilities: [capability],
        metadata: open,
        invoke: async () => ({}),
      });
    }
    registered.push(s.providerRegistry.metadataFor("embedding")!);
    for (const meta of registered) {
      assert.equal(meta.privacy, "external", "a remote provider is external");
      assert.notEqual(meta.privacy, "local");
    }
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

test("V6-W03-010: core behaviour is unchanged with the registry present", async () => {
  // The registry must be inert with respect to the core journey. If adding it changed
  // what a store does, this is the test that says so.
  const s = await service();
  try {
    const m = await s.store({ type: "fact", content: "w03 ordinary fact" } as never);
    assert.ok(m.id, "store works");
    const got = await s.get(m.id);
    assert.equal(got?.memory.content, "w03 ordinary fact", "read works");
    const health = await s.health();
    assert.equal(health.status, "ok", "health is still ok");
  } finally {
    // MemoryService has no close(); the store owns the handle and the temp dir is
    // left to the OS temp cleaner, as the other service tests do.
  }
});

// ---------------------------------------------------------------------------
// Added after the first full-suite run. Two unrelated tests (STRESS-006, the
// maintain backfill) failed with "provider openai is already registered" -- neither
// touches the registry, but the default configuration resolves BOTH embeddings and
// the LLM to "openai", and the builder registered that id twice.
// ---------------------------------------------------------------------------

test("V6-W03-011: one provider serving two capabilities registers once", async () => {
  // The default configuration. A provider id that supplies both embedding and
  // summarization must appear once carrying both, because registering it twice throws
  // by design -- a shadowed provider makes negotiation unpredictable.
  const s = await service();
  try {
    const described = s.providerRegistry.describe();
    const ids = described.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length, `no duplicate provider ids: ${ids.join(", ")}`);

    // And if the same id really does serve both, it declares both.
    for (const entry of described) {
      const caps = entry.capabilities;
      assert.ok(caps.length >= 1, `${entry.id} declares at least one capability`);
      // Capabilities are unique per entry -- a duplicate would be a merge bug.
      assert.equal(new Set(caps).size, caps.length, `${entry.id} has no duplicate capabilities`);
    }
    // The registry is usable: negotiation resolves rather than throwing.
    const n = negotiateCapabilities(s.providerRegistry, ["embedding", "summarization"]);
    assert.ok(n.available.length >= 1, "at least one capability resolves on the default configuration");
  } finally {
    // as above
  }
});

test("V6-W03-012: a local adapter takes precedence over a remote name for the same id", async () => {
  // If one path to a provider is in-process, content may not leave the host for it. The
  // conservative reading wins, because an operator reading `external` learns nothing
  // and reading `local` when it is external is the lie that matters.
  const s = await service({
    embeddingAdapter: { id: "shared", embed: async () => [0.1] } as never,
    llmAdapter: { id: "shared", complete: async () => "" } as never,
  });
  try {
    const entry = s.providerRegistry.describe().find((d) => d.id === "shared");
    assert.ok(entry, "registered once");
    assert.equal(entry!.capabilities.includes("embedding"), true);
    assert.equal(entry!.capabilities.includes("summarization"), true);
    assert.equal(entry!.metadata.privacy, "local", "an in-process path makes the provider local");
  } finally {
    // as above
  }
});

// ---------------------------------------------------------------------------
// Added after mutation testing. Two of thirteen SURVIVED: the duplicate-id guard
// and describe()'s projection were only tested inside T09's own file, never through
// the service. A registry reachable from production code needs those properties
// checked where production code can reach them.
// ---------------------------------------------------------------------------

test("V6-W03-013: the service's registry still refuses a duplicate provider id", async () => {
  // R11 survived. Registering the same id twice on the SERVICE's registry must throw,
  // because a shadowed provider makes negotiation unpredictable -- and T12 will make
  // policy decisions from whatever this registry holds.
  const s = await service();
  try {
    const registration = {
      capabilities: ["embedding"] as const,
      metadata: { privacy: "local" as const, cost: { perCall: 0 }, latency: { p95Ms: 1 }, availability: "local" as const },
      invoke: async () => ({}),
    };
    const firstId = s.providerRegistry.describe()[0]?.id;
    assert.ok(firstId, "something is registered to collide with");
    assert.throws(
      () => s.providerRegistry.register({ ...registration, id: firstId }),
      /already registered|duplicate|shadow/i,
      "a shadowed provider must be refused on the service's registry too",
    );
  } finally {
    // as above
  }
});

test("V6-W03-014: describe() exposes only ids, capabilities and metadata", async () => {
  // R12 survived: returning the raw provider objects would hand a caller the adapter's
  // own shape, which is a place a credential or a base URL could hide.
  const s = await service({
    llmAdapter: { id: "llm-local", apiKey: "sk-must-not-appear", baseUrl: "https://internal.example", complete: async () => "" } as never,
  });
  try {
    for (const entry of s.providerRegistry.describe()) {
      assert.deepEqual(Object.keys(entry).sort(), ["capabilities", "id", "metadata"],
        `describe() exposes exactly three fields, got ${Object.keys(entry).join(",")}`);
      assert.deepEqual(Object.keys(entry.metadata).sort(), ["availability", "cost", "latency", "privacy"],
        "and metadata exposes exactly its four declared axes");
    }
    // An `invoke` function must never be reachable from the report.
    for (const entry of s.providerRegistry.describe()) {
      assert.equal("invoke" in entry, false, "the invoke implementation is not reportable state");
    }
    const json = JSON.stringify(s.providerRegistry.describe());
    assert.equal(json.includes("sk-must-not-appear"), false, "no credential in the report");
    assert.equal(json.includes("internal.example"), false, "and no internal endpoint");
  } finally {
    // as above
  }
});
