/**
 * Local-LLM example: keep retrieval and inference fully offline.
 *
 * Remembra's local operation needs no hosted provider: run the server with
 * `REMEMBRA_EMBEDDINGS=none` and point the LLM at a local runtime. This
 * example shows the offline configuration and a deterministic fallback so the
 * file runs without any model download.
 *
 * Run the server:  REMEMBRA_EMBEDDINGS=none REMEMBRA_LLM=ollama npx remembra --http
 * Then:            node examples/local-llm/local.mjs
 */
import { Remembra } from "@hilbras/remembra/sdk";

export const OFFLINE_SERVER_ENV = {
  REMEMBRA_EMBEDDINGS: "none",
  REMEMBRA_LLM: "ollama",
  REMEMBRA_LLM_BASE_URL: "http://127.0.0.1:11434",
};

const client = new Remembra({
  endpoint: process.env.REMEMBRA_ENDPOINT ?? "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

/** Keyword-only recall keeps the example runnable with no model at all. */
export async function recallOffline(question, limit = 5) {
  const found = await client.search({ query: question, limit });
  return found.results.map((hit) => ({
    id: hit.memory.id,
    type: hit.memory.type,
    content: hit.memory.content,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await client.store({
    type: "fact",
    content: "The offline evaluation harness scores recall without calling a hosted provider.",
    importance: 5,
  });
  const memories = await recallOffline("offline evaluation");
  console.log(`recalled ${memories.length} memories with no hosted provider`);
  for (const memory of memories) console.log(`- ${memory.id}: ${memory.content}`);
}
