import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate } from "../consolidation.js";
import type { Memory } from "../types.js";

function makeMem(overrides: Partial<Memory> & { id: string }): Memory {
  const now = new Date().toISOString();
  const { id, ...rest } = overrides;
  return {
    id,
    type: rest.type ?? "fact",
    scope: rest.scope ?? "global",
    content: rest.content ?? "test content",
    tags: rest.tags ?? [],
    importance: rest.importance ?? 3,
    confidence: rest.confidence ?? 0.8,
    trust: rest.trust ?? "trusted",
    createdAt: rest.createdAt ?? now,
    updatedAt: rest.updatedAt ?? now,
    version: 1,
    provenance: { sourceType: "manual" },
    ...rest,
  } as Memory;
}

test("consolidate: detects exact duplicates", () => {
  const now = new Date().toISOString();
  const mems = [
    makeMem({ id: "a", content: "User prefers coffee", createdAt: now }),
    makeMem({ id: "b", content: "User prefers coffee", createdAt: now }),
  ];
  const r = consolidate(mems);
  assert.equal(r.exactDuplicates.length, 1);
  assert.equal(r.exactDuplicates[0].id, "b");
  assert.equal(r.exactDuplicates[0].duplicateOf, "a");
});

test("consolidate: no duplicates for unique memories", () => {
  const mems = [
    makeMem({ id: "a", content: "User likes coffee" }),
    makeMem({ id: "b", content: "User likes tea" }),
  ];
  const r = consolidate(mems);
  assert.equal(r.exactDuplicates.length, 0);
});

test("consolidate: detects contradictions", () => {
  const mems = [
    makeMem({ id: "a", content: "User is active in the project" }),
    makeMem({ id: "b", content: "User is inactive in the project" }),
  ];
  const r = consolidate(mems);
  assert.ok(r.contradictions.length > 0, "should detect contradiction");
});

test("consolidate: no false-positive contradiction on similar positive statements", () => {
  const mems = [
    makeMem({ id: "a", content: "User uses TypeScript daily" }),
    makeMem({ id: "b", content: "User writes TypeScript code every day" }),
  ];
  const r = consolidate(mems);
  const hasContradiction = r.contradictions.some(
    (c) => (c.a === "a" && c.b === "b") || (c.a === "b" && c.b === "a"),
  );
  assert.equal(hasContradiction, false, "should not flag supporting statements as contradictory");
});

test("consolidate: groups by type+scope", () => {
  const mems = [
    makeMem({ id: "a", type: "fact", scope: "global", content: "User likes coffee" }),
    makeMem({ id: "b", type: "fact", scope: "global", content: "User likes coffee" }),
    makeMem({ id: "c", type: "fact", scope: "project-x", content: "User likes coffee" }),
  ];
  const r = consolidate(mems);
  // Only a and b are exact duplicates (same type+scope).
  assert.equal(r.exactDuplicates.length, 1);
});

test("consolidate: near-duplicate with embeddings", () => {
  const vec = [0.1, 0.2, 0.3, 0.4];
  const mems = [
    makeMem({ id: "a", content: "User prefers dark mode", embedding: vec }),
    makeMem({ id: "b", content: "User likes dark theme", embedding: vec }), // identical vector
  ];
  const r = consolidate(mems, { similarityThreshold: 0.9 });
  assert.ok(r.nearDuplicates.length > 0, "identical vectors should be near-duplicate");
});

test("consolidate: fragment detection", () => {
  const now = new Date().toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const mems = [
    makeMem({ id: "a", type: "fact", scope: "global", content: "User started using React", createdAt: threeDaysAgo }),
    makeMem({ id: "b", type: "fact", scope: "global", content: "User learns React hooks", createdAt: threeDaysAgo }),
    makeMem({ id: "c", type: "fact", scope: "global", content: "User builds React components", createdAt: threeDaysAgo }),
  ];
  const r = consolidate(mems);
  assert.ok(r.fragments.length > 0, "3 short recent memories in same bucket = fragment");
  assert.equal(r.fragments[0].ids.length, 3);
});

test("consolidate: no fragments for old memories", () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const mems = [
    makeMem({ id: "a", type: "fact", scope: "global", content: "User used React", createdAt: old }),
    makeMem({ id: "b", type: "fact", scope: "global", content: "User used Vue", createdAt: old }),
    makeMem({ id: "c", type: "fact", scope: "global", content: "User used Angular", createdAt: old }),
  ];
  const r = consolidate(mems);
  assert.equal(r.fragments.length, 0, "old memories should not be fragments");
});

test("consolidate: empty input returns empty findings", () => {
  const r = consolidate([]);
  assert.equal(r.exactDuplicates.length, 0);
  assert.equal(r.nearDuplicates.length, 0);
  assert.equal(r.contradictions.length, 0);
  assert.equal(r.fragments.length, 0);
});
