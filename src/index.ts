#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse as parseYaml } from "yaml";
import { VERSION } from "./version.js";
import { logEvent } from "./log.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore } from "./store.js";
import { SqliteBackend } from "./sqlite-backend.js";
import { render } from "./store.js";
import { MemoryService } from "./service.js";
import { createHttpServer } from "./http.js";
import {
  DigestInput,
  storeInputShape,
  digestInputShape,
  searchInputShape,
  listInputShape,
  forgetInputShape,
  getInputShape,
  relateInputShape,
  historyInputShape,
  updateInputShape,
  batchInputShape,
  MemoryType,
  TrustLevel,
  RetentionMode,
  ProvenanceSchema,
  RelationKind,
  type Memory,
  type Provenance,
  type Relation,
} from "./types.js";
import { toolFail } from "./errors.js";

const root = MemoryStore.defaultRoot();
// Use SQLite backend (V4.3.0) if available; fall back to file backend.
let store: MemoryStore | SqliteBackend;
try {
  store = new SqliteBackend({ root });
} catch {
  store = new MemoryStore(root);
}
const service = new MemoryService(store);

const argv = process.argv.slice(2);
const httpFlag = argv.includes("--http");
const maintainFlag = argv.includes("maintain");
const portArg = argv.indexOf("--port");
const port = portArg !== -1 ? Number(argv[portArg + 1]) : undefined;

