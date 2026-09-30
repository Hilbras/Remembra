import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import type { RetentionMode } from "./types.js";
import type { SensitivePolicy } from "./sensitive-data.js";
import { DEFAULT_FUSION_WEIGHTS, type FusionWeights } from "./retrieval.js";

export interface MemoryPolicy {
  extraction: { enabled: boolean };
  roles: { requireTrust: boolean };
  sensitiveData: { action: SensitivePolicy };
  lifecycle: { default: RetentionMode };
  retrieval: {
    reranking: boolean;
    diversity: boolean;
    relationExpansion: boolean;
    /**
     * §34 fusion weights. Absent by default rather than pre-filled, so an
     * unconfigured deployment takes searchQ's own `DEFAULT_FUSION_WEIGHTS` path
     * instead of an object that happens to equal it. Those are the same numbers
     * today, but one of them is the single source of truth.
     */
    fusionWeights?: Partial<FusionWeights>;
  };
  provenance: { required: boolean };
}

/**
 * A weight must be a real, non-negative, finite number. `NaN` and `Infinity` pass
 * `z.number()`, and either one silently destroys every ranking it touches — a
 * score of NaN sorts nowhere, so the query returns results in a meaningless order
 * rather than failing.
 */
const weightSchema = z.number().finite().nonnegative();

const SensitiveAction = z.enum(["allow", "redact", "reject", "quarantine"]);
const RetentionDefault = z.enum(["pinned", "persistent", "ephemeral", "decaying", "neverExpire"]);

