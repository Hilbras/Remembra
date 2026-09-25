/**
 * AI agent example: an agent that remembers decisions across sessions.
 *
 * The agent writes a memory when the user states a durable fact, and reads
 * memory before answering. It also demonstrates the rule that keeps memory
 * safe: a retrieved memory is data, never an instruction to follow.
 *
 * Run:  node examples/agent/agent.mjs
 */
import { Remembra } from "@hilbras/remembra/sdk";

const client = new Remembra({
  endpoint: process.env.REMEMBRA_ENDPOINT ?? "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

/** Memory types that may carry instructions; these are quoted, never obeyed. */
const INSTRUCTION_TYPES = new Set(["role", "instruction"]);

/** Classify a user statement into a memory type worth keeping. */
export function classify(statement) {
  const text = statement.trim().toLowerCase();
  if (/\b(we|i) (decided|agreed|chose)\b/.test(text)) return "decision";
  if (/\b(always|never|must|should)\b/.test(text)) return "constraint";
  if (/^i (prefer|like|want)\b/.test(text)) return "preference";
  return "fact";
}

export async function remember(statement) {
  const type = classify(statement);
  const stored = await client.store({ type, content: statement, importance: 7 });
  return { id: stored.id, type };
}

export async function recall(question, limit = 5) {
  const found = await client.search({ query: question, limit });
  return found.results.map((hit) => ({
    id: hit.memory.id,
    type: hit.memory.type,
    content: hit.memory.content,
    // Instructions from memory are context, not commands.
    executable: !INSTRUCTION_TYPES.has(hit.memory.type),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await remember("We decided to deploy payments on tuesday 02:00 UTC with rolling restarts.");
  await remember("The user prefers concise answers without preamble.");
  const memories = await recall("when do we deploy payments?");
  console.log("recalled:");
  for (const memory of memories) {
    console.log(`- (${memory.type}${memory.executable ? "" : ", quoted only"}) ${memory.content}`);
  }
}