if (argv[0] === "export") {
  // CLI backup: `remembra export <file.json>` — full snapshot incl. archived.
  const out = argv[1];
  if (!out) {
    console.error("Usage: remembra export <file.json>");
    process.exit(1);
  }
  const snapshot = await service.exportSnapshot();
  await fs.writeFile(out, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`Exported ${snapshot.memories.length} memories to ${out}`);
  process.exit(0);
} else if (argv[0] === "import") {
  // CLI restore: `remembra import <file.json>` — validates whole file first,
  // then skips existing ids/duplicates (idempotent re-import).
  const input = argv[1];
  if (!input) {
    console.error("Usage: remembra import <file.json>");
    process.exit(1);
  }
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(input, "utf8"));
  } catch (err) {
    console.error(`Cannot read snapshot ${input}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  try {
    const result = await service.importSnapshot(data);
    console.log(`Import: ${result.imported} imported, ${result.skipped} skipped`);
    process.exit(0);
  } catch (err) {
    console.error(`Import rejected (nothing written): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
} else if (argv[0] === "export-markdown") {
    // V4.3.0: dump active memories as human-readable .md files.
    const outDir = argv[1];
    if (!outDir) {
      console.error("Usage: remembra export-markdown <directory>");
      process.exit(1);
    }
    const memories = await store.all();
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
    const inDir = argv[1];
    if (!inDir) {
      console.error("Usage: remembra import-markdown <directory>");
      process.exit(1);
    }
    const files = await globMdFiles(inDir);
    let imported = 0, skipped = 0;
    for (const file of files) {
      try {
        const mem = await parseMarkdownFile(file);
        if (!mem) { skipped++; continue; }
        const ok = await store.importMemory(mem);
        if (ok) imported++; else skipped++;
      } catch { skipped++; }
    }
    console.log(`Imported ${imported}, skipped ${skipped}`);
    process.exit(0);
  } else if (argv[0] === "backup") {
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
    await fs.copyFile(src, outFile);
    const hash = createHash("sha256").update(await fs.readFile(outFile)).digest("hex");
    await fs.writeFile(`${outFile}.sha256`, hash, "utf8");
    console.log(`Backup: ${outFile} (${hash.slice(0, 16)}…)`);
    process.exit(0);
  } else if (argv[0] === "restore") {
    // V4.3.0: verify SHA-256 and atomically replace DB.
    const inFile = argv[1];
    if (!inFile) {
      console.error("Usage: remembra restore <file.sqlite>");
      process.exit(1);
    }
    const expected = (await fs.readFile(`${inFile}.sha256`, "utf8")).trim();
    const actual = createHash("sha256").update(await fs.readFile(inFile)).digest("hex");
    if (actual !== expected) {
      console.error("Checksum mismatch — restore aborted");
      process.exit(1);
    }
    if (!(store instanceof SqliteBackend)) {
      console.error("restore requires SQLite backend");
      process.exit(1);
    }
    const dst = (store as SqliteBackend).getDbPath();
    const tmp = dst + ".tmp.restore";
    await fs.copyFile(inFile, tmp);
    await fs.rename(tmp, dst);
    console.log(`Restored from ${inFile}`);
    process.exit(0);
  } else if (argv[0] === "migrate") {
    // V4.3.0: explicit manual migration from legacy flat files.
    if (!(store instanceof SqliteBackend)) {
      console.error("migrate requires SQLite backend");
      process.exit(1);
    }
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
    const events = await (store as SqliteBackend).getAudit({ limit, since });
    console.log(JSON.stringify({ events, count: events.length }, null, 2));
    process.exit(0);
  } else if (maintainFlag) {
  // CLI maintenance: `remembra maintain` — one-shot, prints JSON, exits.
  const result = await service.maintain();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} else if (argv[0] === "encrypt" || argv[0] === "decrypt") {
  // CLI encryption migration (audit Phase 8): rewrite the tree in place
  // under the storage lock. Requires REMEMBRA_ENCRYPT_KEY either way.
  //   remembra encrypt   → plain files become AES-256-GCM ciphertext
  //   remembra decrypt   → ciphertext becomes plain markdown again
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
  await startMcp();
}

async function startMcp(): Promise<void> {
  const server = new McpServer({ name: "remembra", version: VERSION });

  server.registerTool(
    "memory_store",
    {
      title: "Store a memory",
      description:
        "Persist a fact, decision, role or history entry so it survives context window resets. " +
        "Use type 'fact' for stable knowledge, 'decision' for choices already made, " +
        "'role' for standing instructions/roles, 'history' for condensed chronology of past work.",
      inputSchema: storeInputShape,
    },
    async (args) => {
      try {
        const result = await service.store(args);
        return { content: [{ type: "text", text: result.message }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_batch",
    {
      title: "Run a memory batch",
      description:
        "Run a bounded store, update, delete, or selected export batch. Items are validated " +
        "before writes; operational failures are returned per item and are not a transaction.",
      inputSchema: batchInputShape,
    },
    async (args) => {
      try {
        const result = await service.batch(args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_digest",
    {
      title: "Digest a session",
      description:
        "Extract facts, decisions, roles and history from a conversation transcript and store " +
        "them automatically (exact and near-identical duplicates are skipped; changed "
        + "quantities go to the LLM merge). Call at the end of a session with " +
        "the transcript or a detailed summary of it. Requires REMEMBRA_LLM + an API key.",
      inputSchema: digestInputShape,
    },
    async (args) => {
      try {
        const result = await service.digest(DigestInput.parse(args));
        const text =
          `Digest complete: ${result.extracted} extracted, ${result.stored.length} stored, ` +
          `${result.merged} merged/revived, ${result.skippedDuplicates} duplicates skipped.` +
          (result.ids.length ? `\nStored ids: ${result.ids.join(", ")}` : "");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_maintain",
    {
      title: "Run maintenance",
      description:
        "Run maintenance: archive memories unused past REMEMBRA_ARCHIVE_AFTER_DAYS (default 90), " +
        "auto-delete archived memories past REMEMBRA_ARCHIVE_TTL_DAYS (default 365), and backfill " +
        "missing embedding vectors. Roles never decay. Safe to call anytime.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await service.maintain();
        const text =
          `Maintenance complete: ${result.archived.length} archived, ` +
          `${result.deleted.length} deleted, ${result.embedded} vectors backfilled.` +
          (result.archived.length ? `\nArchived: ${result.archived.join(", ")}` : "") +
          (result.deleted.length ? `\nDeleted: ${result.deleted.join(", ")}` : "");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memories",
      description:
        "Retrieve relevant memories from external storage. Call this at the start of a session " +
        "(or whenever prior context might exist) to recover facts, decisions, roles and history.",
      inputSchema: searchInputShape,
    },
    async (args) => {
      try {
        const result = await service.search(args);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memories",
      description:
        "List stored memories, optionally filtered by scope or type; paginate with offset/limit.",
      inputSchema: listInputShape,
    },
    async (args) => {
      try {
        const result = await service.list(args);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Delete a memory",
      description: "Permanently delete a memory by its id.",
      inputSchema: forgetInputShape,
    },
    async ({ id }) => {
      try {
        const result = await service.forget(id);
        return {
          content: [{ type: "text", text: result.text }],
          isError: !result.ok,
        };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "Get a memory",
      description:
        "Fetch one memory by id with its related links and backlinks (memories that point at it). " +
        "Use after memory_search when you need the full statement, not the snippet.",
      inputSchema: getInputShape,
    },
    async ({ id }) => {
      try {
        const result = await service.get(id);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_relate",
    {
      title: "Link memories",
      description:
        "Create or remove directed links between memories (the relationship graph): " +
        "e.g. tie a decision to the facts it depends on, or a history entry to the decision it records. " +
        "Targets must exist; backlinks are visible via memory_get.",
      inputSchema: relateInputShape,
    },
    async (args) => {
      try {
        const result = await service.relate(args);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_history",
    {
      title: "Show memory history",
      description:
        "Version history of one memory with unified line diffs — every content-changing " +
        "update (e.g. a contradiction merge) snapshots the previous version. Newest first.",
      inputSchema: historyInputShape,
    },
    async (args) => {
      try {
        const result = await service.history(args);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update a memory",
      description:
        "Patch an existing memory by id — any subset of type/content/scope/tags/importance/" +
        "confidence/source. Changing scope moves it between trees; a content change refreshes " +
        "its embedding and snapshots the old version into memory_history.",
      inputSchema: updateInputShape,
    },
    async (args) => {
      try {
        const { id, ...patch } = args;
        const result = await service.update(id, patch);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_archive",
    {
      title: "Archive a memory",
      description:
        "Move a memory to the archived tree — out of search results but kept (and listed " +
        "with includeArchived). Prefer this over forgetting when something may be needed again.",
      inputSchema: forgetInputShape,
    },
    async ({ id }) => {
      try {
        const result = await service.archive(id);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_revive",
    {
      title: "Revive an archived memory",
      description: "Bring an archived memory back to active search.",
      inputSchema: forgetInputShape,
    },
    async ({ id }) => {
      try {
        const result = await service.revive(id);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log hygiene (audit #7): filesystem paths only under REMEMBRA_DEBUG.
  const rootNote = process.env.REMEMBRA_DEBUG ? ` (root: MemoryStore.defaultRoot())` : "";
  logEvent("info", "mcp_listening", { ...(rootNote ? { root: MemoryStore.defaultRoot() } : {}) }, `Remembra MCP server running${rootNote}`);
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
