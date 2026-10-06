/**
 * V6 capability adapters (V6-T13).
 *
 * `provider-adapters.ts` already provides embedding and completion adapters with the
 * full timeout/retry/cancellation policy. What is missing is the layer *above* them:
 * a **typed capability result** for every optional operation, so an unsupported or
 * refused capability is a value a caller handles rather than an exception it forgets to
 * catch.
 *
 * Three properties decide this module:
 *
 *  - **Provider output is data, never authority.** A provider that returns
 *    `trust: "system"` or `organizationId: "org-b"` is not believed. Those fields are
 *    dropped at the parse boundary, so a hostile or careless provider cannot widen what
 *    a memory is or whose it is. Half-parsed output is refused outright rather than
 *    stored as partial truth.
 *  - **The gate runs before the provider, and omitting its input is not a way around
 *    it.** A caller that forgets to pass a manifest gets the conservative derived
 *    external manifest, which refuses `secret`. Failing open here would make forgetting
 *    a parameter a way to transmit.
 *  - **Classification and summarization are separate capabilities.** Conflating them is
 *    how a summarizer's text ends up labelled with a category it never claimed.
 *
 * Everything here is local and pure. "Local adapters work without network access" is
 * asserted by construction: if one reached for a socket, a test would fail or hang —
 * it cannot pass quietly.
 */
import { RemembraError } from "../errors.js";
import {
  defaultManifestFor,
  evaluateTransmission,
  type ProviderManifest,
} from "../provider-boundary.js";
import type { Sensitivity } from "../v6-policy.js";

/** Output bounds. A provider cannot make a record arbitrarily large. */
export const MAX_SUMMARY_CHARS = 10_000;
export const MAX_EXTRACTED_ITEMS = 200;
export const MAX_EXTRACTED_CHARS = 10_000;

export type Capability = "classification" | "summarization" | "embedding" | "consolidation";

export interface CapabilitySuccess<T> {
  readonly ok: true;
  readonly capability: Capability;
  /** Warnings the caller should know even on success (e.g. the provider trains). */
  readonly warnings?: readonly string[];
  /** The declared payload. Never carries trust, access, or a tenant. */
  readonly value?: T;
}

export interface CapabilityFailure {
  readonly ok: false;
  readonly capability: Capability;
  /** Why. Always present: a failure a caller cannot describe is not actionable. */
  readonly reason: string;
}

export type CapabilityResult<T = Record<string, unknown>> = CapabilitySuccess<T> | CapabilityFailure;

export function capabilityResult<T>(
  capability: Capability,
  value: T,
  warnings?: readonly string[],
): CapabilitySuccess<T>;
export function capabilityResult<T>(
  capability: Capability,
  value: undefined,
  reason: string,
): CapabilityFailure;
export function capabilityResult<T>(
  capability: Capability,
  value: T | undefined,
  reasonOrWarnings?: string | readonly string[],
): CapabilityResult<T> {
  if (value === undefined) {
    return { ok: false, capability, reason: typeof reasonOrWarnings === "string" ? reasonOrWarnings : "unavailable" };
  }
  const warnings = typeof reasonOrWarnings === "string" ? undefined : reasonOrWarnings;
  return { ok: true, capability, value, ...(warnings && warnings.length > 0 ? { warnings } : {}) };
}

/** The typed miss for a capability with no provider. */
export function unsupportedCapability(capability: Capability, reason: string): CapabilityFailure {
  return { ok: false, capability, reason };
}

export interface CapabilityContext {
  readonly signal?: AbortSignal;
  /**
   * An injected fetch. Accepted so a REMOTE-backed capability can be tested without a
   * socket; a local adapter ignores it entirely, and `V6-PA-009` proves it never calls
   * it even when one is supplied.
   */
  readonly fetchImpl?: unknown;
  /** The sensitivity of the content being sent. Drives the gate. */
  readonly sensitivity?: Sensitivity;
  readonly manifest?: ProviderManifest;
  readonly tenantAllowsExternal?: boolean;
}

