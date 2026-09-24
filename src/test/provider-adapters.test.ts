import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAnthropicLlmAdapter,
  createEmbeddingAdapter,
  createInjectedEmbeddingAdapter,
  createInjectedLlmAdapter,
  createOllamaLlmAdapter,
  createOpenAICompatibleLlmAdapter,
  createOpenAIEmbeddingAdapter,
} from "../provider-adapters.js";
import { extractMemories } from "../llm.js";
import { embedText } from "../embeddings.js";
import { MemoryService } from "../service.js";
import { MemoryStore } from "../store.js";
import { RemembraError } from "../errors.js";
import type { ProviderPolicy } from "../provider.js";

const boundedPolicy: ProviderPolicy = {
  timeoutMs: 50,
  retries: 0,
  budgetMs: 100,
  backoffMs: 0,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("provider adapter subpath is published without starting the server", async () => {
  const packageAdapters = await import("@hilbras/remembra/providers");
  assert.equal(typeof packageAdapters.createOpenAICompatibleLlmAdapter, "function");
});

test("OpenAI-compatible LLM adapter maps the vendor-neutral request", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const adapter = createOpenAICompatibleLlmAdapter({
    id: "compatible",
    endpoint: "https://compatible.example/v1/chat/completions",
    apiKey: "test-key",
    model: "local-model",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return response({ choices: [{ message: { content: "adapter result" } }] });
    },
  });

  assert.equal(
    await adapter.complete({ system: "system", user: "user" }),
    "adapter result",
  );
  assert.equal(request?.url, "https://compatible.example/v1/chat/completions");
  const body = JSON.parse(String(request?.init?.body));
  assert.equal(body.model, "local-model");
  assert.deepEqual(body.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
  ]);
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-key");
});

test("Anthropic and Ollama adapters preserve their request/response contracts", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const anthropic = createAnthropicLlmAdapter({
    apiKey: "anthropic-key",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return response({ content: [{ text: "anthropic result" }] });
    },
  });
  const ollama = createOllamaLlmAdapter({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return response({ message: { content: "ollama result" } });
    },
  });

  assert.equal(await anthropic.complete({ system: "s", user: "u" }), "anthropic result");
  assert.equal(await ollama.complete({ system: "s", user: "u" }), "ollama result");
  assert.match(requests[0].url, /api\.anthropic\.com/);
  assert.equal(requests[0].body.model, "claude-haiku-4-5");
  assert.match(requests[1].url, /localhost:11434\/api\/chat/);
  assert.equal(requests[1].body.model, "llama3.2");
});

test("injected local LLM and embedding adapters work without vendor keys", async () => {
  const llm = createInjectedLlmAdapter("local-llm", async ({ user }) => {
    assert.match(user, /local transcript/);
    return JSON.stringify([{ type: "fact", content: "local memory", tags: [], importance: 3 }]);
  });
  const extracted = await extractMemories("local transcript", "openai", { adapter: llm });
  assert.equal(extracted[0].content, "local memory");

  const embedding = createInjectedEmbeddingAdapter("local-embedding", async (text) => {
    assert.equal(text, "local embedding");
    return [0.25, 0.75];
  });
  assert.deepEqual(await embedText("local embedding", "none", { adapter: embedding }), [0.25, 0.75]);
});

test("MemoryService uses injected adapters for embedding and digest paths", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remembra-adapters-"));
  const service = new MemoryService(new MemoryStore(dir), {
    embeddingAdapter: createInjectedEmbeddingAdapter("local-embed", async () => [1, 0]),
    llmAdapter: createInjectedLlmAdapter(
      "local-llm-service",
      async () => JSON.stringify([{ type: "fact", content: "service adapter memory", tags: [], importance: 3 }]),
    ),
  });
  const stored = await service.store({ type: "fact", content: "adapter-backed store" });
  assert.match(stored.id, /^[0-9a-f-]+$/i);
  const digested = await service.digest({ transcript: "adapter transcript" });
  assert.equal(digested.stored[0].content, "service adapter memory");
});

test("embedding adapters validate vectors and preserve malformed-response errors", async () => {
  const openai = createOpenAIEmbeddingAdapter({
    apiKey: "embedding-key",
    fetchImpl: async () => response({ data: [{ embedding: [1, 2, 3] }] }),
  });
  assert.deepEqual(await openai.embed("text"), [1, 2, 3]);

  const malformed = createEmbeddingAdapter("openai", {
    apiKey: "embedding-key",
    fetchImpl: async () => response({ data: [{ embedding: [1, "bad"] }] }),
  });
  await assert.rejects(
    () => malformed.embed("text"),
    (error: unknown) => {
      assert.ok(error instanceof RemembraError);
      assert.equal(error.code, "LLM_ERROR");
      return true;
    },
  );
});

test("provider adapters retain bounded timeout and cancellation behavior", async () => {
  const hangingFetch: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const adapter = createOpenAICompatibleLlmAdapter({
    apiKey: "key",
    fetchImpl: hangingFetch,
    policy: boundedPolicy,
  });
  await assert.rejects(
    () => adapter.complete({ system: "s", user: "u" }),
    (error: unknown) => {
      assert.ok(error instanceof RemembraError);
      assert.equal(error.code, "PROVIDER_TIMEOUT");
      return true;
    },
  );

  const controller = new AbortController();
  const pending = adapter.complete(
    { system: "s", user: "u" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert.ok(error instanceof RemembraError);
      assert.equal(error.code, "LLM_ERROR");
      assert.match(error.message, /cancelled/);
      return true;
    },
  );
});
