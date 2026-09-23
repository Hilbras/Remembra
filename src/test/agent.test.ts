import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";

async function makeService(agentMode = false): Promise<MemoryService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-agent-"));
  // agentMode is intentionally not public API yet; the test drives the future contract.
  return new MemoryService(new MemoryStore(root), { agentMode } as never);
}

const agentA = { type: "fact", content: "A private research note", scope: "global", access: "private", provenance: { sourceType: "agent", agentId: "agent-a" } } as const;
const agentB = { type: "fact", content: "B private research note", scope: "global", access: "private", provenance: { sourceType: "agent", agentId: "agent-b" } } as const;

async function storeAsAgent(svc: MemoryService, input: unknown, agentId: string) {
  return svc.store(input, { agent: { agentId } });
}

test("agent stores retain full attribution and legacy trust defaults", async () => {
  const svc = await makeService();
  const { memory } = await svc.store({
    ...agentA,
    owner: "agent",
    provenance: {
      sourceType: "agent",
      agentId: "agent-a",
      agentType: "researcher",
      agentVersion: "1.2.0",
      conversationId: "conversation-7",
      taskId: "task-9",
      runId: "run-3",
    },
  });

  assert.equal(memory.trust, "trusted");
  assert.equal(memory.owner, "agent");
  assert.equal(memory.access, "private");
  assert.deepEqual(memory.provenance, {
    sourceType: "agent",
    agentId: "agent-a",
    agentType: "researcher",
    agentVersion: "1.2.0",
    conversationId: "conversation-7",
    taskId: "task-9",
    runId: "run-3",
  });
});

test("agent mode requires trusted attribution for private agent writes", async () => {
  const svc = await makeService(true);
  await assert.rejects(
    () => (svc.store as any)(agentA),
    /verified agent context/,
  );
  const { memory } = await (svc.store as any)(agentA, { agent: { agentId: "agent-a" } });
  assert.equal(memory.provenance.agentId, "agent-a");
  assert.equal(memory.access, "private");
});

test("agent mode search returns only caller-private and global memories", async () => {
  const svc = await makeService(true);
  await storeAsAgent(svc, agentA, "agent-a");
  await storeAsAgent(svc, agentB, "agent-b");
  await svc.store({ type: "fact", content: "Shared project fact", scope: "global", access: "shared" });

  const visible = await (svc.search as any)({ query: "note fact", agent: { agentId: "agent-a" } });
  assert.deepEqual(visible.results.map((m: { content: string }) => m.content).sort(), [
    "A private research note",
    "Shared project fact",
  ]);

  const anonymous = await (svc.search as any)({ query: "note fact" });
  assert.deepEqual(anonymous.results.map((m: { content: string }) => m.content), []);
});

test("agent mode hides private memories from direct reads", async () => {
  const svc = await makeService(true);
  const { memory } = await storeAsAgent(svc, agentA, "agent-a");

  await assert.rejects(() => (svc.get as any)(memory.id, { agent: { agentId: "agent-b" } }), /No memory/);
  const own = await (svc.get as any)(memory.id, { agent: { agentId: "agent-a" } });
  assert.equal(own.memory.id, memory.id);
});

test("agent mode does not disclose private relationship targets", async () => {
  const svc = await makeService(true);
  const { memory: privateMemory } = await storeAsAgent(svc, agentA, "agent-a");
  const { memory: globalMemory } = await svc.store({ type: "fact", content: "Global fact" });
  await (svc.relate as any)({ id: globalMemory.id, action: "add", related: [privateMemory.id] }, { agent: { agentId: "agent-a" } });

  const view = await (svc.get as any)(globalMemory.id, { agent: { agentId: "agent-b" } });
  assert.deepEqual(view.related, [{ id: privateMemory.id, kind: "related", missing: true }]);
});

test("agent mode prevents cross-agent mutation of private memories", async () => {
  const svc = await makeService(true);
  const { memory } = await storeAsAgent(svc, agentA, "agent-a");

  await assert.rejects(
    () => (svc.update as any)(memory.id, { content: "tampered" }, { agent: { agentId: "agent-b" } }),
    /No memory/,
  );
  await assert.rejects(
    () => (svc.forget as any)(memory.id, { agent: { agentId: "agent-b" } }),
    /No memory/,
  );
  assert.equal((await (svc.forget as any)(memory.id, { agent: { agentId: "agent-a" } })).ok, true);
});

