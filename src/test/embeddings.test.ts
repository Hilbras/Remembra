import { test } from "node:test";
import assert from "node:assert/strict";
import { embedTexts } from "../embeddings.js";

test("embedTexts bounds provider concurrency and isolates failures", async () => {
  let active = 0;
  let peak = 0;
  const seen: string[] = [];
  const result = await embedTexts(["a", "bb", "ccc", "dddd", "eeeee"], "openai", {
    maxBatchSize: 2,
    concurrency: 2,
    embedder: async (text) => {
      seen.push(text);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      if (text === "ccc") throw new Error("provider failed");
      return [text.length];
    },
  });

  assert.equal(seen.length, 5);
  assert.ok(peak <= 2, `expected at most two concurrent calls, saw ${peak}`);
  assert.deepEqual(result, [[1], [2], null, [4], [5]]);
});

test("embedTexts validates limits and supports disabled provider", async () => {
  await assert.rejects(
    () => embedTexts(["ok"], "none", { maxBatchSize: 0 }),
    /maxBatchSize/,
  );
  assert.deepEqual(await embedTexts(["ok", "also"], "none"), [null, null]);
  await assert.rejects(
    () => embedTexts([1 as unknown as string], "none"),
    /array of strings/,
  );
});
