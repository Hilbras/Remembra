import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import {
  createMcpServer,
  MCP_TOOL_NAMES,
  MCP_TOOLS_VERSION,
} from "../mcp.js";

test("MCP manifest lists the stable v1 tool set", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-mcp-"));
  const service = new MemoryService(new MemoryStore(dir));
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "remembra-test", version: "1.0.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(MCP_TOOLS_VERSION, 1);
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...MCP_TOOL_NAMES]);
    assert.equal(new Set(listed.tools.map((tool) => tool.name)).size, MCP_TOOL_NAMES.length);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP store and search tools use the extracted service boundary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-mcp-call-"));
  const service = new MemoryService(new MemoryStore(dir));
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "remembra-test", version: "1.0.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const stored = await client.callTool({
      name: "memory_store",
      arguments: { type: "fact", content: "MCP manifest memory" },
    });
    assert.ok(!stored.isError);
    const found = await client.callTool({
      name: "memory_search",
      arguments: { query: "manifest" },
    });
    assert.ok(!found.isError);
    assert.match(JSON.stringify(found.content), /MCP manifest memory/);
  } finally {
    await client.close();
    await server.close();
  }
});
