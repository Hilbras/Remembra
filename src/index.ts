#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { createHttpServer } from "./http.js";
import {
  DigestInput,
  storeInputShape,
  digestInputShape,
  searchInputShape,
  listInputShape,
  forgetInputShape,
} from "./types.js";
import { toolFail } from "./errors.js";

const store = new MemoryStore(MemoryStore.defaultRoot());
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
} else if (maintainFlag) {
  // CLI maintenance: `remembra maintain` — one-shot, prints JSON, exits.
  const result = await service.maintain();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} else if (httpFlag) {
  // HTTP mode: long-running API for non-MCP clients (ChatGPT, scripts, ...).
  const httpServer = createHttpServer(service, {
    port,
    apiKey: process.env.REMEMBRA_API_KEY,
  });
  // Graceful shutdown: stop accepting, drain in-flight requests, then exit.
  const shutdown = (sig: string) => {
    console.error(`Remembra: received ${sig}, shutting down`);
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
  const server = new McpServer({ name: "remembra", version: "3.4.0" });

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
      description: "List stored memories, optionally filtered by scope or type.",
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log hygiene (audit #7): filesystem paths only under REMEMBRA_DEBUG.
  const rootNote = process.env.REMEMBRA_DEBUG ? ` (root: ${MemoryStore.defaultRoot()})` : "";
  console.error(`Remembra MCP server running${rootNote}`);
}
