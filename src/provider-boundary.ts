/**
 * V6 provider manifests and the transmission gate (V6-T12).
 *
 * The criterion that decides this module: **policy must be able to deny transmission
 * before network work begins.** Not after, not by inspecting what came back — before.
 * Once a request is on the wire the content has left the host, and a refusal that
 * arrives afterwards is a disclosure with extra steps.
 *
 * So every question here is answerable *statically*, from configuration, with no call
 * to the provider:
 *
 *   1. What data classes may this provider receive at all?
 *   2. Where does it process them, and how long does it keep them?
 *   3. May it receive content at or below a given sensitivity band?
 *
 * Three decisions worth stating outright:
 *
 *  - **Bands are compared by position, never lexically.** `"internal" > "confidential"`
 *    is false as strings and true as bands, so a lexical comparison silently permits the
 *    wrong direction for most pairs — and permits the wrong direction in the *permissive*
 *    sense, which is the dangerous one.
 *  - **Training is a separate consent from transmission.** A provider may be permitted
 *    to process content and forbidden to train on it. Those are different permissions,
 *    so a decision reports both rather than collapsing them into one verdict.
 *  - **The manifest schema is `.strict()` and has no credential field.** "Credentials
 *    never enter records" is easy to believe and easy to lose, so it is enforced at the
 *    schema: a manifest carrying `apiKey` does not validate, so it cannot be stored,
 *    logged, or attached to an audit event.
 */
import { z } from "zod";
import { RemembraError } from "./errors.js";
import { SENSITIVITY_ORDER, type Sensitivity } from "./v6-policy.js";

/** Manifest version. A manifest from an unknown version is refused, not half-honoured. */
export const MANIFEST_VERSION = "1.0.0" as const;

/**
 * Data classes a provider might receive.
 *
 * Closed, because "anything the caller sends" is how a data-handling boundary quietly
 * becomes unbounded. Each entry is a category a manifest must name deliberately.
 */
export const DataClass = [
  "prompt",
  "completion",
  "memory_content",
  "memory_metadata",
  "embedding",
  "user_identifier",
  "telemetry",
] as const;
export type DataClassName = (typeof DataClass)[number];

export const RegionCode = /^[a-z]{2}(-[a-z]+)+-\d$/;

export const ProviderManifestSchema = z
  .object({
    id: z.string().min(1).max(128),
    // The version must be one this build understands. A regex alone accepts "99.0.0",
    // which is precisely the case that must be refused: the axes we enforce today may
    // not be the axes a future manifest declares, so honouring it partially is worse
    // than rejecting it.
    version: z.literal(MANIFEST_VERSION),
    capabilities: z.array(z.string().min(1).max(64)).min(1),
    privacy: z.enum(["local", "external"]),
    /** Where the provider processes content. Empty is allowed for local-only. */
    regions: z.array(z.string().regex(RegionCode)),
    dataClasses: z.array(z.enum(DataClass)),
    retention: z
      .object({
        /** May content be used to train the provider's models? A distinct consent. */
        training: z.boolean(),
        /** How long content is retained. 0 means not retained beyond the request. */
        logDays: z.number().int().min(0).max(3650),
      })
      .strict(),
    /** The highest sensitivity band this provider may receive. */
    maxSensitivity: z.enum(SENSITIVITY_ORDER),
    cost: z.object({ perCall: z.number().min(0).max(1_000_000) }).strict(),
    latency: z.object({ p95Ms: z.number().int().min(0).max(3_600_000) }).strict(),
    availability: z.enum(["local", "remote", "degraded"]),
  })
  // `.strict()` is the credential guarantee: there is no field here a key could occupy.
  .strict();
export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

export type TransmissionEffect = "allow" | "deny";

export interface TransmissionDecision {
  readonly effect: TransmissionEffect;
  readonly reason?: string;
  /**
   * Facts the caller should know even on an allow — currently only the training
   * consent, which is a different permission from "may I send this".
   */
  readonly warnings?: readonly string[];
}

/** Band index, or -1 for an unknown band. Unknown is treated as most sensitive. */
function bandIndex(sensitivity: Sensitivity): number {
  return SENSITIVITY_ORDER.indexOf(sensitivity);
}

export interface TransmissionInput {
  readonly manifest: ProviderManifest;
  readonly sensitivity: Sensitivity;
  /** Whether the tenant permits content to leave the host at all. */
  readonly tenantAllowsExternal: boolean;
  readonly now: number;
}

