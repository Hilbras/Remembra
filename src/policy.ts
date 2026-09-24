import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RemembraError } from "./errors.js";
import type { RetentionMode } from "./types.js";
import type { SensitivePolicy } from "./sensitive-data.js";

export interface MemoryPolicy {
  extraction: { enabled: boolean };
  roles: { requireTrust: boolean };
  sensitiveData: { action: SensitivePolicy };
  lifecycle: { default: RetentionMode };
  retrieval: { reranking: boolean; diversity: boolean };
  provenance: { required: boolean };
}

const SensitiveAction = z.enum(["allow", "redact", "reject", "quarantine"]);
const RetentionDefault = z.enum(["pinned", "persistent", "ephemeral", "decaying", "neverExpire"]);

const policyFileSchema = z
  .object({
    extraction: z.object({ enabled: z.boolean() }).strict(),
    roles: z.object({ requireTrust: z.boolean() }).strict(),
    sensitiveData: z.object({ action: SensitiveAction }).strict(),
    lifecycle: z.object({ default: RetentionDefault }).strict(),
    retrieval: z.object({ reranking: z.boolean(), diversity: z.boolean() }).strict(),
    provenance: z.object({ required: z.boolean() }).strict(),
  })
  .strict();

export function defaultMemoryPolicy(): MemoryPolicy {
  return {
    extraction: { enabled: true },
    roles: { requireTrust: true },
    sensitiveData: { action: "redact" },
    lifecycle: { default: "decaying" },
    retrieval: { reranking: true, diversity: true },
    provenance: { required: true },
  };
}

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
    retrieval: { ...defaults.retrieval, ...(isRecord(value.retrieval) ? value.retrieval : {}) },
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
  const provenanceRequired = boolEnv(env, "REMEMBRA_PROVENANCE_REQUIRED");
  const sensitive = env.REMEMBRA_SENSITIVE_POLICY?.trim();
  const lifecycle = env.REMEMBRA_LIFECYCLE_DEFAULT?.trim();

  if (extractionEnabled !== undefined) merged.extraction = { ...(merged.extraction as object), enabled: extractionEnabled };
  if (requireTrust !== undefined) merged.roles = { ...(merged.roles as object), requireTrust };
  if (reranking !== undefined) merged.retrieval = { ...(merged.retrieval as object), reranking };
  if (diversity !== undefined) merged.retrieval = { ...(merged.retrieval as object), diversity };
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