const policyFileSchema = z
  .object({
    extraction: z.object({ enabled: z.boolean() }).strict(),
    roles: z.object({ requireTrust: z.boolean() }).strict(),
    sensitiveData: z.object({ action: SensitiveAction }).strict(),
    lifecycle: z.object({ default: RetentionDefault }).strict(),
    retrieval: z
      .object({
        reranking: z.boolean(),
        diversity: z.boolean(),
        relationExpansion: z.boolean(),
        // Written out rather than `.partial()`, deliberately. In zod 3.25 a
        // `.strict().partial()` object used as a *nested* key comes back required —
        // the optionality does not survive nesting, so an unconfigured deployment
        // failed to load at all. `.optional()` on the key and on each field is the
        // form that behaves. Do not "simplify" this back to `.partial()`.
        //
        // `.strict()` earns its place on the *names*: an unknown weight is a typo
        // that would otherwise be stripped silently, leaving the deployment on
        // defaults it did not ask for and believing they were applied.
        fusionWeights: z
          .object({
            keyword: weightSchema.optional(),
            semantic: weightSchema.optional(),
            metadata: weightSchema.optional(),
            recency: weightSchema.optional(),
            confidence: weightSchema.optional(),
            rrfK: weightSchema.refine((v) => v > 0, "rrfK must be greater than zero").optional(),
            fusionScale: weightSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    provenance: z.object({ required: z.boolean() }).strict(),
  })
  .strict();

export function defaultMemoryPolicy(): MemoryPolicy {
  return {
    extraction: { enabled: true },
    roles: { requireTrust: true },
    sensitiveData: { action: "redact" },
    lifecycle: { default: "decaying" },
    retrieval: { reranking: true, diversity: true, relationExpansion: false },
    provenance: { required: true },
  };
}

export { DEFAULT_FUSION_WEIGHTS };
export type { FusionWeights };

export interface PolicyLoadOptions {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

function invalid(message: string): never {
  throw new RemembraError("INVALID_INPUT", `memory policy: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolEnv(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  invalid(`${name} must be a boolean`);
}

function numberEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) invalid(`${name} must be a non-negative finite number`);
  return parsed;
}

/**
 * `REMEMBRA_RETRIEVAL_FUSION_WEIGHTS=keyword=2,semantic=0.5,recency=0`
 *
 * One env var rather than seven, because weights are almost always tuned
 * together, and an operator setting a "lexical-first" profile should not have to
 * know that doing so also means spelling out the six they are not changing.
 */
const FUSION_WEIGHT_NAMES = ["keyword", "semantic", "metadata", "recency", "confidence", "rrfK", "fusionScale"] as const;

function fusionWeightsEnv(env: NodeJS.ProcessEnv): Partial<FusionWeights> | undefined {
  const raw = env.REMEMBRA_RETRIEVAL_FUSION_WEIGHTS?.trim();
  if (!raw) return undefined;
  const out: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) invalid(`REMEMBRA_RETRIEVAL_FUSION_WEIGHTS entry "${trimmed}" must be name=value`);
    const name = trimmed.slice(0, eq).trim();
    if (!FUSION_WEIGHT_NAMES.includes(name as (typeof FUSION_WEIGHT_NAMES)[number])) {
      // Silently ignoring an unknown name is the worst outcome: the deployment
      // would run on a default it did not ask for and believe otherwise.
      invalid(`REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: unknown weight "${name}"; expected one of ${FUSION_WEIGHT_NAMES.join(", ")}`);
    }
    const value = Number(trimmed.slice(eq + 1).trim());
    if (!Number.isFinite(value) || value < 0) {
      invalid(`REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: ${name} must be a non-negative finite number`);
    }
    if (name === "rrfK" && value === 0) invalid("REMEMBRA_RETRIEVAL_FUSION_WEIGHTS: rrfK must be greater than zero");
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? (out as Partial<FusionWeights>) : undefined;
}

function mergeSections(value: unknown): unknown {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid("policy file must contain an object");
  const defaults = defaultMemoryPolicy();
  return {
    ...defaults,
    ...value,
    extraction: { ...defaults.extraction, ...(isRecord(value.extraction) ? value.extraction : {}) },
    roles: { ...defaults.roles, ...(isRecord(value.roles) ? value.roles : {}) },
    sensitiveData: {
      ...defaults.sensitiveData,
      ...(isRecord(value.sensitiveData) ? value.sensitiveData : {}),
    },
    lifecycle: { ...defaults.lifecycle, ...(isRecord(value.lifecycle) ? value.lifecycle : {}) },
    retrieval: {
      ...defaults.retrieval,
      ...(isRecord(value.retrieval) ? value.retrieval : {}),
    },
    provenance: { ...defaults.provenance, ...(isRecord(value.provenance) ? value.provenance : {}) },
  };
}

/** Load and validate policy once at service construction; never from request bodies. */
export function loadMemoryPolicy(options: PolicyLoadOptions = {}): MemoryPolicy {
  const env = options.env ?? process.env;
  let raw: unknown = {};
  const policyPath = env.REMEMBRA_POLICY_FILE?.trim();
  if (policyPath) {
    let source: string;
    try {
      source = options.readFile ? options.readFile(policyPath) : readFileSync(policyPath, "utf8");
    } catch (error) {
      invalid(`cannot read ${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Buffer.byteLength(source, "utf8") > 64 * 1024) invalid("policy file exceeds 64 KiB");
    try {
      raw = parseYaml(source) ?? {};
      if (isRecord(raw) && Object.keys(raw).length === 1 && isRecord(raw.memory)) {
        raw = raw.memory;
      }
    } catch (error) {
      invalid(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const merged = mergeSections(raw) as Record<string, unknown>;
  const extractionEnabled = boolEnv(env, "REMEMBRA_EXTRACTION_ENABLED");
  const requireTrust = boolEnv(env, "REMEMBRA_ROLES_REQUIRE_TRUST");
  const reranking = boolEnv(env, "REMEMBRA_RETRIEVAL_RERANKING");
  const diversity = boolEnv(env, "REMEMBRA_RETRIEVAL_DIVERSITY");
  const relationExpansion = boolEnv(env, "REMEMBRA_RETRIEVAL_RELATION_EXPANSION");
  const provenanceRequired = boolEnv(env, "REMEMBRA_PROVENANCE_REQUIRED");
  const fusionWeights = fusionWeightsEnv(env);
  const sensitive = env.REMEMBRA_SENSITIVE_POLICY?.trim();
  const lifecycle = env.REMEMBRA_LIFECYCLE_DEFAULT?.trim();

  if (extractionEnabled !== undefined) merged.extraction = { ...(merged.extraction as object), enabled: extractionEnabled };
  if (requireTrust !== undefined) merged.roles = { ...(merged.roles as object), requireTrust };
  if (reranking !== undefined) merged.retrieval = { ...(merged.retrieval as object), reranking };
  if (diversity !== undefined) merged.retrieval = { ...(merged.retrieval as object), diversity };
  if (relationExpansion !== undefined) merged.retrieval = { ...(merged.retrieval as object), relationExpansion };
  if (fusionWeights) merged.retrieval = { ...(merged.retrieval as object), fusionWeights };
  if (provenanceRequired !== undefined) merged.provenance = { ...(merged.provenance as object), required: provenanceRequired };
  if (sensitive) merged.sensitiveData = { ...(merged.sensitiveData as object), action: sensitive };
  if (lifecycle) merged.lifecycle = { ...(merged.lifecycle as object), default: lifecycle };

  const parsed = policyFileSchema.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    invalid(`${issue?.path.join(".") || "policy"}: ${issue?.message || "invalid value"}`);
  }
  return parsed.data;
}