/**
 * Decide whether content may be transmitted — **before** any network work.
 *
 * Two independent denials, checked in a fixed order so the reason is deterministic:
 *
 *   1. **The provider's own ceiling.** A manifest may declare a maximum band; content
 *      above it is refused regardless of what the tenant permits.
 *   2. **The tenant's external rule.** Applies only when the provider is external,
 *      because a local provider transmits nothing and refusing it would deny a request
 *      that involves no transmission.
 *
 * No provider call, no input beyond what is already known. That is the point.
 */
export function evaluateTransmission(input: TransmissionInput): TransmissionDecision {
  const { manifest, sensitivity } = input;
  const requested = bandIndex(sensitivity);
  const ceiling = bandIndex(manifest.maxSensitivity);

  // An unknown band is the most sensitive reading available, never the loosest.
  if (requested < 0 || requested > ceiling) {
    return { effect: "deny", reason: "provider_sensitivity_ceiling" };
  }

  if (manifest.privacy === "external" && !input.tenantAllowsExternal) {
    return { effect: "deny", reason: "tenant_forbids_external_transmission" };
  }

  // Allowed, but say the training truth: processing permission and training permission
  // are different consents, and a caller who only asked "may I send this" deserves to
  // learn the content may be used for training.
  const warnings: string[] = [];
  if (manifest.retention.training) warnings.push("provider_trains_on_data");
  if (manifest.retention.logDays > 0) warnings.push("provider_retains_content");

  return { effect: "allow", ...(warnings.length > 0 ? { warnings } : {}) };
}

/** The boolean form, for call sites that do not need the reason. */
export function mayReceive(manifest: ProviderManifest, sensitivity: Sensitivity): boolean {
  return evaluateTransmission({ manifest, sensitivity, tenantAllowsExternal: true, now: 0 }).effect === "allow";
}

export interface ManifestSeed {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly privacy: "local" | "external";
}

/**
 * Derive a manifest for a provider whose detailed policy was not configured.
 *
 * Derived rather than guessed per call, so one provider cannot answer the transmission
 * question differently on two requests.
 *
 * The defaults are deliberately conservative but not paralyzing:
 *  - a local provider may receive any band, because content never leaves the host;
 *  - an external one is capped at `confidential`, so `secret` content is refused by
 *    default rather than sent to a provider nobody configured to receive it;
 *  - `training: false` by default — using content to train is never assumed;
 *  - `logDays: 0` — retention beyond the request is not assumed either.
 */
export function defaultManifestFor(seed: ManifestSeed): ProviderManifest {
  return ProviderManifestSchema.parse({
    id: seed.id,
    version: MANIFEST_VERSION,
    capabilities: [...seed.capabilities],
    privacy: seed.privacy,
    regions: [],
    dataClasses: seed.capabilities.includes("embedding") ? ["embedding"] : ["prompt", "completion"],
    retention: { training: false, logDays: 0 },
    maxSensitivity: seed.privacy === "local" ? "secret" : "confidential",
    cost: { perCall: 0 },
    latency: { p95Ms: seed.privacy === "local" ? 1 : 500 },
    availability: seed.privacy === "local" ? "local" : "remote",
  });
}

/**
 * Credential shapes that must never travel with a manifest.
 *
 * Checked on manifest-adjacent data rather than trusted to schema strictness alone:
 * a free-form `notes` field, a config blob, or a log line can all carry one, and none
 * of those goes through `ProviderManifestSchema`.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b(?:api[_-]?key|access[_-]?token|secret|password|authorization)\b/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+\S+/i,
];

export function assertNoCredentials(value: unknown, path = "manifest"): void {
  if (typeof value === "string") {
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.test(value)) {
        throw new RemembraError("INVALID_INPUT", `${path} carries a credential-shaped value and was refused`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCredentials(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      assertNoCredentials(v, `${path}.${key}`);
    }
  }
}

/**
 * Redact a manifest for logging.
 *
 * Returns the manifest with credential-shaped strings replaced. A manifest that
 * validates has no credential field, so this is belt-and-braces for the paths that
 * bypass the schema — a `notes` string, an error payload, an adapter description.
 */
export function redactManifest<T>(value: T): T {
  if (typeof value === "string") {
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.test(value)) return "[REDACTED:CREDENTIAL]" as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactManifest(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactManifest(v);
    }
    return out as T;
  }
  return value;
}
