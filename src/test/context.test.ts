import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { defaultTokenCounter, selectContextMemories } from "../context.js";
import { RemembraError } from "../errors.js";

async function service(): Promise<MemoryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-context-"));
  return new MemoryService(new MemoryStore(dir));
}

test("context selection is deterministic and never exceeds the token budget", async () => {
  const memoryService = await service();
  await memoryService.store({ type: "fact", content: "The project uses a bounded context API." });
  await memoryService.store({ type: "decision", content: "Prefer deterministic retrieval ordering." });

  const result = await memoryService.context({ query: "bounded context", maxTokens: 80 });
  assert.ok(result.tokenCount <= 80);
  assert.equal(result.tokenCount, defaultTokenCounter.count(result.context));
  assert.equal(result.memories.every((memory) => !("embedding" in memory)), true);
  assert.equal(result.retrievalMetadata.candidateCount, 2);
  assert.equal(
    result.retrievalMetadata.selectedCount + result.retrievalMetadata.omittedCount,
    result.retrievalMetadata.candidateCount,
  );
  assert.match(result.context, /bounded context API|deterministic retrieval/);
});

test("context accepts an injected token counter", async () => {
  const memoryService = new MemoryService(new MemoryStore(await fs.mkdtemp(path.join(os.tmpdir(), "remembra-counter-"))), {
    tokenCounter: { id: "test-counter", count: () => 10_000 },
  });
  await memoryService.store({ type: "fact", content: "This memory cannot fit." });
  const result = await memoryService.context({ maxTokens: 100 });
  assert.equal(result.context, "");
  assert.equal(result.tokenCount, 0);
  assert.equal(result.retrievalMetadata.tokenCounter, "test-counter");
  assert.equal(result.retrievalMetadata.omittedCount, 1);
});

test("context is read-only and rejects invalid budgets", async () => {
  const memoryService = await service();
  const stored = await memoryService.store({ type: "fact", content: "Read-only context selection." });
  const before = await memoryService.get(stored.id);
  const result = await memoryService.context({ maxTokens: 500 });
  assert.equal(result.memories[0].id, stored.id);
  const after = await memoryService.get(stored.id);
  assert.equal(after.memory.lastSeen, before.memory.lastSeen);

  await assert.rejects(
    () => memoryService.context({ maxTokens: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof RemembraError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
});

test("context preserves trusted agent isolation", async () => {
  const memoryService = new MemoryService(
    new MemoryStore(await fs.mkdtemp(path.join(os.tmpdir(), "remembra-context-agent-"))),
    { agentMode: true },
  );
  const agentA = { agentId: "agent-a", scopes: ["project"] };
  const agentB = { agentId: "agent-b", scopes: ["project"] };
  await memoryService.store(
    {
      type: "fact",
      content: "Agent A private context",
      scope: "project",
      access: "private",
      owner: "agent",
      provenance: { sourceType: "agent", agentId: "agent-a" },
    },
    { agent: agentA },
  );
  const own = await memoryService.context({ query: "private" }, { agent: agentA });
  assert.match(own.context, /Agent A private context/);
  const foreign = await memoryService.context({ query: "private" }, { agent: agentB });
  assert.doesNotMatch(foreign.context, /Agent A private context/);
});

test("context selection handles empty and oversized candidate sets", () => {
  assert.deepEqual(selectContextMemories([], 10), {
    memories: [],
    context: "",
    tokenCount: 0,
    omittedCount: 0,
  });
  const memory = {
    id: "m1",
    type: "fact" as const,
    content: "x".repeat(100),
    scope: "global",
    importance: 3,
    confidence: 1,
    trust: "trusted" as const,
    tags: [],
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: { sourceType: "manual" as const },
  };
  const result = selectContextMemories([memory], 1);
  assert.equal(result.memories.length, 0);
  assert.equal(result.omittedCount, 1);
});
