/**
 * Health/readiness provider axis (V6-T10 wiring).
 *
 * The `/health` payload is a V5 compatibility surface: `ok` | `unready`, cached, and
 * consumed by load balancers and uptime probes. So this module's job is narrow —
 * report the provider axis **without changing what the existing two states mean**.
 *
 * The specific risk worth naming: the obvious implementation is
 * `ready = coreOk && !providersDegraded`, which would take a perfectly healthy node out
 * of rotation because a summarizer was unreachable. A degraded provider means core is
 * serving from local storage — which is exactly what offline-first is for — so readiness
 * is never withdrawn for it. The three-state `reportOperationalStatus` in `v6-degraded`
 * carries the same distinction for callers that want it; here it must not leak into the
 * wire status, because a load balancer only reads two states.
 */
import { z } from "zod";

/** The declared provider facts worth exposing. Everything else stays out. */
export const HealthProviderAxis = z
  .object({
    degraded: z.boolean(),
    privacy: z.enum(["local", "external", "unknown"]),
    availability: z.enum(["local", "remote", "degraded"]),
    capabilities: z.array(z.string()),
    /**
     * The provider's registered id. Descriptive, not authorising — an operator needs
     * to know *which* provider is registered and degraded, and an id grants nothing.
     * The credential and the base URL are the parts that must never appear.
     */
    id: z.string().max(128).optional(),
  })
  .strict();
export type HealthProviderAxisValue = z.infer<typeof HealthProviderAxis>;

export interface HealthStatusInput {
  /** The existing V5 status, verbatim. */
  readonly status: "ok" | "unready";
  readonly providerConfigured?: boolean;
  readonly providerDegraded?: boolean;
  readonly providerPrivacy?: "local" | "external" | "unknown";
  readonly providerAvailability?: "local" | "remote" | "degraded";
  readonly providerCapabilities?: readonly string[];
  /**
   * Description-only fields. Accepted and deliberately **dropped**: a health payload is
   * world-readable on most deployments, so a credential or an internal endpoint must
   * never survive into it. They are declared so a caller passing them by mistake gets
   * silence rather than a leak.
   */
  readonly providerId?: string;
  readonly providerApiKey?: string;
  readonly providerBaseUrl?: string;
}

export interface ClassifiedHealthStatus {
  readonly status: "ok" | "unready";
  readonly ready: boolean;
  /** Present only when a provider is configured — see the module note. */
  readonly providers?: HealthProviderAxisValue;
}

/**
 * Attach the provider axis to an existing health payload.
 *
 * `status` is passed through **unchanged**. Not because the degraded state is
 * unimportant, but because `/health` is a two-state contract with load balancers: making
 * a degraded provider produce `unready` removes a serving node from rotation, which is a
 * worse failure than the one it reports.
 */
export function classifyHealthStatus(input: HealthStatusInput): ClassifiedHealthStatus {
  const status = input.status;
  const base: ClassifiedHealthStatus = { status, ready: status === "ok" };
  if (input.providerConfigured !== true) return base;

  const providers = HealthProviderAxis.parse({
    degraded: input.providerDegraded === true,
    privacy: input.providerPrivacy ?? "unknown",
    availability: input.providerAvailability ?? "degraded",
    capabilities: input.providerCapabilities ?? [],
    // `providerApiKey` and `providerBaseUrl` are declared on the input and dropped
    // here, deliberately and silently: a health payload is typically unauthenticated,
    // so a credential or an internal endpoint reaching it is a disclosure.
    ...(input.providerId !== undefined ? { id: input.providerId } : {}),
  });
  return { ...base, providers };
}
