/**
 * V6 core capability contracts (V6-T09).
 *
 * Separates *durable* core operations from *optional intelligence* capabilities.
 *
 * The premise of this codebase is offline-first, so provider absence is a supported
 * runtime state and not a startup error: durable memory keeps working, degrading to
 * lexical retrieval, with no provider configured at all. Anything that cannot work
 * without one is optional intelligence by definition, and belongs behind
 * `ProviderRegistry` rather than in a core interface.
 *
 * The other load-bearing property: **a provider cannot widen authorization.**
 * Providers return data. The instant a provider result is allowed to carry a
 * principal, a capability or a policy decision, a remote service can escalate by
 * returning a richer object than the contract declares. So the boundary is a
 * projection, not a pass-through — see `invokeCapability`, which copies the declared
 * payload out of whatever the provider returned and discards the rest.
 *
 * Note what is deliberately absent: any provider SDK, and any vendor name. Core
 * compiles with zero optional dependencies, and a test enforces that rather than
 * trusting a document.
 */
import { z } from "zod";
import { RemembraError } from "./errors.js";

/** The contract is versioned, so a caller can refuse an unknown shape. */
export const CORE_CONTRACT_VERSION = "6.0.0" as const;

/**
 * Durable core capabilities.
 *
 * Everything here must work with no provider present. `storage` is therefore not
 * delegable: a remote service cannot be the durable substrate, and a provider
 * claiming to supply it is a misregistration (see V6-CC-014).
 */
export const CORE_CAPABILITIES = [
  "storage",
  "retrieval",
  "context",
  "policy",
  "lifecycle",
  "audit",
  "snapshot",
] as const;
export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

export function isCoreCapability(value: unknown): value is CoreCapability {
  return typeof value === "string" && (CORE_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Optional intelligence capabilities — the things a provider may supply.
 *
 * A closed list rather than `string`, because "anything the caller names" is how a
 * boundary quietly becomes dynamic.
 */
export const OPTIONAL_CAPABILITIES = ["summarization", "embedding", "reranking", "extraction"] as const;
export type OptionalCapability = (typeof OPTIONAL_CAPABILITIES)[number];

export type AnyCapability = CoreCapability | OptionalCapability;

/**
 * Provider metadata: privacy, cost, latency, availability.
 *
 * Every axis is **required**, not optional. A provider with unknown cost or unknown
 * privacy cannot be negotiated safely — the entire point of declaring these is to
 * choose under constraint, and an absent axis is a constraint nobody chose.
 *
 * Bounds are enforced too. An unbounded latency claim is not a latency claim.
 */
export const ProviderMetadataSchema = z
  .object({
    privacy: z.enum(["local", "external", "unknown"]),
    cost: z.object({ perCall: z.number().min(0).max(1_000_000) }),
    latency: z.object({ p95Ms: z.number().int().min(0).max(3_600_000) }),
    availability: z.enum(["local", "remote", "degraded"]),
  })
  .strict();
export type ProviderMetadata = z.infer<typeof ProviderMetadataSchema>;

export interface ProviderRegistration<TIn = unknown, TOut = unknown> {
  readonly id: string;
  readonly capabilities: readonly AnyCapability[];
  readonly metadata: ProviderMetadata;
  readonly invoke: (input: TIn) => Promise<TOut>;
}

/**
 * The declared payload for one optional capability.
 *
 * Deliberately narrow: text out, nothing in. A capability that needs to return
 * identity, a decision, or a tenant would be a capability with a security problem,
 * and this is where that gets said out loud.
 */
const CAPABILITY_OUTPUT_FIELDS: Readonly<Record<OptionalCapability, readonly string[]>> = {
  summarization: ["text"],
  embedding: ["vector"],
  reranking: ["scores"],
  extraction: ["items"],
};

export function invalid(detail: string): never {
  throw new RemembraError("INVALID_INPUT", `v6 core contract: ${detail}`);
}

/**
 * A typed, catchable miss for an unavailable capability.
 *
 * Not a `TypeError` from calling `undefined`: a caller must be able to catch this and
 * degrade, and the code is what makes "degrade" a decision rather than an accident.
 */
export function capabilityUnavailable(capability: string): never {
  throw new RemembraError("NOT_FOUND", `capability ${capability} is not available: no provider is registered for it`);
}

export interface NegotiationResult {
  readonly available: readonly AnyCapability[];
  readonly unavailable: readonly AnyCapability[];
  readonly negotiatedAt: number;
}

/**
 * A registry of optional providers.
 *
 * Absent provider is a first-class state: constructing, registering and negotiating
 * with nothing are all valid, and negotiation names its misses so a caller can decide
 * what to do rather than discovering an undefined at the point of use.
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderRegistration>();

  register<TIn, TOut>(provider: ProviderRegistration<TIn, TOut>): void {
    const id = provider?.id;
    if (typeof id !== "string" || id.length === 0) invalid("a provider needs a non-empty id");
    if (!ProviderMetadataSchema.safeParse(provider.metadata).success) {
      invalid(`provider ${id} must declare privacy, cost, latency and availability`);
    }
    for (const capability of provider.capabilities) {
      if (isCoreCapability(capability)) {
        // A provider cannot supply a durable core capability. Accepting this would
        // let a remote service quietly become the storage substrate.
        invalid(`provider ${id} cannot supply core capability ${capability}; core is never delegated`);
      }
    }
    if (this.#providers.has(id)) invalid(`provider ${id} is already registered; a shadowed provider makes negotiation unpredictable`);
    this.#providers.set(id, provider as ProviderRegistration);
  }

  /**
   * A reportable view of what is registered.
   *
   * Exposes ids and declared metadata only. There is no field here a credential could
   * occupy, which is why the service can publish this without a redaction step.
   */
  describe(): Array<{
    id: string;
    capabilities: readonly AnyCapability[];
    metadata: ProviderMetadata;
  }> {
    return [...this.#providers.values()].map((p) => ({
      id: p.id,
      capabilities: [...p.capabilities] as readonly AnyCapability[],
      metadata: p.metadata,
    }));
  }

  has(capability: string): boolean {
    return [...this.#providers.values()].some((p) => (p.capabilities as readonly string[]).includes(capability));
  }

  metadataFor(capability: string): ProviderMetadata | undefined {
    return this.#providerFor(capability)?.metadata;
  }

  /**
   * The provider satisfying a capability.
   *
   * Returns the registration rather than an id, so a caller cannot look it up again
   * and receive `undefined` from a miss it was told could not happen.
   */
  #providerFor(capability: string): ProviderRegistration | undefined {
    for (const provider of this.#providers.values()) {
      if ((provider.capabilities as readonly string[]).includes(capability)) return provider;
    }
    return undefined;
  }

  /** The provider for a capability, or a typed miss. Never a silent `undefined`. */
  #requireProvider(capability: string): ProviderRegistration {
    const provider = this.#providerFor(capability);
    if (provider === undefined) capabilityUnavailable(capability);
    return provider;
  }

  /**
   * Invoke a capability, projecting the result down to the declared payload.
   *
   * This is the security boundary. Whatever the provider returns — including a
   * well-formed object carrying a principal, a capability set or a policy version —
   * only the fields declared for this capability are copied out. A hostile or merely
   * careless provider cannot widen authorization by returning a richer object, and
   * cannot smuggle a tenant or a token into a result that gets logged.
   */
  async invokeCapability(capability: OptionalCapability, input: unknown): Promise<Record<string, unknown>> {
    const provider = this.#requireProvider(capability);
    const raw = (await provider.invoke(input)) as Record<string, unknown> | null | undefined;
    const out: Record<string, unknown> = {};
    if (raw === null || typeof raw !== "object") return out;
    for (const field of CAPABILITY_OUTPUT_FIELDS[capability]) {
      // Copied one field at a time, deliberately. A spread would reintroduce exactly
      // the pass-through this projection exists to prevent.
      if (raw[field] !== undefined) out[field] = raw[field];
    }
    return out;
  }
}

