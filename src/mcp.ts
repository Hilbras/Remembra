import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryService, type AgentReadOptions } from "./service.js";
import { MemoryStore } from "./store.js";
import { VERSION } from "./version.js";
import { logEvent } from "./log.js";
import { toolFail } from "./errors.js";
import { contextInputShape } from "./context.js";
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
} from "./types.js";

/** Version of the stable MCP tool surface. */
export const MCP_TOOLS_VERSION = 2 as const;

/**
 * Canonical tool names. Existing V4.9 names remain canonical; V5 adds
 * `memory_context` without renaming or removing any existing tool.
 */
export const MCP_TOOL_NAMES = [
  "memory_store",
  "memory_batch",
  "memory_digest",
  "memory_maintain",
  "memory_search",
  "memory_context",
  "memory_list",
  "memory_forget",
  "memory_get",
  "memory_relate",
  "memory_history",
  "memory_update",
  "memory_archive",
  "memory_revive",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Construct an MCP server with the complete stable tool manifest. */
export function createMcpServer(service: MemoryService, requestOptions: AgentReadOptions = {}): McpServer {
  // The service performs the centralized authorization decision at each tool
  // call. Do not require write capability just to construct a read-only server.
  const server = new McpServer({ name: "remembra", version: VERSION });
  const scoped = requestOptions;

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
        const result = await service.store(args, scoped);
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
        const result = await service.batch(args, scoped);
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
        "them automatically (exact and near-identical duplicates are skipped; changed " +
        "quantities go to the LLM merge). Call at the end of a session with " +
        "the transcript or a detailed summary of it. Requires REMEMBRA_LLM + an API key.",
      inputSchema: digestInputShape,
    },
    async (args) => {
      try {
        const result = await service.digest({ ...DigestInput.parse(args), ...scoped });
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
        const result = await service.maintain(scoped);
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
        const result = await service.search({ ...args, ...scoped });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  server.registerTool(
    "memory_context",
    {
      title: "Build bounded memory context",
      description:
        "Assemble a deterministic, token-bounded context from ranked memories. " +
        "The response includes selected memories, rendered context, token count, and retrieval metadata.",
      inputSchema: contextInputShape,
    },
    async (args) => {
      try {
        const result = await service.context(args, scoped);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
        const result = await service.list({ ...args, ...scoped });
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
        const result = await service.forget(id, scoped);
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
        const result = await service.get(id, scoped);
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
        const result = await service.relate(args, scoped);
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
        const result = await service.history(args, scoped);
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
        const result = await service.update(id, patch, scoped);
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
        const result = await service.archive(id, scoped);
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
        const result = await service.revive(id, scoped);
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        return toolFail(err);
      }
    },
  );

  return server;
}

/** Start the standard stdio transport used by the CLI. */
export async function startMcp(service: MemoryService, requestOptions: AgentReadOptions = {}): Promise<void> {
  const server = createMcpServer(service, requestOptions);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const rootNote = process.env.REMEMBRA_DEBUG ? ` (root: ${MemoryStore.defaultRoot()})` : "";
  logEvent(
    "info",
    "mcp_listening",
    { ...(rootNote ? { root: MemoryStore.defaultRoot() } : {}) },
    `Remembra MCP server running${rootNote}`,
  );
}
