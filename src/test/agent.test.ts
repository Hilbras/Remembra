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

test("agent mode search returns only caller-private and global memories", async () => {
  const svc = await makeService(true);
  await svc.store(agentA);
  await svc.store(agentB);
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
  const { memory } = await svc.store(agentA);

  await assert.rejects(() => (svc.get as any)(memory.id, { agent: { agentId: "agent-b" } }), /No memory/);
  const own = await (svc.get as any)(memory.id, { agent: { agentId: "agent-a" } });
  assert.equal(own.memory.id, memory.id);
});

test("agent mode does not disclose private relationship targets", async () => {
  const svc = await makeService(true);
  const { memory: privateMemory } = await svc.store(agentA);
  const { memory: globalMemory } = await svc.store({ type: "fact", content: "Global fact" });
  await (svc.relate as any)({ id: globalMemory.id, action: "add", related: [privateMemory.id] }, { agent: { agentId: "agent-a" } });

  const view = await (svc.get as any)(globalMemory.id, { agent: { agentId: "agent-b" } });
  assert.deepEqual(view.related, [{ id: privateMemory.id, kind: "related", missing: true }]);
});

test("agent mode prevents cross-agent mutation of private memories", async () => {
  const svc = await makeService(true);
  const { memory } = await svc.store(agentA);

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
  const { memory: privateMemory } = await svc.store(agentA);
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
