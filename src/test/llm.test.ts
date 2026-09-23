import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtraction, resolveLlmProvider as resolveLlm } from "../llm.js";
import { cosine, resolveEmbeddingProvider } from "../embeddings.js";

test("parseExtraction handles plain arrays", () => {
  const out = parseExtraction(
    JSON.stringify([{ type: "fact", content: "X is Y", tags: ["a"], importance: 2 }]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "X is Y");
  assert.deepEqual(out[0].tags, ["a"]);
});

test("parseExtraction strips code fences and surrounding prose", () => {
  const raw =
    'Here are the memories:\n```json\n[{"type":"role","content":"Be brief","importance":5}]\n```';
  const out = parseExtraction(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "role");
});

test("parseExtraction handles wrapped objects", () => {
  const out = parseExtraction('{"memories":[{"type":"decision","content":"Use X","importance":9}]}');
  assert.equal(out.length, 1);
  assert.equal(out[0].importance, 5); // clamped
});

test("parseExtraction drops invalid entries", () => {
  const out = parseExtraction(
    JSON.stringify([
      { type: "banana", content: "bad type" },
      { type: "fact", content: "" },
      "not an object",
      { type: "fact", content: "good", importance: "4" },
    ]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "good");
});

test("parseExtraction returns [] for empty array", () => {
  assert.deepEqual(parseExtraction("[]"), []);
});

test("cosine similarity basics", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(cosine([1, 1], [1, 0]) > 0.7);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine([1], [1, 2]), 0); // length mismatch
});

test("provider resolvers default correctly", () => {
  delete process.env.REMEMBRA_EMBEDDINGS;
  delete process.env.REMEMBRA_LLM;
  assert.equal(resolveEmbeddingProvider(), "none");
  assert.equal(resolveLlm(), "openai");
  process.env.REMEMBRA_EMBEDDINGS = "ollama";
  assert.equal(resolveEmbeddingProvider(), "ollama");
  delete process.env.REMEMBRA_EMBEDDINGS;
  assert.throws(() => {
    process.env.REMEMBRA_EMBEDDINGS = "bogus";
    resolveEmbeddingProvider();
  });
  delete process.env.REMEMBRA_EMBEDDINGS;
});
