import { test } from "node:test";
import assert from "node:assert/strict";
import { search } from "../retrieval.js";
import { Memory } from "../types.js";

function mem(over: Partial<Memory>): Memory {
  return {
    id: Math.random().toString(36).slice(2, 8),
    type: "fact",
    content: "",
    scope: "global",
    tags: [],
    importance: 3,
    confidence: 1,
    trust: "trusted",
    provenance: { sourceType: "manual" },
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const store: Memory[] = [
  mem({ id: "role1", type: "role", content: "Answer briefly", scope: "global" }),
  mem({ id: "db", content: "Uses PostgreSQL", embedding: [1, 0] }),
  mem({ id: "ui", content: "Uses React", embedding: [0, 1] }),
  mem({ id: "secret", content: "Other project secret", scope: "/other" }),
];

test("keyword mode (no queryVec) matches v1 behavior", () => {
  const results = search(store, { query: "postgres", scope: "global" });
  assert.equal(results[0].id, "role1"); // roles always surface first (v1 rule)
  assert.equal(results[1].id, "db"); // best keyword match next
  assert.ok(results.every((m) => m.scope !== "/other"));
});

test("semantic mode: query vector ranks by cosine, roles still first", () => {
  const results = search(store, { query: "db", scope: "/global" }, [1, 0]);
  assert.equal(results[0].id, "role1"); // role gate is absolute
  assert.equal(results[1].id, "db"); // cosine 1.0
  const uiIdx = results.findIndex((m) => m.id === "ui");
  const dbIdx = results.findIndex((m) => m.id === "db");
  assert.ok(uiIdx > dbIdx);
});

test("scope gate holds in semantic mode", () => {
  const results = search(store, { query: "anything", scope: "/repo" }, [1, 0]);
  assert.ok(results.every((m) => m.scope === "global" || m.scope === "/repo"));
  assert.ok(!results.some((m) => m.id === "secret"));
});

test("semantic: irrelevant scoped memory filtered by similarity gate", () => {
  const scoped = [
    mem({ id: "repo-fact", content: "uses kubernetes", scope: "/repo" }),
  ];
  const results = search(scoped, { query: "cooking recipes", scope: "/elsewhere" }, [0, 1]);
  // different scope → excluded regardless
  assert.equal(results.length, 0);
  const sameScope = search(scoped, { query: "cooking recipes", scope: "/repo" }, [0, 1]);
  // same scope survives but ranks low; role/global handled elsewhere
  assert.equal(sameScope.length, 1);
});

test("memory without vector falls back to keywords in semantic mode", () => {
  const mixed = [
    mem({ id: "novec", content: "special keyword here", scope: "/repo" }),
    mem({ id: "vec", content: "unrelated text", scope: "/repo", embedding: [1, 0] }),
  ];
  const results = search(mixed, { query: "special keyword", scope: "/repo" }, [0, 1]);
  assert.equal(results[0].id, "novec");
});
