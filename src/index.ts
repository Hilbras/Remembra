#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { logEvent } from "./log.js";
import { MemoryStore } from "./store.js";
import { SqliteBackend } from "./sqlite-backend.js";
import { render } from "./store.js";
import { MemoryService } from "./service.js";
import { createHttpServer } from "./http.js";
import { startMcp } from "./mcp.js";
import { createOperatorTenantContext, tenantModeFromEnv } from "./operator.js";
import { validateStartupConfiguration, validateStorageRoot } from "./startup-validation.js";
import { FileRecoveryStateStore } from "./recovery-state-store.js";
import { FileBatchIdempotencyStore } from "./batch-idempotency-store.js";
import { selectInitialBackend } from "./backend-selection.js";
import {
  analyzeTenantSnapshot,
  createTenantSnapshotPlan,
  tenantSnapshotPlanJson,
  verifyTenantSnapshotPlan,
} from "./tenant-snapshot-migration.js";
import { tenantFilterFromContext } from "./tenant.js";
import { readSignedSnapshotFile, writeSignedSnapshotFile } from "./recovery.js";
import { backupSqlite, restoreSqliteBackup, verifySqliteBackup } from "./sqlite-recovery.js";
import { FileMigrationStateStore, publishTenantMigration, runDurableTenantMigration } from "./migration-state.js";
import {
  MemoryType,
  TrustLevel,
  RetentionMode,
  ProvenanceSchema,
  RelationKind,
  type Memory,
  type Provenance,
  type Relation,
} from "./types.js";

const root = MemoryStore.defaultRoot();
const tenantMode = tenantModeFromEnv();
const operatorTenant = tenantMode === "strict" ? createOperatorTenantContext() : undefined;
const operatorOptions = operatorTenant ? { tenant: operatorTenant } : {};
const operatorFilter = operatorTenant ? tenantFilterFromContext(operatorTenant) : undefined;
const startup = validateStartupConfiguration({
  env: process.env,
  tenantMode,
  tenant: operatorTenant,
});
const validatedRoot = await validateStorageRoot(root);
const backendSelection = await selectInitialBackend(validatedRoot);
const store = backendSelection.store;
const operatorSnapshotKey = startup.snapshotKey;
const argv = process.argv.slice(2);
const service = new MemoryService(store, {
  tenantMode,
  backend: backendSelection.backend,
  backendFallback: backendSelection.fallback,
  policy: startup.policy,
  embeddingProvider: startup.embeddingProvider,
  llmProvider: startup.llmProvider,
  ...(operatorSnapshotKey ? { snapshotKey: operatorSnapshotKey } : {}),
  recoveryStateStore: new FileRecoveryStateStore(path.join(validatedRoot, ".recovery-state.json")),
  batchIdempotencyStore: new FileBatchIdempotencyStore(path.join(validatedRoot, ".idempotency")),
});
await service.initializeRecovery();
const initialHealth = await service.health();
const isRecoveryCommand = argv[0] === "recover" && (argv[1] === "verify" || argv[1] === "read-only");
if (initialHealth.status === "unready" && !isRecoveryCommand) {
  throw new Error(`initial recovery health check failed: ${initialHealth.storage}`);
}

