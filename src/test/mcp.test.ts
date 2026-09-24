import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { createTenantContext } from "../tenant.js";
import {
  createMcpServer,
  MCP_TOOL_NAMES,
  MCP_TOOLS_VERSION,
} from "../mcp.js";

test("MCP manifest lists the stable V4.9 plus V5 context tool set", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-mcp-"));
  const service = new MemoryService(new MemoryStore(dir));
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "remembra-test", version: "1.0.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(MCP_TOOLS_VERSION, 2);
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...MCP_TOOL_NAMES]);
    assert.equal(new Set(listed.tools.map((tool) => tool.name)).size, MCP_TOOL_NAMES.length);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP strict mode binds a host tenant context to every tool", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-mcp-tenant-"));
  const tenant = createTenantContext({
    organizationId: "org-a",
    membershipVersion: "membership-1",
    scopes: ["global"],
    capabilities: ["tenant:read", "tenant:write"],
  });
  const service = new MemoryService(new MemoryStore(dir), { tenantMode: "strict", embeddingProvider: "none" });
  const server = createMcpServer(service, { tenant });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "remembra-test", version: "1.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const stored = await client.callTool({
      name: "memory_store",
      arguments: { type: "fact", content: "MCP tenant memory" },
    });
    assert.ok(!stored.isError);
    const found = await client.callTool({ name: "memory_search", arguments: { query: "tenant" } });
    assert.ok(!found.isError);
    assert.match(JSON.stringify(found.content), /MCP tenant memory/);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
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
    const context = await client.callTool({
      name: "memory_context",
      arguments: { query: "manifest", maxTokens: 200 },
    });
    assert.ok(!context.isError);
    assert.match(JSON.stringify(context.content), /tokenCount/);
  } finally {
    await client.close();
    await server.close();
  }
});