/**
 * Negotiate: what can be had, and what cannot.
 *
 * Both halves are returned because the useful question is never "is it available" —
 * it is "which of my optional features do I actually get in this deployment".
 */
export function negotiateCapabilities(registry: ProviderRegistry, requested: readonly AnyCapability[]): NegotiationResult {
  const available: AnyCapability[] = [];
  const unavailable: AnyCapability[] = [];
  for (const capability of requested) {
    // A core capability is always available by definition; it needs no provider. Only
    // optional capabilities can be missed.
    if (!isCoreCapability(capability) && !registry.has(capability)) {
      unavailable.push(capability);
      continue;
    }
    available.push(capability);
  }
  return { available, unavailable, negotiatedAt: Date.now() };
}

// --- the durable core surface -------------------------------------------------

export interface CoreOperations {
  readonly version: string;
  readonly storage: {
    store(input: unknown): Promise<{ ok: boolean }>;
    get(id: string): Promise<unknown>;
    delete(id: string): Promise<{ ok: boolean }>;
    list(filter?: unknown): Promise<readonly unknown[]>;
  };
  readonly retrieval: {
    search(query: unknown): Promise<readonly unknown[]>;
    explain(query: unknown): Promise<{ hits: readonly unknown[]; budget: { total: number; expanded: number; filtered: number } }>;
  };
  readonly context: {
    build(input: unknown): Promise<{ content: string; references: readonly unknown[] }>;
  };
  readonly policy: {
    evaluate(input: unknown): Promise<{ effect: "allow" | "deny"; reason: string; policyVersion: string }>;
  };
  readonly lifecycle: {
    expire(now: number): Promise<number>;
    archive(id: string): Promise<number>;
  };
  readonly audit: {
    append(event: unknown): Promise<void>;
    query(q: unknown): Promise<{ events: readonly unknown[]; totalRetained: number; dropped: number }>;
  };
  readonly snapshot: {
    create(): Promise<{ id: string }>;
    restore(id: string): Promise<{ ok: boolean }>;
  };
}