const httpFlag = argv.includes("--http");
const maintainFlag = argv.includes("maintain");
const portArg = argv.indexOf("--port");
const port = portArg !== -1 ? Number(argv[portArg + 1]) : undefined;
const optionValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv[0] === "recover" && argv[1] === "read-only") {
  try {
    await service.enterReadOnly();
    console.log(JSON.stringify({ state: "ReadOnly", durable: true }));
    process.exit(0);
  } catch (err) {
    console.error(`Read-only transition failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
} else if (argv[0] === "recover" && argv[1] === "verify") {
  try {
    await service.verifyRecovery();
    const health = await service.health();
    console.log(JSON.stringify({ state: health.state, verified: true, durable: true }));
    process.exit(0);
  } catch (err) {
    console.error(`Recovery verification failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
} else if (argv[0] === "export") {
  // CLI backup: `remembra export <file.json>` — full snapshot incl. archived.
  const out = argv[1];
  if (!out) {
    console.error("Usage: remembra export <file.json>");
    process.exit(1);
  }
  const snapshot = await service.exportSnapshot(operatorOptions);
  if (operatorSnapshotKey) {
    await writeSignedSnapshotFile(out, snapshot, operatorSnapshotKey, { overwrite: true });
  } else {
    await fs.writeFile(out, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  console.log(`Exported ${snapshot.memories.length} memories to ${out}`);
  process.exit(0);
} else if (argv[0] === "import") {
  // CLI restore: `remembra import <file.json>` — validates whole file first,
  // then skips existing ids/duplicates (idempotent re-import).
  const input = argv[1];
  if (!input) {
    console.error("Usage: remembra import <file.json> [--dry-run]");
    process.exit(1);
  }
  const dryRun = argv.includes("--dry-run");
  let data: unknown;
  try {
    data = operatorSnapshotKey
      ? await readSignedSnapshotFile(input, operatorSnapshotKey)
      : JSON.parse(await fs.readFile(input, "utf8"));
  } catch (err) {
    console.error(`Cannot read snapshot ${input}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  try {
    if (dryRun) {
      const preview = await service.previewSnapshot(data, operatorOptions);
      console.log(`Import dry-run: ${preview.imported} would import, ${preview.skipped} would skip (${preview.total} total)`);
    } else {
      const result = await service.importSnapshot(data, operatorOptions);
      console.log(`Import: ${result.imported} imported, ${result.skipped} skipped`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Import failed; verify the primary store before retrying: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
} else if (argv[0] === "export-markdown") {
    // V4.3.0: dump active memories as human-readable .md files.
    if (tenantMode === "strict") {
      console.error("export-markdown requires the dedicated tenant-aware snapshot workflow in strict mode");
      process.exit(1);
    }
    const outDir = argv[1];
    if (!outDir) {
      console.error("Usage: remembra export-markdown <directory>");
      process.exit(1);
    }
    const memories = await store.all(false, operatorFilter);
    await fs.mkdir(outDir, { recursive: true });
    for (const m of memories) {
      const scopeDir = m.scope === "global" ? outDir : path.join(outDir, m.scope);
      await fs.mkdir(scopeDir, { recursive: true });
      await fs.writeFile(path.join(scopeDir, `${m.id}.md`), render(m), "utf8");
    }
    console.log(`Exported ${memories.length} memories to ${outDir}`);
    process.exit(0);
  } else if (argv[0] === "import-markdown") {
    // V4.3.0: import .md files into the SQLite store.
    if (tenantMode === "strict") {
      console.error("import-markdown requires the dedicated tenant-aware snapshot workflow in strict mode");
      process.exit(1);
    }
    const inDir = argv[1];
    if (!inDir) {
      console.error("Usage: remembra import-markdown <directory>");
      process.exit(1);
    }
    service.assertWritable();
    const files = await globMdFiles(inDir);
    const memories: Memory[] = [];
    let skipped = 0;
    for (const file of files) {
      try {
        const mem = await parseMarkdownFile(file);
        if (!mem) { skipped++; continue; }
        memories.push(operatorTenant
          ? {
              ...mem,
              tenantId: operatorTenant.principal.organizationId,
              ...(operatorTenant.principal.projectId ? { projectId: operatorTenant.principal.projectId } : {}),
              ...(operatorTenant.principal.userId ? { userId: operatorTenant.principal.userId } : {}),
              ...(operatorTenant.principal.agentId ? { agentId: operatorTenant.principal.agentId } : {}),
            }
          : mem);
      } catch { skipped++; }
    }
    let imported = 0;
    let batchSkipped = 0;
    if (memories.length > 0) {
      if (store.importBatch) {
        const result = await store.importBatch(memories, operatorFilter);
        imported = result.imported;
        batchSkipped = result.skipped;
      } else {
        for (const memory of memories) {
          if (await store.importMemory(memory, operatorFilter)) imported++;
          else batchSkipped++;
        }
      }
    }
    console.log(`Imported ${imported}, skipped ${skipped + batchSkipped}`);
    process.exit(0);
  } else if (argv[0] === "backup") {
    if (tenantMode === "strict") {
      console.error("backup requires the dedicated tenant-aware recovery workflow in strict mode");
      process.exit(1);
    }
    // V4.3.0: copy DB + write SHA-256 sidecar.
    const outFile = argv[1];
    if (!outFile) {
      console.error("Usage: remembra backup <file.sqlite>");
      process.exit(1);
    }
    if (!(store instanceof SqliteBackend)) {
      console.error("backup requires SQLite backend");
      process.exit(1);
    }
    const src = (store as SqliteBackend).getDbPath();
    await backupSqlite(src, outFile, { overwrite: true });
    const hash = createHash("sha256").update(await fs.readFile(outFile)).digest("hex");
    await fs.writeFile(`${outFile}.sha256`, hash, { encoding: "utf8", mode: 0o600 });
    console.log(`Backup: ${outFile} (${hash.slice(0, 16)}…)`);
    process.exit(0);
  } else if (argv[0] === "restore") {
    if (tenantMode === "strict") {
      console.error("restore requires the dedicated tenant-aware recovery workflow in strict mode");
      process.exit(1);
    }
    // V4.3.0: verify SHA-256 and atomically replace DB.
    const inFile = argv[1];
    if (!inFile) {
      console.error("Usage: remembra restore <file.sqlite>");
      process.exit(1);
    }
    let expected: string;
    try {
      expected = (await fs.readFile(`${inFile}.sha256`, "utf8")).trim();
      const actual = createHash("sha256").update(await fs.readFile(inFile)).digest("hex");
      if (actual !== expected) throw new Error("checksum mismatch");
      await verifySqliteBackup(inFile);
    } catch (err) {
      console.error(`Restore verification failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    if (!(store instanceof SqliteBackend)) {
      console.error("restore requires SQLite backend");
      process.exit(1);
    }
    const dst = (store as SqliteBackend).getDbPath();
    (store as SqliteBackend).close();
    try {
      await restoreSqliteBackup(inFile, dst, { overwrite: true });
    } catch (err) {
      console.error(`Restore aborted: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    console.log(`Restored from ${inFile}`);
    process.exit(0);
  } else if (argv[0] === "migrate" && argv[1] === "plan") {
    const input = argv[2];
    const out = optionValue("--out");
    if (!input || !out) {
      console.error("Usage: remembra migrate plan <snapshot.json> --out <plan.json> [--source-namespace <name>]");
      process.exit(1);
    }
    if (tenantMode !== "strict" || !operatorTenant || !operatorSnapshotKey) {
      console.error("migrate plan requires strict mode, REMEMBRA_TENANT_ID, and REMEMBRA_SNAPSHOT_KEY");
      process.exit(1);
    }
    try {
      const snapshot = JSON.parse(await fs.readFile(input, "utf8"));
      const plan = createTenantSnapshotPlan(snapshot, operatorSnapshotKey, {
        targetOrganizationId: operatorTenant.principal.organizationId,
        sourceNamespace: optionValue("--source-namespace") ?? "legacy-root",
      });
      await fs.writeFile(out, tenantSnapshotPlanJson(plan), { encoding: "utf8", mode: 0o600 });
      console.log(JSON.stringify({
        plan: out,
        targetOrganizationId: plan.targetOrganizationId,
        records: plan.records.length,
        requiresExplicitMigration: true,
      }, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`migrate plan failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else if (argv[0] === "migrate" && argv[1] === "apply") {
    const input = argv[2];
    const planPath = optionValue("--plan");
    if (!input || !planPath) {
      console.error("Usage: remembra migrate apply <snapshot.json> --plan <plan.json> [--dry-run]");
      process.exit(1);
    }
    if (tenantMode !== "strict" || !operatorTenant || !operatorSnapshotKey) {
      console.error("migrate apply requires strict mode, REMEMBRA_TENANT_ID, and REMEMBRA_SNAPSHOT_KEY");
      process.exit(1);
    }
    try {
      const snapshot = JSON.parse(await fs.readFile(input, "utf8"));
      const planValue = JSON.parse(await fs.readFile(planPath, "utf8"));
      const plan = verifyTenantSnapshotPlan(planValue, snapshot, operatorSnapshotKey);
      if (argv.includes("--dry-run")) {
        const result = await service.migrateSnapshot(snapshot, plan, operatorSnapshotKey, {
          tenant: operatorTenant,
          dryRun: true,
        });
        console.log(JSON.stringify(result, null, 2));
      } else {
        const stateStore = new FileMigrationStateStore(path.join(validatedRoot, ".tenant-migration-state.json"));
        const result = await runDurableTenantMigration(plan, store, operatorSnapshotKey, {
          stateStore,
          destinationFilter: operatorFilter,
        });
        const wasAlreadyPublished = result.state.status === "published";
        const published = wasAlreadyPublished
          ? result.state
          : await publishTenantMigration(result.state.planId, stateStore);
        console.log(JSON.stringify({
          total: plan.records.length,
          planned: plan.records.length,
          imported: wasAlreadyPublished ? 0 : result.imported,
          skipped: wasAlreadyPublished ? plan.records.length : result.skipped,
          dryRun: false,
          durable: true,
          state: published.status,
        }, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(`migrate apply failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else if (argv[0] === "migrate" && argv[1] === "analyze") {
    const input = argv[2];
    if (!input) {
      console.error("Usage: remembra migrate analyze <snapshot.json>");
      process.exit(1);
    }
    if (!operatorSnapshotKey) {
      console.error("migrate analyze requires REMEMBRA_SNAPSHOT_KEY");
      process.exit(1);
    }
    try {
      const report = analyzeTenantSnapshot(JSON.parse(await fs.readFile(input, "utf8")), operatorSnapshotKey);
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`migrate analyze failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else if (argv[0] === "migrate") {
    if (tenantMode === "strict") {
      console.error("migrate requires the signed tenant migration workflow in strict mode");
      process.exit(1);
    }
    // V4.3.0: explicit manual migration from legacy flat files.
    if (!(store instanceof SqliteBackend)) {
      console.error("migrate requires SQLite backend");
      process.exit(1);
    }
    service.assertWritable();
    try {
      const result = await (store as SqliteBackend).migrate();
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`migrate failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else if (argv[0] === "audit") {
    // V4.4.0: query audit events.
    const limit = Number(argv[1]) || 50;
    const since = argv[2] || undefined;
    if (!(store instanceof SqliteBackend)) {
      console.error("audit requires SQLite backend");
      process.exit(1);
    }
    const result = await service.getAudit({ limit, since }, operatorOptions);
    console.log(JSON.stringify({ events: result.events, count: result.events.length }, null, 2));
    process.exit(0);
  } else if (maintainFlag) {
  // CLI maintenance: `remembra maintain` — one-shot, prints JSON, exits.
  const result = await service.maintain(operatorOptions);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} else if (argv[0] === "encrypt" || argv[0] === "decrypt") {
  if (tenantMode === "strict") {
    console.error("encryption migration requires the dedicated tenant-aware recovery workflow in strict mode");
    process.exit(1);
  }
  // CLI encryption migration (audit Phase 8): rewrite the tree in place
  // under the storage lock. Requires REMEMBRA_ENCRYPT_KEY either way.
  //   remembra encrypt   → plain files become AES-256-GCM ciphertext
  //   remembra decrypt   → ciphertext becomes plain markdown again
  service.assertWritable();
  try {
    if ("migrateEncryption" in store) {
      const result = await store.migrateEncryption(argv[0]);
      console.log(`${argv[0]}: ${result.converted} converted, ${result.skipped} already in target state`);
    } else {
      console.error(`${argv[0]} not supported on SQLite backend`);
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error(`${argv[0]} failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
} else if (httpFlag) {
  // HTTP mode: long-running API for non-MCP clients (ChatGPT, scripts, ...).
  const httpServer = createHttpServer(service, {
    port,
    apiKey: process.env.REMEMBRA_API_KEY,
    ...(operatorTenant ? { resolveTenantContext: () => operatorTenant } : {}),
  });
  // Graceful shutdown: stop accepting, drain in-flight requests, then exit.
  const shutdown = (sig: string) => {
    logEvent("info", "shutdown", { signal: sig }, `Remembra: received ${sig}, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} else {
  // MCP mode (default): stdio transport launched by an MCP client.
  await startMcp(service, operatorOptions);
}

// -------------------------------------------------------------------------
//  Markdown helpers (V4.3.0 export/import)
// -------------------------------------------------------------------------

async function globMdFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".md")) result.push(full);
    }
  }
  await walk(dir);
  return result;
}

async function parseMarkdownFile(file: string): Promise<Memory | null> {
  const raw = (await fs.readFile(file)).toString("utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return null;
  let meta: Record<string, unknown>;
  try {
    const doc = parseYaml(match[1]);
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
      meta = doc as Record<string, unknown>;
    } else if (match[1].trim() === "") {
      meta = {};
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const baseId = path.basename(file, ".md");
  const id = (meta.id ? String(meta.id) : baseId) as string;
  const type = (meta.type ? String(meta.type) : "fact") as MemoryType;
  if (!MemoryType.options.includes(type)) return null;
  const scope = (meta.scope ? String(meta.scope) : "global") as string;
  if (!scope || /\/|\.\./.test(scope)) return null;
  const content = match[2].trim();
  if (!content) return null;
  const tags: string[] = Array.isArray(meta.tags)
    ? (meta.tags as unknown[]).map((t) => String(t)).filter(Boolean)
    : typeof meta.tags === "string"
      ? (meta.tags as string).replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean)
      : [];
  const impNum = Number(meta.importance ?? 3);
  const importance = Number.isFinite(impNum) ? Math.min(5, Math.max(1, Math.round(impNum))) : 3;
  const confFallback = (() => {
    const p = meta.provenance;
    if (typeof p === "object" && p !== null && "sourceType" in p) {
      return (p as { sourceType: string }).sourceType === "conversation" ? 0.7 : 1;
    }
    return 1;
  })();
  const confNum = Number(meta.confidence);
  const confidence = Number.isFinite(confNum) ? Math.min(1, Math.max(0, confNum)) : confFallback;
  const trustRaw = meta.trust ? String(meta.trust) : undefined;
  const trust = TrustLevel.options.includes(trustRaw as TrustLevel) ? (trustRaw as TrustLevel) : "trusted";
  let provenance: Provenance = { sourceType: "manual" };
  if (meta.provenance) {
    if (typeof meta.provenance === "object" && !Array.isArray(meta.provenance)) {
      const parsed = ProvenanceSchema.safeParse(meta.provenance);
      if (parsed.success) provenance = parsed.data;
    }
  }
  const retentionRaw = meta.retention ? String(meta.retention) : undefined;
  const retention = RetentionMode.options.includes(retentionRaw as RetentionMode) ? (retentionRaw as RetentionMode) : undefined;
  const relationsRaw = meta.relations;
  let relations: Relation[] | undefined = undefined;
  if (Array.isArray(relationsRaw)) {
    relations = (relationsRaw as Array<unknown>)
      .map((e: unknown) => {
        if (typeof e === "object" && e !== null) {
          const o = e as Record<string, unknown>;
          return { id: String(o.id ?? o[0] ?? ""), kind: String(o.kind ?? o[1] ?? "related") as RelationKind };
        }
        return null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.id.length > 0);
    if (relations.length === 0) relations = undefined;
  }
  const createdAt = meta.created ? String(meta.created) : new Date().toISOString();
  const updatedAt = meta.updated ? String(meta.updated) : createdAt;
  const lastSeen = meta.lastSeen ? String(meta.lastSeen) : undefined;
  const archivedAt = meta.archivedAt ? String(meta.archivedAt) : undefined;
  const embeddingRaw = meta.embedding;
  const embedding: number[] | undefined =
    typeof embeddingRaw === "string" && embeddingRaw.length > 0
      ? embeddingRaw.split(",").map((s) => parseFloat(s)).filter((n) => Number.isFinite(n))
      : undefined;
  const revision = meta.revision !== undefined ? Math.max(1, Math.round(Number(meta.revision))) : 1;
  return {
    id, type, content, scope, tags, importance, confidence, trust, provenance,
    retention, relations, version: revision, createdAt, updatedAt,
    ...(lastSeen ? { lastSeen } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(embedding ? { embedding } : {}),
  } as Memory;
}
