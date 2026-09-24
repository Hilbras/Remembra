import { RemembraError } from "./errors.js";
import type { SnapshotInput } from "./types.js";

export interface SnapshotSemanticOptions {
  /** Enforce tenant/dimension and reference rules used by strict V5 restore. */
  strictTenant?: boolean;
  /** Optional serialized-size limit for API/service callers. */
  maxBytes?: number;
}

function invalid(message: string): never {
  throw new RemembraError("SNAPSHOT_INVALID", `snapshot validation: ${message}`);
}

function validDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) invalid(`${label} is not a valid timestamp`);
}

function optionalDate(value: string | undefined, label: string): void {
  if (value !== undefined) validDate(value, label);
}

/** Validate snapshot semantics that are not expressible in the base Zod shape. */
export function validateSnapshotSemantics(
  snapshot: SnapshotInput,
  options: SnapshotSemanticOptions = {},
): void {
  if (options.maxBytes !== undefined) {
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
      invalid("maxBytes must be a positive integer");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      invalid("snapshot is not JSON-serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > options.maxBytes) {
      invalid(`snapshot exceeds ${options.maxBytes} bytes`);
    }
  }

  validDate(snapshot.exportedAt, "exportedAt");
  const ids = new Set<string>();
  for (const memory of snapshot.memories) {
    if (ids.has(memory.id)) invalid(`duplicate memory id ${memory.id}`);
    ids.add(memory.id);
    validDate(memory.createdAt, `memory ${memory.id} createdAt`);
    validDate(memory.updatedAt, `memory ${memory.id} updatedAt`);
    if (Date.parse(memory.createdAt) > Date.parse(memory.updatedAt)) {
      invalid(`memory ${memory.id} createdAt is after updatedAt`);
    }
    optionalDate(memory.lastSeen, `memory ${memory.id} lastSeen`);
    optionalDate(memory.lastValidated, `memory ${memory.id} lastValidated`);
    optionalDate(memory.archivedAt, `memory ${memory.id} archivedAt`);
    optionalDate(memory.validFrom, `memory ${memory.id} validFrom`);
    optionalDate(memory.validUntil, `memory ${memory.id} validUntil`);
    optionalDate(memory.observedAt, `memory ${memory.id} observedAt`);
    optionalDate(memory.meta?.compressionAt, `memory ${memory.id} compressionAt`);

    if (options.strictTenant) {
      if (!memory.tenantId && (memory.projectId || memory.userId || memory.agentId)) {
        invalid(`memory ${memory.id} has tenant dimensions without tenantId`);
      }
      if (memory.relations?.length && memory.related?.length) {
        invalid(`memory ${memory.id} contains both relations and legacy related fields`);
      }
    }

    const references = [
      ...(memory.relations ?? []).map((relation) => relation.id),
      ...(memory.related ?? []),
      ...(memory.supersededBy ? [memory.supersededBy] : []),
      ...(memory.meta?.compressedFrom ?? []),
    ];
    for (const reference of references) {
      if (reference === memory.id) invalid(`memory ${memory.id} contains a self-reference`);
    }
  }
}
