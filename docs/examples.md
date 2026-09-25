# Examples

Runnable examples for the V5.4 developer platform. Start a local server first:

```bash
npx remembra --http
REMEMBRA_API_KEY=your-key npx remembra --http   # if you configured a key
```

| Example | File | What it shows |
|---|---|---|
| Node.js | [examples/node/basic.mjs](../examples/node/basic.mjs) | Store, search, and list with the TypeScript SDK |
| Python | [examples/python/basic.py](../examples/python/basic.py) | The same flow with the Python SDK, plus cursor paging |
| FastAPI | [examples/fastapi/app.py](../examples/fastapi/app.py) | A server that holds the API key and exposes an assistant endpoint |
| RAG | [examples/rag/rag.mjs](../examples/rag/rag.mjs) | Grounded context where memories are quoted data, never instructions |
| Local LLM | [examples/local-llm/local.mjs](../examples/local-llm/local.mjs) | Provider-free operation with `REMEMBRA_EMBEDDINGS=none` |
| Next.js | [examples/next/app/api/memory/route.ts](../examples/next/app/api/memory/route.ts) | A server route that keeps the key out of the browser bundle |
| React | [examples/react/useMemory.tsx](../examples/react/useMemory.tsx) | A hook that talks to your own API, never to Remembra directly |
| AI agent | [examples/agent/agent.mjs](../examples/agent/agent.mjs) | An agent that classifies, remembers, and recalls across sessions |

## Running one

```bash
node examples/node/basic.mjs
python3 examples/python/basic.py
node examples/agent/agent.mjs
node examples/rag/rag.mjs
node examples/local-llm/local.mjs
```

The FastAPI, Next.js, and React examples are meant to be copied into a host
application, so they are not run directly from this repository.

## The rules every example follows

- **The API key stays on the server.** Browser code calls your own endpoint;
  only that endpoint holds `REMEMBRA_API_KEY`.
- **Memory is data, not instructions.** A retrieved `role` or `instruction`
  memory is quoted as context. The RAG and agent examples label those results
  so the distinction is visible.
- **Tenant identity is never a request field.** The host resolves it, and
  Remembra treats it as an opaque context.
- **Writes are not retried automatically.** Retries apply to reads only, so a
  retry can never duplicate a memory. Use an `Idempotency-Key` for batch
  mutations that must survive a retry.
- **Errors are reported as stable codes.** Examples surface `error.code` and
  never a provider secret or raw server diagnostic.
- **Every payload is bounded.** Batch size, context tokens, and result counts
  have documented ceilings; see [public API](public-api.md).

## Verified, and how

`src/test/examples.test.ts` runs in the normal suite and checks that every
example above exists, that the JavaScript examples parse with `node --check`,
that the Python examples compile, and that the security-relevant rules hold:
the RAG example quotes instructions as data, the browser example never reads
the API key, and the local-LLM example documents a provider-free
configuration.

```bash
npm test                       # includes the example checks
node --test dist/test/examples.test.js
```

The examples are intentionally small. For the full contract, read
[public API](public-api.md), the [TypeScript SDK](sdk.md), and the
[Python SDK](python.md).
