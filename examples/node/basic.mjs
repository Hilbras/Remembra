/**
 * Node.js example: store, search, and reuse a memory.
 *
 * Run a local server first:  npx remembra --http
 * Then:                      node examples/node/basic.mjs
 */
import { Remembra } from "@hilbras/remembra/sdk";

const client = new Remembra({
  endpoint: process.env.REMEMBRA_ENDPOINT ?? "http://127.0.0.1:8787",
  apiKey: process.env.REMEMBRA_API_KEY,
});

const stored = await client.store({
  type: "decision",
  content: "Payments deploys happen on tuesday 02:00 UTC with rolling restarts.",
  scope: "global",
  tags: ["deploy", "payments"],
  importance: 8,
});
console.log("stored", stored.id);

// A later session recalls it with the same search the agent would use.
const found = await client.search({ query: "when do payments deploys happen", limit: 5 });
for (const hit of found.results) {
  console.log(`${hit.memory.id}  ${hit.memory.content}`);
}

// Safe retries apply to reads only; a mutation is never retried automatically.
const page = await client.list({ limit: 20, includeArchived: false });
console.log(`active memories: ${page.memories.length}`);
