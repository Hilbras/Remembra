import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { defaultMemoryPolicy } from "../policy.js";

test("service relation expansion adds only bounded pool neighbors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-relation-service-"));
  const service = new MemoryService(new MemoryStore(root), {
    embeddingProvider: "none",
    policy: (() => {
      const policy = defaultMemoryPolicy();
      policy.retrieval.relationExpansion = true;
      return policy;
    })(),
  });
  const seed = await service.store({ type: "fact", content: "needle seed" });
  const neighbor = await service.store({ type: "fact", content: "related neighbor", importance: 5 });
  await service.relate({ id: seed.id, related: [neighbor.id], action: "add" });
  for (let i = 0; i < 12; i++) {
    await service.store({
      type: "observation",
      content: `unrelated ${i}`,
      importance: 1,
      source: `old-${i}`,
    });
  }
  const results = await service.search({ query: "needle", limit: 2 });
  assert.ok(results.results.some((memory) => memory.id === neighbor.id));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