test("agent mode blocks relationship, history, and export disclosure", async () => {
  const svc = await makeService(true);
  const { memory: privateMemory } = await storeAsAgent(svc, agentA, "agent-a");
  const { memory: globalMemory } = await svc.store({ type: "fact", content: "Global fact" });

  await assert.rejects(
    () => (svc.relate as any)({ id: globalMemory.id, action: "add", related: [privateMemory.id] }, { agent: { agentId: "agent-b" } }),
    /related target\(s\) not found/,
  );
  await assert.rejects(
    () => (svc.history as any)({ id: privateMemory.id }, { agent: { agentId: "agent-b" } }),
    /No memory/,
  );
  const snapshot = await (svc.exportSnapshot as any)({ agent: { agentId: "agent-b" } });
  assert.deepEqual(snapshot.memories.map((m: { id: string }) => m.id), [globalMemory.id]);
});

test("snapshot round trip preserves agent policy and attribution", async () => {
  const source = await makeService();
  await source.store({
    ...agentA,
    validFrom: "2026-01-01T00:00:00.000Z",
    observedAt: "2025-12-31T00:00:00.000Z",
    provenance: { sourceType: "agent", agentId: "agent-a", agentType: "researcher", taskId: "task-9" },
  });
  const destination = await makeService();
  await destination.importSnapshot(await source.exportSnapshot());

  const { memories } = await destination.list({});
  assert.equal(memories.length, 1);
  assert.equal(memories[0].owner, "agent");
  assert.equal(memories[0].access, "private");
  assert.equal(memories[0].provenance.agentType, "researcher");
  assert.equal(memories[0].provenance.taskId, "task-9");
  assert.equal(memories[0].validFrom, "2026-01-01T00:00:00.000Z");
  assert.equal(memories[0].observedAt, "2025-12-31T00:00:00.000Z");
});

test("agent mode excludes private source memories from compression", async () => {
  const svc = await makeService(true);
  for (let i = 0; i < 3; i++) {
    await storeAsAgent(svc, { ...agentB, content: `B private note ${i}` }, "agent-b");
  }
  const result = await (svc.compress as any)({ type: "fact" }, { agent: { agentId: "agent-a" } });
  assert.deepEqual(result, { compressed: [], sources: [] });
});

test("agent mode enforces council scope on direct access", async () => {
  const svc = await makeService(true);
  const { memory } = await svc.store(
    { type: "decision", content: "Council decision", scope: "council:research", access: "shared" },
    { agent: { agentId: "agent-a", councilId: "research" } },
  );
  await assert.rejects(
    () => (svc.get as any)(memory.id, { agent: { agentId: "agent-a" } }),
    /No memory/,
  );
  const visible = await (svc.get as any)(memory.id, { agent: { agentId: "agent-a", councilId: "research" } });
  assert.equal(visible.memory.id, memory.id);
});

test("file backend persists agent policy across reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-agent-reopen-"));
  const first = new MemoryService(new MemoryStore(root));
  const { memory } = await first.store(agentA);
  const reopened = new MemoryStore(root);
  const got = await reopened.get(memory.id);
  assert.equal(got?.owner, "agent");
  assert.equal(got?.access, "private");
  assert.equal(got?.provenance.agentId, "agent-a");
});

test("agent summaries expose only the verified agent's own attribution", async () => {
  const svc = await makeService(true);
  await storeAsAgent(svc, agentA, "agent-a");
  await storeAsAgent(svc, agentB, "agent-b");

  const own = await (svc.getAgentSummary as any)("agent-a", { agent: { agentId: "agent-a" } });
  assert.equal(own.agentId, "agent-a");
  assert.equal(own.memories.total, 1);
  assert.equal(own.memories.private, 1);
  const quality = await (svc.quality as any)({ agent: { agentId: "agent-a" } });
  assert.equal(quality.memories.active, 1);
  await assert.rejects(
    () => (svc.getAgentSummary as any)("agent-b", { agent: { agentId: "agent-a" } }),
    /No agent/,
  );
});

test("legacy clients keep access to all memories when agent mode is disabled", async () => {
  const svc = await makeService(false);
  await svc.store(agentA);
  const { results } = await svc.search({ query: "private" });
  assert.equal(results.length, 1);
});

test("council decisions use normal scope isolation", async () => {
  const svc = await makeService();
  const { memory } = await svc.store({ type: "decision", content: "Adopt SQLite", scope: "council:research" });
  assert.equal(memory.type, "decision");
  const { results } = await svc.search({ scope: "council:research", query: "SQLite" });
  assert.equal(results.length, 1);
});