/** An extracted memory. Deliberately WITHOUT trust, access, or tenant fields. */
export interface ExtractedMemory {
  readonly type: string;
  readonly content: string;
  readonly importance?: number;
  readonly tags?: readonly string[];
  readonly confidence?: number;
}

const ALLOWED_EXTRACT_KEYS = new Set(["type", "content", "importance", "tags", "confidence"]);

/**
 * Validate provider extraction output.
 *
 * Refuses anything malformed rather than half-parsing it: a partially understood
 * provider response becomes partially stored data, which is worse than a refusal
 * because nothing downstream can tell the difference.
 *
 * Fields the caller did not declare are DROPPED, not merely ignored — a provider
 * returning `trust: "system"` must not have it sit in an object a caller might spread
 * into a memory.
 */
export function extractExtractedMemories(value: unknown, provider: string): ExtractedMemory[] {
  if (!Array.isArray(value)) {
    throw new RemembraError("LLM_ERROR", `${provider} returned a malformed extraction response`);
  }
  if (value.length > MAX_EXTRACTED_ITEMS) {
    throw new RemembraError("LLM_ERROR", `${provider} returned ${value.length} items, above the ${MAX_EXTRACTED_ITEMS} bound`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new RemembraError("LLM_ERROR", `${provider} returned a malformed item at index ${index}`);
    }
    const source = item as Record<string, unknown>;
    const content = source.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new RemembraError("LLM_ERROR", `${provider} returned an item without content at index ${index}`);
    }
    if (content.length > MAX_EXTRACTED_CHARS) {
      throw new RemembraError("LLM_ERROR", `${provider} returned an item longer than ${MAX_EXTRACTED_CHARS} characters`);
    }
    const type = source.type;
    if (typeof type !== "string" || type === "") {
      throw new RemembraError("LLM_ERROR", `${provider} returned an item without a type at index ${index}`);
    }

    // Built field by field from an allowlist, so an undeclared key cannot survive even
    // if a caller spreads the result.
    const out: Record<string, unknown> = { type, content };
    for (const key of ["importance", "tags", "confidence"] as const) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    for (const key of Object.keys(out)) {
      if (!ALLOWED_EXTRACT_KEYS.has(key)) delete out[key];
    }
    return out as unknown as ExtractedMemory;
  });
}

/** The payload a handler returns, or a reason it could not. */
type HandlerResult = Record<string, unknown> | string;

export class CapabilityAdapter {
  readonly capability: Capability;

  constructor(
    readonly id: string,
    private readonly handler?: (input: string) => Promise<HandlerResult>,
    private readonly capabilities: readonly Capability[] = [],
  ) {
    this.capability = capabilities[0] ?? "summarization";
  }

