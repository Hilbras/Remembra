import { verifySignedSnapshot } from "./snapshot-integrity.js";

export interface TenantSnapshotAnalysis {
  format: "remembra-tenant-snapshot-analysis";
  version: 1;
  sourceFormat: string;
  sourceSchemaVersion: number;
  total: number;
  tenantless: number;
  tenantBound: number;
  mixed: boolean;
  organizations: string[];
  requiresExplicitMigration: boolean;
  estimatedBytes: number;
}

/** Analyze a signed V5 snapshot without reading or mutating a destination store. */
export function analyzeTenantSnapshot(data: unknown, key: Buffer | Uint8Array): TenantSnapshotAnalysis {
  const snapshot = verifySignedSnapshot(data, key);
  const organizations = new Set<string>();
  let tenantless = 0;
  let tenantBound = 0;
  for (const memory of snapshot.memories) {
    if (memory.tenantId) {
      tenantBound++;
      organizations.add(memory.tenantId);
    } else {
      tenantless++;
    }
  }
  return {
    format: "remembra-tenant-snapshot-analysis",
    version: 1,
    sourceFormat: snapshot.format,
    sourceSchemaVersion: snapshot.version,
    total: snapshot.memories.length,
    tenantless,
    tenantBound,
    mixed: tenantless > 0 && tenantBound > 0,
    organizations: [...organizations].sort(),
    requiresExplicitMigration: tenantless > 0,
    estimatedBytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  };
}
