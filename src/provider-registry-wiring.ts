/**
 * W-03 — derive a V6 `ProviderRegistry` from the providers a service actually resolved.
 *
 * The service already knows which providers it has; it recorded them as bare names.
 * This turns those names plus the adapter objects into a registry carrying capability
 * and **data-handling metadata**, so a later caller can ask "may this provider receive
 * confidential content?" before any network work begins (T12).
 *
 * Two decisions worth stating:
 *
 *  - **Privacy is derived from how the provider is constructed, not from its name.** An
 *    injected adapter is in-process and therefore `local`; a name resolved from the
 *    environment is a network provider and therefore `external`. Defaulting either way
 *    would be the reassuring lie — an operator reading `local` concludes content stays
 *    on the host.
 *  - **A provider that is switched off is not registered at all.** `embeddings: "none"`
 *    means no embedding capability exists, and an entry claiming otherwise would make
 *    `/health/provider` and the registry disagree.
 *
 * Nothing here performs I/O, throws, or affects core behaviour: the registry is
 * descriptive, and the existing `providerHealth()` payload is untouched.
 */
import { ProviderRegistry, type ProviderMetadata } from "./v6-core-contract.js";

/** The adapter shapes, structurally — importing the real types would be circular. */
interface AdapterLike {
  readonly id?: string;
}

export interface ProviderWiringInput {
  readonly embeddingAdapter?: AdapterLike;
  readonly embeddingName: string;
  readonly llmAdapter?: AdapterLike;
  readonly llmName: string;
}

/**
 * `true` when the name denotes a provider that is actually switched off, rather than
 * one that is configured. Only "none" means off; every other name is a real provider,
 * including an unrecognised one (which is a configuration error, not an absence).
 */
function isDisabled(name: string): boolean {
  return name.trim().toLowerCase() === "none" || name.trim() === "";
}

const metadataFor = (privacy: ProviderMetadata["privacy"], availability: ProviderMetadata["availability"]): ProviderMetadata => ({
  privacy,
  cost: { perCall: 0 },
  latency: { p95Ms: privacy === "local" ? 1 : 500 },
  availability,
});

/**
 * Build the registry. Always returns a registry — an empty one when nothing is
 * configured, which is the supported offline deployment rather than an error.
 *
 * **One provider may supply several capabilities.** The default configuration has
 * embeddings and the LLM both resolving to "openai", and registering that id twice
 * throws by design (a shadowed provider makes negotiation unpredictable). So entries
 * are accumulated by id first and registered once, with every capability the provider
 * actually serves. My first version registered per capability and broke service
 * construction on the default configuration — caught by STRESS-006 and the maintain
 * backfill test, neither of which touches the registry directly.
 */
export function buildProviderRegistry(input: ProviderWiringInput): ProviderRegistry {
  interface Pending {
    id: string;
    capabilities: string[];
    privacy: ProviderMetadata["privacy"];
    availability: ProviderMetadata["availability"];
  }
  const byId = new Map<string, Pending>();

  const add = (id: string, capability: string, privacy: Pending["privacy"], availability: Pending["availability"]): void => {
    const existing = byId.get(id);
    if (existing) {
      // One provider, several capabilities: merge rather than re-register.
      if (!existing.capabilities.includes(capability)) existing.capabilities.push(capability);
      // Local wins over external. If any path to this provider is in-process, content
      // may not leave the host for that capability, and the more conservative reading
      // is the honest one.
      if (privacy === "local") existing.privacy = "local";
      return;
    }
    byId.set(id, { id, capabilities: [capability], privacy, availability });
  };

  // An injected adapter runs in-process, so content does not leave the host. A name
  // resolved from the environment is a network provider.
  if (input.embeddingAdapter) {
    add(input.embeddingAdapter.id ?? input.embeddingName, "embedding", "local", "local");
  } else if (!isDisabled(input.embeddingName)) {
    add(input.embeddingName, "embedding", "external", "remote");
  }

  if (input.llmAdapter) {
    add(input.llmAdapter.id ?? input.llmName, "summarization", "local", "local");
  } else if (!isDisabled(input.llmName)) {
    add(input.llmName, "summarization", "external", "remote");
  }

  const registry = new ProviderRegistry();
  for (const entry of byId.values()) {
    registry.register({
      id: entry.id,
      capabilities: entry.capabilities as never,
      metadata: metadataFor(entry.privacy, entry.availability),
      invoke: async () => ({}),
    });
  }
  return registry;
}
