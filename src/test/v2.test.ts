import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryService } from "../service.js";
import { ExtractedMemory } from "../llm.js";

async function svcWith(
  extract?: (t: string) => Promise<ExtractedMemory[]>,
  embed?: (t: string) => Promise<number[]>,
): Promise<MemoryService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-v2-"));
  return new MemoryService(new MemoryStore(dir), {
    embedFn: embed,
    extractFn: extract,
    embeddingProvider: "none",
  });
}

test("digest stores extracted memories with dedup", async () => {
  let calls = 0;
  const extract = async (): Promise<ExtractedMemory[]> => {
    calls++;
    return [
      { type: "fact", content: "Uses PostgreSQL 16", tags: ["db"], importance: 4 },
      { type: "decision", content: "Chose JWT over sessions", tags: [], importance: 5 },
    ];
  };
  const svc = await svcWith(extract);

  const first = await svc.digest({ transcript: "whatever", scope: "/repo" });
  assert.equal(first.extracted, 2);
  assert.equal(first.stored.length, 2);
  assert.equal(first.skippedDuplicates, 0);

  // Same extraction again → all duplicates, nothing stored (idempotent).
  const second = await svc.digest({ transcript: "whatever again", scope: "/repo" });
  assert.equal(second.stored.length, 0);
  assert.equal(second.skippedDuplicates, 2);
  assert.equal(calls, 2);
});

test("digest respects scope in dedup keys", async () => {
  const extract = async (): Promise<ExtractedMemory[]> => [
    { type: "fact", content: "Same text", tags: [], importance: 3 },
  ];
  const a = await svcWith(extract);
  await a.digest({ transcript: "t", scope: "/repo-a" });
  const res = await a.digest({ transcript: "t", scope: "/repo-b" });
  // Different scope → NOT a duplicate → stored.
  assert.equal(res.stored.length, 1);
});

test("digest normalizes whitespace/case for dedup", async () => {
  let n = 0;
  const extract = async (): Promise<ExtractedMemory[]> => [
    { type: "fact", content: n++ === 0 ? "Uses  Postgres" : "uses postgres", tags: [], importance: 3 },
  ];
  const svc = await svcWith(extract);
  await svc.digest({ transcript: "t" });
  const res = await svc.digest({ transcript: "t" });
  assert.equal(res.stored.length, 0);
  assert.equal(res.skippedDuplicates, 1);
});

test("embeddings disabled → no vectors stored", async () => {
  const svc = await svcWith();
  assert.equal(svc.embeddingsEnabled, false);
  const { memory } = await svc.store({ type: "fact", content: "no vector here" });
  assert.equal(memory.embedding, undefined);
});

test("embeddings enabled → vectors cached on write and used in search", async () => {
  // Toy embedder: "database" topics → [1,0], "frontend" → [0,1].
  const embed = async (text: string): Promise<number[]> =>
    /db|database|postgres/i.test(text) ? [1, 0] : [0, 1];
  const svc = await svcWith(undefined, embed);
  assert.equal(svc.embeddingsEnabled, true);

  await svc.store({ type: "fact", content: "Uses PostgreSQL for events" });
  await svc.store({ type: "fact", content: "Frontend uses React" });

  const { results } = await svc.search({ query: "postgres database", scope: "global" });
  assert.match(results[0].content, /PostgreSQL/);

  // Vector persisted to disk frontmatter.
  const all = await svc.db.all();
  const withVec = all.find((m) => /PostgreSQL/.test(m.content));
  assert.deepEqual(withVec?.embedding, [1, 0]);
});

test("embedder failure degrades to keyword mode", async () => {
  const embed = async (): Promise<number[]> => {
    throw new Error("api down");
  };
  const svc = await svcWith(undefined, embed);
  const { memory } = await svc.store({ type: "fact", content: "still stored" });
  assert.equal(memory.embedding, undefined);

  await svc.store({ type: "fact", content: "keyword fallback works" });
  const { results } = await svc.search({ query: "keyword fallback" });
  assert.match(results[0].content, /keyword fallback/);
});