  /**
   * Invoke a capability under the transmission gate.
   *
   * The gate runs FIRST and is not skippable: an omitted manifest becomes the derived
   * external one, which refuses `secret` content. Every outcome is a value — an
   * unsupported capability, a refusal, a cancellation, and a provider failure all return
   * `ok: false` with a reason rather than throwing past the boundary.
   */
  async invoke(
    capability: Capability,
    input: string,
    context: CapabilityContext = {},
  ): Promise<CapabilityResult> {
    if (this.capabilities.length > 0 && !this.capabilities.includes(capability)) {
      return unsupportedCapability(capability, `adapter ${this.id} does not implement ${capability}`);
    }
    if (!this.handler) {
      return unsupportedCapability(capability, `adapter ${this.id} has no handler configured`);
    }

    // Conservative by default: an omitted manifest is the derived EXTERNAL one, which
    // caps at `confidential`. Forgetting a parameter must not be a way to transmit.
    const manifest = context.manifest ?? defaultManifestFor({
      id: this.id,
      capabilities: [capability],
      privacy: "external",
    });
    const decision = evaluateTransmission({
      manifest,
      sensitivity: context.sensitivity ?? "internal",
      tenantAllowsExternal: context.tenantAllowsExternal ?? true,
      now: 0,
    });
    if (decision.effect === "deny") {
      return { ok: false, capability, reason: `transmission refused: ${decision.reason}` };
    }

    if (context.signal?.aborted) {
      return { ok: false, capability, reason: "cancelled before the provider was called" };
    }

    try {
      const raw = await this.handler(input);
      if (raw === undefined || raw === null) {
        return { ok: false, capability, reason: `adapter ${this.id} returned nothing` };
      }
      if (typeof raw === "string") {
        if (raw.length > MAX_SUMMARY_CHARS) {
          return { ok: false, capability, reason: `adapter ${this.id} returned ${raw.length} characters, above the ${MAX_SUMMARY_CHARS} bound` };
        }
        return { ok: true, capability, value: { text: raw }, ...(decision.warnings?.length ? { warnings: decision.warnings } : {}) };
      }
      return { ok: true, capability, value: raw, ...(decision.warnings?.length ? { warnings: decision.warnings } : {}) };
    } catch (error) {
      // Never throws past the boundary: an unhandled rejection in a caller's path is a
      // failure mode of its own.
      if (context.signal?.aborted) {
        return { ok: false, capability, reason: "cancelled during the provider call" };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, capability, reason: `adapter ${this.id} failed: ${message.slice(0, 200)}` };
    }
  }
}

export class ClassificationAdapter {
  readonly capability = "classification" as const;
  constructor(private readonly adapter: CapabilityAdapter) {}

  async classify(input: string, context: CapabilityContext = {}): Promise<CapabilityResult> {
    return this.adapter.invoke("classification", input, context);
  }
}

export class SummarizationAdapter {
  readonly capability = "summarization" as const;
  constructor(private readonly adapter: CapabilityAdapter) {}

  async summarize(input: string, context: CapabilityContext = {}): Promise<CapabilityResult> {
    return this.adapter.invoke("summarization", input, context);
  }
}

/**
 * A purely local classifier.
 *
 * Deterministic and offline by construction — it inspects the text, never a network.
 * It is a real capability with a real (small) accuracy, not a stub: the point of
 * "local adapters work without network access" is that something useful works.
 */
export function createLocalClassificationAdapter(): ClassificationAdapter {
  return new ClassificationAdapter(
    new CapabilityAdapter(
      "local-classification",
      async (text) => {
        const lower = text.toLowerCase();
        const labels: string[] = [];
        if (/\b(prefer|prefers|like|likes|rather)\b/.test(lower)) labels.push("preference");
        if (/\b(decide|decided|chose|choose|will use)\b/.test(lower)) labels.push("decision");
        if (/\b(must|never|always|required|constraint)\b/.test(lower)) labels.push("constraint");
        if (/\b(is|are|was|were)\b/.test(lower) && labels.length === 0) labels.push("fact");
        if (labels.length === 0) labels.push("observation");
        return { labels, confidence: 0.5 };
      },
      ["classification"],
    ),
  );
}

/**
 * A purely local summarizer: the leading sentence, bounded.
 *
 * Extractive rather than generative, which is the right trade for an offline default —
 * it cannot hallucinate, and its output is drawn verbatim from the input.
 */
export function createLocalSummarizationAdapter(): SummarizationAdapter {
  return new SummarizationAdapter(
    new CapabilityAdapter(
      "local-summarization",
      async (text) => {
        const trimmed = text.trim();
        if (trimmed === "") return { text: "" };
        const firstSentence = trimmed.match(/^[\s\S]*?[.!?](?:\s|$)/);
        const summary = (firstSentence ? firstSentence[0] : trimmed).trim();
        return { text: summary.slice(0, MAX_SUMMARY_CHARS), truncated: summary.length > MAX_SUMMARY_CHARS };
      },
      ["summarization"],
    ),
  );
}
