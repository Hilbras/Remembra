#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";
import { createHttpServer } from "./http.js";
import { DigestInput } from "./types.js";

const store = new MemoryStore(MemoryStore.defaultRoot());
const service = new MemoryService(store);

const httpFlag = process.argv.includes("--http");
const maintainFlag = process.argv.includes("maintain");
const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : undefined;

if (maintainFlag) {
  // CLI maintenance: `remembra maintain` — one-shot, prints JSON, exits.
  const result = await service.maintain();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} else if (httpFlag) {
  // HTTP mode: long-running API for non-MCP clients (ChatGPT, scripts, ...).
  createHttpServer(service, {
    port,
    apiKey: process.env.REMEMBRA_API_KEY,
  });
} else {
  // MCP mode (default): stdio transport launched by an MCP client.
  await startMcp();
}

async function startMcp(): Promise<void> {
  const server = new McpServer({ name: "remembra", version: "3.1.0" });

  server.registerTool(
    "memory_store",
    {
      title: "Store a memory",
      description:
        "Persist a fact, decision, role or history entry so it survives context window resets. " +
        "Use type 'fact' for stable knowledge, 'decision' for choices already made, " +
        "'role' for standing instructions/roles, 'history' for condensed chronology of past work.",
      inputSchema: {
        type: z.enum(["fact", "decision", "role", "history"]),
        content: z.string().describe("The memory itself, written as a standalone statement"),
        scope: z
          .string()
          .optional()
          .describe("'global' for always-relevant memories, or a project path/id for project-scoped ones"),
        tags: z.array(z.string()).optional(),
        importance: z.number().int().min(1).max(5).optional().describe("1=minor, 5=critical (default 3)"),
        source: z.string().optional().describe("Originating session or client"),
      },
    },
    async (args) => {
      const result = await service.store(args);
      return { content: [{ type: "text", text: result.message }] };
    },
  );

  server.registerTool(
    "memory_digest",
    {
      title: "Digest a session",
      description:
        "Extract facts, decisions, roles and history from a conversation transcript and store " +
        "them automatically (exact duplicates are skipped). Call at the end of a session with " +
        "the transcript or a detailed summary of it. Requires REMEMBRA_LLM + an API key.",
      inputSchema: {
        transcript: z
          .string()
          .describe("Conversation transcript or a detailed summary of the session"),
        scope: z.string().optional().describe("Scope for extracted memories (default: global)"),
        source: z.string().optional().describe("Originating session/client"),
      },
    },
    async (args) => {
      const result = await service.digest(DigestInput.parse(args));
      const text =
        `Digest complete: ${result.extracted} extracted, ${result.stored.length} stored, ` +
        `${result.merged} merged/revived, ${result.skippedDuplicates} duplicates skipped.` +
        (result.ids.length ? `\nStored ids: ${result.ids.join(", ")}` : "");
      return { content: [{ type: "text", text }] };
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
      const result = await service.maintain();
      const text =
        `Maintenance complete: ${result.archived.length} archived, ` +
        `${result.deleted.length} deleted, ${result.embedded} vectors backfilled.` +
        (result.archived.length ? `\nArchived: ${result.archived.join(", ")}` : "") +
        (result.deleted.length ? `\nDeleted: ${result.deleted.join(", ")}` : "");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memories",
      description:
        "Retrieve relevant memories from external storage. Call this at the start of a session " +
        "(or whenever prior context might exist) to recover facts, decisions, roles and history.",
      inputSchema: {
        query: z.string().optional().describe("Keywords to match (omit to get a scope/recency-ranked list)"),
        scope: z.string().optional().describe("Current project path or workspace id to filter by"),
        type: z.enum(["fact", "decision", "role", "history"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => {
      const result = await service.search(args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memories",
      description: "List stored memories, optionally filtered by scope or type.",
      inputSchema: {
        scope: z.string().optional(),
        type: z.enum(["fact", "decision", "role", "history"]).optional(),
        includeArchived: z.boolean().optional().describe("Include archived memories (flagged)"),
      },
    },
    async (args) => {
      const result = await service.list(args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Delete a memory",
      description: "Permanently delete a memory by its id.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const result = await service.forget(id);
      return {
        content: [{ type: "text", text: result.text }],
        isError: !result.ok,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Remembra MCP server running (root: ${MemoryStore.defaultRoot()})`);
}
