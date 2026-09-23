#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "./store.js";
import { search } from "./retrieval.js";
import { StoreInput } from "./types.js";

const store = new MemoryStore(MemoryStore.defaultRoot());

const server = new McpServer({ name: "remembra", version: "0.1.0" });

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
  async ({ type, content, scope, tags, importance, source }) => {
    const memory = await store.store(
      StoreInput.parse({ type, content, scope, tags, importance, source }),
    );
    return { content: [{ type: "text", text: `Stored ${memory.type} memory ${memory.id} (scope: ${memory.scope})` }] };
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
  async ({ query, scope, type, limit }) => {
    const results = search(await store.all(), { query, scope, type, limit });
    const text =
      results.length === 0
        ? "No matching memories."
        : results
            .map(
              (m) =>
                `[${m.id}] ${m.type.toUpperCase()} (scope: ${m.scope}, importance: ${m.importance}, ${m.updatedAt.slice(0, 10)})\n${m.content}`,
            )
            .join("\n\n");
    return { content: [{ type: "text", text }] };
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
    },
  },
  async ({ scope, type }) => {
    let memories = await store.all();
    if (scope) memories = memories.filter((m) => m.scope === scope || m.scope === "global");
    if (type) memories = memories.filter((m) => m.type === type);
    memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const text =
      memories.length === 0
        ? "No memories stored yet."
        : memories.map((m) => `[${m.id}] ${m.type} (${m.scope}): ${m.content.split("\n")[0]}`).join("\n");
    return { content: [{ type: "text", text }] };
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
    const ok = await store.forget(id);
    return {
      content: [{ type: "text", text: ok ? `Deleted memory ${id}.` : `No memory with id ${id}.` }],
      isError: !ok,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Remembra memory server running (root: ${MemoryStore.defaultRoot()})`);
